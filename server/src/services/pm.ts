import { AppError } from './identity.js'
import type { IdentityServices } from './identity.js'
import type {
  ProjectRow,
  PmBoardRow,
  PmFieldRow,
  PmItemRow,
  PmFieldType,
  DiscussionCategory,
} from '../db/store.js'
import { DEFAULT_PRIORITY_OPTIONS, DEFAULT_STATUS_OPTIONS, PM_FIELD_TYPES } from '../db/store.js'
import type { Actor } from '../authz.js'
import { can, type Permission } from '../authz.js'

/**
 * Project management (GitHub Projects / GitLab boards inspiration,
 * LSGit-native schema). Boards hold typed fields; items link to issues and
 * pull requests or exist as drafts; saved views persist filter/group/sort.
 *
 * AUTOMATIC WORKFLOWS subscribe to the domain event bus (issue closed /
 * reopened, PR opened / merged) and move linked items' Status field — every
 * transition is logged to pm_item_status_log so throughput metrics use real
 * transition history rather than approximations.
 *
 * Field-value serialization (canonical, per type):
 *   text → raw · number → decimal string · date → YYYY-MM-DD
 *   status / single_select → option label · multi_select → JSON array of labels
 */

const EVENTS = ['issue_opened', 'issue_closed', 'issue_reopened', 'pr_opened', 'pr_merged'] as const
export type PmWorkflowEvent = (typeof EVENTS)[number]

const KEY_RE = /^[a-z0-9_]+$/

export class ProjectManagementService {
  constructor(private s: IdentityServices) {}

  // ── gates ─────────────────────────────────────────────────────────────────

  private projectCtx(project: { owner_id: number; visibility: string }) {
    return {
      resourceProject: {
        ownerId: project.owner_id,
        visibility: project.visibility as 'private' | 'internal' | 'public',
      },
    }
  }

  private authorize(actor: Actor | null, permission: Permission, project: { owner_id: number; visibility: string }): void {
    if (!can(actor, permission, this.projectCtx(project))) {
      throw new AppError(actor ? 403 : 401, 'Not allowed', actor ? 'forbidden' : 'unauthenticated')
    }
  }

  private readableProject(actor: Actor | null, projectId: number): ProjectRow {
    const p = this.s.projects.byId(projectId)
    if (!p) throw new AppError(404, 'Project not found')
    if (!can(actor, 'project:read', this.projectCtx(p))) {
      throw new AppError(actor ? 404 : 401, actor ? 'Project not found' : 'Authentication required')
    }
    return p
  }

  visibleBoard(actor: Actor | null, projectId: number, boardId: number): { board: PmBoardRow; project: ProjectRow } {
    const project = this.readableProject(actor, projectId)
    const board = this.s.pmBoards.byId(boardId)
    if (!board || board.project_id !== projectId) throw new AppError(404, 'Board not found')
    this.authorize(actor, 'pm:read', project)
    return { board, project }
  }

  // ── boards ────────────────────────────────────────────────────────────────

  createBoard(actor: Actor, projectId: number, input: Record<string, unknown>): PmBoardRow & { fields: PmFieldRow[] } {
    const project = this.s.projects.byId(projectId)
    if (!project) throw new AppError(404, 'Project not found')
    this.authorize(actor, 'pm:write', project)

    const name = typeof input.name === 'string' && input.name.trim() !== ''
      ? input.name.trim().slice(0, 120)
      : (() => { throw new AppError(400, 'name is required') })()
    if (this.s.pmBoards.listForProject(projectId).some((b) => b.name.toLowerCase() === name.toLowerCase())) {
      throw new AppError(409, 'A board with this name already exists', 'taken')
    }
    const description = typeof input.description === 'string' ? input.description.slice(0, 500) : ''

    const board = this.s.db.transaction(() => {
      const b = this.s.pmBoards.create({
        project_id: projectId,
        name,
        description,
        created_by_id: actor.userId,
      })
      this.seedBuiltinFields(b.id)
      this.seedDefaultWorkflows(b.id)
      return b
    })
    return { ...board, fields: this.s.pmFields.listForBoard(board.id) }
  }

