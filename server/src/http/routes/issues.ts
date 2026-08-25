import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError } from '../../services/identity.js'
import { IssuesService } from '../../services/issues.js'
import {
  extractTaskItems,
  type IssueRow,
  type LabelRow,
  type MilestoneRow,
  type NoteRow,
} from '../../db/store.js'

/**
 * Collaboration routes: issues · labels · milestones (GitLab REST v4 parity).
 *
 *   POST/GET   /api/v1/projects/:id/issues
 *   GET/PATCH/DELETE /api/v1/projects/:id/issues/:iid
 *   POST       /api/v1/projects/:id/issues/:iid/close | /reopen | /tasks/toggle
 *   GET/POST   /api/v1/projects/:id/issues/:iid/notes      (+ PATCH/DELETE :note_id)
 *   GET/POST   .../issues/:iid/award_emoji                 (+ DELETE by name)
 *   GET/POST   .../notes/:note_id/award_emoji              (+ DELETE by name)
 *   GET/POST/PATCH/DELETE /api/v1/projects/:id/labels[/:label_id]
 *   GET/POST/PATCH/DELETE /api/v1/projects/:id/milestones[/:milestone_id]
 */

const DEFAULT_PER_PAGE = 20

function numParam(req: FastifyRequest, name: string): number {
  const raw = (req.params as Record<string, string>)[name]
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, `Invalid ${name}`)
  return n
}

function userBrief(
  app: FastifyInstance,
  id: number | null,
): { id: number; username: string; name: string | null } | null {
  if (id === null || id === undefined) return null
  const u = app.store.users.byId(id)
  return u ? { id: u.id, username: u.username, name: u.name } : null
}

export function labelView(l: LabelRow, usageCount?: number) {
  return {
    id: l.id,
    project_id: l.project_id,
    title: l.title,
    description: l.description,
    color: l.color,
    scope: l.scope,
    ...(usageCount !== undefined ? { open_issues_count: usageCount } : {}),
    created_at: l.created_at,
    updated_at: l.updated_at,
  }
}

export function milestoneView(m: MilestoneRow) {
  return {
    id: m.id,
    project_id: m.project_id,
    title: m.title,
    description: m.description,
    due_date: m.due_date,
    state: m.state,
    // Merge requests arrive with the MR phase; the count stays part of the
    // contract from day one so clients never see a shape change.
    merge_requests_count: 0,
    created_at: m.created_at,
    updated_at: m.updated_at,
  }
}

export function noteView(app: FastifyInstance, n: NoteRow) {
  const author = userBrief(app, n.author_id)
  return {
    id: n.id,
    noteable_type: n.noteable_type,
    noteable_iid: undefined as unknown as number, // patched by callers that have the issue row
    body: n.note,
    system: !!n.system,
    author,
    reactions: app.store.reactions.summary('note', n.id),
    created_at: n.created_at,
    updated_at: n.updated_at,
  }
}

export function issueView(app: FastifyInstance, i: IssueRow) {
  const owner = app.store.users.byId(
    app.store.projects.byId(i.project_id)!.owner_id,
  )
  const milestone = i.milestone_id !== null ? app.store.milestones.byId(i.milestone_id) : undefined
  const progress = (() => {
    const items = extractTaskItems(i.description)
    return { total: items.length, completed: items.filter((x) => x.checked).length }
  })()
  return {
    id: i.id,
    iid: i.iid,
    project_id: i.project_id,
    title: i.title,
    description: i.description,
    state: i.state,
    confidential: !!i.confidential,
    author: userBrief(app, i.author_id),
    assignees: app.store.issues.assigneeIds(i.id).map((uid) => userBrief(app, uid)),
    labels: app.store.labels.rowsForIssue(i.id).map((l) => ({
      id: l.id,
      title: l.title,
      color: l.color,
      description: l.description,
    })),
    milestone: milestone ? { ...milestoneView(milestone), issue_count: undefined } : null,
    task_progress: progress,
    has_tasks: progress.total > 0,
    due_date: i.due_date,
    closed_at: i.closed_at,
    closed_by: userBrief(app, i.closed_by_id),
    web_path: `/proj/${owner?.username ?? ''}/${
      app.store.projects.byId(i.project_id)?.path ?? ''
    }/issues/${i.iid}`,
    created_at: i.created_at,
    updated_at: i.updated_at,
  }
}

