import { AppError } from './identity.js'
import type { IdentityServices } from './identity.js'
import type { AppConfig } from '../config.js'
import type { ProjectRow } from '../db/store.js'
import {
  extractMentions,
  extractTaskItems,
  isReactionName,
  normalizeHexColor,
  toggleTaskItem,
  taskProgress,
  type IssueRow,
  type IssueListResult,
  type ReactionName,
} from '../db/store.js'
import type { Actor } from '../authz.js'
import { can, type Permission } from '../authz.js'

/**
 * Issue-domain service (GitLab Issues behavior parity).
 *
 * All authorization flows through the central authz service; this layer
 * supplies resource context and performs effects. Activity is recorded as
 * SYSTEM NOTES so the timeline is one queryable stream (human comments +
 * system events ordered by insertion).
 */

const MAX_TITLE = 255
const MAX_DESCRIPTION = 10_000
const MAX_NOTE = 5_000
const MAX_LABELS_PER_ISSUE = 10
const MAX_ASSIGNEES = 10

export interface IssueCreateInput {
  title: string
  description?: string
  confidential?: boolean
  assignee_ids?: number[]
  labels?: string[]
  milestone_id?: number | null
  due_date?: string | null
}

export interface IssueUpdateInput extends Partial<IssueCreateInput> {
  state_event?: 'close' | 'reopen'
}

function requireText(raw: unknown, field: string, max: number): string {
  if (typeof raw !== 'string') throw new AppError(400, `${field} is required`)
  const v = raw.replace(/\r\n/g, '\n').trim()
  if (v.length === 0) throw new AppError(400, `${field} cannot be empty`)
  if (v.length > max) throw new AppError(400, `${field} exceeds ${max} characters`)
  return v
}

function requireDateOrNull(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  const v = String(raw)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())) {
    throw new AppError(400, `${field} must be an ISO date (YYYY-MM-DD)`)
  }
  return v
}

/** Resolves @username mentions to ACTIVE user ids (order-stable). */
export function resolveMentionIds(s: IdentityServices, texts: Array<string | null | undefined>): number[] {
  const usernames = new Set<string>()
  for (const t of texts) if (t) for (const u of extractMentions(t)) usernames.add(u)
  const ids: number[] = []
  for (const name of usernames) {
    const u = s.users.byUsername(name)
    if (u && u.state === 'active') ids.push(u.id)
  }
  return ids.sort((a, b) => a - b)
}

/** Extracts `#<iid>` references pointing at OTHER issues in the same project. */
function extractReferenceIids(text: string, excludeIid: number | null): number[] {
  const seen = new Set<number>()
  const pattern = /(?:^|[\s(])#(\d+)\b/g
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text)) !== null) {
    const n = Number(m[1])
    if (Number.isInteger(n) && n > 0 && n !== excludeIid) seen.add(n)
  }
  return [...seen].sort((a, b) => a - b)
}

export class IssuesService {
  constructor(private s: IdentityServices, private cfg: AppConfig) {}

