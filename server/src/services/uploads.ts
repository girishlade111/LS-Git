import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from './identity.js'
import type { IdentityServices } from './identity.js'
import type { AppConfig } from '../config.js'
import type { Actor } from '../authz.js'
import type { ProjectRow, UploadBatchRow } from '../db/store.js'
import {
  buildNestedTreeFromShas,
  commitTree,
  writeObject,
  loadTreeEntries,
  parseCommit,
  readObject,
} from '../storage/gitobjects.js'
import type { LocalHashedStorage } from '../storage/local.js'
import { validateRepoFilePath, sanitizeCommitMessage } from '../lib/pathsafe.js'
import { can } from '../authz.js'

/**
 * Upload pipeline (GitLab files-API / Web-IDE upload parity):
 *
 *   session request → authorization → path validation → temporary transfer
 *   → object/hash processing → ONE git commit per batch → branch ref update
 *   → event emission
 *
 * Two session shapes share the staging machinery:
 *   - Single file: initiate → PUT → commit (one file per commit).
 *   - Batch (folder/project upload): create-batch → N × (initiate+PUT) →
 *     finalize. The finalize step produces exactly one git commit and emits
 *     one durable event inside a single database transaction — files are NOT
 *     committed as independent transactions.
 *
 * The client path is never trusted for filesystem access: it is validated to a
 * relative slash-delimited repository path and used ONLY as git tree keys and
 * as an opaque bookkeeping value. All bytes land in server-controlled temp
 * files keyed by random UUIDs.
 */

export interface InitiateResult {
  uploadId: string
  filePath: string
  exists: boolean
}

export interface CommitOptions {
  branch?: string | null
  new_branch?: string | null
  start_branch?: string | null
  /** Required in practice; the service rejects missing/empty messages with 400. */
  commit_message?: string
  replace?: boolean
}

export interface CommitResult {
  file_path: string
  branch: string
  commit_sha: string
  replaced: boolean
  content_sha256: string
  merge_request: { created: false; reason: string }
}

export interface CreateBatchInput {
  file_count?: unknown
  total_bytes?: unknown
}

export interface CreateBatchResult {
  batchId: string
  limits: { max_file_bytes: number; max_batch_files: number; max_batch_total_bytes: number }
}

export interface FinalizeOptions extends CommitOptions {
  /** UI intent only — recorded in the response note; MRs land with the collaboration phase. */
  create_merge_request?: boolean
}

export interface FinalizeResult {
  batch_id: string
  branch: string
  commit_sha: string
  committed_files: number
  identical_skipped: number
  total_bytes: number
  merge_request: { created: false; reason: string }
}

export interface BatchStatusResult {
  batch_id: string
  state: UploadBatchRow['state']
  declared_files: number
  staged_files: number
  received_files: number
  cancelled_files: number
  received_bytes: number
}

const MAX_CONFLICT_LIST = 50

export class UploadService {
  constructor(
    private s: IdentityServices,
    private cfg: AppConfig,
    private storage: LocalHashedStorage,
  ) {}

  // -- authorization ---------------------------------------------------------

  private authorizePush(actor: Actor | null, project: ProjectRow): void {
    const ok = this.canPush(actor, project)
    if (!ok) {
      throw new AppError(
        actor ? 403 : 401,
        actor ? 'You are not allowed to push to this project' : 'Authentication required',
        actor ? 'forbidden' : 'unauthenticated',
      )
    }
  }

  private canPush(actor: Actor | null, project: ProjectRow): boolean {
    // Central authorization service owns the decision (PERMISSIONS boundary).
    return can(actor, 'project:push_code', {
      resourceProject: {
        ownerId: project.owner_id,
        visibility: project.visibility,
        archived: !!project.archived,
      },
    })
  }

  /** Protected-ref gate (PERMISSIONS.md §4–5). Exact names until glob support. */
  private authorizeRefPush(actor: Actor, project: ProjectRow, branch: string): void {
    const rule = this.s.protectedBranches.byName(project.id, branch)
    const allowed = this.s.protectedBranches.pushAllowed(
      actor.admin || actor.userId === project.owner_id,
      actor.admin,
      rule,
    )
    if (!allowed) {
      throw new AppError(
        403,
        `Branch '${branch}' is protected — push to an unprotected branch instead`,
        'protected_branch',
      )
    }
  }