export function registerIssueRoutes(app: FastifyInstance): void {
  const svc = new IssuesService(app.store, app.cfg)
  const auth = app.requireAuth()

  // -- labels -----------------------------------------------------------------

  app.get('/api/v1/projects/:id/labels', async (req) => {
    const projectId = numParam(req, 'id')
    svc.readableProject(req.actor, projectId)
    const withUsage = (req.query as { with_counts?: string }).with_counts === 'true'
    return app.store.labels.listForProject(projectId).map((l) =>
      labelView(l, withUsage ? app.store.labels.usageCount(l.id) : undefined),
    )
  })

  app.post('/api/v1/projects/:id/labels', { preHandler: auth }, async (req, reply) => {
    const projectId = numParam(req, 'id')
    const body = (req.body ?? {}) as Record<string, unknown>
    const label = svc.createLabel(req.actor!, projectId, {
      title: body.title,
      description: body.description,
      color: body.color,
    })
    reply.code(201)
    return labelView(label)
  })

  app.patch('/api/v1/projects/:id/labels/:label_id', { preHandler: auth }, async (req) => {
    const projectId = numParam(req, 'id')
    const labelId = numParam(req, 'label_id')
    const body = (req.body ?? {}) as Record<string, unknown>
    const label = svc.updateLabel(req.actor!, projectId, labelId, body)
    return labelView(label)
  })

  app.delete('/api/v1/projects/:id/labels/:label_id', { preHandler: auth }, async (req) => {
    const projectId = numParam(req, 'id')
    const labelId = numParam(req, 'label_id')
    svc.deleteLabel(req.actor!, projectId, labelId)
    return { ok: true }
  })

  // -- milestones -----------------------------------------------------------------

  app.get('/api/v1/projects/:id/milestones', async (req) => {
    const projectId = numParam(req, 'id')
    svc.readableProject(req.actor, projectId)
    const q = req.query as { state?: string }
    const state = q.state === 'active' || q.state === 'closed' ? q.state : undefined
    return app.store.milestones.listForProject(projectId, state).map((m) => {
      const counts = app.store.milestones.counts(m.id)
      return {
        ...milestoneView(m),
        total_issues: counts.total,
        opened_issues: counts.opened,
        closed_issues: counts.closed,
        completion_percent: app.store.milestones.completionPercent(m.id),
      }
    })
  })

  app.post('/api/v1/projects/:id/milestones', { preHandler: auth }, async (req, reply) => {
    const projectId = numParam(req, 'id')
    const body = (req.body ?? {}) as Record<string, unknown>
    const m = svc.createMilestone(req.actor!, projectId, body)
    reply.code(201)
    return milestoneView(m)
  })

  app.get('/api/v1/projects/:id/milestones/:milestone_id', async (req) => {
    const projectId = numParam(req, 'id')
    const mid = numParam(req, 'milestone_id')
    svc.readableProject(req.actor, projectId)
    const m = app.store.milestones.byId(mid)
    if (!m || m.project_id !== projectId) throw new AppError(404, 'Milestone not found')
    const counts = app.store.milestones.counts(mid)
    return {
      ...milestoneView(m),
      total_issues: counts.total,
      opened_issues: counts.opened,
      closed_issues: counts.closed,
      completion_percent: app.store.milestones.completionPercent(mid),
    }
  })

  app.patch('/api/v1/projects/:id/milestones/:milestone_id', { preHandler: auth }, async (req) => {
    const projectId = numParam(req, 'id')
    const mid = numParam(req, 'milestone_id')
    const body = (req.body ?? {}) as Record<string, unknown>
    const m = svc.updateMilestone(req.actor!, projectId, mid, body)
    return milestoneView(m)
  })

  app.delete('/api/v1/projects/:id/milestones/:milestone_id', { preHandler: auth }, async (req) => {
    const projectId = numParam(req, 'id')
    const mid = numParam(req, 'milestone_id')
    svc.deleteMilestone(req.actor!, projectId, mid)
    return { ok: true }
  })

  // -- issues ------------------------------------------------------------------------

  app.get('/api/v1/projects/:id/issues', async (req, reply) => {
    const projectId = numParam(req, 'id')
    const q = req.query as Record<string, string | undefined>

    let labelIds: number[] | undefined
    if (q.labels !== undefined && q.labels !== '') {
      const titles = q.labels.split(',').map((t) => t.trim()).filter(Boolean)
      labelIds = []
      for (const t of titles) {
        const l = app.store.labels.byTitle(projectId, t)
        if (!l) throw new AppError(422, `Label "${t}" does not exist`, 'label_not_found')
        labelIds.push(l.id)
      }
    }

    let milestoneFilter: number | 'none' | 'any' | undefined
    if (q.milestone === 'none') milestoneFilter = 'none'
    else if (q.milestone === 'any') milestoneFilter = 'any'
    else if (q.milestone !== undefined && q.milestone !== '') {
      const byTitle = app.store.milestones.byTitle(projectId, q.milestone)
      const byId = Number(q.milestone)
      const m = byTitle ?? (Number.isInteger(byId) ? app.store.milestones.byId(byId) : undefined)
      if (!m || m.project_id !== projectId) throw new AppError(422, 'Milestone does not exist', 'invalid_milestone')
      milestoneFilter = m.id
    }

    const result = svc.listIssues(req.actor, projectId, {
      state: q.state === 'opened' || q.state === 'closed' || q.state === 'all' ? q.state : undefined,
      milestoneId: milestoneFilter,
      labelIds,
      assigneeId:
        q.assignee_username !== undefined
          ? q.assignee_username.toLowerCase() === 'none'
            ? null
            : (app.store.users.byUsername(q.assignee_username)?.id ?? -1)
          : undefined,
      authorId:
        q.author_username !== undefined
          ? (app.store.users.byUsername(q.author_username)?.id ?? -1)
          : undefined,
      search: q.search?.slice(0, 100),
      orderBy: q.order_by === 'created_at' ? 'created_at' : 'updated_at',
      sort: q.sort === 'asc' ? 'asc' : 'desc',
      page: Number(q.page ?? 1),
      perPage: Number(q.per_page ?? DEFAULT_PER_PAGE),
    })

    reply.header('x-total-count', result.total)
    reply.header('x-total-pages', Math.max(1, Math.ceil(result.total / result.perPage)))
    reply.header('x-page', result.page)
    reply.header('x-per-page', result.perPage)
    return {
      issues: result.rows.map((i) => issueView(app, i)),
      pagination: {
        page: result.page,
        per_page: result.perPage,
        total: result.total,
        total_pages: Math.max(1, Math.ceil(result.total / result.perPage)),
        has_more: result.page * result.perPage < result.total,
      },
    }
  })

  app.post('/api/v1/projects/:id/issues', { preHandler: auth }, async (req, reply) => {
    const projectId = numParam(req, 'id')
    const body = (req.body ?? {}) as Record<string, unknown>
    const issue = svc.create(req.actor!, projectId, {
      title: String(body.title ?? ''),
      description: typeof body.description === 'string' ? body.description : '',
      confidential: body.confidential === true,
      assignee_ids: Array.isArray(body.assignee_ids) ? (body.assignee_ids as number[]) : [],
      labels: Array.isArray(body.labels) ? (body.labels as string[]) : [],
      milestone_id: body.milestone_id === undefined ? undefined : (body.milestone_id as number | null),
      due_date: body.due_date as string | null | undefined,
    })
    reply.code(201)
    return issueView(app, issue)
  })

  app.get('/api/v1/projects/:id/issues/:iid', async (req) => {
    const projectId = numParam(req, 'id')
    const iid = numParam(req, 'iid')
    const issue = svc.visibleIssue(req.actor, projectId, iid)
    return issueView(app, issue)
  })

  app.patch('/api/v1/projects/:id/issues/:iid', { preHandler: auth }, async (req) => {
    const projectId = numParam(req, 'id')
    const iid = numParam(req, 'iid')
    const body = (req.body ?? {}) as Record<string, unknown>
    const issue = svc.update(req.actor!, projectId, iid, {
      title: body.title === undefined ? undefined : String(body.title),
      description:
        body.description === undefined
          ? undefined
          : typeof body.description === 'string'
            ? body.description
            : String(body.description ?? ''),
      confidential: body.confidential as boolean | undefined,
      assignee_ids: body.assignee_ids as number[] | undefined,
      labels: body.labels as string[] | undefined,
      milestone_id: body.milestone_id as number | null | undefined,
      due_date: body.due_date as string | null | undefined,
      state_event: body.state_event as 'close' | 'reopen' | undefined,
    })
    return issueView(app, issue)
  })

  app.post('/api/v1/projects/:id/issues/:iid/close', { preHandler: auth }, async (req) => {
    const projectId = numParam(req, 'id')
    const iid = numParam(req, 'iid')
    return issueView(app, svc.close(req.actor!, projectId, iid))
  })

  app.post('/api/v1/projects/:id/issues/:iid/reopen', { preHandler: auth }, async (req) => {
    const projectId = numParam(req, 'id')
    const iid = numParam(req, 'iid')
    return issueView(app, svc.reopen(req.actor!, projectId, iid))
  })

  app.delete('/api/v1/projects/:id/issues/:iid', { preHandler: auth }, async (req) => {
    const projectId = numParam(req, 'id')
    const iid = numParam(req, 'iid')
    svc.delete(req.actor!, projectId, iid)
    return { ok: true }
  })

  // -- task lists ---------------------------------------------------------------

  app.post('/api/v1/projects/:id/issues/:iid/tasks/toggle', { preHandler: auth }, async (req) => {
    const projectId = numParam(req, 'id')
    const iid = numParam(req, 'iid')
    const index = Number((req.body as { index?: unknown } | undefined)?.index)
    const out = svc.toggleTaskItem(req.actor!, projectId, iid, index)
    return { description: out.description, task_progress: out.progress }
  })

  // -- comments & timeline -----------------------------------------------------------

  app.get('/api/v1/projects/:id/issues/:iid/notes', async (req) => {
    const projectId = numParam(req, 'id')
    const iid = numParam(req, 'iid')
    const issue = svc.visibleIssue(req.actor, projectId, iid)
    const includeSystem = (req.query as { include_system?: string }).include_system !== 'false'
    return {
      notes: app.store.notes.timeline('issue', issue.id, { includeSystem }).map((n) => ({
        ...noteView(app, n),
        noteable_iid: issue.iid,
      })),
    }
  })

  app.post('/api/v1/projects/:id/issues/:iid/notes', { preHandler: auth }, async (req, reply) => {
    const projectId = numParam(req, 'id')
    const iid = numParam(req, 'iid')
    const body = String((req.body as { body?: unknown } | undefined)?.body ?? '')
    const note = svc.comment(req.actor!, projectId, iid, body)
    reply.code(201)
    return { ...noteView(app, note), noteable_iid: iid }
  })

  app.patch('/api/v1/projects/:id/issues/:iid/notes/:note_id', { preHandler: auth }, async (req) => {
    const projectId = numParam(req, 'id')
    const iid = numParam(req, 'iid')
    const noteId = numParam(req, 'note_id')
    const body = String((req.body as { body?: unknown } | undefined)?.body ?? '')
    svc.editComment(req.actor!, projectId, iid, noteId, body)
    return { ok: true }
  })

  app.delete('/api/v1/projects/:id/issues/:iid/notes/:note_id', { preHandler: auth }, async (req) => {
    const projectId = numParam(req, 'id')
    const iid = numParam(req, 'iid')
    const noteId = numParam(req, 'note_id')
    svc.deleteComment(req.actor!, projectId, iid, noteId)
    return { ok: true }
  })

  // -- reactions (award emoji) ------------------------------------------------------------

  function reactionRoutes(basePath: 'issue' | 'note'): void {
    const pathFor =
      basePath === 'issue'
        ? `/api/v1/projects/:id/issues/:iid/award_emoji`
        : `/api/v1/projects/:id/issues/:iid/notes/:note_id/award_emoji`

    app.get(pathFor, async (req) => {
      const projectId = numParam(req, 'id')
      const iid = numParam(req, 'iid')
      const issue = svc.visibleIssue(req.actor, projectId, iid)
      const targetId = basePath === 'issue' ? issue.id : numParam(req, 'note_id')
      if (basePath === 'note') svc.assertNoteInIssue(projectId, issue.id, targetId)
      return app.store.reactions.summary(basePath, targetId, req.actor?.userId)
    })

    app.post(pathFor, { preHandler: auth }, async (req) => {
      const projectId = numParam(req, 'id')
      const iid = numParam(req, 'iid')
      const issue = svc.visibleIssue(req.actor, projectId, iid)
      const targetId = basePath === 'issue' ? issue.id : numParam(req, 'note_id')
      if (basePath === 'note') svc.assertNoteInIssue(projectId, issue.id, targetId)
      const name = (req.body as { name?: unknown } | undefined)?.name
      const action = svc.toggleReaction(req.actor!, projectId, basePath, targetId, name)
      return {
        action,
        summary: app.store.reactions.summary(basePath, targetId, req.actor!.userId),
      }
    })

    app.delete(`${pathFor}/:name`, { preHandler: auth }, async (req) => {
      const projectId = numParam(req, 'id')
      const iid = numParam(req, 'iid')
      const issue = svc.visibleIssue(req.actor, projectId, iid)
      const targetId = basePath === 'issue' ? issue.id : numParam(req, 'note_id')
      if (basePath === 'note') svc.assertNoteInIssue(projectId, issue.id, targetId)
      const name = String((req.params as Record<string, string>).name ?? '')
      const summary = app.store.reactions.summary(basePath, targetId, req.actor!.userId)
      void name
      // Revoke is expressed as a toggle only when currently held.
      const mine = summary.find((s) => s.me && s.name === name)
      if (!mine) throw new AppError(404, 'Reaction not found')
      app.store.reactions.toggle(req.actor!.userId, basePath, targetId, name as never)
      return { action: 'revoked', summary: app.store.reactions.summary(basePath, targetId, req.actor!.userId) }
    })
  }

  reactionRoutes('issue')
  reactionRoutes('note')

  // -- cross-cutting: expose assert helper used above -----------------------------------
  void svc
}
