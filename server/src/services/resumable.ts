import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from './identity.js'
import type { IdentityServices } from './identity.js'
import type { AppConfig } from '../config.js'
import type { Actor } from '../authz.js'
import type {
  ProjectRow,
  UploadSessionItemRow,
  UploadSessionRow,
} from '../db/store.js'
import {
  buildNestedTreeFromShas,
  commitTree,
  loadTreeEntries,
  parseCommit,
  readObject,
  writeObject,
} from '../storage/gitobjects.js'
import type { LocalHashedStorage } from '../storage/local.js'
import type { UploadStagingStore } from '../storage/uploadstaging.js'
import { LocalChunkStore } from '../storage/uploadstaging.js'
import { validateRepoFilePath, sanitizeCommitMessage } from '../lib/pathsafe.js'
import { can } from '../authz.js'

/**
 * Resumable upload sessions — LSGit's headless transfer infrastructure
 * (UPLOADS.md). Independent of the visual upload UI.
 *
 * Flow:
 *   create session (+manifest) → authorize repository → create items
 *   → PUT chunks (bounded parallelism client-side, idempotent server-side)
 *   → verify (per-chunk + whole-file checksums) → finalize → git objects
 *   → ONE commit → events
 *
 * Guarantees:
 *  - Resume: GET chunk map tells a returning client exactly what is missing.
 *  - Idempotency: duplicate chunks are no-ops; duplicate finalization returns
 *    the original result; a DB unique index on committed_sha makes double
 *    commits impossible even across processes.
 *  - No partial commits: any unverified/failed item blocks the commit with a
 *    STRUCTURED per-item failure report — success is never faked.
 *  - Bounded damage: session TTL, per-user staging quota, per-item attempt
 *    caps and declared-size boundaries prevent infinite retries and storage
 *    exhaustion. Chunk bytes never enter PostgreSQL.
 */

export interface ManifestInput {
  file_path?: unknown
  size?: unknown
  mime?: unknown
  last_modified?: unknown
  sha256?: unknown
}

export interface CreateSessionInput {
  items?: unknown
  chunk_size?: unknown
}

export interface SessionLimits {
  max_file_bytes: number
  max_session_files: number
  max_session_total_bytes: number
  default_chunk_size: number
  min_chunk_size: number
}

export interface CreatedItemView {
  id: string
  file_path: string
  size: number
  mime: string
  chunk_size: number
  chunk_count: number
}

export interface CreateSessionResult {
  session_id: string
  state: 'open'
  expires_at: string
  chunk_size: number
  limits: SessionLimits
  items: CreatedItemView[]
}

export interface ItemFailureView {
  item_id: string
  file_path: string
  state: UploadSessionItemRow['state']
  failure_code: string | null
  failure_message: string | null
  attempts: number
  received_chunks: number
  chunk_count: number
}

export interface SessionStatusResult {
  session_id: string
  project_id: number
  state: UploadSessionRow['state']
  expires_at: string
  declared_files: number
  declared_bytes: number
  received_bytes: number
  received_chunks: number
  commit_sha: string | null
  branch: string | null
  items: Array<ItemFailureView & { size: number }>
}

export interface ChunkPutResult {
  item_id: string
  index: number
  duplicate: boolean
  received_chunks: number
  received_bytes: number
  chunk_count: number
  item_state: UploadSessionItemRow['state']
}

export interface ChunkMapResult {
  item_id: string
  file_path: string
  chunk_size: number
  chunk_count: number
  received_indices: number[]
  received_bytes: number
}

export interface FinalizeInput {
  commit_message?: unknown
  branch?: unknown
  new_branch?: unknown
  start_branch?: unknown
  replace?: unknown
  exclude?: unknown
}

export interface FinalizeSuccess {
  session_id: string
  state: 'committed'
  already_committed: boolean
  branch: string
  commit_sha: string
  committed_files: number
  replaced_count: number
  identical_skipped: number
  total_bytes: number
}

export interface FinalizeBlocked {
  code: 'session_incomplete' | 'empty_commit' | 'protected_branch' | 'file_exists' | 'branch_missing'
  message: string
  committed: false
  items?: ItemFailureView[]
  conflict_paths?: string[]
}

