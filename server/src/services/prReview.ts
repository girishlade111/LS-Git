import { AppError } from './identity.js'
import type { IdentityServices } from './identity.js'
import type { ProjectRow, PullRequestRow, PrThreadRow, PrThreadNoteRow } from '../db/store.js'
import type { Actor } from '../authz.js'
import { can } from '../authz.js'
import type { RepositoriesService } from './repositories.js'
import type { LocalHashedStorage } from '../storage/local.js'
import { extractSuggestion } from '../lib/suggestion.js'
import { ownersForPath, parseCodeOwners, type CodeOwnerRule } from '../lib/codeowners.js'

/**
 * Code review for pull requests (GitLab review/suggestion behavior).
 *
 * Threads pin diff positions against an EXACT diff version (base..head) and
 * snapshot the covered file lines. A thread is OUTDATED once the source tip
 * moves past its snapshot; replies stay possible, but suggestions REFUSE to
 * apply unless the covered lines still match at the current tip - a moved
 * target can never be edited blindly.
 *
 * Applying a suggestion produces REAL git commits on the PR source branch,
 * gated by push-level permission rules. Batch apply is all-or-nothing: every
 * suggestion is validated against evolving file contents first; then ONE
 * commit lands them together.
 *
 * Reviews: submit approved / changes_requested / commented, publishing any
 * draft comments. Approving grants the user's approval; requesting changes
 * revokes it and flips reviewer state. Policy reset_approvals_on_push clears
 * accumulated approvals whenever the source branch moves.
 */

const MAX_BODY = 5_000

interface Job {
  noteId: number
  path: string
  start: number
  end: number
  covered: string[]
  replacement: string[]
}

function applyRange(lines: string[], job: Job): { ok: true; lines: string[] } | { ok: false; reason: string } {
  if (job.end > lines.length || job.start < 1 || job.end < job.start) {
    return { ok: false, reason: 'range ' + job.start + '-' + job.end + ' out of bounds' }
  }
  const current = lines.slice(job.start - 1, job.end).join('\n')
  if (current !== job.covered.join('\n')) return { ok: false, reason: 'covered lines changed since review' }
  return { ok: true, lines: [...lines.slice(0, job.start - 1), ...job.replacement, ...lines.slice(job.end)] }
}

export class PrReviewService {
  constructor(
    private s: IdentityServices,
    private repos: RepositoriesService,
    private storage: LocalHashedStorage,
  ) {}

  private requirePr(projectId: number, iid: number): PullRequestRow {
    const pr = this.s.pullRequests.byIid(projectId, iid)
    if (!pr) throw new AppError(404, 'Pull request not found')
    return pr
  }

  visiblePr(actor: Actor | null, projectId: number, iid: number): PullRequestRow {
    const project = this.s.projects.byId(projectId)
    if (!project) throw new AppError(404, 'Project not found')
    const readable = can(actor, 'project:read', {
      resourceProject: { ownerId: project.owner_id, visibility: project.visibility },
    })
    if (!readable) {
      // Non-readers get the nonexistent-project answer (PERMISSIONS.md §2).
      if (actor) throw new AppError(404, 'Project not found')
      throw new AppError(401, 'Authentication required')
    }
    return this.requirePr(projectId, iid)
  }

  private engineFor(project: ProjectRow) {
    try {
      return this.storage.repository(project.disk_path)
    } catch {
      throw new AppError(422, 'Repository has no commits yet', 'empty_repository')
    }
  }

  private tips(pr: PullRequestRow): { srcTip: string; baseSha: string } {
    const project = this.s.projects.byId(pr.project_id)!
    const repo = this.engineFor(project)
    const srcTip = repo.resolveBranch(pr.source_branch)
    if (!srcTip) throw new AppError(422, 'Source branch no longer exists', 'source_branch_missing')
    const tgtTip = repo.resolveBranch(pr.target_branch)
    const base = tgtTip ? this.repos.mergeBase(repo, tgtTip, srcTip) : null
    return { srcTip, baseSha: base ?? srcTip }
  }