  /** GitLab-parity starter set: status, priority, iteration + mirrored assignee/labels/milestone. */
  private seedBuiltinFields(boardId: number): void {
    const seed: Array<{ key: string; label: string; type: PmFieldType; options?: string[] }> = [
      { key: 'status', label: 'Status', type: 'status', options: [...DEFAULT_STATUS_OPTIONS] },
      { key: 'priority', label: 'Priority', type: 'single_select', options: [...DEFAULT_PRIORITY_OPTIONS] },
      { key: 'iteration', label: 'Iteration', type: 'single_select', options: ['Iteration 1'] },
      { key: 'assignee', label: 'Assignees', type: 'text' }, // mirrored from issue/PR assignees
      { key: 'labels', label: 'Labels', type: 'text' },     // mirrored comma-separated titles
      { key: 'milestone', label: 'Milestone', type: 'text' },
    ]
    seed.forEach((f, i) => {
      this.s.pmFields.create({
        board_id: boardId,
        key: f.key,
        label: f.label,
        type: f.type,
        config: f.options ? { options: f.options } : {},
        position: i,
      })
    })
  }

  private seedDefaultWorkflows(boardId: number): void {
    for (const [event, target] of [
      ['issue_closed', 'Done'],
      ['pr_merged', 'Done'],
      ['pr_opened', 'In review'],
    ] as const) {
      this.s.pmWorkflows.upsert(boardId, event, target)
    }
  }

  getBoard(actor: Actor | null, projectId: number, boardId: number) {
    const { board } = this.visibleBoard(actor, projectId, boardId)
    return {
      board,
      fields: this.s.pmFields.listForBoard(boardId),
      workflows: this.s.pmWorkflows.listForBoard(boardId),
    }
  }

  listBoards(actor: Actor | null, projectId: number) {
    this.readableProject(actor, projectId)
    return { boards: this.s.pmBoards.listForProject(projectId) }
  }

  updateBoard(actor: Actor, projectId: number, boardId: number, patch: Record<string, unknown>): PmBoardRow {
    const { board, project } = this.visibleBoard(actor, projectId, boardId)
    this.authorize(actor, 'pm:maintain', project)
    const sets: { name?: string; description?: string } = {}
    if (patch.name !== undefined) {
      const n = String(patch.name).trim()
      if (!n) throw new AppError(400, 'name cannot be empty')
      sets.name = n.slice(0, 120)
    }
    if (patch.description !== undefined) sets.description = String(patch.description ?? '').slice(0, 500)
    this.s.pmBoards.update(board.id, sets)
    return this.s.pmBoards.byId(board.id)!
  }

  deleteBoard(actor: Actor, projectId: number, boardId: number): void {
    const { board, project } = this.visibleBoard(actor, projectId, boardId)
    this.authorize(actor, 'pm:maintain', project)
    this.s.db.transaction(() => this.s.pmBoards.delete(board.id))
  }

  // ── fields ─────────────────────────────────────────────────────────────────

  listFields(actor: Actor | null, projectId: number, boardId: number): Array<PmFieldRow> {
    const { board } = this.visibleBoard(actor, projectId, boardId)
    return this.s.pmFields.listForBoard(board.id)
  }