const UUID_RE = /^[a-f0-9-]{36}$/

export class ResumableUploadService {
  private staging: UploadStagingStore

  constructor(
    private s: IdentityServices,
    private cfg: AppConfig,
    storage: LocalHashedStorage,
    staging?: UploadStagingStore,
  ) {
    this.staging = staging ?? new LocalChunkStore(join(cfg.uploadsRoot, 'resumable'))
    void storage // repository access flows through s.projects.storage at finalize
  }

  // -- authorization -------------------------------------------------------------

  private requireProject(projectId: number): ProjectRow {
    const p = this.s.projects.byId(projectId)
    if (!p) throw new AppError(404, 'Project not found')
    return p
  }

  private authorizePush(actor: Actor | null, project: ProjectRow): void {
    const ok = can(actor, 'project:push_code', {
      resourceProject: {
        ownerId: project.owner_id,
        visibility: project.visibility,
        archived: !!project.archived,
      },
    })
    if (!ok) {
      throw new AppError(
        actor ? 403 : 401,
        actor ? 'You are not allowed to push to this project' : 'Authentication required',
        actor ? 'forbidden' : 'unauthenticated',
      )
    }
  }

  /** Every operation is scoped to the owning user (admins excepted). */
  private requireSessionAccess(actor: Actor | null, projectId: number, sid: string): UploadSessionRow {
    if (!UUID_RE.test(sid)) throw new AppError(404, 'Upload session not found')
    const session = this.s.uploadSessions.byId(sid)
    if (!session || session.project_id !== projectId) throw new AppError(404, 'Upload session not found')
    if (!actor || (actor.userId !== session.user_id && !actor.admin)) {
      throw new AppError(actor ? 403 : 401, 'Not allowed to access this upload session')
    }
    return session
  }

  private authorizeRefPush(actor: Actor, project: ProjectRow, branch: string): void {
    const rule = this.s.protectedBranches.byName(project.id, branch)
    const allowed = this.s.protectedBranches.pushAllowed(
      actor.admin || actor.userId === project.owner_id,
      actor.admin,
      rule,
    )
    if (!allowed) {
      throw new AppError(403, `Branch '${branch}' is protected — push to an unprotected branch instead`, 'protected_branch', {
        code: 'protected_branch',
      })
    }
  }

  // -- lifecycle -------------------------------------------------------------------