  // -- authorization helpers --------------------------------------------------

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
    extraCtx: { resourceUserId?: number; closerId?: number } = {},
  ): void {
    const ok = can(actor, permission, {
      ...this.projectCtx(project),
      resourceUserId: extraCtx.resourceUserId,
      ...(extraCtx.closerId !== undefined
        ? { resourceProject: { ...this.projectCtx(project).resourceProject!, closerId: extraCtx.closerId } }
        : {}),
    })
    if (!ok) {
      throw new AppError(
        actor ? 403 : 401,
        actor ? 'You are not allowed to perform this action' : 'Authentication required',
        actor ? 'forbidden' : 'unauthenticated',
      )
    }
  }

  /** Loads a project the actor may read, or throws 404/401/403. */
  readableProject(actor: Actor | null, projectId: number): ProjectRow {
    const p = this.s.projects.byId(projectId)
    if (!p) throw new AppError(404, 'Project not found')
    this.authorize(actor, 'project:read', p)
    return p
  }

  private requireIssue(projectId: number, iid: number): IssueRow {
    const issue = this.s.issues.byIid(projectId, iid)
    if (!issue) throw new AppError(404, 'Issue not found')
    return issue
  }

  /** PERMISSIONS.md §6: confidential issues visible to author/assignee/reporter+/admin only. */
  canSeeConfidential(actor: Actor | null, issue: IssueRow): boolean {
    if (!issue.confidential) return true
    if (!actor) return false
    if (actor.admin) return true
    const project = this.s.projects.byId(issue.project_id)
    if (project && (project.owner_id === actor.userId)) return true
    return (
      issue.author_id === actor.userId ||
      this.s.issues.assigneeIds(issue.id).includes(actor.userId)
    )
  }

  visibleIssue(actor: Actor | null, projectId: number, iid: number): IssueRow {
    const project = this.readableProject(actor, projectId)
    void project
    const issue = this.requireIssue(projectId, iid)
    if (!this.canSeeConfidential(actor, issue)) throw new AppError(404, 'Issue not found')
    return issue
  }

  // -- input assembly ----------------------------------------------------------

  private resolveLabelsByTitle(projectId: number, titles: string[]): number[] {
    const unique = [...new Set(titles.map((t) => t.trim()).filter(Boolean))]
    if (unique.length > MAX_LABELS_PER_ISSUE) {
      throw new AppError(400, `An issue can have at most ${MAX_LABELS_PER_ISSUE} labels`)
    }
    const ids: number[] = []
    for (const t of unique) {
      const l = this.s.labels.byTitle(projectId, t)
      if (!l) throw new AppError(422, `Label "${t}" does not exist`, 'label_not_found')
      ids.push(l.id)
    }
    return ids
  }

  private resolveAssigneeIds(userIds: unknown): number[] {
    if (userIds === undefined || userIds === null) return []
    if (!Array.isArray(userIds)) throw new AppError(400, 'assignee_ids must be an array')
    const ids = userIds.map(Number)
    if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
      throw new AppError(400, 'assignee_ids must contain positive integers')
    }
    const unique = [...new Set(ids)]
    if (unique.length > MAX_ASSIGNEES) throw new AppError(400, `At most ${MAX_ASSIGNEES} assignees are supported`)
    for (const uid of unique) {
      const u = this.s.users.byId(uid)
      if (!u || u.state !== 'active') throw new AppError(422, `Assignee does not exist or is inactive`, 'invalid_assignee')
    }
    return unique
  }

  private resolveMilestone(projectId: number, milestoneId: unknown): number | null {
    if (milestoneId === undefined || milestoneId === null) return null
    const n = Number(milestoneId)
    if (!Number.isInteger(n) || n <= 0) throw new AppError(400, 'milestone_id must be a positive integer or null')
    const m = this.s.milestones.byId(n)
    if (!m || m.project_id !== projectId) throw new AppError(422, 'Milestone does not belong to this project', 'invalid_milestone')
    return n
  }

  // -- effects ---------------------------------------------------------------

  private recordActivity(issue: IssueRow, actor: Actor, note: string): void {
    this.s.notes.create({
      noteable_type: 'issue',
      noteable_id: issue.id,
      project_id: issue.project_id,
      author_id: actor.userId,
      note,
      system: true,
    })
  }

  private fanout(
    project: ProjectRow,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    this.s.events.emit(project.id, type, payload)
  }

  private crossReference(source: IssueRow, actor: Actor, text: string): void {
    for (const refIid of extractReferenceIids(text, source.iid)) {
      const target = this.s.issues.byIid(source.project_id, refIid)
      if (!target) continue
      this.recordActivity(target, actor, `mentioned in issue #${source.iid}`)
    }
  }

  create(actor: Actor, projectId: number, rawInput: IssueCreateInput): IssueRow {
    const project = this.readableProject(actor, projectId)
    if (project.archived) throw new AppError(422, 'Cannot create issues in an archived project')
    this.authorize(actor, 'issue:create', project)

    const title = requireText(rawInput.title, 'Title', MAX_TITLE)
    const description =
      rawInput.description === undefined || rawInput.description === null
        ? ''
        : String(rawInput.description).slice(0, MAX_DESCRIPTION)
    const milestoneId = rawInput.milestone_id
      ? this.resolveMilestone(projectId, rawInput.milestone_id)
      : null
    const assigneeIds = this.resolveAssigneeIds(rawInput.assignee_ids)
    const labelIds = this.resolveLabelsByTitle(projectId, rawInput.labels ?? [])
    const dueDate = requireDateOrNull(rawInput.due_date, 'due_date')

    const issue = this.s.db.transaction(() => {
      const row = this.s.issues.create({
        project_id: projectId,
        author_id: actor.userId,
        title,
        description,
        confidential: rawInput.confidential === true,
        milestone_id: milestoneId,
        due_date: dueDate,
      })
      if (assigneeIds.length > 0) this.s.issues.setAssignees(row.id, assigneeIds)
      if (labelIds.length > 0) this.s.labels.setForIssue(row.id, labelIds)
      return row
    })

    this.fanout(project, 'issue.opened', {
      action: 'opened',
      title,
      iid: issue.iid,
      actor_user_id: actor.userId,
      actor_username: actor.username,
      participant_user_ids: [actor.userId, ...assigneeIds],
      mentioned_user_ids: resolveMentionIds(this.s, [title, description]),
    })
    this.crossReference(issue, actor, description)
    return issue
  }

  update(actor: Actor, projectId: number, iid: number, rawInput: IssueUpdateInput): IssueRow {
    const project = this.readableProject(actor, projectId)
    const issue = this.requireIssue(projectId, iid)
    this.authorize(actor, 'issue:update', project, { resourceUserId: issue.author_id })

    const sets: Record<string, unknown> = {}
    const activities: string[] = []

    if (rawInput.title !== undefined) {
      const title = requireText(rawInput.title, 'Title', MAX_TITLE)
      if (title !== issue.title) {
        sets.title = title
        activities.push('changed title')
      }
    }
    if (rawInput.description !== undefined) {
      const d = String(rawInput.description ?? '').slice(0, MAX_DESCRIPTION)
      if (d !== issue.description) {
        sets.description = d
        // Description edits are silent (GitLab parity); mentions re-fanout below.
      }
    }
    if (rawInput.confidential !== undefined && rawInput.confidential !== !!issue.confidential) {
      this.authorize(actor, 'issue:set_metadata', project)
      sets.confidential = rawInput.confidential ? 1 : 0
      activities.push(rawInput.confidential ? 'made this issue confidential' : 'made this issue visible to everyone')
    }
    if (rawInput.due_date !== undefined) {
      const d = requireDateOrNull(rawInput.due_date, 'due_date')
      if (d !== issue.due_date) {
        sets.due_date = d
        activities.push(d ? `set due date to ${d}` : 'removed due date')
      }
    }
    if (rawInput.milestone_id !== undefined) {
      this.authorize(actor, 'issue:set_metadata', project)
      const m = this.resolveMilestone(projectId, rawInput.milestone_id)
      if (m !== issue.milestone_id) {
        sets.milestone_id = m
        if (m) {
          const row = this.s.milestones.byId(m)!
          activities.push(`set milestone to ${row.title}`)
        } else {
          activities.push('removed milestone')
        }
      }
    }
    if (rawInput.assignee_ids !== undefined) {
      this.authorize(actor, 'issue:set_metadata', project)
      const next = this.resolveAssigneeIds(rawInput.assignee_ids)
      const prev = this.s.issues.assigneeIds(issue.id)
      const usernameOf = (uid: number) => this.s.users.byId(uid)?.username ?? `user#${uid}`
      const added = next.filter((u) => !prev.includes(u)).map(usernameOf)
      const removed = prev.filter((u) => !next.includes(u)).map(usernameOf)
      if (added.length > 0) activities.push(`assigned to ${added.map((n) => `@${n}`).join(', ')}`)
      if (removed.length > 0) activities.push(`unassigned ${removed.map((n) => `@${n}`).join(', ')}`)
      pendingAssignees.set(issue.id, next)
    }
    if (rawInput.labels !== undefined) {
      this.authorize(actor, 'issue:set_metadata', project)
      const next = this.resolveLabelsByTitle(projectId, rawInput.labels)
      const prevRows = this.s.labels.rowsForIssue(issue.id)
      const prevTitles = new Map(prevRows.map((l) => [l.id, l.title]))
      const addedTitles = next.filter((id) => !prevTitles.has(id)).map((id) => this.s.labels.byId(id)!.title)
      const removedTitles = prevRows.filter((l) => !next.includes(l.id)).map((l) => l.title)
      if (addedTitles.length > 0) activities.push(`added ${addedTitles.map((t) => `~${t}`).join(' ')} labels`)
      if (removedTitles.length > 0) activities.push(`removed ${removedTitles.map((t) => `~${t}`).join(' ')} label${removedTitles.length === 1 ? '' : 's'}`)
      pendingLabels.set(issue.id, next)
    }

    // State transitions ride the same PATCH (GitLab state_event parity).
    let closedNow = false
    let reopenedNow = false
    if (rawInput.state_event === 'close') {
      this.authorize(actor, 'issue:close', project, { resourceUserId: issue.author_id })
      if (issue.state === 'opened') {
        sets.state = 'closed'
        sets.closed_at = new Date().toISOString()
        sets.closed_by_id = actor.userId
        closedNow = true
        activities.push('closed this issue')
      }
    } else if (rawInput.state_event === 'reopen') {
      this.authorize(actor, 'issue:reopen', project, {
        resourceUserId: issue.author_id,
        closerId: issue.closed_by_id ?? undefined,
      })
      if (issue.state === 'closed') {
        sets.state = 'opened'
        sets.closed_at = null
        sets.closed_by_id = null
        reopenedNow = true
        activities.push('reopened this issue')
      }
    }

    this.s.db.transaction(() => {
      if (Object.keys(sets).length > 0) this.s.issues.update(issue.id, sets as Partial<IssueRow>)
      const assignees = pendingAssignees.get(issue.id)
      if (assignees) this.s.issues.setAssignees(issue.id, assignees)
      const labels = pendingLabels.get(issue.id)
      if (labels) this.s.labels.setForIssue(issue.id, labels)
      for (const a of activities) this.recordActivity(issue, actor, a)
    })
    pendingAssignees.delete(issue.id)
    pendingLabels.delete(issue.id)

    const updated = this.requireIssue(projectId, iid)
    if (activities.length > 0 || sets.description !== undefined) {
      this.fanout(project, 'issue.updated', {
        action: closedNow ? 'closed' : reopenedNow ? 'reopened' : 'updated',
        title: updated.title,
        iid: updated.iid,
        actor_user_id: actor.userId,
        actor_username: actor.username,
        participant_user_ids: [
          updated.author_id,
          ...this.s.issues.assigneeIds(updated.id),
          ...(sets.closed_by_id !== undefined && sets.closed_by_id !== null ? [Number(sets.closed_by_id)] : []),
        ],
        mentioned_user_ids: resolveMentionIds(this.s, [
          typeof sets.title === 'string' ? sets.title : null,
          typeof sets.description === 'string' ? sets.description : null,
          ...activities,
        ]),
      })
    }
    return updated
  }

  close(actor: Actor, projectId: number, iid: number): IssueRow {
    return this.update(actor, projectId, iid, { state_event: 'close' })
  }

  reopen(actor: Actor, projectId: number, iid: number): IssueRow {
    return this.update(actor, projectId, iid, { state_event: 'reopen' })
  }

  delete(actor: Actor, projectId: number, iid: number): void {
    const project = this.readableProject(actor, projectId)
    const issue = this.requireIssue(projectId, iid)
    this.authorize(actor, 'issue:delete', project)
    this.s.db.transaction(() => {
      this.s.issues.delete(issue.id)
    })
    this.fanout(project, 'issue.deleted', {
      action: 'deleted',
      iid: issue.iid,
      actor_user_id: actor.userId,
    })
  }

  // -- task lists -----------------------------------------------------------------

  /**
   * Toggles the nth Markdown checkbox in the description. Completion state IS
   * the persisted `- [x]` marker (GitLab storage contract), so progress
   * survives any client and every read recomputes cheaply.
   */
  toggleTaskItem(actor: Actor, projectId: number, iid: number, index: number): {
    description: string
    progress: { total: number; completed: number }
  } {
    const project = this.readableProject(actor, projectId)
    const issue = this.requireIssue(projectId, iid)
    this.authorize(actor, 'issue:update', project, { resourceUserId: issue.author_id })

    if (!Number.isInteger(index) || index < 0) throw new AppError(400, 'index must be a non-negative integer')
    const items = extractTaskItems(issue.description)
    if (index >= items.length) throw new AppError(404, 'No such task item')

    const next = toggleTaskItem(issue.description, index)
    if (next === null) throw new AppError(404, 'No such task item')
    this.s.issues.update(issue.id, { description: next })
    const item = items[index]!
    this.recordActivity(issue, actor, `marked task '${item.text.slice(0, 80)}' ${item.checked ? 'incomplete' : 'complete'}`)
    return { description: next, progress: taskProgress(next) }
  }

  // -- comments ---------------------------------------------------------------------

  comment(actor: Actor, projectId: number, iid: number, body: string): import('../db/store.js').NoteRow {
    const project = this.readableProject(actor, projectId)
    const issue = this.visibleIssue(actor, projectId, iid)
    this.authorize(actor, 'issue:comment', project)
    const note = requireText(body, 'Comment', MAX_NOTE)
    const created = this.s.notes.create({
      noteable_type: 'issue',
      noteable_id: issue.id,
      project_id: issue.project_id,
      author_id: actor.userId,
      note,
    })
    this.crossReference(issue, actor, note)
    this.fanout(project, 'issue.commented', {
      action: 'commented',
      title: issue.title,
      iid: issue.iid,
      actor_user_id: actor.userId,
      actor_username: actor.username,
      participant_user_ids: [actor.userId, issue.author_id, ...this.s.issues.assigneeIds(issue.id)],
      mentioned_user_ids: resolveMentionIds(this.s, [note]),
      project_path: `${this.ownerUsernameOf(project)}/${project.path}`,
    })
    return created
  }

  editComment(actor: Actor, projectId: number, iid: number, noteId: number, body: string): void {
    const project = this.readableProject(actor, projectId)
    const note = this.s.notes.byId(noteId)
    if (!note || note.noteable_type !== 'issue' || note.project_id !== projectId) {
      throw new AppError(404, 'Comment not found')
    }
    if (note.system) throw new AppError(422, 'System notes cannot be edited')
    const isOwnerOrAdmin = actor.admin || project.owner_id === actor.userId
    if (note.author_id !== actor.userId && !isOwnerOrAdmin) {
      throw new AppError(403, 'You can only edit your own comments')
    }
    this.s.notes.update(noteId, requireText(body, 'Comment', MAX_NOTE))
  }

  deleteComment(actor: Actor, projectId: number, iid: number, noteId: number): void {
    const project = this.readableProject(actor, projectId)
    const note = this.s.notes.byId(noteId)
    if (!note || note.noteable_type !== 'issue' || note.project_id !== projectId) {
      throw new AppError(404, 'Comment not found')
    }
    if (note.system) throw new AppError(422, 'System notes cannot be deleted')
    const isOwnerOrAdmin = actor.admin || project.owner_id === actor.userId
    if (note.author_id !== actor.userId && !isOwnerOrAdmin) {
      throw new AppError(403, 'You can only delete your own comments')
    }
    this.s.notes.delete(noteId)
  }

  // -- reactions ----------------------------------------------------------------------

  toggleReaction(
    actor: Actor,
    projectId: number,
    targetType: 'issue' | 'note',
    targetId: number,
    rawName: unknown,
  ): 'awarded' | 'revoked' {
    const project = this.readableProject(actor, projectId)
    void project
    this.authorize(actor, 'issue:comment', project) // reacting is guest-level participation
    if (!isReactionName(rawName)) {
      throw new AppError(400, `name must be one of the supported emoji identifiers`)
    }
    this.assertReactableTarget(projectId, targetType, targetId)
    return this.s.reactions.toggle(actor.userId, targetType, targetId, rawName as ReactionName)
  }

  private assertReactableTarget(projectId: number, targetType: 'issue' | 'note', targetId: number): void {
    if (targetType === 'issue') {
      const issue = this.s.issues.byId(targetId)
      if (!issue || issue.project_id !== projectId) throw new AppError(404, 'Issue not found')
      return
    }
    const note = this.s.notes.byId(targetId)
    if (!note || note.project_id !== projectId) throw new AppError(404, 'Comment not found')
  }

  /** Route-level guard: a note reaction must address a note ON this issue. */
  assertNoteInIssue(projectId: number, issueId: number, noteId: number): void {
    const note = this.s.notes.byId(noteId)
    if (!note || note.noteable_type !== 'issue' || note.project_id !== projectId || note.noteable_id !== issueId) {
      throw new AppError(404, 'Comment not found on this issue')
    }
  }

  // -- listing ---------------------------------------------------------------------------

  listIssues(
    actor: Actor | null,
    projectId: number,
    filters: Parameters<IdentityServices['issues']['listFiltered']>[1],
  ): IssueListResult {
    const project = this.readableProject(actor, projectId)
    void project
    // Confidentiality filtering (PERMISSIONS.md §6) applied inside the query.
    const unrestricted = actor ? actor.admin || project.owner_id === actor.userId : false
    return this.s.issues.listFiltered(projectId, {
      ...filters,
      viewerId: actor?.userId ?? null,
      unrestrictedConfidential: unrestricted,
    })
  }

  private ownerUsernameOf(project: ProjectRow): string {
    return this.s.users.byId(project.owner_id)?.username ?? ''
  }

  // -- labels -------------------------------------------------------------------------------

  createLabel(
    actor: Actor,
    projectId: number,
    input: { title: unknown; description?: unknown; color?: unknown },
  ) {
    const project = this.readableProject(actor, projectId)
    this.authorize(actor, 'labels:maintain', project)
    const title = requireText(input.title, 'Label name', 64)
    if (this.s.labels.byTitle(projectId, title)) {
      throw new AppError(409, 'Label has already been taken', 'taken')
    }
    const colorRaw = typeof input.color === 'string' && input.color.trim() !== '' ? input.color : '#8a8a8a'
    const color = normalizeHexColor(colorRaw)
    if (!color) throw new AppError(400, 'color must be a hex value like #rrggbb')
    const description = String(input.description ?? '').slice(0, 500)
    return this.s.labels.create({ project_id: projectId, title, description, color })
  }

  updateLabel(
    actor: Actor,
    projectId: number,
    labelId: number,
    input: { title?: unknown; description?: unknown; color?: unknown },
  ) {
    const project = this.readableProject(actor, projectId)
    this.authorize(actor, 'labels:maintain', project)
    const label = this.s.labels.byId(labelId)
    if (!label || label.project_id !== projectId) throw new AppError(404, 'Label not found')
    const fields: Record<string, unknown> = {}
    if (input.title !== undefined) {
      const title = requireText(input.title, 'Label name', 64)
      const clash = this.s.labels.byTitle(projectId, title)
      if (clash && clash.id !== labelId) throw new AppError(409, 'Label has already been taken', 'taken')
      fields.title = title
    }
    if (input.description !== undefined) fields.description = String(input.description ?? '').slice(0, 500)
    if (input.color !== undefined) {
      const color = normalizeHexColor(input.color)
      if (!color) throw new AppError(400, 'color must be a hex value like #rrggbb')
      fields.color = color
    }
    this.s.labels.update(labelId, fields as never)
    return this.s.labels.byId(labelId)!
  }

  deleteLabel(actor: Actor, projectId: number, labelId: number): void {
    const project = this.readableProject(actor, projectId)
    this.authorize(actor, 'labels:maintain', project)
    const label = this.s.labels.byId(labelId)
    if (!label || label.project_id !== projectId) throw new AppError(404, 'Label not found')
    // Detach happens via ON DELETE CASCADE on issue_labels.
    this.s.labels.delete(labelId)
  }

  // -- milestones ------------------------------------------------------------------------------

  createMilestone(
    actor: Actor,
    projectId: number,
    input: { title: unknown; description?: unknown; due_date?: unknown },
  ) {
    const project = this.readableProject(actor, projectId)
    this.authorize(actor, 'milestones:maintain', project)
    const title = requireText(input.title, 'Milestone title', 128)
    if (this.s.milestones.byTitle(projectId, title)) {
      throw new AppError(409, 'Milestone title has already been taken', 'taken')
    }
    const due = requireDateOrNull(input.due_date, 'due_date')
    const description = String(input.description ?? '').slice(0, 2000)
    return this.s.milestones.create({ project_id: projectId, title, description, due_date: due })
  }

  updateMilestone(
    actor: Actor,
    projectId: number,
    milestoneId: number,
    input: { title?: unknown; description?: unknown; due_date?: unknown; state_event?: unknown },
  ) {
    const project = this.readableProject(actor, projectId)
    this.authorize(actor, 'milestones:maintain', project)
    const m = this.s.milestones.byId(milestoneId)
    if (!m || m.project_id !== projectId) throw new AppError(404, 'Milestone not found')
    const fields: Record<string, unknown> = {}
    if (input.title !== undefined) {
      const title = requireText(input.title, 'Milestone title', 128)
      const clash = this.s.milestones.byTitle(projectId, title)
      if (clash && clash.id !== milestoneId) throw new AppError(409, 'Milestone title has already been taken', 'taken')
      fields.title = title
    }
    if (input.description !== undefined) fields.description = String(input.description ?? '').slice(0, 2000)
    if (input.due_date !== undefined) fields.due_date = requireDateOrNull(input.due_date, 'due_date')
    if (input.state_event !== undefined) {
      if (input.state_event === 'close') fields.state = 'closed'
      else if (input.state_event === 'activate') fields.state = 'active'
      else throw new AppError(400, "state_event must be 'close' or 'activate'")
    }
    this.s.milestones.update(milestoneId, fields as never)
    return this.s.milestones.byId(milestoneId)!
  }

  deleteMilestone(actor: Actor, projectId: number, milestoneId: number): void {
    const project = this.readableProject(actor, projectId)
    this.authorize(actor, 'milestones:maintain', project)
    const m = this.s.milestones.byId(milestoneId)
    if (!m || m.project_id !== projectId) throw new AppError(404, 'Milestone not found')
    this.s.milestones.delete(milestoneId) // linked issues auto-unlink (SET NULL)
  }
}

/**
 * Scratch space for multi-table updates inside `update()`; entries live only
 * for the duration of the call (single-threaded event loop ⇒ safe module scope).
 */
const pendingAssignees = new Map<number, number[]>()
const pendingLabels = new Map<number, number[]>()
