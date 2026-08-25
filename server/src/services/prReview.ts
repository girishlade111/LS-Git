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

  // ── suggestions ──────────────────────────────────────────────────────────

  /**
   * Applicability at the CURRENT tip: file exists AND the covered range still
   * contains exactly the lines snapshotted at creation. Stale suggestions
   * REFUSE instead of editing the wrong region after upstream shifts.
   */
  private threadApplicability(pr: PullRequestRow, thread: PrThreadRow, srcTip: string): {
    outdated: boolean
    reason?: string
  } {
    const project = this.s.projects.byId(pr.project_id)!
    if (thread.side !== 'new') return { outdated: true, reason: 'old-side threads cannot carry suggestions' }
    const repo = this.engineFor(project)
    const blobSha = repo.findEntryAt(repo.readCommit(srcTip).tree, thread.path)?.sha ?? null
    if (!blobSha) return { outdated: true, reason: 'file missing at source tip' }
    const text = repo.readBlob(blobSha).toString('utf8')
    const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
    if (thread.line_end > lines.length) return { outdated: true, reason: 'range out of bounds after update' }
    const current = lines.slice(thread.line_start - 1, thread.line_end).join('\n')
    let covered: string[] = []
    try { covered = JSON.parse(thread.covered_lines) as string[] } catch { covered = [] }
    if (current !== covered.join('\n')) return { outdated: true, reason: 'covered lines changed since review' }
    return { outdated: false }
  }

  /** Applies ONE suggestion as its own commit on the PR source branch. */
  applySuggestion(actor: Actor, projectId: number, iid: number, threadNoteId: number): { commit_sha: string } {
    const project = this.s.projects.byId(projectId)!
    const pr = this.visiblePr(actor, projectId, iid)
    this.authorizePushLevel(actor, project)
    if (pr.state === 'merged') throw new AppError(422, 'Merged pull requests are immutable', 'merged_immutable')

    const plan = this.validateSuggestionsForApply(pr, [threadNoteId])
    const entry = plan.entries[0]!
    const commit = this.commitChangesToSource(
      pr,
      actor,
      [{ path: entry.path, content: entry.content }],
      'Apply suggestion from !' + pr.iid + ' (' + entry.path + ')',
    )

    this.s.db.transaction(() => {
      for (const n of plan.notes) this.s.prThreadNotes.setStatus(n.id, 'applied', commit)
      this.recordSystemNote(pr, actor, 'applied a suggestion to ' + entry.path + ' (' + commit.slice(0, 10) + ')')
    })
    return { commit_sha: commit }
  }

  /**
   * Batch apply: ALL suggestions validate first (against evolving file state,
   * composed bottom-up per path), then land as ONE atomic commit. Any failure
   * means 422 with per-item reasons and NOTHING is committed.
   */
  batchApplySuggestions(actor: Actor, projectId: number, iid: number, rawIds: unknown): { commit_sha: string; applied: number } {
    const project = this.s.projects.byId(projectId)!
    const pr = this.visiblePr(actor, projectId, iid)
    this.authorizePushLevel(actor, project)
    if (pr.state === 'merged') throw new AppError(422, 'Merged pull requests are immutable', 'merged_immutable')

    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      throw new AppError(400, 'suggestion_note_ids must be a non-empty array')
    }
    const ids = [...new Set(rawIds.map(Number))]
    if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
      throw new AppError(400, 'suggestion_note_ids must contain positive integers')
    }

    const plan = this.validateSuggestionsForApply(pr, ids)
    const message =
      plan.entries.length === 1
        ? 'Apply suggestion from !' + pr.iid + ' (' + plan.entries[0]!.path + ')'
        : 'Apply ' + plan.entries.length + ' suggestions from !' + pr.iid
    const commit = this.commitChangesToSource(
      pr,
      actor,
      plan.entries.map((e) => ({ path: e.path, content: e.content })),
      message,
    )

    this.s.db.transaction(() => {
      for (const n of plan.notes) this.s.prThreadNotes.setStatus(n.id, 'applied', commit)
      this.recordSystemNote(pr, actor, 'applied ' + plan.entries.length + ' suggestion' + (plan.entries.length === 1 ? '' : 's') + ' (' + commit.slice(0, 10) + ')')
    })
    return { commit_sha: commit, applied: plan.entries.length }
  }

  rejectSuggestion(actor: Actor, projectId: number, iid: number, threadNoteId: number): void {
    const project = this.s.projects.byId(projectId)!
    const pr = this.visiblePr(actor, projectId, iid)
    const note = this.s.prThreadNotes.byId(threadNoteId)
    const thread = note ? this.s.prThreads.byId(note.thread_id) : undefined
    if (!note || !thread || thread.pr_id !== pr.id) throw new AppError(404, 'Suggestion not found')
    if (note.suggestion_status !== 'pending') throw new AppError(422, 'Only pending suggestions can be rejected')

    const maintainer = can(actor, 'issue:set_metadata', {
      resourceProject: { ownerId: project.owner_id, visibility: project.visibility },
    })
    if (note.author_id !== actor.userId && !maintainer) {
      throw new AppError(403, 'Only the suggestion author or a maintainer can reject it')
    }
    this.s.prThreadNotes.setStatus(threadNoteId, 'rejected')
    this.recordSystemNote(pr, actor, 'rejected a suggestion')
  }

  private validateSuggestionsForApply(pr: PullRequestRow, noteIds: number[]): {
    entries: Array<{ path: string; content: string }>
    notes: Array<{ id: number }>
  } {
    const project = this.s.projects.byId(pr.project_id)!
    const repo = this.engineFor(project)
    const srcTip = repo.resolveBranch(pr.source_branch)
    if (!srcTip) throw new AppError(422, 'Source branch no longer exists', 'source_branch_missing')

    const jobs: Job[] = []
    const failures: Array<{ id: number; reason: string }> = []

    for (const noteId of noteIds) {
      const note = this.s.prThreadNotes.byId(noteId)
      const thread = note ? this.s.prThreads.byId(note.thread_id) : undefined
      if (!note || !thread || thread.pr_id !== pr.id) {
        failures.push({ id: noteId, reason: 'not found' }); continue
      }
      if (note.suggestion_status !== 'pending' || !note.suggestion_lines) {
        failures.push({ id: noteId, reason: 'suggestion is not pending' }); continue
      }
      const applicability = this.threadApplicability(pr, thread, srcTip)
      if (applicability.outdated) {
        failures.push({ id: noteId, reason: 'outdated: ' + applicability.reason }); continue
      }
      let replacement: string[]
      try { replacement = JSON.parse(note.suggestion_lines) as string[] } catch {
        failures.push({ id: noteId, reason: 'corrupt suggestion payload' }); continue
      }
      let covered: string[] = []
      try { covered = JSON.parse(thread.covered_lines) as string[] } catch { covered = [] }
      jobs.push({ noteId, path: thread.path, start: thread.line_start, end: thread.line_end, covered, replacement })
    }
    if (failures.length > 0) {
      throw new AppError(422, 'Some suggestions cannot be applied', 'suggestions_not_applicable', { failures })
    }

    // Compose per path bottom-up so overlapping ranges stay consistent.
    const byPath = new Map<string, Job[]>()
    for (const j of jobs) {
      const list = byPath.get(j.path) ?? []
      list.push(j)
      byPath.set(j.path, list)
    }
    const entries: Array<{ path: string; content: string }> = []
    for (const [path, list] of byPath) {
      const blobSha = repo.findEntryAt(repo.readCommit(srcTip).tree, path)?.sha ?? null
      if (!blobSha) throw new AppError(422, "'" + path + "' disappeared while applying suggestions", 'suggestions_not_applicable')
      let lines = repo.readBlob(blobSha).toString('utf8').replace(/\n$/, '').split('\n')
      for (const job of [...list].sort((a, b) => b.start - a.start)) {
        const r = applyRange(lines, job)
        if (!r.ok) {
          throw new AppError(422, "Cannot apply suggestion to '" + path + "': " + r.reason, 'suggestions_not_applicable', {
            failures: [{ id: job.noteId, reason: r.reason }],
          })
        }
        lines = r.lines
      }
      entries.push({ path, content: lines.length > 0 ? lines.join('\n') + '\n' : '' })
    }
    return { entries, notes: jobs.map((j) => ({ id: j.noteId })) }
  }

  /** REAL git commit onto the PR source branch via the core engine. */
  private commitChangesToSource(
    pr: PullRequestRow,
    actor: Actor,
    changes: Array<{ path: string; content: string }>,
    message: string,
  ): string {
    const project = this.s.projects.byId(pr.project_id)!
    const repo = this.engineFor(project)
    const result = repo.applyChangesToBranch({
      baseBranch: pr.source_branch,
      targetBranch: pr.source_branch,
      message,
      identity: (() => {
        const u = this.s.users.byId(actor.userId)
        return { name: u?.name || u?.username || actor.username, email: actor.username + '@users.lsgit.local' }
      })(),
      changes: changes.map((c) => ({ path: c.path, content: c.content, mode: '100644' as const })),
    })
    // Keep the PR's seen-sha bookkeeping in lockstep with this push.
    this.s.pullRequests.update(pr.id, { seen_source_sha: result.commitSha })
    return result.commitSha
  }

  private loadCodeOwnerRules(project: ProjectRow): CodeOwnerRule[] {
    try {
      const repo = this.engineFor(project)
      const tip = repo.resolveBranch(project.default_branch)
      if (!tip) return []
      const sha = repo.findEntryAt(repo.readCommit(tip).tree, 'CODEOWNERS')?.sha
        ?? repo.findEntryAt(repo.readCommit(tip).tree, '.lsgit/CODEOWNERS')?.sha
      if (!sha) return []
      const parsed = parseCodeOwners(repo.readBlob(sha).toString('utf8'))
      return parsed.rules
    } catch {
      return []
    }
  }

  codeownersCoverage(actor: Actor | null, projectId: number, iid: number) {
    const pr = this.visiblePr(actor, projectId, iid)
    const project = this.s.projects.byId(projectId)!
    const rules = this.loadCodeOwnerRules(project)
    const repo = this.engineFor(project)
    const srcTip = repo.resolveBranch(pr.source_branch)
    const files = srcTip
      ? [...repo.flattenTree(repo.readCommit(srcTip).tree).keys()].filter((p) => !p.startsWith('.lsgit/') && p !== 'CODEOWNERS')
      : []
    return {
      rules,
      coverage: files.map((p) => {
        const o = ownersForPath(rules, p)
        return { path: p, owner_users: o.users, owner_unresolved: o.unresolved }
      }),
    }
  }

  // ── reviews & drafts ──────────────────────────────────────────────────────

  /**
   * Approval bookkeeping sync: when the source tip moves past the sha the
   * review machinery last saw AND policy requires it, accumulated approvals
   * are reset exactly once. Called from refresh paths and merge.
   */
  syncSeenSourceSha(pr: PullRequestRow, actorForNote?: Actor): void {
    const project = this.s.projects.byId(pr.project_id)!
    if (pr.state !== 'opened') return
    let srcTip: string | null = null
    try {
      const repo = this.engineFor(project)
      srcTip = repo.resolveBranch(pr.source_branch)
    } catch { return }
    if (!srcTip || pr.seen_source_sha === srcTip) {
      if (srcTip && pr.seen_source_sha !== srcTip) {
        this.s.pullRequests.update(pr.id, { seen_source_sha: srcTip })
      }
      return
    }
    if (project.reset_approvals_on_push) {
      this.s.db.transaction(() => {
        this.s.pullRequests.setApprovalsReset(pr.id)
        for (const r of this.s.pullRequests.reviewers(pr.id)) {
          this.s.pullRequests.setReviewerState(pr.id, r.userId, 'unreviewed')
        }
        if (actorForNote) {
          this.recordSystemNote(
            { ...pr, seen_source_sha: null } as PullRequestRow,
            actorForNote,
            'approvals were reset because new commits were pushed',
          )
        }
      })
    }
    this.s.pullRequests.update(pr.id, { seen_source_sha: srcTip })
  }

  submitReview(
    actor: Actor,
    projectId: number,
    iid: number,
    input: { state?: unknown; body?: unknown },
  ): { review: ReturnType<IdentityServices['prReviews']['byId']>; published_drafts: number } {
    const project = this.s.projects.byId(projectId)!
    const pr = this.visiblePr(actor, projectId, iid)
    this.commentGate(actor, project)

    const state = String(input.state ?? '')
    if (!['approved', 'changes_requested', 'commented'].includes(state)) {
      throw new AppError(400, "state must be 'approved', 'changes_requested' or 'commented'")
    }
    if (state === 'approved' && pr.author_id === actor.userId) {
      throw new AppError(422, 'Authors cannot approve their own pull requests', 'self_approval_denied')
    }
    if (pr.state !== 'opened') throw new AppError(422, 'Reviews can only be submitted on open pull requests')

    const summaryBody = typeof input.body === 'string' && input.body.trim() !== ''
      ? input.body.trim().slice(0, MAX_BODY)
      : null

    // Publish THIS user's draft comments: positioned ones become threads,
    // unpositioned ones become plain timeline comments.
    const drafts = this.s.prDrafts.listForAuthor(pr.id, actor.userId)
    const headSha = (() => {
      try { return this.tips(pr).srcTip } catch { return pr.seen_source_sha ?? '' }
    })()

    this.s.db.transaction(() => {
      for (const d of drafts) {
        const body = this.assertBody(d.body)
        if (d.path && d.side && d.line_start !== null && d.line_end !== null) {
          const existing = this.findOpenThreadAtPosition(pr.id, d.path, d.side, d.line_start, d.line_end, headSha)
          if (existing) {
            this.s.prThreadNotes.create({
              thread_id: existing.id,
              project_id: projectId,
              author_id: actor.userId,
              body,
              suggestionLines: extractSuggestion(body),
            })
          } else {
            // Position validated lazily by createThread-like checks; reuse raw
            // insert to avoid re-reading tips inside the transaction.
            const covered = this.coveredLinesAt(pr, d)
            const t = this.s.prThreads.create({
              pr_id: pr.id,
              project_id: projectId,
              path: d.path,
              side: d.side as 'new' | 'old',
              line_start: d.line_start!,
              line_end: d.line_end!,
              base_sha: covered.base,
              head_sha: covered.head,
              covered_lines: covered.lines,
            })
            this.s.prThreadNotes.create({
              thread_id: t.id,
              project_id: projectId,
              author_id: actor.userId,
              body,
              suggestionLines: extractSuggestion(body),
            })
          }
        } else {
          this.s.notes.create({
            noteable_type: 'pull_request',
            noteable_id: pr.id,
            project_id: projectId,
            author_id: actor.userId,
            note: body,
          })
        }
      }

      const review = this.s.prReviews.insert({
        pr_id: pr.id,
        project_id: projectId,
        reviewer_id: actor.userId,
        state: state as 'approved' | 'changes_requested' | 'commented',
        head_sha: headSha,
        body: summaryBody,
      })

      if (state === 'approved') {
        this.s.pullRequests.approve(pr.id, actor.userId)
        this.s.pullRequests.setReviewerState(pr.id, actor.userId, 'approved')
        this.recordSystemNote(pr, actor, summaryBody ? 'approved this pull request' : 'approved this pull request')
      } else if (state === 'changes_requested') {
        this.s.pullRequests.unapprove(pr.id, actor.userId)
        this.s.pullRequests.setReviewerState(pr.id, actor.userId, 'changes_requested')
        this.recordSystemNote(pr, actor, 'requested changes')
      }

      this.s.prDrafts.deleteAllForAuthor(pr.id, actor.userId)
      void review
    })

    const latest = this.s.prReviews.latestPerReviewer(pr.id).find((r) => r.reviewer_id === actor.userId) ?? null
    return {
      review: latest,
      published_drafts: drafts.length,
    }
  }

  private findOpenThreadAtPosition(prId: number, path: string, side: string, start: number, end: number, headSha: string): PrThreadRow | null {
    for (const t of this.s.prThreads.listForPr(prId)) {
      if (
        t.path === path && t.side === side &&
        t.line_start === start && t.line_end === end &&
        t.head_sha === headSha && !t.resolved
      ) return t
    }
    return null
  }

  private coveredLinesAt(pr: PullRequestRow, d: { path: string; side: string | null }): { base: string; head: string; lines: string[] } {
    try {
      const project = this.s.projects.byId(pr.project_id)!
      const repo = this.engineFor(project)
      const { srcTip, baseSha } = this.tips(pr)
      const atSha = d.side === 'old' ? baseSha : srcTip
      const sha = atSha ? repo.findEntryAt(repo.readCommit(atSha).tree, d.path)?.sha ?? null : null
      if (!sha) throw new AppError(422, "Draft path '" + d.path + "' no longer exists in the diff", 'invalid_position')
      const text = repo.readBlob(sha).toString('utf8')
      const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
      if (d.line_start === null || d.line_end === null || d.line_start < 1 || d.line_end > lines.length) {
        throw new AppError(422, 'Draft line range is now invalid — discard or edit it', 'invalid_position')
      }
      return {
        base: baseSha,
        head: srcTip,
        lines: lines.slice(d.line_start - 1, d.line_end),
      }
    } catch (err) {
      if (err instanceof AppError) throw err
      throw new AppError(422, 'Draft position could not be validated', 'invalid_position')
    }
  }

  listReviews(actor: Actor | null, projectId: number, iid: number) {
    const pr = this.visiblePr(actor, projectId, iid)
    const latest = this.s.prReviews.latestPerReviewer(pr.id)
    return {
      reviews: latest.map((r) => ({
        id: r.id,
        reviewer: this.userBrief(r.reviewer_id),
        state: r.state,
        head_sha: r.head_sha,
        body: r.body,
        submitted_at: r.submitted_at,
      })),
    }
  }

  // ── draft comments ────────────────────────────────────────────────────────

  addDraft(actor: Actor, projectId: number, iid: number, input: Record<string, unknown>) {
    const project = this.s.projects.byId(projectId)!
    const pr = this.visiblePr(actor, projectId, iid)
    this.commentGate(actor, project)
    const body = this.assertBody(input.body)
    return this.s.prDrafts.create({
      pr_id: pr.id,
      author_id: actor.userId,
      body,
      path: typeof input.path === 'string' ? input.path : null,
      side: input.side === 'old' ? 'old' : input.side === 'new' ? 'new' : null,
      line_start: input.line_start === undefined ? null : Number(input.line_start),
      line_end: input.line_end === undefined ? null : Number(input.line_end),
    })
  }

  listDrafts(actor: Actor, projectId: number, iid: number) {
    const pr = this.visiblePr(actor, projectId, iid)
    return { drafts: this.s.prDrafts.listForAuthor(pr.id, actor.userId) }
  }

  updateDraft(actor: Actor, projectId: number, iid: number, draftId: number, patch: Record<string, unknown>): void {
    const pr = this.visiblePr(actor, projectId, iid)
    const d = this.s.prDrafts.byId(draftId)
    if (!d || d.pr_id !== pr.id || d.author_id !== actor.userId) throw new AppError(404, 'Draft not found')
    const fields: Record<string, unknown> = {}
    if (patch.body !== undefined) fields.body = this.assertBody(patch.body)
    if (patch.path !== undefined) fields.path = typeof patch.path === 'string' ? patch.path : null
    if (patch.line_start !== undefined) fields.line_start = patch.line_start === null ? null : Number(patch.line_start)
    if (patch.line_end !== undefined) fields.line_end = patch.line_end === null ? null : Number(patch.line_end)
    this.s.prDrafts.update(draftId, fields as never)
  }

  deleteDraft(actor: Actor, projectId: number, iid: number, draftId: number): void {
    const pr = this.visiblePr(actor, projectId, iid)
    if (!this.s.prDrafts.deleteOwn(draftId, actor.userId)) {
      const d = this.s.prDrafts.byId(draftId)
      if (!d || d.pr_id !== pr.id) throw new AppError(404, 'Draft not found')
      throw new AppError(403, 'You can only delete your own drafts')
    }
  }
}