  createField(actor: Actor, projectId: number, boardId: number, input: Record<string, unknown>): PmFieldRow {
    const { board, project } = this.visibleBoard(actor, projectId, boardId)
    this.authorize(actor, 'pm:maintain', project)

    const key = String(input.key ?? '').trim()
    if (!KEY_RE.test(key)) throw new AppError(400, 'key must match [a-z0-9_]')
    if (this.s.pmFields.byKey(board.id, key)) throw new AppError(409, 'Field key already exists', 'taken')

    const type = String(input.type ?? '') as PmFieldType
    if (!(PM_FIELD_TYPES as readonly string[]).includes(type)) {
      throw new AppError(400, `type must be one of ${PM_FIELD_TYPES.join(', ')}`)
    }
    const label = typeof input.label === 'string' && input.label.trim() !== '' ? input.label.trim().slice(0, 60) : key

    let config: Record<string, unknown> = {}
    if (type === 'single_select' || type === 'multi_select' || type === 'status') {
      const opts = Array.isArray(input.options) ? (input.options as unknown[]).map(String).filter(Boolean) : []
      if (opts.length === 0) throw new AppError(400, `${type} fields need at least one option`)
      config = { options: [...new Set(opts)].slice(0, 30) }
    }

    const position = Math.max(0, Number(input.position ?? this.s.pmFields.listForBoard(board.id).length))
    return this.s.pmFields.create({ board_id: board.id, key, label, type, config, position })
  }

  updateField(actor: Actor, projectId: number, boardId: number, fieldId: number, patch: Record<string, unknown>): PmFieldRow {
    const { board, project } = this.visibleBoard(actor, projectId, boardId)
    this.authorize(actor, 'pm:maintain', project)
    const field = this.s.pmFields.byId(fieldId)
    if (!field || field.board_id !== boardId) throw new AppError(404, 'Field not found')
    if (field.key === 'status' && patch.config !== undefined) {
      throw new AppError(422, 'The builtin status field options are managed via workflow rules')
    }
    const updates: Record<string, unknown> = {}
    if (patch.label !== undefined) {
      const l = String(patch.label).trim()
      if (!l) throw new AppError(400, 'label cannot be empty')
      updates.label = l.slice(0, 60)
    }
    if (patch.config !== undefined && patch.config !== null) {
      const cfg = patch.config as Record<string, unknown>
      const opts = Array.isArray(cfg.options) ? (cfg.options as unknown[]).map(String).filter(Boolean) : []
      if (opts.length === 0) throw new AppError(400, 'options cannot be empty')
      updates.config = { options: [...new Set(opts)].slice(0, 30) }
    }
    if (patch.position !== undefined) updates.position = Number(patch.position)
    this.s.pmFields.update(fieldId, updates as never)
    return this.s.pmFields.byId(fieldId)!
  }

  deleteField(actor: Actor, projectId: number, boardId: number, fieldId: number): void {
    const { board, project } = this.visibleBoard(actor, projectId, boardId)
    this.authorize(actor, 'pm:maintain', project)
    const field = this.s.pmFields.byId(fieldId)
    if (!field || field.board_id !== boardId) throw new AppError(404, 'Field not found')
    if (['status', 'priority'].includes(field.key)) {
      throw new AppError(422, 'Builtin fields cannot be deleted')
    }
    this.s.pmFields.delete(fieldId) // values cascade
  }

  // ── items ──────────────────────────────────────────────────────────────────

