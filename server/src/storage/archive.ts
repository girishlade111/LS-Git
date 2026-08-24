import { gzipSync } from 'node:zlib'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Archive builder — packs a flattened tree (path → {mode, sha}) into a
 * gzip-compressed POSIX tar (ustar), the same artifact `git archive` produces
 * for a ref. Reads blob bytes through the caller-supplied accessor so this
 * module stays storage-agnostic and testable.
 *
 * Output goes to a temp file (never buffered in the HTTP response path) that
 * the route streams and then unlinks.
 */

export interface ArchiveEntry {
  path: string
  mode: '100644' | '100755'
  /** Blob content accessor. */
  read: () => Buffer
}

const MAX_ARCHIVE_FILES = 20_000

interface TarHeader {
  name: string
  size: number
  mode: string
  mtime: Date
  type: '0' // regular file
}

/** Builds a 512-byte ustar header block. */
function tarHeader(h: TarHeader): Buffer {
  const block = Buffer.alloc(512)
  const write = (offset: number, length: number, value: string): void => {
    block.write(value, offset, length, 'ascii')
  }
  write(0, 100, h.name)
  write(100, 8, `${h.mode} `) // octal mode + trailing space/NUL padding
  write(108, 8, '0000000 ') // uid
  write(116, 8, '0000000 ') // gid
  write(124, 12, `${h.size.toString(8).padStart(11, '0')} `)
  write(136, 12, `${Math.floor(h.mtime.getTime() / 1000).toString(8).padStart(11, '0')} `)
  block[156] = 0x30 // '0' — regular file
  write(257, 6, 'ustar')
  write(263, 2, '00')
  write(265, 32, 'lsgit') // owner name
  write(297, 32, 'lsgit')
  // Checksum: spaces during computation, then 6-digit octal + NUL + space.
  for (let i = 148; i < 156; i++) block[i] = 0x20
  let checksum = 0
  for (const byte of block) checksum += byte
  write(148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  return block
}

function pad512(n: number): Buffer {
  const rem = n % 512
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - rem)
}

export interface ArchiveResult {
  /** Absolute temp file path containing the gzipped tar. Caller must unlink. */
  file: string
  fileName: string
  fileCount: number
  uncompressedBytes: number
}

/**
 * Packs entries into `<fileName>` tar.gz at a server-chosen temp location.
 * Deterministic mtimes (commit time) keep archives reproducible per ref.
 */
export function buildArchive(
  opts: {
    entries: Array<ArchiveEntry>
    /** Directory prefix inside the archive, e.g. 'my-project-main/'. */
    rootPrefix: string
    fileName: string
    commitTime: Date
    tempDir: string
  },
): ArchiveResult {
  if (opts.entries.length > MAX_ARCHIVE_FILES) {
    throw new Error(`Archive exceeds ${MAX_ARCHIVE_FILES} files`)
  }
  const chunks: Buffer[] = []
  let total = 0
  for (const entry of opts.entries) {
    const content = entry.read()
    const name = `${opts.rootPrefix}${entry.path}`
    chunks.push(
      tarHeader({
        // ustar name field is 100 bytes; deep paths are truncated conservatively.
        name: name.length > 99 ? `${name.slice(0, 96)}...` : name,
        size: content.length,
        mode: entry.mode === '100755' ? '0000755' : '0000644',
        mtime: opts.commitTime,
        type: '0',
      }),
    )
    chunks.push(content, pad512(content.length))
    total += content.length
  }
  chunks.push(Buffer.alloc(1024)) // two zero blocks terminate the tar
  mkdirSync(opts.tempDir, { recursive: true })
  const file = join(opts.tempDir, `archive-${randomUUID()}.tar.gz`)
  try {
    writeFileSync(file, gzipSync(Buffer.concat(chunks)))
  } catch (err) {
    rmSync(file, { force: true })
    throw err
  }
  return { file, fileName: opts.fileName, fileCount: opts.entries.length, uncompressedBytes: total }
}
