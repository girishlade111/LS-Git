import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { AppError } from './identity.js'
import type { IdentityServices } from './identity.js'
import type { AppConfig } from '../config.js'
import type { Actor } from '../authz.js'
import { can } from '../authz.js'
import type { ProjectRow } from '../db/store.js'
import {
  GitRepository,
  RefConflictError,
  RefLockError,
  RefValidationError,
  ObjectNotFoundError,
  RepositoryNotFoundError,
  RepositoryError,
  normalizeRevCandidate,
  type CommitIdentity,
  type FileMode,
  type ParsedCommit,
} from '../storage/repository.js'
import type { LocalHashedStorage } from '../storage/local.js'
import { validateRepoFilePath, sanitizeCommitMessage } from '../lib/pathsafe.js'

/**
 * Repository service — the authorization-gated face of the core Git engine.
 *
 * Every mutation follows the same discipline:
 *   1. resolve + authenticate (404 without leaking existence to strangers),
 *   2. AUTHORIZE before any byte touches disk (central `can()` service),
 *   3. enforce protected-branch rules (PERMISSIONS.md §5),
 *   4. perform the atomic Git operation (engine guarantees lock + CAS),
 *   5. emit durable events + audit rows.
 *
 * Git object bytes never pass through PostgreSQL; this service orchestrates,
 * the engine owns disk.
 */

export interface ChangeInput {
  path: string
  /** New file content (blob is written into the Git object store). */
  content?: Buffer | string
  /** Alternatively reference a pre-written blob SHA. */
  sha?: string
  mode?: FileMode
}

export interface CommitInput {
  changes: Array<ChangeInput>
  message: string
  /** Existing branch to commit onto (default: repository default branch). */
  branch?: string | null
  /** Create a NEW branch from start_branch and commit there. */
  new_branch?: string | null
  /** Base for new_branch (default: default branch). */
  start_branch?: string | null
  /**
   * false (default): overwriting an existing path replaces it (browser edit).
   * true: refuse when a change would overwrite an existing path.
   */
  reject_overwrite?: boolean
}

export interface CommitOutcome {
  commit_sha: string
  tree_sha: string
  branch: string
  created_branch: boolean
  previous_tip: string | null
  replaced_paths: string[]
}

const MIN_SHORT_SHA = 7

export class RepositoriesService {
  constructor(
    private s: IdentityServices,
    private cfg: AppConfig,
    private storage: LocalHashedStorage,
  ) {}

  // ------------------------------------------------------------------ gates --

  private projectCtx(project: ProjectRow) {
    return {
      resourceProject: {
        ownerId: project.owner_id,
        visibility: project.visibility,
        archived: !!project.archived,
      },
    }
  }

  requireProject(projectId: number): ProjectRow {
    const p = this.s.projects.byId(projectId)
    if (!p) throw new AppError(404, 'Project not found')
    return p
  }

  private failAuth(actor: Actor | null, detail?: Record<string, unknown>): never {
    if (actor) {
      this.s.audit.record({
        userId: actor.userId,
        name: 'repo_write_denied',
        ...(detail ? { detail } : {}),
      })
    }
    throw new AppError(
      actor ? 403 : 401,
      actor ? 'You are not allowed to write to this repository' : 'Authentication required',
      actor ? 'forbidden' : 'unauthenticated',
    )
  }

  /** Central authorization gate — ownership/admin decides push rights today. */
  private authorizePush(actor: Actor | null, project: ProjectRow, action: string): void {
    const ok = can(actor, 'project:push_code', this.projectCtx(project))
    if (!ok) {
      this.failAuth(actor, { kind: 'push_denied', action, project_id: project.id })
    }
  }

  /** Protected-ref gate applied AFTER role authorization, BEFORE any write. */
  private authorizeProtectedBranch(actor: Actor, project: ProjectRow, branch: string): void {
    const rule = this.s.protectedBranches.byName(project.id, branch)
    const allowed = this.s.protectedBranches.pushAllowed(
      actor.admin || actor.userId === project.owner_id,
      actor.admin,
      rule,
    )
    if (!allowed) {
      this.s.audit.record({
        userId: actor.userId,
        name: 'repo_write_denied',
        detail: { kind: 'protected_branch', project_id: project.id, branch },
      })
      throw new AppError(
        403,
        `Branch '${branch}' is protected — the operation was rejected`,
        'protected_branch',
        { code: 'protected_branch', branch },
      )
    }
  }