  async createSession(actor: Actor | null, projectId: number, input: CreateSessionInput): Promise<CreateSessionResult> {
    const project = this.requireProject(projectId)
    this.authorizePush(actor, project)

    const rawItems = Array.isArray(input.items) ? input.items : []
    if (rawItems.length === 0) throw new AppError(400, 'Manifest must contain at least one item', 'validation_failed')
    if (rawItems.length > this.cfg.maxSessionFiles) {
      throw new AppError(413, `A session may contain at most ${this.cfg.maxSessionFiles} files`, 'too_many_files')
    }

    let chunkSize = Number(input.chunk_size ?? this.cfg.defaultChunkSize)
    if (!Number.isInteger(chunkSize)) throw new AppError(400, 'chunk_size must be an integer', 'validation_failed')
    chunkSize = Math.min(Math.max(chunkSize, this.cfg.minChunkSize), this.cfg.maxUploadBytes)

    const seenPaths = new Set<string>()
    let declaredBytes = 0
    for (const raw of rawItems as ManifestInput[]) {
      const checked = validateRepoFilePath(raw.file_path)
      if (!checked.ok) throw new AppError(400, checked.error, 'invalid_path')
      if (seenPaths.has(checked.path)) {
        throw new AppError(409, `'${checked.path}' appears twice in the manifest`, 'duplicate_in_session')
      }
      seenPaths.add(checked.path)

      const size = Number(raw.size)
      if (!Number.isInteger(size) || size < 0) throw new AppError(400, `Invalid size for '${checked.path}'`, 'validation_failed')
      if (size > this.cfg.maxUploadBytes) {
        throw new AppError(
          413,
          `'${checked.path}' exceeds the ${Math.floor(this.cfg.maxUploadBytes / 1024 / 1024)} MB per-file limit`,
          'too_large',
        )
      }
      if (raw.sha256 !== undefined && raw.sha256 !== null && !/^[a-f0-9]{64}$/.test(String(raw.sha256))) {
        throw new AppError(400, `Invalid sha256 for '${checked.path}'`, 'validation_failed')
      }
      declaredBytes += size
    }
    if (declaredBytes > this.cfg.maxSessionTotalBytes) {
      throw new AppError(
        413,
        `Manifest totals ${Math.floor(declaredBytes / 1024 / 1024)} MB — above the ${Math.floor(this.cfg.maxSessionTotalBytes / 1024 / 1024)} MB session limit`,
        'too_large',
      )
    }

    // Storage exhaustion guard: cap DECLARED bytes across all open sessions per user.
    const openBytes = this.s.uploadSessions.openDeclaredBytesForUser(actor!.userId)
    if (openBytes + declaredBytes > this.cfg.maxUserStagingBytes) {
      throw new AppError(
        413,
        'Staging quota exceeded — finish or cancel open upload sessions first',
        'storage_quota_exceeded',
      )
    }

    // Opportunistic housekeeping keeps abandoned staging from accumulating.
    this.purgeAbandoned()

    const sessionId = randomUUID()
    const expiresAt = new Date(Date.now() + this.cfg.uploadSessionTtlMinutes * 60_000).toISOString()
    this.s.db.transaction(() => {
      this.s.uploadSessions.create({
        id: sessionId,
        projectId: project.id,
        userId: actor!.userId,
        declaredFiles: rawItems.length,
        declaredBytes,
        expiresAt,
      })
      this.s.uploadSessionItems.createBatch(
        sessionId,
        (rawItems as ManifestInput[]).map((raw) => {
          const path = String(raw.file_path).trim() // validated above via validateRepoFilePath
          const size = Number(raw.size)
          return {
            id: randomUUID(),
            filePath: path,
            size,
            mime: typeof raw.mime === 'string' && raw.mime ? raw.mime.slice(0, 255) : 'application/octet-stream',
            lastModified: Number.isFinite(Number(raw.last_modified)) ? Math.trunc(Number(raw.last_modified)) : null,
            sha256: raw.sha256 ? String(raw.sha256) : null,
            chunkSize,
            chunkCount: Math.max(1, Math.ceil(size / chunkSize)),
          }
        }),
      )
    })

    this.staging.initSession(sessionId)

    const rows = this.s.uploadSessionItems.listForSession(sessionId)
    return {
      session_id: sessionId,
      state: 'open',
      expires_at: expiresAt,
      chunk_size: chunkSize,
      limits: {
        max_file_bytes: this.cfg.maxUploadBytes,
        max_session_files: this.cfg.maxSessionFiles,
        max_session_total_bytes: this.cfg.maxSessionTotalBytes,
        default_chunk_size: this.cfg.defaultChunkSize,
        min_chunk_size: this.cfg.minChunkSize,
      },
      items: rows.map((r) => ({
        id: r.id,
        file_path: r.file_path,
        size: r.size,
        mime: r.mime,
        chunk_size: r.chunk_size,
        chunk_count: r.chunk_count,
      })),
    }
  }

  async getSession(actor: Actor | null, projectId: number, sid: string): Promise<SessionStatusResult> {
    const session = this.requireSessionAccess(actor, projectId, sid)
    if (this.expireIfDue(session)) throw expiredError()
    const items = this.s.uploadSessionItems.listForSession(sid)
    return {
      session_id: session.id,
      project_id: session.project_id,
      state: session.state,
      expires_at: session.expires_at,
      declared_files: session.declared_files,
      declared_bytes: session.declared_bytes,
      received_bytes: session.received_bytes,
      received_chunks: session.received_chunks,
      commit_sha: session.committed_sha,
      branch: session.committed_branch,
      items: items.map((r) => ({
        item_id: r.id,
        file_path: r.file_path,
        state: r.state,
        size: r.size,
        failure_code: r.failure_code,
        failure_message: r.failure_message,
        attempts: r.attempts,
        received_chunks: r.received_chunks,
        chunk_count: r.chunk_count,
      })),
    }
  }

