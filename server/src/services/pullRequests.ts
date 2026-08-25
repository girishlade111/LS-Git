import { AppError } from './identity.js'
import type { IdentityServices } from './identity.js'
import type { AppConfig } from '../config.js'
import type { ProjectRow, PullRequestRow, MergeStatus, NoteRow, LabelRow } from '../db/store.js'
import type { Actor } from '../authz.js'
import { can, type Permission } from '../authz.js'
import type { RepositoriesService } from './repositories.js'
import type { IssuesService } from './issues.js'
import type { GitRepository } from '../storage/repository.js'
import type { CommitIdentity } from '../storage/repository.js'
import { threeWayMerge } from '../lib/linemerge.js'

/**
 * Pull requests — GitLab Merge Request workflow semantics on LSGit naming.
 *
 * ══════════════════════════ STATE MACHINE (explicit) ═════════════════════
 *
 *   create ──▶ opened ──close───▶ closed ──reopen──▶ opened
 *                │  ▲ mark_ready (draft flag only; state stays opened)
 *                └──merge──▶ locked ──finalize──▶ merged   (TERMINAL)
 *                               └──rollback───▶ opened     (git failure)
 *
 * Enforced invariants:
 *   - merge requires state='opened' AND draft=0; the claim is a guarded SQL
 *     UPDATE ... WHERE state='opened' AND draft=0 (atomic under SQLite's
 *     single-writer model) so concurrent merges/closes cannot double-fire.
 *   - 'locked' is transient: finalize sets 'merged'; ANY git failure rolls
 *     back to 'opened'. It is never a resting state.
 *   - closed/merged reject every mutating transition except reopen(closed).
 * Every transition appends a SYSTEM note to the PR timeline and emits a
 * domain event ('mr.*') for the notification bus.
 *
 * ══════════════════════════ MERGE GATES (ordered) ════════════════════════
 *   G1 permission denied            → 403 (pr:merge + protected-target rule)
 *   G2 unknown PR                   → 404
 *   G3 wrong state / already merged → 422
 *   G4 draft not ready              → 422
 *   G5 protected target rule fails  → 403
 *   G6 required approvals missing   → 422
 *   G7 required checks failing      → 422  [CI phase hook — see below]
 *   G8 stale expected sha           → 409
 *   G9 unresolved conflicts /
 *      nothing to merge             → 422
 * A merge NEVER proceeds past a failed gate. There is no bypass path.
 *
 * G7 note: LSGit has no CI engine yet (ROADMAP Phase 3). The gate exists as
 * an explicit function returning { ok:true, reason:'no_checks_configured' }
 * today; wiring CI into it is additive and cannot silently change results.
 */

export type MergeMethod = 'merge' | 'squash' | 'rebase'

const MAX_TITLE = 255
const MAX_DESCRIPTION = 10_000

/** GitLab closing-keyword parity: "closes #12", "fix: #3", "resolved #7"… */
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)\b/gi