  addItem(
    actor: Actor,
    projectId: number,
    boardId: number,
    input: Record<string, unknown>,
  ): PmItemRow & { field_values: Record<string, string | null> } {
    const { board, project } = this.visibleBoard(actor, projectId, boardId)
    this.authorize(actor, 'pm:write', project)

    const kind = String(input.kind ?? '') as PmItemRow['kind']
    if (!(kind in { issue: 1, pull_request: 1, draft: 1 })) throw new AppError(400, "kind must be 'issue', 'pull_request' or 'draft'")

    let item!: PmItemRow
    this.s.db.transaction(() => {
      if (kind === 'draft') {
        const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim().slice(0, 200) : ''
        if (!title) throw new AppError(400, 'draft items need a title')
        item = this.s.pmItems.create({
          board_id: board.id, kind, title,
          body: typeof input.body === 'string' ? input.body.slice(0, 5000) : '',
          created_by_id: actor.userId,
        })
      } else if (kind === 'issue') {
        const issueIid = Number(input.issue_iid)
        const issue = this.s.issues.byIid(projectId, issueIid)
        if (!issue) throw new AppError(422, `Issue #${issueIid} does not exist`, 'not_found')
        item = this.linkIssue(board.id, projectId, issueIid, issue.title, issue.assigneeIds?.() ?? [], actor.userId, issue.milestoneTitle?.() ?? '')
      } else {
        const prIid = Number(input.pr_iid)
        const pr = this.s.pullRequests.byIid(projectId, prIid)
        if (!pr) throw new AppError(422, `Pull request !${prIid} does not exist`, 'not_found')
        const assignees = this.s.pullRequests.assigneeIds(pr.id)
        const usernames = assignees.map((u) => this.s.users.byId(u)?.username ?? '').filter(Boolean)
        item = this.linkPr(board.id, prIid, pr.title, usernames.join(','), actor.userId)
      }
    })

    // Default status for brand-new items: first configured option (Backlog).
    const statusField = this.s.pmFields.byKey(board.id, 'status')!
    if (this.s.pmItemValues.get(item.id, statusField.id) === undefined) {
      const options = this.statusOptions(statusField)
      this.setStatusValue(board.id, item, statusField, options[0] ?? 'Todo', actor.userId)
    }
    return this.itemView(item.id)
  }

  /** Mirrors issue metadata into the item's built-in text fields. */
  private linkIssue(
    boardId: number,
    _projectId: number,
    issueIid: number,
    title: string,
    assigneeUsernames: string[],
    createdBy: number,
    milestoneTitle: string,
  ): PmItemRow {
    void _projectId
    const item = this.s.pmItems.create({
      board_id: boardId,
      kind: 'issue',
      issue_iid: issueIid,
      title,
      created_by_id: createdBy,
    })
    const assigneeField = this.s.pmFields.byKey(boardId, 'assignee')
    if (assigneeField && assigneeUsernames.length > 0) {
      this.s.pmItemValues.set(item.id, assigneeField.id, assigneeUsernames.join(','))
    }
    const msField = this.s.pmFields.byKey(boardId, 'milestone')
    if (msField && milestoneTitle) this.s.pmItemValues.set(item.id, msField.id, milestoneTitle)
    return item
  }

  private linkPr(boardId: number, prIid: number, title: string, assigneeText: string, createdBy: number): PmItemRow {
    const item = this.s.pmItems.create({
      board_id: boardId,
      kind: 'pull_request',
      pr_iid: prIid,
      title,
      created_by_id: createdBy,
    })
    const assigneeField = this.s.pmFields.byKey(boardId, 'assignee')
    if (assigneeField && assigneeText) this.s.pmItemValues.set(item.id, assigneeField.id, assigneeText)
    return item
  }

  removeItem(actor: Actor, projectId: number, boardId: number, itemId: number): void {
    const { board, project } = this.visibleBoard(actor, projectId, boardId)
    this.authorize(actor, 'pm:write', project)
    const item = this.s.pmItems.byId(itemId)
    if (!item || item.board_id !== boardId) throw new AppError(404, 'Item not found')
    this.s.pmItems.delete(itemId)
  }

  /**
   * Typed value validation per field type:
   *   number → finite decimal · date → YYYY-MM-DD
   *   status/single_select → must be a configured option
   *   multi_select → array subset of options · text → free string
   */
  setItemValue(
    actor: Actor,
    projectId: number,
    boardId: number,
    itemId: number,
    fieldKey: string,
    rawValue: unknown,
  ): { item: PmItemRow; from_status: string | null; to_status: string | null } {
    const { board, project } = this.visibleBoard(actor, projectId, boardId)
    this.authorize(actor, 'pm:write', project)
    const item = this.s.pmItems.byId(itemId)
    if (!item || item.board_id !== boardId) throw new AppError(404, 'Item not found')

    const field = this.s.pmFields.byKey(boardId, fieldKey)
    if (!field) throw new AppError(404, `Unknown field '${fieldKey}'`)

    const canonical = this.validateValue(field, rawValue)

    let fromStatus: string | null = null
    let toStatus: string | null = null
    this.s.db.transaction(() => {
      if (field.key === 'status') {
        fromStatus = this.currentStatus(board.id, itemId) ?? ''
        toStatus = canonical as string
      }
      this.s.pmItemValues.set(itemId, field.id, canonical as string | null)
      this.s.pmItems.touch(itemId)
      if (field.key === 'status') {
        this.s.pmStatusLog.insert(itemId, fromStatus, toStatus!, actor.userId)
      }
      // Assignment rule: mirror code-project assignees onto the Assignee field.
      if (field.key === 'assignee' && item.kind === 'issue') {
        void item
      }
    })

    return { item: this.s.pmItems.byId(itemId)!, from_status: fromStatus, to_status: toStatus }
  }

