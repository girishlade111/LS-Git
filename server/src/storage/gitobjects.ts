import { createHash } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Minimal Git object plumbing (loose objects) — write/read blobs, trees and
 * commits without shelling out to the `git` binary. Produces standard,
 * clonable repositories (format per gitrepository-layout(7)).
 *
 * Owned by the storage abstraction; feature code must not use this directly.
 */

export type ObjectType = 'blob' | 'tree' | 'commit'

export interface TreeEntryInput {
  mode: '100644' | '100755'
  name: string
  content: Buffer
}

export interface TreeEntryParsed {
  mode: string
  name: string
  sha: string
}

function objectPath(objectsDir: string, sha: string): string {
  return join(objectsDir, sha.slice(0, 2), sha.slice(2))
}

export function writeObject(
  objectsDir: string,
  type: ObjectType,
  body: Buffer,
): string {
  const header = Buffer.from(`${type} ${body.length}\0`, 'utf8')
  const store = Buffer.concat([header, body])
  const sha = createHash('sha1').update(store).digest('hex')
  const file = objectPath(objectsDir, sha)
  if (!existsSync(file)) {
    mkdirSync(join(objectsDir, sha.slice(0, 2)), { recursive: true })
    writeFileSync(file, deflateSync(store))
  }
  return sha
}

export function readObject(objectsDir: string, sha: string): { type: ObjectType; body: Buffer } {
  const raw = inflateSync(readFileSync(objectPath(objectsDir, sha)))
  const nul = raw.indexOf(0)
  if (nul === -1) throw new Error(`malformed object ${sha}`)
  const header = raw.subarray(0, nul).toString('utf8')
  const space = header.indexOf(' ')
  const type = header.slice(0, space) as ObjectType
  const size = Number(header.slice(space + 1))
  const body = raw.subarray(nul + 1)
  if (body.length !== size) throw new Error(`object ${sha} size mismatch`)
  return { type, body }
}

/** Builds a single-level tree of files. Entries sorted by name (git tree order). */
export function buildTree(entries: Array<TreeEntryInput>, objectsDir: string): { sha: string; entryShas: Map<string, string> } {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  const chunks: Buffer[] = []
  const entryShas = new Map<string, string>()
  for (const e of sorted) {
    const sha = writeObject(objectsDir, 'blob', e.content)
    entryShas.set(e.name, sha)
    chunks.push(Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(sha, 'hex')]))
  }
  const sha = writeObject(objectsDir, 'tree', Buffer.concat(chunks))
  return { sha, entryShas }
}

export function commitTree(
  objectsDir: string,
  treeSha: string,
  message: string,
  author: { name: string; email: string },
): string {
  const ts = Math.floor(Date.now() / 1000)
  const tz = '+0000'
  const ident = `${author.name} <${author.email}> ${ts} ${tz}`
  const body = Buffer.from(
    `tree ${treeSha}\n` +
      `author ${ident}\n` +
      `committer ${ident}\n\n` +
      `${message.trim()}\n`,
    'utf8',
  )
  return writeObject(objectsDir, 'commit', body)
}

// -- reading -----------------------------------------------------------------

export function parseCommit(body: Buffer): { tree: string } {
  const m = /^tree ([0-9a-f]{40})/m.exec(body.toString('utf8'))
  if (!m) throw new Error('commit has no tree')
  return { tree: m[1]! }
}

export function parseTree(body: Buffer): Array<TreeEntryParsed> {
  const out: Array<TreeEntryParsed> = []
  let off = 0
  while (off < body.length) {
    const space = body.indexOf(0x20, off)
    const nul = body.indexOf(0x00, space)
    if (space === -1 || nul === -1) throw new Error('malformed tree entry')
    const mode = body.subarray(off, space).toString('ascii')
    const name = body.subarray(space + 1, nul).toString('utf8')
    const sha = body.subarray(nul + 1, nul + 21).toString('hex')
    out.push({ mode, name, sha })
    off = nul + 21
  }
  return out
}

/** Recursively loads all files under a tree. Returns path → content map. */
export function loadFilesUnderTree(objectsDir: string, treeSha: string, prefix = ''): Map<string, Buffer> {
  const { body } = readObject(objectsDir, treeSha)
  const out = new Map<string, Buffer>()
  for (const entry of parseTree(body)) {
    if (entry.mode.startsWith('4')) {
      for (const [p, c] of loadFilesUnderTree(objectsDir, entry.sha, prefix + entry.name + '/')) {
        out.set(p, c)
      }
    } else {
      out.set(prefix + entry.name, readObject(objectsDir, entry.sha).body)
    }
  }
  return out
}

/** Self-check helper: recomputes a loose object's SHA-1 from its stored bytes. */
export function verifyLooseObject(objectsDir: string, sha: string): boolean {
  const raw = inflateSync(readFileSync(objectPath(objectsDir, sha)))
  return createHash('sha1').update(raw).digest('hex') === sha
}