  async getChunkMap(actor: Actor | null, projectId: number, sid: string, itemId: string): Promise<ChunkMapResult> {
    const session = this.requireSessionAccess(actor, projectId, sid)
    if (this.expireIfDue(session)) throw expiredError()
    const item = this.requireItem(sid, itemId)
    const chunks = await this.staging.listChunks(sid, itemId)
    return {
      item_id: item.id,
      file_path: item.file_path,
      chunk_size: item.chunk_size,
      chunk_count: item.chunk_count,
      received_indices: chunks.map((c) => c.index),
      received_bytes: chunks.reduce((acc, c) => acc + c.size, 0),
    }
  }

  cancel(actor: Actor | null, projectId: number, sid: string): void {
    const session = this.requireSessionAccess(actor, projectId, sid)
    if (session.state !== 'open') return // idempotent
    this.s.uploadSessions.setState(sid, 'cancelled')
    this.staging.discardSession(sid)
  }

  // -- chunk transfer ----------------------------------------------------------------

  async putChunk(
    actor: Actor | null,
    projectId: number,
    sid: string,
    itemId: string,
    indexRaw: string,
    body: Buffer,
    opts: { declaredSha256?: string | undefined },
  ): Promise<ChunkPutResult> {
    const session = this.requireSessionAccess(actor, projectId, sid)
    if (this.expireIfDue(session)) throw expiredError()
    if (session.state !== 'open') throw closedError(session.state)
    const item = this.requireItem(sid, itemId)
    if (item.state === 'failed' || item.state === 'skipped') {
      throw new AppError(409, `Item '${item.file_path}' can no longer receive chunks (${item.failure_code ?? item.state})`, 'item_closed')
    }

    const index = Number(indexRaw)
    if (!Number.isInteger(index) || index < 0 || index >= item.chunk_count) {
      throw new AppError(400, `Chunk index must be within [0, ${item.chunk_count})`, 'chunk_index_out_of_range')
    }

    // Declared-size boundary: every full chunk is chunk_size; the last takes the remainder.
    const expected = index === item.chunk_count - 1
      ? item.size - item.chunk_size * (item.chunk_count - 1)
      : item.chunk_size
    if (body.length !== expected) {
      return this.rejectAttempt(item, 'chunk_size_mismatch', `Chunk ${index} must be exactly ${expected} bytes`)
    }

    // Per-chunk integrity: client-declared checksum verified before acceptance.
    const actualSha = createHash('sha256').update(body).digest('hex')
    if (opts.declaredSha256 && opts.declaredSha256.toLowerCase() !== actualSha) {
      return this.rejectAttempt(item, 'chunk_checksum_mismatch', `Checksum mismatch for chunk ${index}`)
    }

    const result = await this.staging.putChunk(sid, itemId, index, body)
    if (!result.duplicate) {
      this.s.uploadSessionItems.recordChunk(item.id, body.length)
    }
    const fresh = this.s.uploadSessionItems.byId(item.id)!
    return {
      item_id: item.id,
      index,
      duplicate: result.duplicate,
      received_chunks: fresh.received_chunks,
      received_bytes: fresh.received_bytes,
      chunk_count: fresh.chunk_count,
      item_state: fresh.state,
    }
  }

  /** Checksum/size violations consume an attempt; past the cap the item dies. */
  private rejectAttempt(item: UploadSessionItemRow, code: string, message: string): never {
    if (item.attempts + 1 >= this.cfg.maxAttemptsPerItem) {
      this.s.uploadSessionItems.failItem(item.id, 'too_many_attempts', message)
      throw new AppError(409, `Item '${item.file_path}' failed permanently: ${message}`, 'too_many_attempts', {
        code: 'too_many_attempts',
        item_id: item.id,
        failure_code: 'too_many_attempts',
      })
    }
    this.s.uploadSessionItems.bumpAttempts(item.id, code, message)
    throw new AppError(422, message, code, { code, item_id: item.id })
  }

  // -- finalize -------------------------------------------------------------------------