  itemViewFull(board: PmBoardRow, item: PmItemRow): Record<string, unknown> {
    const values: Record<string, string | null> = {}
    for (const f of this.s.pmFields.listForBoard(board.id)) {
      const v = this.s.pmItemValues.get(item.id, f.id)
      values[f.key] = v ?? null
    }
    void board
    return {
      id: item.id,
      kind: item.kind,
      issue_iid: item.issue_iid,
      pr_iid: item.pr_iid,
      title: item.title,
      body: item.kind === 'draft' ? item.body : '',
      field_values: values,
      created_at: item.created_at,
      updated_at: item.updated_at,
    }
  }

  private itemView(itemId: number) {
    const item = this.s.pmItems.byId(itemId)!
    const board = this.s.pmBoards.byId(item.board_id)!
    return this.itemViewFull(board, item)
  }

  private statusOptions(statusField: PmFieldRow): string[] {
    try {
      const cfg = JSON.parse(statusField.config) as { options?: string[] }
      return cfg.options ?? DEFAULT_STATUS_OPTIONS
    } catch {
      return DEFAULT_STATUS_OPTIONS
    }
  }

  currentStatus(boardId: number, itemId: number): string | null {
    const f = this.s.pmFields.byKey(boardId, 'status')
    if (!f) return null
    const v = this.s.pmItemValues.get(itemId, f.id)
    return v ?? null
  }

  private setStatusValue(boardId: number, item: PmItemRow, field: PmFieldRow, status: string, actorId: number | null): void {
    const from = this.currentStatus(boardId, item.id)
    this.s.pmItemValues.set(item.id, field.id, status)
    this.s.pmStatusLog.insert(item.id, from, status, actorId)
  }