  recordSystemNote(pr: PullRequestRow, actor: Actor, note: string): void {
    this.s.notes.create({
      noteable_type: 'pull_request',
      noteable_id: pr.id,
      project_id: pr.project_id,
      author_id: actor.userId,
      note,
      system: true,
    })
  }

  private authorizePushLevel(actor: Actor | null, project: ProjectRow): void {
    if (!can(actor, 'pr:create', {
      resourceProject: { ownerId: project.owner_id, visibility: project.visibility },
    })) {
      throw new AppError(
        actor ? 403 : 401,
        actor ? 'Applying suggestions requires branch-push permission' : 'Authentication required',
        actor ? 'forbidden' : 'unauthenticated',
      )
    }
  }

  private commentGate(actor: Actor | null, project: ProjectRow): void {
    if (!can(actor, 'pr:comment', {
      resourceProject: { ownerId: project.owner_id, visibility: project.visibility },
    })) {
      throw new AppError(actor ? 403 : 401, 'Not allowed', actor ? 'forbidden' : 'unauthenticated')
    }
  }

  private assertBody(body: unknown): string {
    if (typeof body !== 'string' || body.trim() === '') throw new AppError(400, 'body is required')
    const v = body.replace(/\r\n/g, '\n').trim()
    if (v.length > MAX_BODY) throw new AppError(400, 'body exceeds ' + MAX_BODY + ' characters')
    return v
  }
}
  // ── threads ──────────────────────────────────────────────────────────────

  createThread(
    actor: Actor,
    projectId: number,
    iid: number,
    input: { path?: unknown; side?: unknown; line_start?: unknown; line_end?: unknown; body?: unknown },
  ): PrThreadRow {
    const project = this.s.projects.byId(projectId)!
    const pr = this.visiblePr(actor, projectId, iid)
    this.commentGate(actor, project)

    const body = this.assertBody(input.body)
    const path = String(input.path ?? '').trim()
    if (!path) throw new AppError(400, 'path is required')

    const side = input.side === 'old' ? ('old' as const) : ('new' as const)
    const lineStart = Number(input.line_start)
    const lineEndRaw = input.line_end === undefined || input.line_end === null ? lineStart : Number(input.line_end)

    // Validate the position against the reviewed commit's actual content.
    const { srcTip, baseSha } = this.tips(pr)
    const repo = this.engineFor(project)
    let shaAtSide: string | null = null
    if (side === 'new') {
      shaAtSide = repo.findEntryAt(repo.readCommit(srcTip).tree, path)?.sha ?? null
    } else if (baseSha) {
      shaAtSide = repo.findEntryAt(repo.readCommit(baseSha).tree, path)?.sha ?? null
    }
    if (!shaAtSide) {
      throw new AppError(422, "'" + 'path' + "' does not exist on the " + (side === 'new' ? 'source tip' : 'base version') + ' of this diff', 'invalid_position')
    }
    const text = repo.readBlob(shaAtSide).toString('utf8')
    const totalLines = text === '' ? 0 : text.replace(/\n$/, '').split('\n').length
    if (
      !Number.isInteger(lineStart) || !Number.isInteger(lineEndRaw) ||
      lineStart < 1 || lineEndRaw < lineStart || lineEndRaw > totalLines
    ) {
      throw new AppError(422, 'Invalid line range for a ' + totalLines + '-line file', 'invalid_position')
    }

    const coveredLines = text.replace(/\n$/, '').split('\n').slice(lineStart - 1, lineEndRaw)
    return this.s.db.transaction(() => {
      const t = this.s.prThreads.create({
        pr_id: pr.id,
        project_id: projectId,
        path,
        side,
        line_start: lineStart,
        line_end: lineEndRaw,
        base_sha: baseSha,
        head_sha: srcTip,
        covered_lines: coveredLines,
      })
      const suggestion = extractSuggestion(body)
      this.s.prThreadNotes.create({
        thread_id: t.id,
        project_id: projectId,
        author_id: actor.userId,
        body,
        suggestionLines: suggestion,
      })
      return t
    })
  }

  reply(actor: Actor, projectId: number, iid: number, threadId: number, input: { body?: unknown }): PrThreadNoteRow {
    const project = this.s.projects.byId(projectId)!
    const pr = this.visiblePr(actor, projectId, iid)
    this.commentGate(actor, project)
    const thread = this.s.prThreads.byId(threadId)
    if (!thread || thread.pr_id !== pr.id) throw new AppError(404, 'Thread not found')
    const body = this.assertBody(input.body)
    const suggestion = extractSuggestion(body)
    return this.s.prThreadNotes.create({
      thread_id: thread.id,
      project_id: projectId,
      author_id: actor.userId,
      body,
      suggestionLines: suggestion,
    })
  }

  listThreads(actor: Actor | null, projectId: number, iid: number) {
    const pr = this.visiblePr(actor, projectId, iid)
    const { srcTip } = this.tips(pr)
    const project = this.s.projects.byId(projectId)!
    const ownerRules = this.loadCodeOwnerRules(project)
    return {
      threads: this.s.prThreads.listForPr(pr.id).map((t) => {
        const applicability = this.threadApplicability(pr, t, srcTip)
        const owners = ownersForPath(ownerRules, t.path)
        return {
          ...this.threadView(t, applicability),
          code_owner_users: owners.users,
          code_owner_unresolved: owners.unresolved,
          notes: this.s.prThreadNotes.listForThread(t.id).map((n) => ({
            id: n.id,
            author: this.userBrief(n.author_id),
            body: n.body,
            suggestion: n.suggestion_lines
              ? { status: n.suggestion_status, applied_commit_sha: n.applied_commit_sha }
              : null,
            created_at: n.created_at,
          })),
        }
      }),
      head_sha: srcTip,
    }
  }

  resolve(actor: Actor, projectId: number, iid: number, threadId: number): PrThreadRow {
    const project = this.s.projects.byId(projectId)!
    const pr = this.visiblePr(actor, projectId, iid)
    this.commentGate(actor, project)
    const thread = this.s.prThreads.byId(threadId)
    if (!thread || thread.pr_id !== pr.id) throw new AppError(404, 'Thread not found')
    if (!thread.resolved) {
      this.s.db.transaction(() => {
        this.s.prThreads.setResolved(thread.id, true, actor.userId)
        this.recordSystemNote(pr, actor, 'resolved the thread on ' + thread.path)
      })
    }
    return this.s.prThreads.byId(thread.id)!
  }

  unresolve(actor: Actor, projectId: number, iid: number, threadId: number): PrThreadRow {
    const project = this.s.projects.byId(projectId)!
    const pr = this.visiblePr(actor, projectId, iid)
    this.commentGate(actor, project)
    const thread = this.s.prThreads.byId(threadId)
    if (!thread || thread.pr_id !== pr.id) throw new AppError(404, 'Thread not found')
    if (thread.resolved) {
      this.s.db.transaction(() => {
        this.s.prThreads.setResolved(thread.id, false, null)
        this.recordSystemNote(pr, actor, 'reopened the thread on ' + thread.path)
      })
    }
    return this.s.prThreads.byId(thread.id)!
  }

  private userBrief(id: number | null) {
    if (id === null) return null
    const u = this.s.users.byId(id)
    return u ? { id: u.id, username: u.username, name: u.name } : null
  }

  private threadView(t: PrThreadRow, applicability: { outdated: boolean; reason?: string }) {
    return {
      id: t.id,
      path: t.path,
      side: t.side,
      line_start: t.line_start,
      line_end: t.line_end,
      resolved: !!t.resolved,
      outdated: applicability.outdated,
      outdated_reason: applicability.reason ?? null,
      head_sha: t.head_sha,
      created_at: t.created_at,
    }
  }