  async finalize(actor: Actor | null, projectId: number, sid: string, opts: FinalizeInput): Promise<FinalizeSuccess> {
    const session = this.requireSessionAccess(actor, projectId, sid)
    const project = this.requireProject(projectId)

    // Idempotent replay: a committed session re-reports its original result.
    if (session.state === 'committed') {
      return this.replayCommit(session)
    }
    if (this.expireIfDue(session)) throw expiredError()
    if (session.state !== 'open') throw closedError(session.state)

    const message = sanitizeCommitMessage(opts.commit_message)
    if (!message) throw new AppError(400, 'A commit message is required', 'validation_failed')

    const targetBranch = String(opts.new_branch ?? opts.branch ?? project.default_branch)
    const baseBranch = opts.new_branch ? String(opts.start_branch ?? project.default_branch) : targetBranch
    const replace = opts.replace === true
    const excludeIds = Array.isArray(opts.exclude) ? opts.exclude.map(String) : []

    // Exclusions are explicit operator intent ("3 of 500 failed — ship the rest").
    const items = this.s.uploadSessionItems.listForSession(sid)
    const excluded = items.filter((i) => excludeIds.includes(i.id))
    if (excluded.length !== excludeIds.length) {
      throw new AppError(400, 'exclude references unknown items', 'validation_failed')
    }
    if (excluded.length > 0) this.s.uploadSessionItems.markSkipped(excluded.map((i) => i.id))
    const included = items.filter((i) => !excludeIds.includes(i.id))
    if (included.length === 0) {
      throw new AppError(400, 'No items remain in this session', 'empty_commit')
    }

    this.authorizeRefPush(actor!, project, targetBranch)

    // ---- verification pass: NOTHING mutates the repository until every item passes.
    const failures: ItemFailureView[] = []
    const assembled = new Map<string, Buffer>()
    const stagedShas = new Map<string, { mode: '100644' | '100755'; sha: string }>()
    let identicalSkipped = 0
    let replacedCount = 0
    let totalBytes = 0

    const abs = join(this.cfg.repositoriesRoot, project.disk_path)
    const objectsDir = join(abs, 'objects')
    const baseHead = resolveRef(abs, baseBranch)
    const targetHead = resolveRef(abs, targetBranch)
    if (!(targetBranch === baseBranch && !targetHead && !baseHead) && !baseHead && targetBranch === baseBranch) {
      throw new AppError(400, `Source branch does not exist: ${baseBranch}`, 'branch_missing')
    }
    const baseEntries = baseHead
      ? loadTreeEntries(objectsDir, parseCommit(readObject(objectsDir, baseHead).body).tree)
      : new Map<string, { mode: '100644' | '100755'; sha: string }>()

    const conflicts: string[] = []
    if (!replace) {
      for (const item of included) {
        if (baseEntries.has(item.file_path)) conflicts.push(item.file_path)
      }
      if (conflicts.length > 0) {
        throw new AppError(
          409,
          conflicts.length === 1 ? `'${conflicts[0]}' already exists` : `${conflicts.length} files already exist in this branch`,
          'file_exists',
          { code: 'file_exists', conflict_paths: conflicts.slice(0, 50), conflict_count: conflicts.length },
        )
      }
    }

    try {
      for (const item of included) {
        const problem = await this.verifyItem(sid, item)
        if (problem) {
          failures.push(problem)
          continue
        }
        const { buffer, sha256 } = await this.staging.assemble(sid, item.id)
        if (buffer.length !== item.size) {
          failures.push(failureView(item, 'size_mismatch', `Assembled ${buffer.length} bytes, expected ${item.size}`))
          continue
        }
        if (item.sha256 && item.sha256 !== sha256) {
          failures.push(failureView(item, 'sha256_mismatch', 'Assembled content does not match the declared checksum'))
          continue
        }
        const header = Buffer.from(`blob ${buffer.length}\0`, 'utf8')
        const gitSha = createHash('sha1').update(header).update(buffer).digest('hex')
        const existing = baseEntries.get(item.file_path)
        if (existing && existing.sha === gitSha) {
          identicalSkipped += 1
          continue
        }
        assembled.set(item.file_path, buffer)
        stagedShas.set(item.file_path, { mode: '100644', sha: gitSha })
        if (existing) replacedCount += 1
        totalBytes += buffer.length
      }
    } catch (err) {
      // Staging remains intact — the caller can repair and retry verification.
      if (err instanceof AppError) throw err
      throw new AppError(500, 'Failed to process uploaded files during verification')
    }

    if (failures.length > 0) {
      // STRUCTURED failure: never pretend a partially-verified session succeeded.
      throw new AppError(
        409,
        `${failures.length} of ${included.length} item(s) are not ready — nothing was committed`,
        'session_incomplete',
        { code: 'session_incomplete', items: failures },
      )
    }
    if (assembled.size === 0) {
      throw new AppError(400, 'All uploaded files are identical to the branch — nothing to commit', 'empty_commit')
    }

    // ---- git mutation: blobs (already buffered by verification) → tree → commit → ref.
    for (const [path, content] of assembled) {
      writeObject(objectsDir, 'blob', content)
    }
    const merged = new Map(baseEntries)
    for (const [path, entry] of stagedShas) merged.set(path, entry)
    const treeSha = buildNestedTreeFromShas(
      objectsDir,
      [...merged.entries()].map(([path, e]) => ({ path, mode: e.mode, sha: e.sha })),
    )
    const user = this.s.users.byId(actor!.userId)!
    const commitSha = commitTree(
      objectsDir,
      treeSha,
      message,
      { name: user.name ?? user.username, email: `${user.username}@users.lsgit.local` },
      baseHead ? [baseHead] : [],
    )
    writeRef(abs, targetBranch, commitSha)

    const committedIds = included.filter((i) => !failures.some((f) => f.item_id === i.id)).map((i) => i.id)
    this.s.db.transaction(() => {
      this.s.uploadSessions.markCommitted(session.id, {
        branch: targetBranch,
        sha: commitSha,
        files: stagedShas.size,
      })
      this.s.uploadSessionItems.markVerified(committedIds)
      this.s.events.emit(project.id, 'repository.files_committed', {
        session_id: session.id,
        branch: targetBranch,
        commit_sha: commitSha,
        file_count: stagedShas.size,
        identical_skipped: identicalSkipped,
        replaced_count: replacedCount,
        total_bytes: totalBytes,
        new_branch: opts.new_branch ? true : false,
        actor_user_id: actor!.userId,
      })
      this.s.projects.update(project.id, { last_activity_at: new Date().toISOString() })
    })
    this.s.audit.record({
      userId: actor!.userId,
      name: 'profile_updated',
      detail: { kind: 'upload_session_committed', project_id: project.id, files: stagedShas.size, session_id: session.id },
    })

    // Storage lifecycle: staging bytes are garbage the moment the commit lands.
    this.staging.discardSession(sid)

    return {
      session_id: sid,
      state: 'committed',
      already_committed: false,
      branch: targetBranch,
      commit_sha: commitSha,
      committed_files: stagedShas.size,
      replaced_count: replacedCount,
      identical_skipped: identicalSkipped,
      total_bytes: totalBytes,
    }
  }

