import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  renameSync,
} from 'node:fs'
import { join } from 'node:path'

/**
 * Upload staging store — the seam between resumable upload sessions and
 * wherever chunk bytes physically live (UPLOADS.md §Storage).
 *
 * Contract:
 *  - Chunks are addressed by (sessionId, itemId, index) — NEVER by client paths.
 *  - putChunk is idempotent: replaying an identical chunk reports duplicate
 *    without double-counting; a different payload for the same index replaces
 *    atomically (temp + rename) so concurrent writers never expose partial data.
 *  - The store is AUTHORITATIVE for which chunks exist; database counters are
 *    advisory progress state only.
 *  - assemble() concatenates chunks in index order. Callers must verify
 *    completeness via listChunks() first.
 *
 * Drivers:
 *  - LocalChunkStore — filesystem under uploadsRoot (development + self-hosted
 *    default). Chunk layout mirrors multipart semantics so an S3 driver maps
 *    index → PartNumber and assemble → CompleteMultipartUpload.
 *  - Direct browser→object-storage presigned uploads are the recommended
 *    production deployment mode (see UPLOADS.md §Storage decision); this
 *    interface is what such a driver implements.
 */

export interface StagingChunk {
  index: number
  size: number
}

export interface PutChunkResult {
  /** True when a chunk with identical content already occupied this slot. */
  duplicate: boolean
  sha256: string
}

export interface UploadStagingStore {
  readonly kind: 'local' | 'object'
  initSession(sessionId: string): void
  discardSession(sessionId: string): void
  /** Session directories present on storage, including orphans with no DB row. */
  listSessionIds(): string[]
  putChunk(sessionId: string, itemId: string, index: number, data: Buffer): Promise<PutChunkResult>
  listChunks(sessionId: string, itemId: string): Promise<StagingChunk[]>
  /** Concatenation of all chunks in index order. Completeness verified by caller. */
  assemble(sessionId: string, itemId: string): Promise<{ buffer: Buffer; sha256: string }>
}

function chunkFileName(index: number): string {
  return `chunk-${String(index).padStart(6, '0')}`
}

/** Dev/self-hosted filesystem driver. */
export class LocalChunkStore implements UploadStagingStore {
  readonly kind = 'local' as const

  constructor(private root: string) {}

  private sessionDir(sessionId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw new Error('malformed session id')
    return join(this.root, sessionId)
  }

  private itemDir(sessionId: string, itemId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(itemId)) throw new Error('malformed item id')
    return join(this.sessionDir(sessionId), itemId)
  }

  initSession(sessionId: string): void {
    mkdirSync(this.sessionDir(sessionId), { recursive: true })
  }

  discardSession(sessionId: string): void {
    rmSync(this.sessionDir(sessionId), { recursive: true, force: true })
  }

  listSessionIds(): string[] {
    if (!existsSync(this.root)) return []
    const ids: string[] = []
    for (const entry of readdirSync(this.root)) {
      if (/^[a-f0-9-]{36}$/.test(entry) && statSync(join(this.root, entry)).isDirectory()) {
        ids.push(entry)
      }
    }
    return ids
  }

  async putChunk(
    sessionId: string,
    itemId: string,
    index: number,
    data: Buffer,
  ): Promise<PutChunkResult> {
    const dir = this.itemDir(sessionId, itemId)
    mkdirSync(dir, { recursive: true })
    const finalPath = join(dir, chunkFileName(index))
    const sha256 = createHash('sha256').update(data).digest('hex')

    // Idempotent replay: identical bytes already staged → no-op.
    if (existsSync(finalPath)) {
      const existing = createHash('sha256').update(readFileSync(finalPath)).digest('hex')
      if (existing === sha256) return { duplicate: true, sha256 }
    }

    const tmp = join(dir, `${chunkFileName(index)}.${randomUUID()}.part`)
    writeFileSync(tmp, data)
    renameSync(tmp, finalPath) // atomic within the same directory/filesystem
    return { duplicate: false, sha256 }
  }

  async listChunks(sessionId: string, itemId: string): Promise<StagingChunk[]> {
    const dir = this.itemDir(sessionId, itemId)
    if (!existsSync(dir)) return []
    const chunks: StagingChunk[] = []
    for (const name of readdirSync(dir)) {
      const m = /^chunk-(\d{6})$/.exec(name)
      if (!m) continue // ignore .part leftovers from crashed writers
      const path = join(dir, name)
      if (!statSync(path).isFile()) continue
      chunks.push({ index: Number(m[1]), size: statSync(path).size })
    }
    chunks.sort((a, b) => a.index - b.index)
    return chunks
  }

  async assemble(sessionId: string, itemId: string): Promise<{ buffer: Buffer; sha256: string }> {
    const chunks = await this.listChunks(sessionId, itemId)
    const hash = createHash('sha256')
    const parts: Buffer[] = []
    for (const c of chunks) {
      const buf = readFileSync(join(this.itemDir(sessionId, itemId), chunkFileName(c.index)))
      hash.update(buf)
      parts.push(buf)
    }
    const buffer = Buffer.concat(parts)
    return { buffer, sha256: hash.digest('hex') }
  }
}