  authorizeRead(actor: Actor | null, project: ProjectRow): void {
    const ok = can(actor, 'project:read', this.projectCtx(project))
    if (!ok) {
      throw new AppError(
        actor ? 403 : 401,
        actor ? 'You are not allowed to read this project' : 'Authentication required',
        actor ? 'forbidden' : 'unauthenticated',
      )
    }
  }

  // ------------------------------------------------------- open / lifecycle --

  /** Opens the underlying engine after a read authorization check. */
  open(actor: Actor | null, projectId: number): { project: ProjectRow; repo: GitRepository } {
    const project = this.requireProject(projectId)
    this.authorizeRead(actor, project)
    return { project, repo: this.openEngine(project) }
  }

  private openEngine(project: ProjectRow): GitRepository {
    try {
      return this.storage.repository(project.disk_path)
    } catch (err) {
      if (err instanceof RepositoryNotFoundError) {
        throw new AppError(422, 'The repository has not been created yet', 'repository_missing')
      }
      throw err
    }
  }

  /**
   * Creates the physical bare repository for an existing project row.
   * Used right after metadata creation (STORAGE.md §3 create RPC).
   */
  createRepository(
    actor: Actor | null,
    projectId: number,
    opts: { default_branch?: string; initialize_files?: Array<{ path: string; content: Buffer | string; mode?: FileMode }>; initial_message?: string } = {},
  ): { project: ProjectRow; commit_sha: string | null } {
    const project = this.requireProject(projectId)
    this.authorizePush(actor, project, 'create_repository')

    const abs = join(this.cfg.repositoriesRoot, project.disk_path)
    const branch = opts.default_branch ?? project.default_branch
    let repo: GitRepository
    try {
      repo = GitRepository.createBare(abs, branch)
    } catch {
      throw new AppError(409, 'Repository storage already exists', 'repository_exists')
    }

    let commitSha: string | null = null
    if (opts.initialize_files && opts.initialize_files.length > 0) {
      const result = repo.applyChangesToBranch({
        baseBranch: branch,
        targetBranch: branch,
        message: opts.initial_message?.trim() || 'Initial commit',
        identity: this.identityOf(actor),
        changes: opts.initialize_files.map((f) => ({ path: f.path, content: f.content, mode: f.mode ?? '100644' })),
      })
      commitSha = result.commitSha
      this.recordCommitEvents(actor!, project, result.branch, null, result.commitSha, 'initial_commit')
    }
    return { project, commit_sha: commitSha }
  }

  // ------------------------------------------------------------------ writes --

