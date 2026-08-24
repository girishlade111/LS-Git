import { createHash } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'
import {
  openSync, closeSync, writeSync, readFileSync, writeFileSync,
  mkdirSync, existsSync, rmSync, renameSync, readdirSync, statSync, unlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * LSGit core Git repository engine (the in-process "git-core" analog).
 *
 * Owns REAL Git repositories — standard loose objects, tree/commit/tag object
 * formats and ref files exactly as produced by `git init --bare`. Repositories
 * written by this engine are clonable and pass `git fsck --strict`. There is no
 * JSON emulation anywhere; blob bytes live only inside Git's own object store.
 *
 * Concurrency model (mirrors git itself):
 *   - Every ref mutation takes `<ref>.lock` via O_CREAT|O_EXCL. Two concurrent
 *     writers cannot both hold the lock; the loser fails fast instead of
 *     corrupting state.
 *   - Optimistic concurrency: callers pass the tip they based their work on
 *     (`expectedOld`); if the ref moved underneath them the update is refused
 *     with RefConflictError (git's "update-ref old-value mismatch").
 *   - The new value is staged in the lock file and installed with a single
 *     rename, so readers never observe partial writes.
 *
 * Security posture: no subprocess is ever spawned and no user-controlled string
 * reaches a filesystem path unvalidated — every ref name passes a
 * git-check-ref-format subset validator before it can touch disk.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RepositoryError extends Error {
  constructor(message: string, public code: string) {
    super(message)
  }
}

export class RepositoryNotFoundError extends RepositoryError {
  constructor(path: string) {
    super(`Repository not found at ${path}`, 'repository_not_found')
  }
}

export class ObjectNotFoundError extends RepositoryError {
  constructor(sha: string) {
    super(`Object not found: ${sha}`, 'object_not_found')
  }
}

export class InvalidObjectError extends RepositoryError {
  constructor(message: string) {
    super(message, 'invalid_object')
  }
}

/** Ref name failed git-check-ref-format-style validation. */
export class RefValidationError extends RepositoryError {
  constructor(message: string) {
    super(message, 'invalid_ref')
  }
}

/** Another writer holds the lock for this ref (or left a stale one). */
export class RefLockError extends RepositoryError {
  constructor(ref: string) {
    super(`Ref '${ref}' is locked by another operation`, 'ref_locked')
  }
}

/** Optimistic-concurrency failure: the ref moved since the caller read it. */
export class RefConflictError extends RepositoryError {
  constructor(
    ref: string,
    public readonly currentSha: string | null,
    public readonly expectedOld: string | null,
  ) {
    super(
      `Ref '${ref}' changed concurrently (expected ${expectedOld ?? '<absent>'}, found ${currentSha ?? '<absent>'})`,
      'ref_conflict',
    )
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag'
export type FileMode = '100644' | '100755'

export interface CommitIdentity {
  name: string
  email: string
}

export interface CommitTimestamp {
  /** Unix seconds. */
  time: number
  /** Offset like '+0200' or '-0730'. */
  timezone?: string
}

export interface TreeEntryParsed {
  mode: string
  name: string
  sha: string
}

export interface FlatFileInput {
  path: string
  mode?: FileMode
  content: Buffer | string
}

export interface ShaEntryInput {
  path: string
  mode: FileMode
  sha: string
}

export interface ParsedCommit {
  sha: string
  tree: string
  parents: string[]
  author: { identity: CommitIdentity; timestamp: CommitTimestamp }
  committer: { identity: CommitIdentity; timestamp: CommitTimestamp }
  message: string
}

export interface WriteCommitOptions {
  tree: string
  parents: string[]
  message: string
  author: CommitIdentity
  committer?: CommitIdentity
  timestamp?: CommitTimestamp
}

export interface CreateTagOptions {
  name: string
  target: string
  /** Presence of message+tagger produces an annotated tag object; otherwise lightweight. */
  message?: string
  tagger?: CommitIdentity
  timestamp?: CommitTimestamp
}

export interface TagInfo {
  name: string
  annotated: boolean
  /** Ref value: the tag object (annotated) or target object (lightweight). */
  sha: string
  /** What the tag ultimately points at. */
  target: string
  targetType: ObjectType
  tagger?: CommitIdentity
  message?: string
}

export interface RefUpdateResult {
  ref: string
  old: string | null
  new: string
}

export interface ApplyChangesOptions {
  baseBranch: string
  targetBranch: string
  message: string
  identity: CommitIdentity
  changes: Array<{ path: string; content?: Buffer | string; sha?: string; mode?: FileMode }>
  /**
   * Fail when any change would overwrite an existing path (default false).
   * Callers wanting replace semantics leave this off.
   */
  rejectOverwrite?: boolean
}

export interface ApplyChangesResult {
  commitSha: string
  treeSha: string
  branch: string
  previousTip: string | null
  createdBranch: boolean
  replacedPaths: string[]
}

const SHA_RE = /^[0-9a-f]{40}$/
/** Locks older than this are considered abandoned by a crashed process. */
const STALE_LOCK_MS = 60_000

function localTimezoneOffset(): string {
  const minutes = -new Date().getTimezoneOffset()
  const sign = minutes >= 0 ? '+' : '-'
  const abs = Math.abs(minutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Ref-name validation (subset of git-check-ref-format(1) rules)
// ---------------------------------------------------------------------------

/**
 * Validates and returns the fully qualified ref name ('refs/heads/<name>',
 * 'refs/tags/<name>'). Rules enforced:
 *   - must start with refs/heads/ or refs/tags/ (engine scope)
 *   - no ASCII control chars, space, ~ ^ : ? * [ \ < >
 *   - no '..', no '@{', component may not start with '.', end with '.lock',
 *     or be empty; name may not begin/end with '/' or '.'
 */
export function validateRefName(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024) {
    throw new RefValidationError('Ref name must be a non-empty string of at most 1024 characters')
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f ~^:?*[\\<>]/.test(raw)) {
    throw new RefValidationError("Ref name contains characters that are not allowed (' ', '~', '^', ':', '?', '*', '[', '\\', '<', '>', control chars)")
  }
  if (!raw.startsWith('refs/heads/') && !raw.startsWith('refs/tags/')) {
    throw new RefValidationError("Ref name must start with 'refs/heads/' or 'refs/tags/'")
  }
  if (raw.includes('..')) throw new RefValidationError("Ref name contains '..'")
  if (raw.includes('@{')) throw new RefValidationError("Ref name contains '@{'")
  if (raw.endsWith('/') || raw.endsWith('.')) throw new RefValidationError('Ref name ends with / or .')
  const components = raw.split('/')
  for (let i = 1; i < components.length; i++) {
    const c = components[i]!
    if (c.length === 0) throw new RefValidationError("Ref name contains an empty component ('//')")
    if (c.startsWith('.')) throw new RefValidationError("A ref name component starts with '.'")
    if (c.endsWith('.lock')) throw new RefValidationError("A ref name component ends with '.lock'")
  }
  return raw
}

export function validateSha(raw: string): string {
  if (typeof raw !== 'string' || !SHA_RE.test(raw)) {
    throw new RefValidationError(`Invalid object id: ${String(raw).slice(0, 64)}`)
  }
  return raw
}

/** Hex revision input → lowercase candidate; full shas and short prefixes (≥7). */
export function normalizeRevCandidate(rev: string): string | null {
  const lower = rev.trim().toLowerCase()
  return /^[0-9a-f]{7,40}$/.test(lower) ? lower : null
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface LooseHeader {
  type: ObjectType
  body: Buffer
}

export class GitRepository {
  private constructor(private readonly root: string) {}

  /** Absolute path of the bare repository directory. */
  get path(): string {
    return this.root
  }

  // -- lifecycle -------------------------------------------------------------

  static open(rootPath: string): GitRepository {
    if (!existsSync(join(rootPath, 'HEAD')) || !existsSync(join(rootPath, 'objects'))) {
      throw new RepositoryNotFoundError(rootPath)
    }
    return new GitRepository(rootPath)
  }

  static existsAt(rootPath: string): boolean {
    return existsSync(join(rootPath, 'HEAD')) && existsSync(join(rootPath, 'objects'))
  }

  /**
   * Creates a bare repository with the layout of `git init --bare`
   * (format per gitrepository-layout(7)). HEAD is symbolic to the default
   * branch; the repo is empty until its first commit lands.
   */
  static createBare(rootPath: string, defaultBranch: string): GitRepository {
    mkdirSync(join(rootPath, 'objects', 'info'), { recursive: true })
    mkdirSync(join(rootPath, 'objects', 'pack'), { recursive: true })
    mkdirSync(join(rootPath, 'refs', 'heads'), { recursive: true })
    mkdirSync(join(rootPath, 'refs', 'tags'), { recursive: true })
    writeFileSync(join(rootPath, 'HEAD'), `ref: refs/heads/${validateBranchName(defaultBranch)}\n`, 'utf8')
    writeFileSync(
      join(rootPath, 'config'),
      '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = true\n',
      'utf8',
    )
    writeFileSync(
      join(rootPath, 'description'),
      'Unnamed repository; edit this file to name the repository.\n',
      'utf8',
    )
    return new GitRepository(rootPath)
  }

  isEmpty(): boolean {
    return this.listRefs('refs/').length === 0
  }

  // -- objects ----------------------------------------------------------------

  private objectPath(sha: string): string {
    return join(this.root, 'objects', sha.slice(0, 2), sha.slice(2))
  }

  hasObject(sha: string): boolean {
    validateSha(sha)
    return existsSync(this.objectPath(sha))
  }

  writeObject(type: ObjectType, body: Buffer): string {
    const header = Buffer.from(`${type} ${body.length}\0`, 'utf8')
    const store = Buffer.concat([header, body])
    const sha = createHash('sha1').update(store).digest('hex')
    const file = this.objectPath(sha)
    if (!existsSync(file)) {
      mkdirSync(join(this.root, 'objects', sha.slice(0, 2)), { recursive: true })
      // Write-then-rename so a crash never leaves a truncated object that
      // another process could mistake for complete.
      const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
      writeFileSync(tmp, deflateSync(store))
      renameSync(tmp, file)
    }
    return sha
  }

  private readLooseOrThrow(sha: string): LooseHeader {
    const raw = (() => {
      try {
        return inflateSync(readFileSync(this.objectPath(sha)))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ObjectNotFoundError(sha)
        throw err
      }
    })()
    const nul = raw.indexOf(0)
    if (nul === -1) throw new InvalidObjectError(`malformed object ${sha}`)
    const header = raw.subarray(0, nul).toString('utf8')
    const space = header.indexOf(' ')
    const type = header.slice(0, space) as ObjectType
    if (!['blob', 'tree', 'commit', 'tag'].includes(type)) {
      throw new InvalidObjectError(`unknown object type '${type}' for ${sha}`)
    }
    const body = raw.subarray(nul + 1)
    if (body.length !== Number(header.slice(space + 1))) {
      throw new InvalidObjectError(`object ${sha} size mismatch`)
    }
    return { type, body }
  }

  objectType(sha: string): ObjectType {
    return this.readLooseOrThrow(validateSha(sha)).type
  }

  readBlob(sha: string): Buffer {
    const obj = this.readLooseOrThrow(validateSha(sha))
    if (obj.type !== 'blob') throw new InvalidObjectError(`${sha} is a ${obj.type}, not a blob`)
    return obj.body
  }

  writeBlob(content: Buffer | string): string {
    return this.writeObject('blob', typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
  }

  // -- trees --------------------------------------------------------------------

  readTree(treeSha: string): Array<TreeEntryParsed> {
    const obj = this.readLooseOrThrow(validateSha(treeSha))
    if (obj.type !== 'tree') throw new InvalidObjectError(`${treeSha} is a ${obj.type}, not a tree`)
    return parseTreeBody(obj.body)
  }

  /**
   * Builds arbitrarily deep trees from flat paths (implicit directories),
   * writing any missing blobs. Entries sorted per git tree order.
   */
  writeTreeFromFiles(files: Array<FlatFileInput>): string {
    const inputs = files.map((f) => ({
      path: f.path,
      mode: f.mode ?? '100644' as const,
      sha: this.writeBlob(f.content),
    }))
    return this.writeTreeFromShas(inputs)
  }

  /** Builds trees from already-written blob SHAs (no byte re-buffering). */
  writeTreeFromShas(entries: Array<ShaEntryInput>): string {
    const root: DirNode = { files: [], dirs: new Map() }
    for (const e of entries) {
      const segments = e.path.split('/')
      let node = root
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i]!
        let child = node.dirs.get(seg)
        if (!child) {
          child = { files: [], dirs: new Map() }
          node.dirs.set(seg, child)
        }
        node = child
      }
      node.files.push({ mode: e.mode, name: segments[segments.length - 1]!, sha: e.sha })
    }
    return this.writeTreeLevel(root)
  }

  private writeTreeLevel(node: DirNode): string {
    const entries: Array<{ mode: '100644' | '100755' | '40000'; name: string; sha: string }> = [
      ...node.files.map((f) => ({ mode: f.mode, name: f.name, sha: f.sha })),
      ...[...node.dirs.entries()].map(([name, child]) => ({
        mode: '40000' as const,
        name,
        sha: this.writeTreeLevel(child),
      })),
    ]
    entries.sort((a, b) =>
      Buffer.compare(
        Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8'),
        Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8'),
      ),
    )
    const chunks = entries.map((e) =>
      Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(e.sha, 'hex')]),
    )
    return this.writeObject('tree', Buffer.concat(chunks))
  }

  /** Recursively flattens a tree: path → {mode, blobSha}. Reads no blob bytes. */
  flattenTree(treeSha: string, prefix = ''): Map<string, { mode: FileMode; sha: string }> {
    const out = new Map<string, { mode: FileMode; sha: string }>()
    for (const entry of this.readTree(treeSha)) {
      if (entry.mode.startsWith('4')) {
        for (const [p, e] of this.flattenTree(entry.sha, `${prefix}${entry.name}/`)) out.set(p, e)
      } else {
        out.set(prefix + entry.name, {
          mode: entry.mode === '100755' ? '100755' : '100644',
          sha: entry.sha,
        })
      }
    }
    return out
  }

  readFileAt(treeSha: string, path: string): Buffer | null {
    const segments = path.split('/')
    let current: string = validateSha(treeSha)
    for (let i = 0; i < segments.length - 1; i++) {
      const entry = this.readTree(current).find((e) => e.name === segments[i])
      if (!entry || !entry.mode.startsWith('4')) return null
      current = entry.sha
    }
    const leaf = this.readTree(current).find((e) => e.name === segments[segments.length - 1])
    if (!leaf || leaf.mode.startsWith('4')) return null
    return this.readBlob(leaf.sha)
  }

  // -- commits ---------------------------------------------------------------

  writeCommit(opts: WriteCommitOptions): string {
    const ts = opts.timestamp ?? { time: Math.floor(Date.now() / 1000), timezone: localTimezoneOffset() }
    const tz = ts.timezone ?? '+0000'
    const ident = (i: CommitIdentity) => `${sanitizeIdentName(i.name)} <${sanitizeIdentEmail(i.email)}> ${ts.time} ${tz}`
    const parentLines = opts.parents.map((p) => `parent ${validateSha(p)}\n`).join('')
    const body = Buffer.from(
      `tree ${validateSha(opts.tree)}\n` +
        parentLines +
        `author ${ident(opts.author)}\n` +
        `committer ${ident(opts.committer ?? opts.author)}\n\n` +
        `${opts.message.trimEnd()}\n`,
      'utf8',
    )
    return this.writeObject('commit', body)
  }

  readCommit(sha: string): ParsedCommit {
    const full = validateSha(sha)
    const obj = this.readLooseOrThrow(full)
    if (obj.type !== 'commit') throw new InvalidObjectError(`${full} is a ${obj.type}, not a commit`)
    return parseCommitBody(obj.body, full)
  }

  /**
   * Walks commit history newest-first following parent links (BFS ordered by
   * committer time within each frontier batch). firstParent=true follows only
   * the first parent of each commit (linearized view, git log default).
   */
  history(tipSha: string, opts: { limit?: number; firstParent?: boolean } = {}): ParsedCommit[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 0), 10_000)
    const visited = new Set<string>()
    const out: ParsedCommit[] = []
    let frontier: ParsedCommit[] = [this.readCommit(tipSha)]
    while (frontier.length > 0 && out.length < limit) {
      frontier.sort((a, b) => b.committer.timestamp.time - a.committer.timestamp.time)
      const nextFrontier: ParsedCommit[] = []
      for (const commit of frontier) {
        if (out.length >= limit) break
        if (visited.has(commit.sha)) continue
        visited.add(commit.sha)
        out.push(commit)
        const wanted = opts.firstParent ? commit.parents.slice(0, 1) : commit.parents
        for (const p of wanted) {
          if (!visited.has(p)) nextFrontier.push(this.readCommit(p))
        }
      }
      frontier = nextFrontier
    }
    return out
  }

  /** True when `candidate` is reachable from `tip` (bounded walk, depth-capped). */
  isAncestor(candidate: string, tip: string, maxDepth = 10_000): boolean {
    const seen = new Set<string>([tip])
    let frontier = [tip]
    let depth = 0
    while (frontier.length > 0 && depth < maxDepth) {
      const next: string[] = []
      for (const sha of frontier) {
        if (sha === candidate) return true
        for (const p of this.readCommit(sha).parents) {
          if (!seen.has(p)) {
            seen.add(p)
            next.push(p)
          }
        }
      }
      frontier = next
      depth++
    }
    return false
  }

  // -- HEAD / default branch -----------------------------------------------

  headRef(): string {
    const content = readFileSync(join(this.root, 'HEAD'), 'utf8').trim()
    const m = /^ref: (.+)$/.exec(content)
    if (!m) throw new InvalidObjectError(`HEAD is detached (${content.slice(0, 64)})`)
    return m[1]!
  }

  defaultBranch(): string {
    return this.headRef().replace(/^refs\/heads\//, '')
  }

  setHeadTo(branch: string): void {
    validateBranchName(branch)
    atomicWriteFile(join(this.root, 'HEAD'), `ref: refs/heads/${branch}\n`)
  }

  // -- refs ------------------------------------------------------------------

  private lockPathFor(ref: string): string {
    return join(this.root, `${ref}.lock`)
  }

  private refFilePath(ref: string): string {
    return join(this.root, ...ref.split('/'))
  }

  /** Loose value only (no packed-refs consultation). */
  private readLoose(ref: string): string | null {
    try {
      const value = readFileSync(this.refFilePath(ref), 'utf8').trim()
      return SHA_RE.test(value) ? value : null
    } catch {
      return null
    }
  }

  private parsePackedRefs(): Map<string, string> {
    const out = new Map<string, string>()
    let raw: string
    try {
      raw = readFileSync(join(this.root, 'packed-refs'), 'utf8')
    } catch {
      return out
    }
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue
      const space = line.indexOf(' ')
      if (space === -1) continue
      const sha = line.slice(0, space)
      const name = line.slice(space + 1).trim()
      if (SHA_RE.test(sha) && name.startsWith('refs/')) out.set(name, sha)
    }
    return out
  }

  /**
   * Resolves a ref: loose file wins over packed-refs (git semantics).
   * Symbolic refs (HEAD) resolve through their target chain (bounded).
   */
  readRef(refRaw: string): string | null {
    let ref = validateRefName(refRaw)
    for (let hops = 0; hops < 5; hops++) {
      const loose = this.readLoose(ref)
      if (loose) return loose
      const packed = this.parsePackedRefs().get(ref)
      if (packed) return packed
      // Symbolic? Only meaningful outside refs/* (HEAD); refs/* are direct.
      break
    }
    void ref
    return null
  }

  /**
   * Atomic ref update with optimistic concurrency control.
   *
   * expectedOld semantics (git update-ref parity):
   *   - undefined  → unconditional overwrite/create
   *   - null       → ref MUST NOT exist (create-only)
   *   - '<sha>'    → ref MUST currently equal this value
   *
   * Implementation: O_EXCL lock file → verify current value under the lock →
   * stage content → single rename onto the final path. Readers never see a
   * torn write; racing writers fail with RefLockError/RefConflictError rather
   * than silently losing updates.
   */
  updateRef(refRaw: string, newSha: string, expectedOld?: string | null): RefUpdateResult {
    const ref = validateRefName(refRaw)
    validateSha(newSha)
    const finalPath = this.refFilePath(ref)
    const lockPath = this.lockPathFor(ref)
    mkdirSync(dirname(finalPath), { recursive: true })

    this.breakStaleLock(lockPath)

    let fd: number
    try {
      fd = openSync(lockPath, 'wx')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new RefLockError(ref)
      throw err
    }
    try {
      const current = this.currentValueLocked(ref)
      if (expectedOld !== undefined && current !== expectedOld) {
        throw new RefConflictError(ref, current, expectedOld ?? null)
      }
      writeSync(fd, `${newSha}\n`)
      closeSync(fd)
      fd = -1
      renameSync(lockPath, finalPath)
      return { ref, old: current, new: newSha }
    } finally {
      if (fd >= 0) {
        try { closeSync(fd) } catch { /* already closed */ }
      }
      rmLockQuietly(lockPath)
    }
  }

  deleteRef(refRaw: string, expectedOld?: string | null): void {
    const ref = validateRefName(refRaw)
    const finalPath = this.refFilePath(ref)
    const lockPath = this.lockPathFor(ref)
    this.breakStaleLock(lockPath)
    let fd: number
    try {
      fd = openSync(lockPath, 'wx')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new RefLockError(ref)
      throw err
    }
    try {
      closeSync(fd)
      fd = -1
      const current = this.currentValueLocked(ref)
      if (current === null) throw new RefValidationError(`Ref '${ref}' does not exist`)
      if (expectedOld !== undefined && current !== expectedOld) {
        throw new RefConflictError(ref, current, expectedOld ?? null)
      }
      // Remove loose file…
      try { unlinkSync(finalPath) } catch { /* was packed-only */ }
      // …and scrub the packed-refs entry while still holding the lock.
      const packed = this.parsePackedRefs()
      if (packed.has(ref)) {
        packed.delete(ref)
        const lines: string[] = ['# pack-refs with: peeled fully-peeled sorted \n']
        const sorted = [...packed.entries()].sort(([a], [b]) => a.localeCompare(b))
        for (const [name, sha] of sorted) lines.push(`${sha} ${name}\n`)
        atomicWriteFile(join(this.root, 'packed-refs'), lines.join(''))
      }
    } finally {
      rmLockQuietly(lockPath)
    }
  }

  /** Value of the ref as seen while holding its lock (loose then packed). */
  private currentValueLocked(ref: string): string | null {
    const loose = this.readLoose(ref)
    if (loose) return loose
    return this.parsePackedRefs().get(ref) ?? null
  }

  private breakStaleLock(lockPath: string): void {
    try {
      const age = Date.now() - statSync(lockPath).mtimeMs
      if (age > STALE_LOCK_MS) unlinkSync(lockPath)
    } catch { /* absent — nothing to break */ }
  }

  /** Lists refs under a prefix, merging packed-refs beneath loose values. */
  listRefs(prefix = 'refs/'): Array<{ name: string; sha: string }> {
    const merged = new Map<string, string>(this.parsePackedRefs())
    // Names are reported WITH their full ref path (e.g. refs/heads/main).
    const baseRel = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
    const walk = (dirAbs: string, relPrefix: string): void => {
      let items: string[]
      try {
        items = readdirSync(dirAbs)
      } catch {
        return
      }
      for (const item of items) {
        if (item.endsWith('.lock')) continue
        const abs = join(dirAbs, item)
        const rel = `${relPrefix}/${item}`
        if (statSync(abs).isDirectory()) {
          walk(abs, rel)
        } else {
          const value = readFileSync(abs, 'utf8').trim()
          if (SHA_RE.test(value)) merged.set(rel, value)
          else merged.delete(rel) // malformed loose entry shadows packed
        }
      }
    }
    walk(join(this.root, ...prefix.split('/')), baseRel)
    return [...merged.entries()]
      .filter(([name]) => name.startsWith(`${baseRel}/`) || name === baseRel)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, sha]) => ({ name, sha }))
  }

  listBranches(): Array<{ name: string; sha: string }> {
    return this.listRefs('refs/heads/').map((r) => ({ name: r.name.replace(/^refs\/heads\//, ''), sha: r.sha }))
  }

  listTags(): Array<{ name: string; sha: string }> {
    return this.listRefs('refs/tags/').map((r) => ({ name: r.name.replace(/^refs\/tags\//, ''), sha: r.sha }))
  }

  resolveBranch(branch: string): string | null {
    validateBranchName(branch)
    return this.readRef(`refs/heads/${branch}`)
  }

  resolveTag(tag: string): string | null {
    return this.readRef(`refs/tags/${validateTagName(tag)}`)
  }

  // -- tags -------------------------------------------------------------------

  createTag(opts: CreateTagOptions): TagInfo {
    const name = validateTagName(opts.name)
    const target = validateSha(opts.target)
    const targetType = this.objectType(target)
    const annotated = typeof opts.message === 'string' && opts.message.trim().length > 0 && !!opts.tagger
    let sha = target
    if (annotated) {
      const ts = opts.timestamp ?? { time: Math.floor(Date.now() / 1000), timezone: localTimezoneOffset() }
      const tz = ts.timezone ?? '+0000'
      const body = Buffer.from(
        `object ${target}\ntype ${targetType}\ntag ${name}\n` +
          `tagger ${sanitizeIdentName(opts.tagger!.name)} <${sanitizeIdentEmail(opts.tagger!.email)}> ${ts.time} ${tz}\n\n` +
          `${opts.message!.trimEnd()}\n`,
        'utf8',
      )
      sha = this.writeObject('tag', body)
    }
    this.updateRef(`refs/tags/${name}`, sha, null) // create-only
    return { name, annotated, sha, target, targetType, ...(opts.tagger ? { tagger: opts.tagger } : {}) }
  }

  readTagInfo(name: string): TagInfo | null {
    const clean = validateTagName(name)
    const sha = this.resolveTag(clean)
    if (!sha) return null
    const obj = this.readLooseOrThrow(sha)
    if (obj.type === 'tag') {
      const parsed = parseTagBody(obj.body)
      return {
        name: clean,
        annotated: true,
        sha,
        target: parsed.object,
        targetType: parsed.type,
        ...(parsed.tagger ? { tagger: parsed.tagger } : {}),
        ...(parsed.message ? { message: parsed.message } : {}),
      }
    }
    return { name: clean, annotated: false, sha, target: sha, targetType: obj.type }
  }

  // -- composite: atomic changeset application ----------------------------------

  /**
   * Applies a set of file changes to a branch in ONE atomic step:
   *
   *   base tip → merged tree → commit → CAS ref update
   *
   * The tip captured BEFORE tree construction doubles as the CAS expectation,
   * so a concurrent writer landing between read and write causes a
   * RefConflictError (409 upstream) instead of a lost update. Supports:
   *   - empty repositories (base tip null → parentless initial commit)
   *   - new branches (target ≠ base → create-only CAS on the target ref)
   */
  applyChangesToBranch(opts: ApplyChangesOptions): ApplyChangesResult {
    const targetRef = `refs/heads/${validateBranchName(opts.targetBranch)}`
    const previousTip =
      opts.targetBranch === opts.baseBranch
        ? this.resolveBranch(opts.baseBranch)
        : this.resolveBranch(opts.baseBranch)

    const baseEntries = previousTip
      ? this.flattenTree(this.readCommit(previousTip).tree)
      : new Map<string, { mode: FileMode; sha: string }>()

    const merged = new Map(baseEntries)
    const replacedPaths: string[] = []
    let changed = false
    for (const change of opts.changes) {
      const existing = baseEntries.get(change.path)
      const sha = change.sha ?? this.writeBlob(change.content ?? '')
      if (existing && existing.sha === sha && existing.mode === (change.mode ?? '100644')) continue // identical → no-op
      if (existing && opts.rejectOverwrite) {
        throw new RepositoryError(`'${change.path}' already exists on '${opts.targetBranch}'`, 'path_exists')
      }
      merged.set(change.path, { mode: change.mode ?? '100644', sha })
      if (existing) replacedPaths.push(change.path)
      changed = true
    }
    if (!changed) {
      throw new RepositoryError('No changes to commit — contents identical to the branch tip', 'empty_commit')
    }

    const treeSha = this.writeTreeFromShas(
      [...merged.entries()].map(([path, e]) => ({ path, mode: e.mode, sha: e.sha })),
    )
    const commitSha = this.writeCommit({
      tree: treeSha,
      parents: previousTip ? [previousTip] : [],
      message: opts.message,
      author: opts.identity,
    })

    // Creating a NEW branch: the target must not exist (create-only).
    // Same branch: expect the exact tip we built upon (lost-update guard).
    const creatingNewBranch = opts.targetBranch !== opts.baseBranch
    this.updateRef(targetRef, commitSha, creatingNewBranch ? null : previousTip)
    return {
      commitSha,
      treeSha,
      branch: opts.targetBranch,
      previousTip,
      createdBranch: creatingNewBranch,
      replacedPaths,
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface DirNode {
  files: Array<{ mode: FileMode; name: string; sha: string }>
  dirs: Map<string, DirNode>
}

function parseTreeBody(body: Buffer): Array<TreeEntryParsed> {
  const out: Array<TreeEntryParsed> = []
  let off = 0
  while (off < body.length) {
    const space = body.indexOf(0x20, off)
    const nul = body.indexOf(0x00, space)
    if (space === -1 || nul === -1) throw new InvalidObjectError('malformed tree entry')
    const mode = body.subarray(off, space).toString('ascii')
    const name = body.subarray(space + 1, nul).toString('utf8')
    const sha = body.subarray(nul + 1, nul + 21).toString('hex')
    out.push({ mode, name, sha })
    off = nul + 21
  }
  return out
}

function parseIdentLine(line: string): { identity: CommitIdentity; timestamp: CommitTimestamp } | null {
  const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line)
  if (!m) return null
  return {
    identity: { name: m[1]!, email: m[2]! },
    timestamp: { time: Number(m[3]), timezone: m[4] },
  }
}

function parseCommitBody(body: Buffer, sha: string): ParsedCommit {
  const text = body.toString('utf8')
  const headerEnd = text.indexOf('\n\n')
  const headerBlock = headerEnd === -1 ? text : text.slice(0, headerEnd)
  const message = headerEnd === -1 ? '' : text.slice(headerEnd + 2).replace(/\n$/, '')
  let tree: string | undefined
  const parents: string[] = []
  let author: ReturnType<typeof parseIdentLine> = null
  let committer: ReturnType<typeof parseIdentLine> = null
  for (const line of headerBlock.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5)
    else if (line.startsWith('parent ')) parents.push(line.slice(7))
    else if (line.startsWith('author ')) author = parseIdentLine(line.slice(7))
    else if (line.startsWith('committer ')) committer = parseIdentLine(line.slice(10))
  }
  if (!tree || !SHA_RE.test(tree)) throw new InvalidObjectError(`commit ${sha} has no valid tree`)
  if (!author || !committer) throw new InvalidObjectError(`commit ${sha} has malformed identity headers`)
  const fallbackTs: CommitTimestamp = { time: 0, timezone: '+0000' }
  return {
    sha,
    tree,
    parents,
    author: { identity: author.identity, timestamp: author.timestamp ?? fallbackTs },
    committer: { identity: committer.identity, timestamp: committer.timestamp ?? fallbackTs },
    message,
  }
}

function parseTagBody(body: Buffer): { object: string; type: ObjectType; tag: string; tagger?: CommitIdentity; message?: string } {
  const text = body.toString('utf8')
  const headerEnd = text.indexOf('\n\n')
  const headerBlock = headerEnd === -1 ? text : text.slice(0, headerEnd)
  const message = headerEnd === -1 ? undefined : text.slice(headerEnd + 2).replace(/\n$/, '')
  let object: string | undefined
  let type: string | undefined
  let tag: string | undefined
  let tagger: CommitIdentity | undefined
  for (const line of headerBlock.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7)
    else if (line.startsWith('type ')) type = line.slice(5)
    else if (line.startsWith('tag ')) tag = line.slice(4)
    else if (line.startsWith('tagger ')) tagger = parseIdentLine(line.slice(7))?.identity
  }
  if (!object || !SHA_RE.test(object) || !type || !tag) {
    throw new InvalidObjectError('malformed tag object')
  }
  return { object, type: type as ObjectType, tag, ...(tagger ? { tagger } : {}), ...(message ? { message } : {}) }
}

/** Branch-only validation (used where callers hand us a bare branch name). */
function validateBranchName(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 1000) {
    throw new RefValidationError('Branch name must be a non-empty string')
  }
  return validateRefName(`refs/heads/${name}`).slice('refs/heads/'.length)
}

function validateTagName(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 1000) {
    throw new RefValidationError('Tag name must be a non-empty string')
  }
  return validateRefName(`refs/tags/${name}`).slice('refs/tags/'.length)
}

function sanitizeIdentName(name: string): string {
  // git forbids < > and newline in ident names; collapse whitespace runs.
  const clean = name.replace(/[\u0000-\u001f<>]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (clean || 'LSGit User').slice(0, 255)
}

function sanitizeIdentEmail(email: string): string {
  const clean = email.replace(/[\u0000-\u001f<>\s]+/g, '').trim()
  return (clean || 'unknown@lsgit.local').slice(0, 254)
}

function atomicWriteFile(path: string, content: string): void {
  const dir = join(path, '..')
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${Math.random().toString(36).slice(2)}.tmp`)
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

function rmLockQuietly(lockPath: string): void {
  try { rmSync(lockPath, { force: true }) } catch { /* best effort */ }
}