  private replayCommit(session: UploadSessionRow): FinalizeSuccess {
    const items = this.s.uploadSessionItems.listForSession(session.id)
    return {
      session_id: session.id,
      state: 'committed',
      already_committed: true,
      branch: session.committed_branch ?? '',
      commit_sha: session.committed_sha ?? '',
      committed_files: session.committed_files ?? items.filter((i) => i.state === 'verified').length,
      replaced_count: 0,
      identical_skipped: 0,
      total_bytes: session.declared_bytes,
    }
  }

  /**
   * Authoritative completeness check straight from the store: exact chunk set,
   * exact boundary sizes. Returns a structured failure view or null when the
   * item is byte-complete (assembly + whole-file checksum happen next).
   */
  private async verifyItem(sid: string, item: UploadSessionItemRow): Promise<ItemFailureView | null> {
    const chunks = await this.staging.listChunks(sid, item.id)
    if (chunks.length !== item.chunk_count) {
      return failureView(item, 'incomplete_transfer', `${chunks.length}/${item.chunk_count} chunks received`)
    }
    for (let i = 0; i < item.chunk_count; i++) {
      const found = chunks.find((c) => c.index === i)
      if (!found) {
        return failureView(item, 'incomplete_transfer', `Chunk ${i} missing`)
      }
      const expected = i === item.chunk_count - 1
        ? item.size - item.chunk_size * (item.chunk_count - 1)
        : item.chunk_size
      if (found.size !== expected) {
        return failureView(item, 'chunk_size_mismatch', `Chunk ${i} is ${found.size} bytes, expected ${expected}`)
      }
    }
    return null
  }