  /**
   * The ONE commit path for every web-originated flow:
   *   - initial commit on an empty repository,
   *   - upload commit (single/batch finalize),
   *   - browser edit commit (replace semantics),
   *   - branch commit (new branch from a start point).
   */
  commitChanges(actor: Actor | null, projectId: number, input: CommitInput): CommitOutcome {
    const project = this.requireProject(projectId)
    this.authorizePush(actor, project, 'commit')

    const message = sanitizeCommitMessage(input.message)
    if (!message) throw new AppError(400, 'A commit message is required', 'validation_failed')

    const repo = this.openEngine(project)
    const defaultBranch = repo.defaultBranch()
    const targetBranch = String(input.new_branch ?? input.branch ?? defaultBranch)
    const baseBranch = input.new_branch ? String(input.start_branch ?? defaultBranch) : targetBranch

    // Authorization BEFORE writes — including the protected-ref gate.
    this.authorizeProtectedBranch(actor!, project, targetBranch)

    if (input.changes.length === 0) {
      throw new AppError(400, 'At least one file change is required', 'empty_commit')
    }
    for (const change of input.changes) {
      const checked = validateRepoFilePath(change.path)
      if (!checked.ok) throw new AppError(400, checked.error, 'invalid_path')
      if (!change.sha && change.content === undefined) {
        throw new AppError(400, `'${change.path}' needs content or a blob sha`, 'validation_failed')
      }
    }

    // An explicitly named base must exist unless we are simply committing to
    // the (still empty) default branch — that is the initial-commit flow.
    if (input.new_branch || input.start_branch) {
      const hasBase = !!repo.resolveBranch(baseBranch)
      if (!hasBase && baseBranch !== targetBranch) {
        throw new AppError(400, `Source branch does not exist: ${baseBranch}`, 'branch_missing')
      }
    }

    let result
    try {
      result = repo.applyChangesToBranch({
        baseBranch,
        targetBranch,
        message,
        identity: this.identityOf(actor),
        rejectOverwrite: input.reject_overwrite === true,
        changes: input.changes.map((c) => ({
          path: c.path,
          content: c.content,
          sha: c.sha,
          mode: c.mode ?? '100644',
        })),
      })
    } catch (err) {
      throw this.mapEngineError(err)
    }

    this.recordCommitEvents(actor!, project, targetBranch, result.previousTip, result.commitSha, input.new_branch ? 'new_branch_commit' : 'commit')
    return {
      commit_sha: result.commitSha,
      tree_sha: result.treeSha,
      branch: targetBranch,
      created_branch: result.createdBranch,
      previous_tip: result.previousTip,
      replaced_paths: result.replacedPaths,
    }
  }

  /** Creates a branch pointing at an existing revision (CAS: must not exist). */
  createBranch(
    actor: Actor | null,
    projectId: number,
    input: { name: string; start_point?: string | null },
  ): { branch: string; commit_sha: string } {
    const project = this.requireProject(projectId)
    this.authorizePush(actor, project, 'create_branch')

    const repo = this.openEngine(project)
    const startSha = this.resolveRevision(repo, input.start_point || repo.defaultBranch())
    if (!startSha) throw new AppError(404, `Start point not found: ${input.start_point || repo.defaultBranch()}`, 'start_point_missing')

    try {
      const res = repo.updateRef(`refs/heads/${input.name}`, startSha.sha, null)
      this.emitRepoEvent(project.id, 'repo.push', {
        ref: res.ref,
        before: null,
        after: startSha.sha,
        action: 'branch_created',
        actor_user_id: actor!.userId,
      })
      this.audit(actor!.userId, 'repo_branch_created', { project_id: project.id, branch: input.name, sha: startSha.sha })
      return { branch: input.name, commit_sha: startSha.sha }
    } catch (err) {
      throw this.mapEngineError(err)
    }
  }

  /**
   * Deletes a branch. Protected branches are never deletable (unprotect first,
   * GitLab parity); the default branch is never deletable.
   */
  deleteBranch(actor: Actor | null, projectId: number, branch: string, expectedOld?: string | null): void {
    const project = this.requireProject(projectId)
    this.authorizePush(actor, project, 'delete_branch')

    const repo = this.openEngine(project)
    if (branch === repo.defaultBranch()) {
      throw new AppError(400, 'The default branch cannot be deleted', 'default_branch')
    }
    if (this.s.protectedBranches.byName(project.id, branch)) {
      this.s.audit.record({
        userId: actor!.userId,
        name: 'repo_write_denied',
        detail: { kind: 'delete_protected_branch', project_id: project.id, branch },
      })
      throw new AppError(403, `Branch '${branch}' is protected and cannot be deleted`, 'protected_branch')
    }
    const current = repo.resolveBranch(branch)
    if (!current) throw new AppError(404, `Branch '${branch}' does not exist`, 'branch_missing')
    try {
      repo.deleteRef(`refs/heads/${branch}`, expectedOld !== undefined ? expectedOld : current)
    } catch (err) {
      throw this.mapEngineError(err)
    }
    this.emitRepoEvent(project.id, 'repo.push', {
      ref: `refs/heads/${branch}`,
      before: current,
      after: null,
      action: 'branch_deleted',
      actor_user_id: actor!.userId,
    })
    this.audit(actor!.userId, 'repo_branch_deleted', { project_id: project.id, branch, sha: current })
  }