  private resolveTargetBranches(project: ProjectRow, opts: CommitOptions): {
    targetBranch: string
    baseBranch: string
  } {
    const targetBranch = String(opts.new_branch ?? opts.branch ?? project.default_branch)
    const baseBranch = opts.new_branch ? String(opts.start_branch ?? project.default_branch) : targetBranch
    return { targetBranch, baseBranch }
  }

  private requireCommitMessage(opts: CommitOptions): string {
    const message = sanitizeCommitMessage(opts.commit_message)
    if (!message) throw new AppError(400, 'A commit message is required', 'validation_failed')
    return message
  }

  // -- batch sessions ----------------------------------------------------------

  /**
   * Opens a multi-file upload session. Limits are declared up-front so the UI
   * can pre-reject oversized queues before a single byte moves. Opportunistic
   * GC reclaims batches orphaned by browser refreshes / abandoned tabs.
   */
  createBatch(actor: Actor | null, projectId: number, input: CreateBatchInput): CreateBatchResult {
    const project = this.requireProject(projectId)
    this.authorizePush(actor, project)

    const fileCount = Number(input.file_count)
    const totalBytes = Number(input.total_bytes)
    if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > this.cfg.maxBatchFiles) {
      throw new AppError(
        413,
        `Batch must contain between 1 and ${this.cfg.maxBatchFiles} files`,
        'too_many_files',
      )
    }
    if (!Number.isInteger(totalBytes) || totalBytes < 0 || totalBytes > this.cfg.maxBatchTotalBytes) {
      throw new AppError(
        413,
        `Batch exceeds the ${Math.floor(this.cfg.maxBatchTotalBytes / 1024 / 1024)} MB total size limit`,
        'too_large',
      )
    }

    this.purgeStale()