export function parseClosingIssueIids(text: string): number[] {
  const out = new Set<number>()
  let m: RegExpExecArray | null
  CLOSING_KEYWORD.lastIndex = 0
  while ((m = CLOSING_KEYWORD.exec(text)) !== null) {
    const n = Number(m[1])
    if (Number.isInteger(n) && n > 0) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

interface TreeEntryLite {
  mode: string
  sha: string
}

export class PullRequestsService {
  constructor(
    private s: IdentityServices,
    private cfg: AppConfig,
    private repos: RepositoriesService,
    private issues: IssuesService,
  ) {}

  // ── authorization ────────────────────────────────────────────────────────

  private projectCtx(project: ProjectRow) {
    return {
      resourceProject: {
        ownerId: project.owner_id,
        visibility: project.visibility,
        archived: !!project.archived,
      },
    }
  }

  authorize(
    actor: Actor | null,
    permission: Permission,
    project: ProjectRow,
    extraCtx: { resourceUserId?: number } = {},
  ): void {
    const ok = can(actor, permission, { ...this.projectCtx(project), resourceUserId: extraCtx.resourceUserId })
    if (!ok) {
      throw new AppError(
        actor ? 403 : 401,
        actor ? 'You are not allowed to perform this action on this pull request' : 'Authentication required',
        actor ? 'forbidden' : 'unauthenticated',
      )
    }
  }

  readableProject(actor: Actor | null, projectId: number): ProjectRow {
    const p = this.s.projects.byId(projectId)
    if (!p) throw new AppError(404, 'Project not found')
    try {
      this.authorize(actor, 'project:read', p)
    } catch {
      throw new AppError(404, 'Project not found') // existence hidden
    }
    return p
  }

  visiblePr(actor: Actor | null, projectId: number, iid: number): PullRequestRow {
    const project = this.readableProject(actor, projectId)
    void project
    const pr = this.s.pullRequests.byIid(projectId, iid)
    if (!pr) throw new AppError(404, 'Pull request not found')
    return pr
  }

  private requirePr(projectId: number, iid: number): PullRequestRow {
    const pr = this.s.pullRequests.byIid(projectId, iid)
    if (!pr) throw new AppError(404, 'Pull request not found')
    return pr
  }

  private requireRepoEngine(project: ProjectRow): GitRepository {
    try {
      return this.s.projects.storage.repository(project.disk_path)
    } catch {
      throw new AppError(422, 'Repository has no commits yet', 'empty_repository')
    }
  }

  // ── validation helpers ─────────────────────────────────────────────────────

  private requireText(raw: unknown, field: string, max: number): string {
    if (typeof raw !== 'string') throw new AppError(400, `${field} is required`)
    const v = raw.replace(/\r\n/g, '\n').trim()
    if (v.length === 0) throw new AppError(400, `${field} cannot be empty`)
    if (v.length > max) throw new AppError(400, `${field} exceeds ${max} characters`)
    return v
  }

  private resolveBranchOrFail(engine: GitRepository, branch: string, what: string): string {
    const tip = engine.resolveBranch(branch)
    if (!tip) throw new AppError(422, `${what} branch does not exist: ${branch}`, 'branch_missing')
    return tip
  }

  private resolveUserIds(userIds: unknown, what: string): number[] {
    if (userIds === undefined || userIds === null) return []
    if (!Array.isArray(userIds)) throw new AppError(400, `${what} must be an array`)
    const ids = [...new Set(userIds.map(Number))]
    if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new AppError(400, `${what} must contain positive integers`)
    for (const uid of ids) {
      const u = this.s.users.byId(uid)
      if (!u || u.state !== 'active') throw new AppError(422, `${what} contains an unknown or inactive user`, 'invalid_user')
    }
    return ids.sort((a, b) => a - b)
  }

  private resolveLabelIds(projectId: number, titles: unknown): number[] {
    if (titles === undefined || titles === null) return []
    if (!Array.isArray(titles)) throw new AppError(400, 'labels must be an array')
    const unique = [...new Set(titles.map((t) => String(t).trim()).filter(Boolean))]
    if (unique.length > 10) throw new AppError(400, 'At most 10 labels are supported')
    const ids: number[] = []
    for (const t of unique) {
      const l = this.s.labels.byTitle(projectId, t)
      if (!l) throw new AppError(422, `Label "${t}" does not exist`, 'label_not_found')
      ids.push(l.id)
    }
    return ids
  }

  private resolveMilestone(projectId: number, milestoneId: unknown): number | null {
    if (milestoneId === undefined || milestoneId === null) return null
    const n = Number(milestoneId)
    if (!Number.isInteger(n) || n <= 0) throw new AppError(400, 'milestone_id must be a positive integer or null')
    const m = this.s.milestones.byId(n)
    if (!m || m.project_id !== projectId) throw new AppError(422, 'Milestone does not belong to this project', 'invalid_milestone')
    return n
  }

  /** Resolves linked issues from the description, validating existence. */
  private resolveLinkedIssues(projectId: number, description: string): number[] {
    const iids = parseClosingIssueIids(description)
    const valid: number[] = []
    for (const iid of iids) {
      if (this.s.issues.byIid(projectId, iid)) valid.push(iid)
    }
    return valid
  }

  // ── effects ─────────────────────────────────────────────────────────────

  private recordActivity(pr: PullRequestRow, actor: Actor, note: string): void {
    this.s.notes.create({
      noteable_type: 'pull_request',
      noteable_id: pr.id,
      project_id: pr.project_id,
      author_id: actor.userId,
      note,
      system: true,
    })
  }

  private fanout(project: ProjectRow, type: string, payload: Record<string, unknown>): void {
    this.s.events.emit(project.id, type, payload)
  }

  private identityOf(actor: Actor): CommitIdentity {
    const u = this.s.users.byId(actor.userId)
    return { name: u?.name || u?.username || actor.username, email: `${actor.username}@users.lsgit.local` }
  }

  private ownerUsernameOf(project: ProjectRow): string {
    return this.s.users.byId(project.owner_id)?.username ?? ''
  }

  // ══ create ══════════════════════════════════════════════════════════════

  create(
    actor: Actor,
    projectId: number,
    input: {
      title?: unknown
      description?: unknown
      draft?: unknown
      source_branch?: unknown
      target_branch?: unknown
      assignee_ids?: unknown
      labels?: unknown
      milestone_id?: unknown
    },
  ): PullRequestRow {
    const project = this.readableProject(actor, projectId)
    if (project.archived) throw new AppError(422, 'Cannot create pull requests in an archived project')
    this.authorize(actor, 'pr:create', project)

    const title = this.requireText(input.title, 'Title', MAX_TITLE)
    const description =
      typeof input.description === 'string' ? input.description.slice(0, MAX_DESCRIPTION) : ''
    const draft = input.draft === true
    const sourceBranch = String(input.source_branch ?? '').trim()
    const targetBranch = String(input.target_branch ?? '').trim()

    if (!sourceBranch || !targetBranch) throw new AppError(400, 'source_branch and target_branch are required')
    if (sourceBranch === targetBranch) {
      throw new AppError(422, 'Source and target branches must differ', 'same_branches')
    }

    const engine = this.requireRepoEngine(project)
    const sourceTip = this.resolveBranchOrFail(engine, sourceBranch, 'Source')
    const targetTip = this.resolveBranchOrFail(engine, targetBranch, 'Target')

    const dupes = this.s.pullRequests.openForBranches(projectId, sourceBranch, targetBranch)
    if (dupes.length > 0) {
      throw new AppError(409, `An open pull request already exists for ${sourceBranch} → ${targetBranch}`, 'duplicate_pr')
    }

    const assigneeIds = this.resolveUserIds(input.assignee_ids, 'assignee_ids')
    const labelIds = this.resolveLabelIds(projectId, input.labels)
    const milestoneId = this.resolveMilestone(projectId, input.milestone_id)
    const linkedIssues = this.resolveLinkedIssues(projectId, description)

    const pr = this.s.db.transaction(() => {
      const row = this.s.pullRequests.create({
        project_id: projectId,
        author_id: actor.userId,
        title,
        description,
        draft,
        source_branch: sourceBranch,
        target_branch: targetBranch,
        milestone_id: milestoneId,
      })
      if (assigneeIds.length > 0) this.s.pullRequests.setAssignees(row.id, assigneeIds)
      if (labelIds.length > 0) this.s.pullRequests.setLabels(row.id, labelIds)
      if (linkedIssues.length > 0) this.s.pullRequests.setLinkedIssues(row.id, linkedIssues)
      return row
    })

    // Compute initial mergeability eagerly so list views never show 'unchecked'.
    this.refreshMergeStatus(pr)

    this.fanout(project, 'mr.opened', {
      action: 'opened',
      title,
      iid: pr.iid,
      draft,
      source_branch: sourceBranch,
      target_branch: targetBranch,
      actor_user_id: actor.userId,
      participant_user_ids: [actor.userId, ...assigneeIds],
    })
    void sourceTip
    void targetTip
    return this.requirePr(projectId, pr.iid)
  }

  // ══ update & transitions ═════════════════════════════════════════════════

  update(
    actor: Actor,
    projectId: number,
    iid: number,
    patch: Record<string, unknown>,
  ): PullRequestRow {
    const project = this.readableProject(actor, projectId)
    const pr = this.requirePr(projectId, iid)

    // State transitions first — they have their own gates.
    const stateEvent = patch.state_event as string | undefined
    if (stateEvent !== undefined) {
      if (stateEvent === 'close') return this.close(actor, projectId, iid)
      if (stateEvent === 'reopen') return this.reopen(actor, projectId, iid)
      throw new AppError(400, "state_event must be 'close' or 'reopen'")
    }

    this.authorize(actor, 'pr:update', project, { resourceUserId: pr.author_id })
    if (pr.state === 'merged') throw new AppError(422, 'Merged pull requests are immutable', 'merged_immutable')
    if (pr.state === 'locked') throw new AppError(409, 'This pull request is being merged', 'locked')

    const activities: string[] = []
    const sets: Record<string, unknown> = {}

    if (patch.title !== undefined) {
      const title = this.requireText(patch.title, 'Title', MAX_TITLE)
      if (title !== pr.title) { sets.title = title; activities.push('changed title') }
    }
    if (patch.description !== undefined) {
      const d = typeof patch.description === 'string' ? patch.description.slice(0, MAX_DESCRIPTION) : ''
      if (d !== pr.description) {
        sets.description = d
        const links = this.resolveLinkedIssues(projectId, d)
        this.s.pullRequests.setLinkedIssues(pr.id, links)
        activities.push('changed description')
      }
    }
    if (patch.draft !== undefined && patch.draft !== !!pr.draft) {
      if (typeof patch.draft !== 'boolean') throw new AppError(400, 'draft must be a boolean')
      if (patch.draft === false) {
        activities.push('marked this pull request as ready')
      }
      sets.draft = patch.draft ? 1 : 0
    }
    if (patch.target_branch !== undefined) {
      const tb = String(patch.target_branch).trim()
      if (tb !== pr.target_branch) {
        if (tb === pr.source_branch) throw new AppError(422, 'Target must differ from source', 'same_branches')
        const engine = this.requireRepoEngine(project)
        this.resolveBranchOrFail(engine, tb, 'Target')
        sets.target_branch = tb
        sets.merge_status = 'unchecked' satisfies MergeStatus
        sets.merge_status_reason = null
        activities.push(`changed target branch to ${tb}`)
      }
    }
    if (patch.assignee_ids !== undefined) {
      const next = this.resolveUserIds(patch.assignee_ids, 'assignee_ids')
      const prev = this.s.pullRequests.assigneeIds(pr.id)
      const name = (uid: number) => `@${this.s.users.byId(uid)?.username ?? uid}`
      const added = next.filter((u) => !prev.includes(u)).map(name)
      const removed = prev.filter((u) => !next.includes(u)).map(name)
      if (added.length) activities.push(`assigned to ${added.join(', ')}`)
      if (removed.length) activities.push(`unassigned ${removed.join(', ')}`)
      pendingAssignees.set(pr.id, next)
    }
    if (patch.labels !== undefined) {
      const nextIds = this.resolveLabelIds(projectId, patch.labels)
      const prevRows = this.s.pullRequests.labelRows(pr.id)
      const addedTitles = nextIds
        .filter((id) => !prevRows.some((l) => l.id === id))
        .map((id) => this.s.labels.byId(id)!.title)
      const removedTitles = prevRows.filter((l) => !nextIds.includes(l.id)).map((l) => l.title)
      if (addedTitles.length) activities.push(`added ${addedTitles.map((t) => `~${t}`).join(' ')} label${addedTitles.length === 1 ? '' : 's'}`)
      if (removedTitles.length) activities.push(`removed ${removedTitles.map((t) => `~${t}`).join(' ')} label${removedTitles.length === 1 ? '' : 's'}`)
      pendingLabels.set(pr.id, nextIds)
    }
    if (patch.milestone_id !== undefined) {
      const m = this.resolveMilestone(projectId, patch.milestone_id)
      if (m !== pr.milestone_id) {
        sets.milestone_id = m
        activities.push(m ? `set milestone to ${this.s.milestones.byId(m)!.title}` : 'removed milestone')
      }
    }

    this.s.db.transaction(() => {
      if (Object.keys(sets).length > 0) this.s.pullRequests.update(pr.id, sets as Partial<PullRequestRow>)
      const a = pendingAssignees.get(pr.id)
      if (a) this.s.pullRequests.setAssignees(pr.id, a)
      const l = pendingLabels.get(pr.id)
      if (l) this.s.pullRequests.setLabels(pr.id, l)
      for (const act of activities) this.recordActivity(pr, actor, act)
    })
    pendingAssignees.delete(pr.id)
    pendingLabels.delete(pr.id)

    if (sets.merge_status === 'unchecked' || Object.keys(sets).length > 0) {
      const fresh = this.requirePr(projectId, iid)
      if (fresh.state === 'opened') this.refreshMergeStatus(fresh)
    }
    if (activities.length > 0) {
      this.fanout(project, 'mr.updated', {
        action: 'updated', title: pr.title, iid: pr.iid, actor_user_id: actor.userId,
        actor_username: actor.username,
        participant_user_ids: [pr.author_id, ...this.s.pullRequests.assigneeIds(pr.id)],
      })
    }
    return this.requirePr(projectId, iid)
  }

  close(actor: Actor, projectId: number, iid: number): PullRequestRow {
    const project = this.readableProject(actor, projectId)
    const pr = this.requirePr(projectId, iid)
    this.authorize(actor, 'pr:update', project, { resourceUserId: pr.author_id })

    if (pr.state === 'merged') throw new AppError(422, 'Merged pull requests cannot be closed', 'merged_terminal')
    if (pr.state === 'closed') return pr // idempotent no-op
    if (pr.state === 'locked') throw new AppError(409, 'This pull request is being merged', 'locked')

    this.s.db.transaction(() => {
      this.s.pullRequests.update(pr.id, {
        state: 'closed',
        closed_at: new Date().toISOString(),
        closed_by_id: actor.userId,
      })
      this.recordActivity(pr, actor, 'closed this pull request')
    })
    this.fanout(project, 'mr.closed', {
      action: 'closed', title: pr.title, iid: pr.iid, actor_user_id: actor.userId,
      actor_username: actor.username, participant_user_ids: [pr.author_id],
    })
    return this.requirePr(projectId, iid)
  }

  reopen(actor: Actor, projectId: number, iid: number): PullRequestRow {
    const project = this.readableProject(actor, projectId)
    const pr = this.requirePr(projectId, iid)
    if (pr.state === 'merged') throw new AppError(422, 'Merged pull requests are terminal', 'merged_terminal')

    // Closer, author, or maintainer+ may reopen (mirrors issue reopen).
    const isMaintainer = can(actor, 'issue:set_metadata', this.projectCtx(project))
    if (pr.closed_by_id !== actor.userId && pr.author_id !== actor.userId && !isMaintainer) {
      throw new AppError(actor ? 403 : 401, 'Only the author, closer, or a maintainer can reopen', 'forbidden')
    }
    if (pr.state === 'opened') return pr // idempotent
    if (pr.state === 'locked') throw new AppError(409, 'This pull request is being merged', 'locked')

    // Branches must still exist to be meaningfully open.
    const engine = this.requireRepoEngine(project)
    this.resolveBranchOrFail(engine, pr.source_branch, 'Source')
    this.resolveBranchOrFail(engine, pr.target_branch, 'Target')

    this.s.db.transaction(() => {
      this.s.pullRequests.update(pr.id, {
        state: 'opened',
        closed_at: null,
        closed_by_id: null,
        merge_status: 'unchecked' satisfies MergeStatus,
        merge_status_reason: null,
      })
      this.recordActivity(pr, actor, 'reopened this pull request')
    })
    const fresh = this.requirePr(projectId, iid)
    this.refreshMergeStatus(fresh)
    this.fanout(project, 'mr.reopened', {
      action: 'reopened', title: pr.title, iid: pr.iid, actor_user_id: actor.userId,
      actor_username: actor.username, participant_user_ids: [pr.author_id],
    })
    return this.requirePr(projectId, iid)
  }

  // ══ reviewers & approvals ═══════════════════════════════════════════════

  setReviewers(actor: Actor, projectId: number, iid: number, reviewerIds: unknown): PullRequestRow {
    const project = this.readableProject(actor, projectId)
    const pr = this.requirePr(projectId, iid)
    this.authorize(actor, 'pr:update', project, { resourceUserId: pr.author_id })
    if (pr.state === 'merged') throw new AppError(422, 'Merged pull requests are immutable', 'merged_immutable')

    const next = this.resolveUserIds(reviewerIds, 'reviewer_ids').filter((u) => u !== pr.author_id)
    const prev = this.s.pullRequests.reviewers(pr.id).map((r) => r.userId)
    const username = (uid: number) => `@${this.s.users.byId(uid)?.username ?? uid}`
    const added = next.filter((u) => !prev.includes(u)).map(username)
    const removed = prev.filter((u) => !next.includes(u)).map(username)

    this.s.db.transaction(() => {
      this.s.pullRequests.setReviewers(pr.id, next)
      for (const u of added) this.recordActivity(pr, actor, `requested review from ${u}`)
      for (const u of removed) this.recordActivity(pr, actor, `removed review request for ${u}`)
    })
    return this.requirePr(projectId, iid)
  }

  approve(actor: Actor, projectId: number, iid: number): PullRequestRow {
    const project = this.readableProject(actor, projectId)
    const pr = this.visiblePr(actor, projectId, iid)
    this.authorize(actor, 'pr:approve', project, { resourceUserId: pr.author_id })
    if (pr.state !== 'opened') throw new AppError(422, 'Only open pull requests can receive approvals')
    if (pr.author_id === actor.userId) {
      throw new AppError(422, 'Authors cannot approve their own pull requests', 'self_approval_denied')
    }

    this.s.db.transaction(() => {
      this.s.pullRequests.approve(pr.id, actor.userId)
      this.s.pullRequests.setReviewerState(pr.id, actor.userId, 'approved')
      this.recordActivity(pr, actor, `approved this pull request`)
    })
    return this.requirePr(projectId, iid)
  }

  unapprove(actor: Actor, projectId: number, iid: number): PullRequestRow {
    const project = this.readableProject(actor, projectId)
    const pr = this.visiblePr(actor, projectId, iid)

    // Current-user semantics (GitLab parity): you withdraw YOUR approval.
    if (!this.s.pullRequests.hasApproved(pr.id, actor.userId)) {
      throw new AppError(404, 'You have no approval to withdraw')
    }
    this.s.db.transaction(() => {
      this.s.pullRequests.unapprove(pr.id, actor.userId)
      this.s.pullRequests.setReviewerState(pr.id, actor.userId, 'unreviewed')
      this.recordActivity(pr, actor, 'withdrew their approval')
    })
    return this.requirePr(projectId, iid)
  }

  // ══ mergeability ════════════════════════════════════════════════════════

  /**
   * Recomputes and persists merge_status. Pure read over git objects plus one
   * UPDATE — safe to call from any request path.
   */
  refreshMergeStatus(pr: PullRequestRow): PullRequestRow {
    if (pr.state === 'merged') return pr
    const project = this.s.projects.byId(pr.project_id)!
    let status: MergeStatus = 'cannot_be_merged'
    let reason: string
    try {
      const engine = this.requireRepoEngine(project)
      const srcTip = engine.resolveBranch(pr.source_branch)
      if (!srcTip) reason = 'source_branch_missing'
      else {
        const tgtTip = engine.resolveBranch(pr.target_branch)
        if (!tgtTip) reason = 'target_branch_missing'
        else if (engine.isAncestor(srcTip, tgtTip)) reason = 'nothing_to_merge'
        else {
          const baseSha = this.repos.mergeBase(engine, tgtTip, srcTip)
          if (!baseSha) reason = 'unrelated_histories'
          else {
            const result = this.mergeTrees(engine, baseSha, tgtTip, srcTip)
            if (result.conflictPaths.length > 0) reason = 'conflicts'
            else status = 'can_be_merged', (reason = '')
          }
        }
      }
    } catch {
      status = 'cannot_be_merged'
      reason = 'repository_unavailable'
    }
    if (status === 'can_be_merged') reason = ''
    this.s.pullRequests.update(pr.id, { merge_status: status, merge_status_reason: reason || null })
    return this.requirePr(pr.project_id, pr.iid)
  }

  /** Live mergeability report for the UI/merge box (no persistence side effects beyond refresh). */
  mergeability(actor: Actor | null, projectId: number, iid: number) {
    const pr = this.visiblePr(actor, projectId, iid)
    const project = this.readableProject(actor, projectId)
    const refreshed = this.refreshMergeStatus(pr)
    const approvals = this.s.pullRequests.approvals(refreshed.id)
    const required = project.approvals_required ?? 0
    const blockers: Array<{ code: string; message: string }> = []
    if (refreshed.state !== 'opened') blockers.push({ code: 'wrong_state', message: `Pull request is ${refreshed.state}` })
    else {
      if (refreshed.draft) blockers.push({ code: 'draft', message: 'Marked as draft — mark it ready to enable merging' })
      if (refreshed.merge_status_reason) {
        const messages: Record<string, string> = {
          conflicts: 'Merge conflicts block this merge',
          nothing_to_merge: 'All commits are already part of the target branch',
          source_branch_missing: 'The source branch was deleted',
          target_branch_missing: 'The target branch was deleted',
          unrelated_histories: 'The branches share no common history',
          repository_unavailable: 'Repository could not be read',
        }
        blockers.push({ code: refreshed.merge_status_reason, message: messages[refreshed.merge_status_reason] ?? refreshed.merge_status_reason })
      }
      if (approvals.length < required) {
        blockers.push({
          code: 'required_approvals_missing',
          message: `${required - approvals.length} more approval${required - approvals.length === 1 ? '' : 's'} required`,
        })
      }
      // Protected-branch gate preview (the hard check re-runs inside merge()).
      const rule = this.s.protectedBranches.byName(projectId, refreshed.target_branch)
      const viewerCanMergeTarget = rule
        ? this.s.protectedBranches.pushAllowed(
            actor?.userId === project.owner_id || !!actor?.admin,
            !!actor?.admin,
            rule,
          )
        : true
      if (rule && !viewerCanMergeTarget) {
        blockers.push({ code: 'protected_branch_rule', message: `Target branch '${refreshed.target_branch}' is protected` })
      }
    }
    return {
      state: refreshed.state,
      draft: !!refreshed.draft,
      merge_status: refreshed.merge_status,
      merge_status_reason: refreshed.merge_status_reason,
      approvals: { count: approvals.length, required, user_ids: approvals },
      can_merge: blockers.length === 0,
      blockers,
    }
  }

  // ══ THE MERGE ═══════════════════════════════════════════════════════════

  merge(
    actor: Actor,
    projectId: number,
    iid: number,
    input: { method?: unknown; should_remove_source_branch?: unknown; expected_sha?: unknown },
  ): PullRequestRow & { merge_method?: MergeMethod; new_tip?: string } {
    const project = this.readableProject(actor, projectId)

    // ── G1: permission ──
    this.authorize(actor, 'pr:merge', project)

    const pr = this.requirePr(projectId, iid)

    // ── G2 implicit (404 above). ──
    // ── G3: state ──
    if (pr.state === 'merged') throw new AppError(422, 'This pull request is already merged', 'already_merged')
    if (pr.state === 'closed') throw new AppError(422, 'Closed pull requests cannot be merged', 'closed_pr')
    if (pr.state === 'locked') throw new AppError(409, 'A merge is already in progress', 'locked')
    if (pr.state !== 'opened') throw new AppError(422, `Unexpected state ${pr.state}`)

    // ── G4: draft ──
    if (pr.draft) throw new AppError(422, 'Mark the pull request as ready before merging', 'draft_blocked')

    const method = (input.method === undefined || input.method === null ? 'merge' : String(input.method)) as MergeMethod
    if (!['merge', 'squash', 'rebase'].includes(method)) {
      throw new AppError(400, "method must be 'merge', 'squash' or 'rebase'")
    }

    const engine = this.requireRepoEngine(project)

    // ── G5: protected target rule (PERMISSIONS.md §4 semantics) ──
    const protectionRule = this.s.protectedBranches.byName(projectId, pr.target_branch)
    const actorIsOwnerOrAdmin = actor.admin || project.owner_id === actor.userId
    if (protectionRule && !this.s.protectedBranches.pushAllowed(actorIsOwnerOrAdmin, actor.admin, protectionRule)) {
      throw new AppError(403, `Target branch '${pr.target_branch}' is protected against this merge`, 'protected_branch_rule')
    }

    // ── G6: required approvals ──
    const approvalsRequired = project.approvals_required ?? 0
    const approvalCount = this.s.pullRequests.approvals(pr.id).length
    if (approvalCount < approvalsRequired) {
      throw new AppError(422, `${approvalsRequired - approvalCount} required approval(s) missing`, 'required_approvals_missing')
    }

    // ── G7: required checks ──
    const checks = this.requiredChecksSatisfied(project)
    if (!checks.ok) throw new AppError(422, `Required checks failing: ${checks.reason}`, 'checks_failed')

    const srcTipNow = this.resolveBranchOrFail(engine, pr.source_branch, 'Source')
    const tgtTipNow = this.resolveBranchOrFail(engine, pr.target_branch, 'Target')

    // ── G8: stale expected sha (GitLab sha-parameter parity) ──
    if (typeof input.expected_sha === 'string' && input.expected_sha !== '' && input.expected_sha !== srcTipNow) {
      throw new AppError(409, 'The source branch changed — review the new commits and retry', 'sha_not_match', {
        expected: input.expected_sha,
        current: srcTipNow,
      })
    }

    // ── G9: fresh conflict/nothing-to-merge evaluation ──
    if (engine.isAncestor(srcTipNow, tgtTipNow)) {
      throw new AppError(422, 'Nothing to merge — all commits are already in the target branch', 'nothing_to_merge')
    }
    const baseSha = this.repos.mergeBase(engine, tgtTipNow, srcTipNow)
    if (!baseSha) throw new AppError(422, 'The branches share no common history', 'unrelated_histories')

    // ── CLAIM: atomic state transition opened→locked ──
    const claimed = this.db.run(
      `UPDATE pull_requests SET state = 'locked', updated_at = ? WHERE id = ? AND state = 'opened' AND draft = 0`,
      new Date().toISOString(),
      pr.id,
    )
    if (claimed.changes === 0) {
      throw new AppError(409, 'This pull request changed while merging was starting — reload and retry', 'race_lost')
    }

    try {
      // Fresh conflict evaluation UNDER the claim (tips may have moved since G9).
      const pre = this.mergeTrees(engine, baseSha, tgtTipNow, srcTipNow)
      if (pre.conflictPaths.length > 0) {
        throw new AppError(422, `Merge conflicts in ${pre.conflictPaths.length} file(s): ${pre.conflictPaths.slice(0, 5).join(', ')}`, 'conflicts', {
          conflicts: pre.conflictPaths,
        })
      }

      let newTip: string
      let mergeCommitSha: string | null = null
      let squashCommitSha: string | null = null
      const identity = this.identityOf(actor)

      if (method === 'merge') {
        newTip = engine.writeCommit({
          tree: pre.treeSha,
          parents: [tgtTipNow, srcTipNow],
          author: identity,
          committer: identity,
          message: `Merge branch '${pr.source_branch}' into '${pr.target_branch}'`,
        })
        mergeCommitSha = newTip
      } else if (method === 'squash') {
        newTip = engine.writeCommit({
          tree: pre.treeSha,
          parents: [tgtTipNow],
          author: identity,
          committer: identity,
          message: pr.title,
        })
        squashCommitSha = newTip
      } else {
        // rebase: replay each source commit onto the moving target head.
        newTip = this.rebaseChain(engine, baseSha, tgtTipNow, srcTipNow, identity)
      }

      // CAS ref update — a moved target aborts the whole merge cleanly.
      engine.updateRef(`refs/heads/${pr.target_branch}`, newTip, tgtTipNow)

      // Finalize the DB claim.
      const nowIsoStr = new Date().toISOString()
      const finalized = this.db.run(
        `UPDATE pull_requests SET state = 'merged', merged_at = ?, merged_by_id = ?,
           merge_commit_sha = ?, squash_commit_sha = ?, merge_status = 'can_be_merged',
           merge_status_reason = NULL, updated_at = ?
         WHERE id = ? AND state = 'locked'`,
        nowIsoStr,
        actor.userId,
        mergeCommitSha,
        squashCommitSha,
        nowIsoStr,
        pr.id,
      )
      if (finalized.changes === 0) {
        // Claim vanished — ref already advanced; surface honestly instead of faking.
        throw new AppError(409, 'Concurrent modification during merge finalization', 'race_lost_finalize')
      }

      // Optional source-branch cleanup (never touches the default branch).
      let removedBranch = false
      if (input.should_remove_source_branch === true && pr.source_branch !== project.default_branch) {
        try {
          engine.deleteRef(`refs/heads/${pr.source_branch}`, srcTipNow)
          removedBranch = true
        } catch { /* raced deletion — non-fatal */ }
      }

      const merged = this.requirePr(projectId, iid)
      this.s.db.transaction(() => {
        this.recordActivity(merged, actor, `merged with the ${method} strategy${removedBranch ? ' and deleted the source branch' : ''}`)
        for (const issueIid of this.s.pullRequests.linkedIssueIids(merged.id)) {
          const issue = this.s.issues.byIid(projectId, issueIid)
          if (issue && issue.state === 'opened') {
            try {
              this.issues.close(actor, projectId, issueIid)
              this.recordActivity(merged, actor, `closed linked issue #${issueIid}`)
            } catch { /* concurrent close — fine */ }
          }
        }
      })

      this.fanout(project, 'mr.merged', {
        action: 'merged', method, title: merged.title, iid: merged.iid,
        actor_user_id: actor.userId, actor_username: actor.username,
        new_tip: newTip, merge_commit_sha: mergeCommitSha, squash_commit_sha: squashCommitSha,
        participant_user_ids: [merged.author_id],
      })
      return { ...merged, merge_method: method, new_tip: newTip }
    } catch (err) {
      // Rollback the claim — 'locked' must never persist across failures.
      this.db.run(
        `UPDATE pull_requests SET state = 'opened', updated_at = ? WHERE id = ? AND state = 'locked'`,
        new Date().toISOString(),
        pr.id,
      )
      if (err instanceof AppError) throw err
      throw new AppError(500, `Merge failed: ${(err as Error).message}`)
    }
  }

  delete(actor: Actor, projectId: number, iid: number): void {
    const project = this.readableProject(actor, projectId)
    const pr = this.requirePr(projectId, iid)
    this.authorize(actor, 'project:delete', project)
    this.s.pullRequests.delete(pr.id)
  }

  // ══ listing / timeline passthroughs ══════════════════════════════════════

  comments(actor: Actor, projectId: number, iid: number, body: string): NoteRow {
    const project = this.readableProject(actor, projectId)
    const pr = this.visiblePr(actor, projectId, iid)
    this.authorize(actor, 'pr:comment', project)
    const text = body.replace(/\r\n/g, '\n').trim()
    if (!text) throw new AppError(400, 'Comment cannot be empty')
    if (text.length > 5000) throw new AppError(400, 'Comment exceeds 5000 characters')
    const note = this.s.notes.create({
      noteable_type: 'pull_request',
      noteable_id: pr.id,
      project_id: pr.project_id,
      author_id: actor.userId,
      note: text,
    })
    this.fanout(project, 'mr.commented', {
      action: 'commented', title: pr.title, iid: pr.iid, actor_user_id: actor.userId,
      actor_username: actor.username,
      participant_user_ids: [actor.userId, pr.author_id, ...this.s.pullRequests.assigneeIds(pr.id)],
    })
    return note
  }

  timeline(pr: PullRequestRow, opts: { includeSystem?: boolean } = {}): Array<NoteRow> {
    return this.s.notes.timeline('pull_request', pr.id, opts)
  }

  editComment(actor: Actor, projectId: number, noteId: number, body: string): void {
    this.mutateCommentGate(actor, projectId, noteId, 'edit')
    this.s.notes.update(noteId, body.replace(/\r\n/g, '\n').trim())
  }

  deleteComment(actor: Actor, projectId: number, noteId: number): void {
    this.mutateCommentGate(actor, projectId, noteId, 'delete')
    this.s.notes.delete(noteId)
  }

  private mutateCommentGate(actor: Actor, projectId: number, noteId: number, what: 'edit' | 'delete'): void {
    const project = this.readableProject(actor, projectId)
    const note = this.s.notes.byId(noteId)
    if (!note || note.noteable_type !== 'pull_request' || note.project_id !== projectId) {
      throw new AppError(404, 'Comment not found')
    }
    if (note.system) throw new AppError(422, 'System notes cannot be modified')
    const isOwnerOrAdmin = actor.admin || project.owner_id === actor.userId
    if (note.author_id !== actor.userId && !isOwnerOrAdmin) {
      throw new AppError(403, `You can only ${what} your own comments`)
    }
  }

  // ══ git plumbing: three-way TREE merge + rebase chain ═══════════════════

  private mergeTrees(
    repo: GitRepository,
    baseSha: string,
    oursTip: string,
    theirsTip: string,
  ): { treeSha: string; conflictPaths: string[] } {
    const oursTree = repo.flattenTree(repo.readCommit(oursTip).tree)
    const theirsTree = repo.flattenTree(repo.readCommit(theirsTip).tree)
    const baseTree = repo.flattenTree(repo.readCommit(baseSha).tree)

    const entries: Array<{ path: string; mode: '100644' | '100755'; sha: string }> = []
    const conflictPaths: string[] = []

    const paths = new Set<string>([...oursTree.keys(), ...theirsTree.keys()])
    for (const path of paths) {
      const o = oursTree.get(path)
      const t = theirsTree.get(path)
      const b = baseTree.get(path)

      if (o && t) {
        if (o.sha === t.sha) {
          entries.push({ path, mode: normMode(o.mode), sha: o.sha })
          continue
        }
        if (b && o.sha === b.sha) {
          entries.push({ path, mode: normMode(t.mode), sha: t.sha }) // only theirs changed
          continue
        }
        if (b && t.sha === b.sha) {
          entries.push({ path, mode: normMode(o.mode), sha: o.sha }) // only ours changed
          continue
        }
        // Both changed differently — genuine three-way content merge.
        const ourText = this.safeBlobText(repo, o.sha)
        const theirText = this.safeBlobText(repo, t.sha)
        const baseText = b ? this.safeBlobText(repo, b.sha) : ''
        if (ourText !== null && theirText !== null && baseText !== null) {
          const result = threeWayMerge(baseText, ourText, theirText)
          if (result.lines !== null) {
            const sha = repo.writeBlob(result.lines.join('\n') + '\n')
            const mode =
              o.mode === t.mode ? o.mode : b && (o.mode === b.mode ? t.mode : o.mode)
            entries.push({ path, mode: normMode(mode), sha })
            continue
          }
        }
        conflictPaths.push(path) // textual merge failed (conflict/binary/oversized)
        continue
      }

      // Exactly one side has the file.
      const present = (o ?? t)!
      const otherDeletedIt = o ? false : true // !o ⇒ theirs deleted
      void otherDeletedIt
      if (b && present.sha === b.sha) {
        continue // clean deletion (the side holding it never modified it)
      }
      if (!b) {
        // add/delete race on a brand-new file — genuinely conflicting intent
        conflictPaths.push(path)
        continue
      }
      // modify/delete conflict
      conflictPaths.push(path)
    }

    if (conflictPaths.length > 0) return { treeSha: '', conflictPaths }
    return { treeSha: repo.writeTreeFromShas(entries), conflictPaths: [] }
  }

  private rebaseChain(
    repo: GitRepository,
    baseSha: string,
    targetTip: string,
    sourceTip: string,
    committer: CommitIdentity,
  ): string {
    // Source-only commits, OLDEST first.
    const aheadSet = this.repos.reachableSet(repo, sourceTip, baseSha)
    const chain = [...aheadSet]
      .map((sha) => repo.readCommit(sha))
      .sort((a, b) => a.committer.timestamp.time - b.committer.timestamp.time)

    let head = targetTip
    for (const commit of chain) {
      const parentSha = commit.parents[0] ?? baseSha
      const result = this.mergeTrees(repo, parentSha, head, commit.sha)
      if (result.conflictPaths.length > 0) {
        throw new AppError(422, `Rebase hit conflicts at ${commit.sha.slice(0, 10)} (${result.conflictPaths[0]}…); rebase locally and push`, 'rebase_conflict', {
          conflicts: result.conflictPaths,
        })
      }
      // Empty pick (change already upstream): skip rather than fabricate a commit.
      if (result.treeSha === repo.readCommit(head).tree) continue

      head = repo.writeCommit({
        tree: result.treeSha,
        parents: [head],
        author: {
          name: commit.author.name,
          email: commit.author.email,
        },
        committer,
        message: commit.message,
      })
    }
    return head
  }

  /** Required-checks hook (Phase 3 CI plugs in here). Never fakes success/failure. */
  private requiredChecksSatisfied(_project: ProjectRow): { ok: boolean; reason?: string } {
    // No pipeline system exists yet ⇒ there are no checks that can fail.
    return { ok: true, reason: 'no_checks_configured' }
  }

  private safeBlobText(repo: GitRepository, sha: string): string | null {
    const blob = repo.readBlob(sha)
    if (blob.length > 512 * 1024) return null
    if (blob.includes(0)) return null // binary
    try {
      return blob.toString('utf8')
    } catch {
      return null
    }
  }

  private get db() {
    return this.s.db
  }
}

/** Scratch space for multi-table updates inside update(); call-scoped lifetime. */
const pendingAssignees = new Map<number, number[]>()
const pendingLabels = new Map<number, number[]>()

// Re-export for routes.
export type { LabelRow }