  /** Creates a tag (annotated when message+tagger given, otherwise lightweight). */
  createTag(
    actor: Actor | null,
    projectId: number,
    input: { name: string; ref: string; message?: string | null },
  ): { name: string; annotated: boolean; target: string; tag_sha: string | null } {
    const project = this.requireProject(projectId)
    this.authorizePush(actor, project, 'create_tag')

    const repo = this.openEngine(project)
    const resolved = this.resolveRevision(repo, input.ref)
    if (!resolved) throw new AppError(404, `Target ref not found: ${input.ref}`, 'ref_not_found')

    try {
      const info = repo.createTag({
        name: input.name,
        target: resolved.sha,
        ...(input.message?.trim() ? { message: input.message, tagger: this.identityOf(actor) } : {}),
      })
      this.emitRepoEvent(project.id, 'repo.tag_push', {
        ref: `refs/tags/${info.name}`,
        before: null,
        after: info.sha,
        action: 'tag_created',
        annotated: info.annotated,
        actor_user_id: actor!.userId,
      })
      this.audit(actor!.userId, 'repo_tag_created', {
        project_id: project.id, tag: info.name, target: info.target, annotated: info.annotated,
      })
      return { name: info.name, annotated: info.annotated, target: info.target, tag_sha: info.annotated ? info.sha : null }
    } catch (err) {
      throw this.mapEngineError(err)
    }
  }

  deleteTag(actor: Actor | null, projectId: number, name: string): void {
    const project = this.requireProject(projectId)
    this.authorizePush(actor, project, 'delete_tag')

    const repo = this.openEngine(project)
    const current = repo.resolveTag(name)
    if (!current) throw new AppError(404, `Tag '${name}' does not exist`, 'tag_missing')
    try {
      repo.deleteRef(`refs/tags/${name}`)
    } catch (err) {
      throw this.mapEngineError(err)
    }
    this.emitRepoEvent(project.id, 'repo.tag_push', {
      ref: `refs/tags/${name}`, before: current, after: null, action: 'tag_deleted', actor_user_id: actor!.userId,
    })
    this.audit(actor!.userId, 'repo_tag_deleted', { project_id: project.id, tag: name })
  }

  /**
   * Generic guarded ref update (heads/tags namespaces only).
   * Optimistic concurrency: pass expectedOld to refuse stale updates.
   */
  updateRef(
    actor: Actor | null,
    projectId: number,
    input: { ref: string; new_sha: string; expected_old?: string | null },
  ): { ref: string; old: string | null; new: string } {
    const project = this.requireProject(projectId)
    this.authorizePush(actor, project, 'update_ref')
    if (input.ref.startsWith('refs/heads/')) {
      this.authorizeProtectedBranch(actor!, project, input.ref.slice('refs/heads/'.length))
    }
    const repo = this.openEngine(project)
    try {
      const res = repo.updateRef(input.ref, input.new_sha, input.expected_old)
      this.emitRepoEvent(project.id, 'repo.push', {
        ref: res.ref, before: res.old, after: res.new, action: 'ref_updated', actor_user_id: actor!.userId,
      })
      this.audit(actor!.userId, 'repo_ref_updated', {
        project_id: project.id, ref: res.ref, old: res.old, new: res.new,
      })
      return res
    } catch (err) {
      throw this.mapEngineError(err)
    }
  }

  // ------------------------------------------------------------------- reads --

  /** Reads a fully qualified ref (read-gated). */
  readRef(actor: Actor | null, projectId: number, ref: string): string | null {
    const { repo } = this.open(actor, projectId)
    return repo.readRef(ref)
  }

  /** Branch head lookup (null when absent). */
  resolveBranch(actor: Actor | null, projectId: number, branch: string): string | null {
    const { repo } = this.open(actor, projectId)
    return repo.resolveBranch(branch)
  }

  /**
   * Rev-parse analog: resolves a branch name, tag name, full sha or unique
   * sha-prefix to its commit. Returns the parsed commit plus how it resolved.
   */
  resolveCommit(
    actor: Actor | null,
    projectId: number,
    rev: string,
  ): { commit: ParsedCommit; via: 'branch' | 'tag' | 'sha' | 'sha_prefix'; ref: string | null } | null {
    const { repo } = this.open(actor, projectId)
    const resolved = this.resolveRevision(repo, rev)
    if (!resolved) return null
    const commit = repo.readCommit(resolved.sha)
    return { commit, via: resolved.via, ref: resolved.source }
  }

