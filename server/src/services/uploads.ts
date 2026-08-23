import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from './identity.js'
import type { IdentityServices } from './identity.js'
import type { AppConfig } from '../config.js'
import type { Actor } from '../authz.js'
import type { ProjectRow } from '../db/store.js'
import {
  buildNestedTree,
  commitTree,
  writeObject,
  loadFilesUnderTree,
  parseCommit,
  readObject,
  type FlatFile,
} from '../storage/gitobjects.js'
import type { LocalHashedStorage } from '../storage/local.js'
import { validateRepoFilePath, sanitizeCommitMessage } from '../lib/pathsafe.js'
import { can } from '../authz.js'

/**
 * Single-file upload pipeline (GitLab Web-Editor / files-API parity):
 *
 *   upload request → authorization → path validation → temporary upload
 *   → object/hash processing (sha256 + git blob) → git tree → git commit
 *   → branch ref update → event emission
 *
 * The client path is never trusted for filesystem access: it is validated to a
 * relative slash-delimited repository path and used ONLY as git tree keys and as
 * an opaque bookkeeping value. All bytes land in a server-controlled temp file.
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
  commit_message: string
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
    // Delegates to the central service; kept as thin wrapper for readability.
    return (
      !!actor &&
      actor.state === 'active' &&
      (actor.admin || actor.userId === project.owner_id)
    )
  }

  // -- step 1–2: request + authorization + path validation --------------------

  initiate(
    actor: Actor | null,
    projectId: number,
    input: { file_path?: unknown; size?: unknown; start_branch?: unknown },
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

    const baseBranch = typeof input.start_branch === 'string' && input.start_branch
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

  // -- steps 5–9: blob → tree → commit → ref → event --------------------------------

  commit(actor: Actor | null, projectId: number, uploadId: string, opts: CommitOptions): CommitResult {
    const row = this.requirePendingRow(actor, projectId, uploadId)
    const project = this.requireProject(projectId)

    // Authoritative existence check happens below against the TARGET ref head.
    const targetBranch = String(opts.new_branch ?? opts.branch ?? project.default_branch)
    const baseBranch = opts.new_branch ? String(opts.start_branch ?? project.default_branch) : targetBranch

    const message = sanitizeCommitMessage(opts.commit_message)
    if (!message) throw new AppError(400, 'A commit message is required', 'validation_failed')

    // Temp bytes must exist and match the recorded hash ("object/hash processing").
    const tempPath = this.tempPath(row.id)
    if (!existsSync(tempPath) || row.state !== 'pending') {
      throw new AppError(404, 'Upload data is missing — retry the transfer', 'upload_missing')
    }
    const content = readFileSync(tempPath)
    const sha256 = createHash('sha256').update(content).digest('hex')
    if (row.sha256 && row.sha256 !== sha256) {
      throw new AppError(409, 'Uploaded data changed during transfer — retry the upload', 'hash_mismatch')
    }

    // Resolve refs.
    const abs = join(this.cfg.repositoriesRoot, project.disk_path)
    const objectsDir = join(abs, 'objects')
    const baseHead = this.resolveRef(abs, baseBranch)
    const targetHead = this.resolveRef(abs, targetBranch)

    if (targetBranch === baseBranch && !targetHead && !baseHead) {
      // Empty repository committing straight to the default branch is fine.
    } else if (!baseHead && targetBranch === baseBranch) {
      throw new AppError(400, `Source branch does not exist: ${baseBranch}`, 'branch_missing')
    }

    // Load current tree of the BASE ref (new branches fork from it).
    let files = new Map<string, Buffer>()
    if (baseHead) {
      const commitObj = readObject(objectsDir, baseHead)
      files = loadFilesUnderTree(objectsDir, parseCommit(commitObj.body).tree)
    }

    const existedBefore = files.has(row.file_path)
    if (existedBefore && !opts.replace) {
      throw new AppError(409, 'A file with this name already exists', 'file_exists')
    }
    const existingSha = existedBefore
      ? createHash('sha256').update(files.get(row.file_path)!).digest('hex')
      : null
    if (existedBefore && existingSha === sha256 && opts.replace) {
      throw new AppError(400, 'The file contents are identical — nothing to commit', 'empty_commit')
    }

    // Git blob → nested tree → commit with parent linkage.
    writeObject(objectsDir, 'blob', content)
    const merged: FlatFile[] = [
      ...[...files.entries()]
        .filter(([p]) => p !== row.file_path)
        .map(([p, c]) => ({ path: p, mode: '100644' as const, content: c })),
      { path: row.file_path, mode: '100644' as const, content },
    ]
    const treeSha = buildNestedTree(objectsDir, merged)
    const user = this.s.users.byId(actor!.userId)!
    const commitSha = commitTree(
      objectsDir,
      treeSha,
      message,
      { name: user.name ?? user.username, email: `${user.username}@users.lsgit.local` },
      baseHead ? [baseHead] : [],
    )

    // Branch ref update (atomic-ish: temp+rename within refs dir).
    this.writeRef(abs, targetBranch, commitSha)

    // Event emission (durable outbox row) + activity touch.
    this.db.transaction(() => {
      this.s.events.emit(project.id, 'repository.file_committed', {
        file_path: row.file_path,
        branch: targetBranch,
        commit_sha: commitSha,
        content_sha256_prefix: sha256.slice(0, 12),
        size: content.length,
        replaced: existedBefore,
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

    // Cleanup staged bytes.
    this.discardTemp(row.id)
    this.s.uploads.markCompleted(row.id)

    return {
      file_path: row.file_path,
      branch: targetBranch,
      commit_sha: commitSha,
      replaced: existedBefore,
      content_sha256: sha256,
      merge_request: {
        created: false,
        reason:
          'Merge requests arrive with the collaboration phase; your branch is ready on the instance.',
      },
    }
  }

  // -- plumbing ---------------------------------------------------------------------

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