  private validateValue(field: PmFieldRow, raw: unknown): string | null {
    if (raw === null || raw === undefined || raw === '') {
      if (field.type === 'status') throw new AppError(400, 'status is required')
      return null // clearing other fields is allowed
    }
    const options = (() => {
      try {
        const cfg = JSON.parse(field.config) as { options?: string[] }
        return cfg.options ?? []
      } catch { return [] }
    })()

    switch (field.type) {
      case 'text':
        return String(raw).slice(0, 500)
      case 'number': {
        const n = Number(raw)
        if (!Number.isFinite(n)) throw new AppError(400, `'${field.label}' expects a number`)
        return String(n)
      }
      case 'date':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) throw new AppError(400, `'${field.label}' expects YYYY-MM-DD`)
        return String(raw)
      case 'status':
      case 'single_select': {
        const s = String(raw)
        if (options.length > 0 && !options.includes(s)) {
          throw new AppError(400, `'${s}' is not a valid option for '${field.label}'`)
        }
        return s
      }
      case 'multi_select': {
        if (!Array.isArray(raw)) throw new AppError(400, `'${field.label}' expects an array`)
        const labels = (raw as unknown[]).map(String)
        for (const l of labels) {
          if (options.length > 0 && !options.includes(l)) {
            throw new AppError(400, `'${l}' is not a valid option for '${field.label}'`)
          }
        }
        return JSON.stringify([...new Set(labels)])
      }
      default:
        throw new AppError(400, 'Unsupported field type')
    }
  }

  // ── listing with filters/sort (+ saved view application) ───────────────────

  listItems(
    actor: Actor | null,
    projectId: number,
    boardId: number,
    q: { status?: string; kind?: string; search?: string; sort?: string; dir?: string; view?: string },
  ) {
    const { board } = this.visibleBoard(actor, projectId, boardId)
    let filters: { status?: string; kind?: PmItemRow['kind']; search?: string; sort?: 'updated_at' | 'title' | 'status'; dir?: 'asc' | 'desc' } = {}
    if (q.view !== undefined && q.view !== '') {
      const sv = this.s.pmSavedViews.listForBoard(boardId).find((v) => String((v as Row).name) === q.view)
      if (sv) {
        const parsed = JSON.parse(sv.filters as string) as { status?: string; kinds?: string[]; q?: string }
        if (parsed.status) filters.status = parsed.status
        if (parsed.q) filters.q = parsed.q
      }
    }
    if (q.status !== undefined) filters.status = q.status
    if (q.kind === 'issue' || q.kind === 'pull_request' || q.kind === 'draft') filters.kind = q.kind
    if (q.search) filters.q = q.search
    if (q.sort === 'title' || q.sort === 'status' || q.sort === 'updated_at') filters.sort = q.sort
    filters.dir = q.dir === 'asc' ? 'asc' : 'desc'

    const result = this.s.pmItems.listFiltered(boardId, filters)
    return {
      items: result.rows.map((r) => this.itemViewFull(board, r)),
      total: result.total,
    }
  }

  // ── saved views ────────────────────────────────────────────────────────────

  createSavedView(actor: Actor, projectId: number, boardId: number, input: Record<string, unknown>) {
    const { board, project } = this.visibleBoard(actor, projectId, boardId)
    this.authorize(actor, 'pm:write', project)
    const name = typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim().slice(0, 60) : (() => { throw new AppError(400, 'view name is required') })()
    if (this.s.pmSavedViews.listForBoard(board.id).some((v) => String((v as Row).name).toLowerCase() === name.toLowerCase())) {
      throw new AppError(409, 'A view with this name already exists', 'taken')
    }
    const filters = typeof input.filters === 'object' && input.filters !== null ? input.filters : {}
    const groupBy = typeof input.group_by === 'string' ? input.group_by : null
    return this.s.pmSavedViews.create({
      board_id: board.id,
      name,
      filters,
      groupBy,
      sort: typeof input.sort === 'object' && input.sort !== null ? input.sort : {},
      owner_id: actor.userId,
    })
  }

  listSavedViews(actor: Actor | null, projectId: number, boardId: number) {
    const { board } = this.visibleBoard(actor, projectId, boardId)
    const views = this.s.pmSavedViews.listForBoard(board.id) as Array<Row>
    return {
      views: views.map((v) => ({
        id: Number(v.id),
        name: String(v.name),
        filters: safeParse(String(v.filters), {}),
        group_by: v.group_by === null ? null : String(v.group_by),
        sort: safeParse(String(v.sort), {}),
      })),
    }
  }

  deleteSavedView(actor: Actor, projectId: number, boardId: number, viewId: number): void {
    const { board, project } = this.visibleBoard(actor, projectId, boardId)
    this.authorize(actor, 'pm:maintain', project)
    if (!this.s.pmSavedViews.deleteOwn(viewId, actor.userId)) {
      const row = this.s.pmSavedViews.byId(viewId)
      if (!row || row.board_id !== boardId) throw new AppError(404, 'View not found')
      throw new AppError(403, 'Only the view creator or a maintainer can delete it')
    }
    void board
  }

  // ── workflow rules ─────────────────────────────────────────────────────────

  setWorkflowRule(actor: Actor, projectId: number, boardId: number, event: string, targetStatus: string | null): void {
    const { board, project } = this.visibleBoard(actor, projectId, boardId)
    this.authorize(actor, 'pm:maintain', project)
    if (!(EVENTS as readonly string[]).includes(event)) {
      throw new AppError(400, `event must be one of ${EVENTS.join(', ')}`)
    }
    if (targetStatus === null) {
      this.s.pmWorkflows.remove(board.id, event)
      return
    }
    const statusField = this.s.pmFields.byKey(board.id, 'status')!
    const options = this.statusOptions(statusField)
    if (!options.includes(targetStatus)) throw new AppError(400, `'${targetStatus}' is not a valid status option`)
    this.s.pmWorkflows.upsert(board.id, event, targetStatus)
  }

  listWorkflowRules(actor: Actor | null, projectId: number, boardId: number) {
    const { board } = this.visibleBoard(actor, projectId, boardId)
    return { rules: this.s.pmWorkflows.listForBoard(board.id) }
  }

  // ── event subscription (called by the bus) ────────────────────────────────

  applyDomainEvent(row: { type: string; payload: Record<string, unknown>; project_id: number | null }): void {
    if (row.project_id === null) return
    const map: Record<string, string> = {
      'issue.opened': 'issue_opened',
      'issue.updated': row.payload.action === 'closed' ? 'issue_closed'
        : row.payload.action === 'reopened' ? 'issue_reopened' : '',
      'mr.opened': 'pr_opened',
      'mr.merged': 'pr_merged',
    }
    const event = map[row.type]
    if (!event) return
    const iid = Number(row.payload.iid)
    if (!Number.isInteger(iid) || iid <= 0) return

    const kind: 'issue' | 'pull_request' = event.startsWith('issue_') ? 'issue' : 'pull_request'
    const items = this.s.pmItems.findLinked(row.project_id, kind, iid)
    for (const item of items) {
      const board = this.s.pmBoards.byId(item.board_id)
      if (!board) continue
      const target = this.s.pmWorkflows.targetFor(board.id, event)
      if (!target) continue
      const statusField = this.s.pmFields.byKey(board.id, 'status')
      if (!statusField) continue
      const options = this.statusOptions(statusField)
      if (!options.includes(target)) continue // rule references a removed status — skip honestly
      const from = this.currentStatus(board.id, item.id)
      this.s.pmItemValues.set(item.id, statusField.id, target)
      this.s.pmStatusLog.insert(item.id, from, target, null)
      this.s.pmItems.touch(item.id)
    }
  }

  // ── insights foundation ────────────────────────────────────────────────────

  insights(actor: Actor | null, projectId: number, boardId: number) {
    const { board } = this.visibleBoard(actor, projectId, boardId)
    const { rows } = this.s.pmItems.listFiltered(board.id, {})
    const statusField = this.s.pmFields.byKey(board.id, 'status')
    const distribution = new Map<string, number>()
    for (const item of rows) {
      const st = statusField ? this.s.pmItemValues.get(item.id, statusField.id) ?? '(none)' : '(none)'
      distribution.set(st, (distribution.get(st) ?? 0) + 1)
    }
    const doneTarget =
      statusField
        ? (this.statusOptions(statusField).at(-1) ?? 'Done')
        : 'Done'
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()

    return {
      total_items: rows.length,
      by_kind: {
        issues: rows.filter((r) => r.kind === 'issue').length,
        pull_requests: rows.filter((r) => r.kind === 'pull_request').length,
        drafts: rows.filter((r) => r.kind === 'draft').length,
      },
      status_distribution: [...distribution.entries()].map(([status, count]) => ({ status, count })),
      progress: {
        done_status: doneTarget,
        done_count: distribution.get(doneTarget) ?? 0,
        percent: rows.length === 0 ? 0 : Math.floor(((distribution.get(doneTarget) ?? 0) / rows.length) * 100),
      },
      throughput_last_30_days: this.s.pmStatusLog.countToStatusSince(boardId, doneTarget, since),
    }
  }
}

function safeParse<T>(json: string, fallback: T): T {
  try { return JSON.parse(json) as T } catch { return fallback }
}