  listRefs(actor: Actor | null, projectId: number): Array<{ name: string; sha: string }> {
    const { repo } = this.open(actor, projectId)
    return repo.listRefs('refs/')
  }

  listBranches(actor: Actor | null, projectId: number): Array<{ name: string; sha: string; default: boolean; protected: boolean }> {
    const { project, repo } = this.open(actor, projectId)
    const def = repo.defaultBranch()
    return repo.listBranches().map((b) => ({
      ...b,
      default: b.name === def,
      protected: !!this.s.protectedBranches.byName(project.id, b.name),
    }))
  }

  listTags(actor: Actor | null, projectId: number): Array<{ name: string; sha: string; annotated: boolean; target: string }> {
    const { repo } = this.open(actor, projectId)
    return repo.listTags().map((t) => {
      const objType = repo.objectType(t.sha)
      const annotated = objType === 'tag'
      return {
        name: t.name,
        sha: t.sha,
        annotated,
        target: annotated ? (repo.readTagInfo(t.name)?.target ?? t.sha) : t.sha,
      }
    })
  }

  readCommit(actor: Actor | null, projectId: number, rev: string): ParsedCommit {
    const resolved = this.resolveCommit(actor, projectId, rev)
    if (!resolved) throw new AppError(404, `Revision not found: ${rev}`, 'revision_not_found')
    return resolved.commit
  }

  /** Newest-first history from a revision (first-parent linearized by default). */
  commitHistory(
    actor: Actor | null,
    projectId: number,
    rev: string,
    opts: { limit?: number; all_parents?: boolean } = {},
  ): Array<ParsedCommit> {
    const { repo } = this.open(actor, projectId)
    const resolved = this.resolveRevision(repo, rev)
    if (!resolved) throw new AppError(404, `Revision not found: ${rev}`, 'revision_not_found')
    return repo.history(resolved.sha, { limit: Math.min(opts.limit ?? 50, 200), firstParent: opts.all_parents !== true })
  }

  readFileAt(actor: Actor | null, projectId: number, rev: string, path: string): Buffer {
    const { repo } = this.open(actor, projectId)
    const resolved = this.resolveRevision(repo, rev)
    if (!resolved) throw new AppError(404, `Revision not found: ${rev}`, 'revision_not_found')
    const blob = repo.readFileAt(repo.readCommit(resolved.sha).tree, path)
    if (!blob) throw new AppError(404, `File '${path}' not found at ${rev}`, 'file_not_found')
    return blob
  }

  readTreeAt(
    actor: Actor | null,
    projectId: number,
    rev: string,
    path: string,
  ): Array<{ name: string; type: 'tree' | 'blob'; mode: string; sha: string }> {
    const { repo } = this.open(actor, projectId)
    const resolved = this.resolveRevision(repo, rev)
    if (!resolved) throw new AppError(404, `Revision not found: ${rev}`, 'revision_not_found')
    let treeSha = repo.readCommit(resolved.sha).tree
    if (path) {
      for (const seg of path.split('/').filter(Boolean)) {
        const entry = repo.readTree(treeSha).find((e) => e.name === seg)
        if (!entry) throw new AppError(404, `Path '${path}' not found`, 'path_not_found')
        treeSha = entry.sha
      }
    }
    return repo.readTree(treeSha).map((e) => ({
      name: e.name,
      type: e.mode.startsWith('4') ? ('tree' as const) : ('blob' as const),
      mode: e.mode,
      sha: e.sha,
    }))
  }

  // ---------------------------------------------------------------- internals --

  private identityOf(actor: Actor | null): CommitIdentity {
    if (!actor) return { name: 'LSGit', email: 'system@lsgit.local' }
    const u = this.s.users.byId(actor.userId)
    return {
      name: u?.name || u?.username || actor.username,
      email: `${actor.username}@users.lsgit.local`,
    }
  }