  // -- cleanup -----------------------------------------------------------------------------

  /**
   * Abandonment sweep. Called opportunistically on session creation; wire to a
   * cron/worker timer for periodic execution (UPLOADS.md §Cleanup job).
   *  1. Open sessions past their hard TTL → state=expired, staging discarded.
   *  2. Orphaned staging directories with no DB row (crash leftovers) removed.
   */
  purgeAbandoned(now: Date = new Date()): { expiredSessions: number; orphanDirs: number } {
    let expiredSessions = 0
    for (const session of this.s.uploadSessions.openExpiredBefore(now.toISOString())) {
      this.s.uploadSessions.setState(session.id, 'expired')
      this.staging.discardSession(session.id)
      expiredSessions += 1
    }

    let orphanDirs = 0
    const known = new Set<string>()
    for (const row of this.allKnownSessionIds()) known.add(row)
    for (const dirId of this.staging.listSessionIds()) {
      if (!known.has(dirId)) {
        this.staging.discardSession(dirId)
        orphanDirs += 1
      }
    }
    return { expiredSessions, orphanDirs }
  }

  private allKnownSessionIds(): string[] {
    const rows = this.s.db.all('SELECT id FROM upload_sessions') as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  /** Lazy expiry: an open session past its TTL terminalizes on first touch. */
  private expireIfDue(session: UploadSessionRow): boolean {
    if (session.state === 'open' && new Date(session.expires_at).getTime() <= Date.now()) {
      this.s.uploadSessions.setState(session.id, 'expired')
      this.staging.discardSession(session.id)
      return true
    }
    return false
  }

  private requireItem(sid: string, itemId: string): UploadSessionItemRow {
    if (!UUID_RE.test(itemId)) throw new AppError(404, 'Upload item not found')
    const item = this.s.uploadSessionItems.byId(itemId)
    if (!item || item.session_id !== sid) throw new AppError(404, 'Upload item not found')
    return item
  }
}

// -- module-scope helpers ------------------------------------------------------

const stagedShas = new Map<string, { mode: '100644' | '100755'; sha: string }>()

function failureView(
  item: UploadSessionItemRow,
  code: string,
  message: string,
): ItemFailureView {
  return {
    item_id: item.id,
    file_path: item.file_path,
    state: 'failed',
    failure_code: code,
    failure_message: message,
    attempts: item.attempts,
    received_chunks: item.received_chunks,
    chunk_count: item.chunk_count,
  }
}

function expiredError(): AppError {
  return new AppError(410, 'Upload session has expired — start a new session', 'session_expired')
}

function closedError(state: string): AppError {
  return new AppError(409, `Upload session is ${state} and no longer accepts transfers`, 'session_closed')
}

function resolveRef(absRepo: string, branch: string): string | null {
  const refFile = join(absRepo, 'refs', 'heads', branch)
  if (!existsSync(refFile)) return null
  return readFileSync(refFile, 'utf8').trim() || null
}

function writeRef(absRepo: string, branch: string, sha: string): void {
  const parts = branch.split('/')
  const dir = join(absRepo, 'refs', 'heads', ...parts.slice(0, -1))
  mkdirSync(dir, { recursive: true })
  const finalPath = join(dir, parts[parts.length - 1]!)
  const tmp = `${finalPath}.tmp-${randomUUID()}`
  writeFileSync(tmp, `${sha}\n`, 'utf8')
  renameSync(tmp, finalPath)
}