    const id = randomUUID()
    this.s.uploadBatches.create({
      id,
      projectId: project.id,
      userId: actor!.userId,
      declaredFiles: fileCount,
      declaredBytes: totalBytes,
    })
    mkdirSync(this.cfg.uploadsRoot, { recursive: true })
    return {
      batchId: id,
      limits: {
        max_file_bytes: this.cfg.maxUploadBytes,
        max_batch_files: this.cfg.maxBatchFiles,
        max_batch_total_bytes: this.cfg.maxBatchTotalBytes,
      },
    }
  }

  batchStatus(actor: Actor | null, projectId: number, batchId: string): BatchStatusResult {
    const batch = this.requireBatch(batchId)
    if (batch.project_id !== projectId) throw new AppError(404, 'Upload batch not found')
    this.requireSameActor(actor, batch.user_id)
    const rows = this.s.uploads.listByBatch(batchId)
    return {
      batch_id: batch.id,
      state: batch.state,
      declared_files: batch.declared_files,
      staged_files: rows.length,
      received_files: rows.filter((r) => r.state === 'pending' && r.received_size > 0 && r.sha256).length,
      cancelled_files: rows.filter((r) => r.state === 'cancelled').length,
      received_bytes: rows.reduce((acc, r) => acc + (r.state === 'cancelled' ? 0 : r.received_size), 0),
    }
  }

  cancelBatch(actor: Actor | null, projectId: number, batchId: string): void {
    const batch = this.requireBatch(batchId)
    if (batch.project_id !== projectId) throw new AppError(404, 'Upload batch not found')
    this.requireSameActor(actor, batch.user_id)
    if (batch.state !== 'open') return // idempotent cancel
    for (const row of this.s.uploads.listByBatch(batchId)) {
      if (row.state === 'pending') {
        this.discardTemp(row.id)
        this.s.uploads.markCancelled(row.id)
      }
    }
    this.s.uploadBatches.setState(batchId, 'cancelled')
  }

  /**
   * Reclaims abandoned staging: open batches whose last activity predates the
   * TTL (typical cause: page refresh mid-upload). Temp bytes are destroyed and
   * rows terminalized so finalize can never resurrect them.
   */
  purgeStale(now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - this.cfg.staleUploadTtlMinutes * 60_000).toISOString()
    const stale = this.s.uploadBatches.staleOpenBefore(cutoff)
    for (const batch of stale) {
      for (const row of this.s.uploads.listByBatch(batch.id)) {
        if (row.state === 'pending') {
          this.discardTemp(row.id)
          this.s.uploads.markCancelled(row.id)
        }
      }
      this.s.uploadBatches.setState(batch.id, 'cancelled')
    }
    return stale.length
  }

  // -- steps 1–2: request + authorization + path validation --------------------

  initiate(
    actor: Actor | null,
    projectId: number,
    input: { file_path?: unknown; size?: unknown; start_branch?: unknown; batch_id?: unknown },
  ): InitiateResult {
    const project = this.requireProject(projectId)
    this.authorizePush(actor, project)

    const checked = validateRepoFilePath(input.file_path)
    if (!checked.ok) throw new AppError(400, checked.error, 'invalid_path')
    const filePath = checked.path

    const size = Number(input.size)
    if (!Number.isInteger(size) || size < 0) throw new AppError(400, 'Invalid file size', 'validation_failed')
    if (size > this.cfg.maxUploadBytes) {
      throw new AppError(413, `File exceeds the ${Math.floor(this.cfg.maxUploadBytes / 1024 / 1024)} MB limit`, 'too_large')
    }

    let batchId: string | null = null
    if (input.batch_id !== undefined && input.batch_id !== null && input.batch_id !== '') {
      const batch = this.s.uploadBatches.byId(String(input.batch_id))
      if (
        !batch ||
        batch.project_id !== project.id ||
        batch.user_id !== actor!.userId
      ) {
        throw new AppError(404, 'Upload batch not found')
      }
      if (batch.state !== 'open') {
        throw new AppError(409, 'Upload batch is no longer accepting files', 'batch_closed')
      }
      const staged = this.s.uploads.listByBatch(batch.id)
      if (staged.length >= batch.declared_files) {
        throw new AppError(413, 'Upload batch file count exceeded', 'too_many_files')
      }
      if (this.s.uploads.liveByBatchAndPath(batch.id, filePath)) {
        throw new AppError(
          409,
          `'${filePath}' is already staged in this upload batch`,
          'duplicate_in_batch',
        )
      }
      batchId = batch.id
    }

    const baseBranch =
      typeof input.start_branch === 'string' && input.start_branch
        ? input.start_branch
        : project.default_branch

    // Early conflict detection against the base ref (authoritative check repeats at commit).
    let exists = false
    try {
      const files = this.storage.readBranchFiles(project.disk_path, baseBranch)
      exists = files.has(filePath)
    } catch {
      exists = false // empty repository / missing ref
    }

    const id = randomUUID()
    this.s.uploads.create({
      id,
      projectId: project.id,
      userId: actor!.userId,
      filePath,
      declaredSize: size,
      batchId,
    })
    const tmp = this.tempPath(id)
    mkdirSync(this.cfg.uploadsRoot, { recursive: true })
    writeFileSync(tmp, Buffer.alloc(0))

    return { uploadId: id, filePath, exists }
  }

  // -- step 3–4: temporary upload + hash processing ------------------------------

  /** Stores (or re-stores — retry semantics) the bytes for a pending upload. */
  storeBytes(actor: Actor | null, projectId: number, uploadId: string, body: Buffer): { received: number; sha256: string } {
    const row = this.requirePendingRow(actor, projectId, uploadId)

    if (!Buffer.isBuffer(body)) throw new AppError(400, 'Expected raw octet-stream body')
    if (body.length > this.cfg.maxUploadBytes) {
      this.discardTemp(row.id)
      throw new AppError(413, `File exceeds the ${Math.floor(this.cfg.maxUploadBytes / 1024 / 1024)} MB limit`, 'too_large')
    }
    if ((row.declared_size ?? body.length) !== 0 && body.length !== row.declared_size) {
      // Declared size mismatch is allowed to be corrected by re-initiating; but an
      // exact mismatch here signals a truncated/extended transfer.
      throw new AppError(400, `Byte count does not match declared size (${row.declared_size})`, 'size_mismatch')
    }

    const sha256 = createHash('sha256').update(body).digest('hex')
    const tmp = `${this.tempPath(row.id)}.part`
    writeFileSync(tmp, body)
    renameSync(tmp, this.tempPath(row.id))
    this.s.uploads.markReceived(row.id, body.length, sha256)
    return { received: body.length, sha256 }
  }

  cancel(actor: Actor | null, projectId: number, uploadId: string): void {
    const row = this.s.uploads.byId(uploadId)
    if (!row || row.project_id !== projectId || (actor && row.user_id !== actor.userId && !actor.admin)) {
      throw new AppError(404, 'Upload not found')
    }
    this.discardTemp(row.id)
    this.s.uploads.markCancelled(row.id)
  }

  // -- single-file steps 5–9: blob → tree → commit → ref → event --------------------

  commit(actor: Actor | null, projectId: number, uploadId: string, opts: CommitOptions): CommitResult {
    const row = this.requirePendingRow(actor, projectId, uploadId)
    const project = this.requireProject(projectId)
    const message = this.requireCommitMessage(opts)
    const { targetBranch, baseBranch } = this.resolveTargetBranches(project, opts)

    // Temp bytes must exist and match the recorded hash ("object/hash processing").
    const tempPath = this.tempPath(row.id)
    if (!existsSync(tempPath) || row.state !== 'pending') {
      throw new AppError(404, 'Upload data is missing — retry the transfer', 'upload_missing')
    }
    const content = readFileSync(tempPath)
    if (row.sha256 === null || row.received_size !== content.length) {
      throw new AppError(404, 'Upload transfer incomplete — retry the upload', 'upload_missing')
    }
    const sha256 = createHash('sha256').update(content).digest('hex')
    if (row.sha256 && row.sha256 !== sha256) {
      throw new AppError(409, 'Uploaded data changed during transfer — retry the upload', 'hash_mismatch')
    }

    this.authorizeRefPush(actor!, project, targetBranch)

    const abs = join(this.cfg.repositoriesRoot, project.disk_path)
    const objectsDir = join(abs, 'objects')

    const result = this.applyCommit(objectsDir, abs, project, {
      actor: actor!,
      baseBranch,
      targetBranch,
      message,
      replace: !!opts.replace,
      changes: [{ path: row.file_path, content }],
    })

    this.db.transaction(() => {
      this.s.events.emit(project.id, 'repository.file_committed', {
        file_path: row.file_path,
        branch: targetBranch,
        commit_sha: result.commitSha,
        content_sha256_prefix: sha256.slice(0, 12),
        size: content.length,
        replaced: result.replacedPaths.includes(row.file_path),
        new_branch: opts.new_branch ? true : false,
        actor_user_id: actor!.userId,
      })
      this.s.projects.update(project.id, { last_activity_at: new Date().toISOString() })
    })
    this.s.audit.record({
      userId: actor!.userId,
      name: 'profile_updated',
      detail: { kind: 'repository_file_committed', project_id: project.id, path: row.file_path },
    })

    this.discardTemp(row.id)
    this.s.uploads.markCompleted(row.id)

    return {
      file_path: row.file_path,
      branch: targetBranch,
      commit_sha: result.commitSha,
      replaced: result.replacedPaths.length > 0,
      content_sha256: sha256,
      merge_request: {
        created: false,
        reason:
          'Merge requests arrive with the collaboration phase; your branch is ready on the instance.',
      },
    }
  }

  /**
   * Batch finalize: verifies every staged transfer, resolves replace conflicts,
   * streams each temp file into Git object storage one at a time, builds the
   * merged tree, creates ONE commit, and lands metadata/event/state changes in
   * a single database transaction.
   */
  finalizeBatch(actor: Actor | null, projectId: number, batchId: string, opts: FinalizeOptions): FinalizeResult {
    const batch = this.requireBatch(batchId)
    if (batch.project_id !== projectId) throw new AppError(404, 'Upload batch not found')
    this.requireSameActor(actor, batch.user_id)
    if (batch.state !== 'open') {
      throw new AppError(409, 'Upload batch was already finalized or cancelled', 'batch_closed')
    }
    const project = this.requireProject(projectId)
    const message = this.requireCommitMessage(opts)
    const { targetBranch, baseBranch } = this.resolveTargetBranches(project, opts)

    const rows = this.s.uploads.listByBatch(batchId)
    const pendingIncomplete = rows.filter((r) => r.state === 'pending' && !(r.sha256 && existsSync(this.tempPath(r.id))))
    if (pendingIncomplete.length > 0) {
      throw new AppError(
        409,
        `${pendingIncomplete.length} file(s) have not finished transferring — retry or remove them first`,
        'incomplete_batch',
        { pending_paths: pendingIncomplete.slice(0, MAX_CONFLICT_LIST).map((r) => r.file_path) },
      )
    }
    const included = rows.filter((r) => r.state === 'pending') // fully received
    if (included.length === 0) {
      throw new AppError(400, 'No files remain in this upload batch', 'empty_commit')
    }

    // Server-side re-validation of every path (defense in depth).
    for (const row of included) {
      const checked = validateRepoFilePath(row.file_path)
      if (!checked.ok || checked.path !== row.file_path) {
        throw new AppError(400, `Invalid staged path: ${row.file_path}`, 'invalid_path')
      }
    }

    this.authorizeRefPush(actor!, project, targetBranch)

    const abs = join(this.cfg.repositoriesRoot, project.disk_path)
    const objectsDir = join(abs, 'objects')

    // Resolve refs.
    const baseHead = this.resolveRef(abs, baseBranch)
    const targetHead = this.resolveRef(abs, targetBranch)
    if (targetBranch === baseBranch && !targetHead && !baseHead) {
      // Empty repository committing straight to the default branch is fine.
    } else if (!baseHead && targetBranch === baseBranch) {
      throw new AppError(400, `Source branch does not exist: ${baseBranch}`, 'branch_missing')
    }

    // Base tip contents as path → blob sha (no byte loading).
    const baseEntries = baseHead
      ? loadTreeEntries(objectsDir, parseCommit(readObject(objectsDir, baseHead).body).tree)
      : new Map<string, { mode: '100644' | '100755'; sha: string }>()

    // Replace-conflict resolution BEFORE any mutation.
    const conflicts: string[] = []
    if (!opts.replace) {
      for (const row of included) {
        if (baseEntries.has(row.file_path)) conflicts.push(row.file_path)
      }
      if (conflicts.length > 0) {
        throw new AppError(
          409,
          conflicts.length === 1
            ? `'${conflicts[0]}' already exists`
            : `${conflicts.length} files already exist in this branch`,
          'file_exists',
          { conflict_paths: conflicts.slice(0, MAX_CONFLICT_LIST), conflict_count: conflicts.length },
        )
      }
    }

    // Stream staged bytes into Git objects one file at a time; detect no-op
    // replacements via object identity (same blob sha ⇒ nothing to commit).
    const changes: Array<{ path: string; mode: '100644' | '100755'; sha: string }> = []
    const replacedPaths: string[] = []
    let identicalSkipped = 0
    let totalBytes = 0
    try {
      for (const row of included) {
        const content = readFileSync(this.tempPath(row.id))
        if (content.length !== row.received_size) {
          throw new AppError(409, `Staged data for '${row.file_path}' changed during upload`, 'hash_mismatch')
        }
        const header = Buffer.from(`blob ${content.length}\0`, 'utf8')
        const gitSha = createHash('sha1').update(header).update(content).digest('hex')
        totalBytes += content.length
        const existing = baseEntries.get(row.file_path)
        if (existing && existing.sha === gitSha) {
          identicalSkipped++
          continue
        }
        writeObject(objectsDir, 'blob', content)
        changes.push({ path: row.file_path, mode: '100644', sha: gitSha })
        if (existing) replacedPaths.push(row.file_path)
      }
    } catch (err) {
      // Staging stays intact so the client can retry finalize after fixing.
      if (err instanceof AppError) throw err
      throw new AppError(500, 'Failed to process uploaded files into Git objects')
    }
    if (changes.length === 0) {
      throw new AppError(400, 'Uploaded files are identical to the current branch — nothing to commit', 'empty_commit')
    }

    const result = this.applyCommitFromShas(objectsDir, abs, baseEntries, changes, {
      actor: actor!,
      baseBranch,
      targetBranch,
      message,
    })

    // ONE transaction: event outbox + activity + terminal state transitions.
    this.db.transaction(() => {
      this.s.events.emit(project.id, 'repository.files_committed', {
        branch: targetBranch,
        commit_sha: result.commitSha,
        file_count: changes.length,
        identical_skipped: identicalSkipped,
        replaced_count: replacedPaths.length,
        total_bytes: totalBytes,
        new_branch: opts.new_branch ? true : false,
        actor_user_id: actor!.userId,
      })
      this.s.projects.update(project.id, { last_activity_at: new Date().toISOString() })
      for (const row of included) this.s.uploads.markCompleted(row.id)
      this.s.uploadBatches.setState(batchId, 'completed')
    })
    this.s.audit.record({
      userId: actor!.userId,
      name: 'profile_updated',
      detail: { kind: 'repository_batch_committed', project_id: project.id, files: changes.length },
    })

    // Cleanup staged bytes only after success.
    for (const row of included) this.discardTemp(row.id)

    return {
      batch_id: batchId,
      branch: targetBranch,
      commit_sha: result.commitSha,
      committed_files: changes.length,
      identical_skipped: identicalSkipped,
      total_bytes: totalBytes,
      merge_request: {
        created: false,
        reason: opts.create_merge_request_requested
          ? 'Merge requests arrive with the collaboration phase — your branch is ready.'
          : 'Merge requests arrive with the collaboration phase; your branch is ready on the instance.',
      },
    }
  }

  // -- shared git plumbing ------------------------------------------------------

  private applyCommit(
    objectsDir: string,
    absRepo: string,
    project: ProjectRow,
    args: {
      actor: Actor
      baseBranch: string
      targetBranch: string
      message: string
      replace: boolean
      changes: Array<{ path: string; content: Buffer }>
    },
  ): { commitSha: string; replacedPaths: string[] } {
    const baseHead = this.resolveRef(absRepo, args.baseBranch)
    const targetHead = this.resolveRef(absRepo, args.targetBranch)
    if (args.targetBranch === args.baseBranch && !targetHead && !baseHead) {
      // empty repo
    } else if (!baseHead && args.targetBranch === args.baseBranch) {
      throw new AppError(400, `Source branch does not exist: ${args.baseBranch}`, 'branch_missing')
    }

    const baseEntries = baseHead
      ? loadTreeEntries(objectsDir, parseCommit(readObject(objectsDir, baseHead).body).tree)
      : new Map<string, { mode: '100644' | '100755'; sha: string }>()

    const changes: Array<{ path: string; mode: '100644' | '100755'; sha: string }> = []
    const replacedPaths: string[] = []
    for (const change of args.changes) {
      const existing = baseEntries.get(change.path)
      const gitSha = createHash('sha1')
        .update(Buffer.from(`blob ${change.content.length}\0`, 'utf8'))
        .update(change.content)
        .digest('hex')
      if (existing && existing.sha === gitSha && args.replace) {
        throw new AppError(400, 'The file contents are identical — nothing to commit', 'empty_commit')
      }
      if (existing && !args.replace) {
        throw new AppError(409, 'A file with this name already exists', 'file_exists')
      }
      writeObject(objectsDir, 'blob', change.content)
      changes.push({ path: change.path, mode: '100644', sha: gitSha })
      if (existing) replacedPaths.push(change.path)
    }
    if (changes.length === 0) {
      throw new AppError(400, 'The file contents are identical — nothing to commit', 'empty_commit')
    }

    const result = this.applyCommitFromShas(objectsDir, absRepo, baseEntries, changes, {
      actor: args.actor,
      baseBranch: args.baseBranch,
      targetBranch: args.targetBranch,
      message: args.message,
    })
    return { commitSha: result.commitSha, replacedPaths }
  }

  private applyCommitFromShas(
    objectsDir: string,
    absRepo: string,
    baseEntries: Map<string, { mode: '100644' | '100755'; sha: string }>,
    changes: Array<{ path: string; mode: '100644' | '100755'; sha: string }>,
    args: { actor: Actor; baseBranch: string; targetBranch: string; message: string },
  ): { commitSha: string } {
    const merged = new Map(baseEntries)
    for (const c of changes) merged.set(c.path, { mode: c.mode, sha: c.sha })
    const treeSha = buildNestedTreeFromShas(
      objectsDir,
      [...merged.entries()].map(([path, e]) => ({ path, mode: e.mode, sha: e.sha })),
    )

    const user = this.s.users.byId(args.actor.userId)!
    const baseHead = this.resolveRef(absRepo, args.baseBranch)
    const commitSha = commitTree(
      objectsDir,
      treeSha,
      args.message,
      { name: user.name ?? user.username, email: `${user.username}@users.lsgit.local` },
      baseHead ? [baseHead] : [],
    )
    // Branch ref update (atomic-ish: temp+rename within refs dir).
    this.writeRef(absRepo, args.targetBranch, commitSha)
    return { commitSha }
  }

  // -- plumbing ---------------------------------------------------------------------

  private requireSameActor(actor: Actor | null, userId: number): void {
    if (!actor || (actor.userId !== userId && !actor.admin)) {
      throw new AppError(actor ? 403 : 401, actor ? 'Not allowed to access this upload' : 'Authentication required')
    }
  }

  private requireBatch(batchId: string): UploadBatchRow {
    if (!/^[a-f0-9-]{36}$/.test(batchId)) throw new AppError(404, 'Upload batch not found')
    const batch = this.s.uploadBatches.byId(batchId)
    if (!batch) throw new AppError(404, 'Upload batch not found')
    return batch
  }

  private requirePendingRow(actor: Actor | null, projectId: number, uploadId: string) {
    const row = this.s.uploads.byId(uploadId)
    if (!row || row.project_id !== projectId) throw new AppError(404, 'Upload not found')
    if (!actor || (row.user_id !== actor.userId && !actor.admin)) {
      throw new AppError(403, 'Not allowed to access this upload')
    }
    return row
  }

  private discardTemp(id: string): void {
    const p = this.tempPath(id)
    try {
      rmSync(p, { force: true })
      rmSync(`${p}.part`, { force: true })
    } catch {
      /* best-effort */
    }
  }

  private tempPath(uploadId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(uploadId)) throw new AppError(400, 'Malformed upload id')
    return join(this.cfg.uploadsRoot, uploadId)
  }

  private resolveRef(absRepo: string, branch: string): string | null {
    const refFile = join(absRepo, 'refs', 'heads', branch)
    if (!existsSync(refFile)) return null
    return readFileSync(refFile, 'utf8').trim() || null
  }

  /** Writes refs/heads/<branch>, creating intermediate dirs for slashed branch names. */
  private writeRef(absRepo: string, branch: string, sha: string): void {
    const parts = branch.split('/')
    const dir = join(absRepo, 'refs', 'heads', ...parts.slice(0, -1))
    mkdirSync(dir, { recursive: true })
    const finalPath = join(dir, parts[parts.length - 1]!)
    const tmp = `${finalPath}.tmp-${randomUUID()}`
    writeFileSync(tmp, `${sha}\n`, 'utf8')
    renameSync(tmp, finalPath)
  }

  private requireProject(id: number): ProjectRow {
    const p = this.s.projects.byId(id)
    if (!p) throw new AppError(404, 'Project not found')
    return p
  }

  private get db() {
    return this.s.db
  }
}