  /**
   * Revision resolver (bounded, no shell): branch → tag → full sha → unique
   * short-sha prefix. Returns the commit sha plus provenance.
   */
  private resolveRevision(
    repo: GitRepository,
    revRaw: string,
  ): { sha: string; via: 'branch' | 'tag' | 'sha' | 'sha_prefix'; source: string | null } | null {
    const rev = String(revRaw ?? '').trim()
    if (!rev || rev.length > 1024) return null

    const asBranch = repo.resolveBranch(rev)
    if (asBranch) return { sha: asBranch, via: 'branch', source: `refs/heads/${rev}` }

    const asTag = (() => {
      try {
        return repo.resolveTag(rev)
      } catch (err) {
        if (err instanceof RefValidationError) return null // not a legal tag name
        throw err
      }
    })()
    if (asTag) return { sha: asTag, via: 'tag', source: `refs/tags/${rev}` }

    const candidate = normalizeRevCandidate(rev)
    if (!candidate) return null
    if (candidate.length === 40 && repo.hasObject(candidate)) {
      return { sha: candidate, via: 'sha', source: null }
    }
    // Unique short-sha prefix resolution (≥7 chars), scanning loose objects.
    if (candidate.length >= MIN_SHORT_SHA) {
      const dir = join(repo.path, 'objects', candidate.slice(0, 2))
      const rest = candidate.slice(2)
      try {
        const matches = readdirSafe(dir).filter((f) => f.startsWith(rest))
        if (matches.length === 1) {
          const sha = `${candidate.slice(0, 2)}${matches[0]!}`
          if (repo.hasObject(sha)) return { sha, via: 'sha_prefix', source: null }
        }
      } catch { /* unreadable dir → treat as unresolved */ }
    }
    return null
  }

  /** Resolves any ref expression to its commit; 404 with safe message otherwise. */
  private requireResolved(repo: GitRepository, rev: string): { sha: string; via: 'branch' | 'tag' | 'sha' | 'sha_prefix'; source: string | null } {
    const resolved = this.resolveRevision(repo, rev)
    if (!resolved) throw new AppError(404, `Revision not found: ${truncate(rev, 64)}`, 'revision_not_found')
    return resolved
  }

  private recordCommitEvents(
    actor: Actor,
    project: ProjectRow,
    branch: string,
    before: string | null,
    after: string,
    kind: string,
  ): void {
    this.emitRepoEvent(project.id, 'repo.push', {
      ref: `refs/heads/${branch}`, before, after, action: kind, actor_user_id: actor.userId,
    })
    this.audit(actor.userId, 'repo_commit_created', {
      project_id: project.id, branch, commit_sha: after, kind,
    })
  }

  private emitRepoEvent(projectId: number, type: string, payload: Record<string, unknown>): void {
    this.s.events.emit(projectId, type, payload)
  }

  private audit(userId: number, name: Parameters<IdentityServices['audit']['record']>[0]['name'], detail: Record<string, unknown>): void {
    this.s.audit.record({ userId, name, detail })
  }

  /** Maps engine failures to HTTP-safe AppErrors (no internal paths leak). */
  private mapEngineError(err: unknown): never {
    if (err instanceof AppError) throw err
    if (err instanceof RefConflictError) {
      throw new AppError(
        409,
        'The branch changed while you were working — reload and retry your change',
        'ref_update_conflict',
        { code: 'ref_update_conflict', current: err.currentSha, expected: err.expectedOld },
      )
    }
    if (err instanceof RefLockError) {
      throw new AppError(409, 'Another update to this ref is in progress — retry shortly', 'ref_locked')
    }
    if (err instanceof RefValidationError) {
      throw new AppError(400, err.message, 'invalid_ref')
    }
    if (err instanceof ObjectNotFoundError) {
      throw new AppError(404, 'Object not found in repository', 'object_not_found')
    }
    if (err instanceof RepositoryError && err.code === 'path_exists') {
      throw new AppError(409, err.message, 'file_exists')
    }
    if (err instanceof RepositoryError && err.code === 'empty_commit') {
      throw new AppError(400, err.message, 'empty_commit')
    }
    throw new AppError(500, 'A repository operation failed')
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
