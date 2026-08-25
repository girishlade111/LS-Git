import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError } from '../../services/identity.js'
import { userBrief } from './issues.js'
import { labelView } from './issues.js'
import type { PullRequestRow } from '../../db/store.js'

/**
 * Pull request routes (GitLab MR semantics; see services/pullRequests.ts for
 * the state machine and merge gates).
 *
 *   POST   /api/v1/projects/:id/pull_requests                     create
 *   GET    /api/v1/projects/:id/pull_requests                     list (filters+pagination)
 *   GET    /api/v1/projects/:id/pull_requests/:iid                detail
 *   PATCH  /api/v1/projects/:id/pull_requests/:iid                update / state_event / draft
 *   DELETE /api/v1/projects/:id/pull_requests/:iid                owner/admin only
 *   GET    .../mergeability                                       live gates report
 *   POST   .../merge                                              {method, should_remove_source_branch?, expected_sha?}
 *   PUT    .../reviewers                                          {reviewer_ids}
 *   POST   .../approve | .../unapprove
 *   GET    .../commits                                            source commits ahead of target
 *   GET    .../changes(?with_patches=1)                           changed files (+unified patches)
 *   GET/POST .../notes · PATCH/DELETE .../notes/:note_id          comments + timeline
 */

function numParam(req: FastifyRequest, name: string): number {
  const n = Number((req.params as Record<string, string>)[name])
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, `Invalid ${name}`)
  return n
}

export function prView(app: FastifyInstance, pr: PullRequestRow) {
  const project = app.store.projects.byId(pr.project_id)
  const owner = project ? app.store.users.byId(project.owner_id) : undefined
  const approvals = app.store.pullRequests.approvals(pr.id)
  const required = project?.approvals_required ?? 0
  return {
    id: pr.id,
    iid: pr.iid,
    project_id: pr.project_id,
    title: pr.title,
    description: pr.description,
    state: pr.state,
    draft: !!pr.draft,
    author: userBrief(app, pr.author_id),
    source_branch: pr.source_branch,
    target_branch: pr.target_branch,
    assignees: app.store.pullRequests.assigneeIds(pr.id).map((uid) => userBrief(app, uid)),
    reviewers: app.store.pullRequests.reviewers(pr.id).map((r) => ({
      ...(userBrief(app, r.userId) ?? {}),
      review_state: r.reviewState,
    })),
    labels: app.store.pullRequests.labelRows(pr.id).map((l) => ({
      id: l.id,
      title: l.title,
      color: l.color,
      description: l.description,
    })),
    milestone:
      pr.milestone_id !== null && app.store.milestones.byId(pr.milestone_id)
        ? (() => {
            const m = app.store.milestones.byId(pr.milestone_id)!
            return {
              id: m.id,
              title: m.title,
              due_date: m.due_date,
              state: m.state,
            }
          })()
        : null,
    linked_issue_iids: app.store.pullRequests.linkedIssueIids(pr.id),
    approvals: { count: approvals.length, required, user_ids: approvals },
    merge_status: pr.merge_status,
    merge_status_reason: pr.merge_status_reason,
    merge_commit_sha: pr.merge_commit_sha,
    squash_commit_sha: pr.squash_commit_sha,
    closed_at: pr.closed_at,
    closed_by: userBrief(app, pr.closed_by_id),
    merged_at: pr.merged_at,
    merged_by: userBrief(app, pr.merged_by_id),
    web_path: `/proj/${owner?.username ?? ''}/${project?.path ?? ''}/pulls/${pr.iid}`,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
  }
}

export function registerPullRequestRoutes(app: FastifyInstance): void {
  const svc = app.pullRequests
  const auth = app.requireAuth()

  app.post('/api/v1/projects/:id/pull_requests', { preHandler: auth }, async (req, reply) => {
    const projectId = numParam(req, 'id')
    const body = (req.body ?? {}) as Record<string, unknown>
    const pr = svc.create(actorOf(req), projectId, body)
    reply.code(201)
    return prView(app, pr)
  })

  app.get('/api/v1/projects/:id/pull_requests', async (req, reply) => {
    const projectId = numParam(req, 'id')
    const q = req.query as Record<string, string | undefined>
    const state = ['opened', 'closed', 'merged', 'all'].includes(q.state ?? '')
      ? (q.state as 'opened' | 'closed' | 'merged' | 'all' | undefined)
      : undefined
    const result = svc.listPullRequests(req.actor, projectId, {
      state,
      draft: q.draft === 'true' ? true : q.draft === 'false' ? false : undefined,
      sourceBranch: q.source_branch || undefined,
      targetBranch: q.target_branch || undefined,
      authorId: q.author_username ? (app.store.users.byUsername(q.author_username)?.id ?? -1) : undefined,
      reviewerId: q.reviewer_username ? (app.store.users.byUsername(q.reviewer_username)?.id ?? -1) : undefined,
      search: q.search?.slice(0, 100),
      orderBy: q.order_by === 'created_at' ? 'created_at' : 'updated_at',
      sort: q.sort === 'asc' ? 'asc' : 'desc',
      page: Number(q.page ?? 1),
      perPage: Number(q.per_page ?? 20),
    })
    reply.header('x-total-count', result.total)
    reply.header('x-total-pages', Math.max(1, Math.ceil(result.total / result.perPage)))
    return {
      pull_requests: result.rows.map((p) => prView(app, p)),
      pagination: {
        page: result.page,
        per_page: result.perPage,
        total: result.total,
        total_pages: Math.max(1, Math.ceil(result.total / result.perPage)),
        has_more: result.page * result.perPage < result.total,
      },
    }
  })

  app.get('/api/v1/projects/:id/pull_requests/:iid', async (req) => {
    const pr0 = svc.visiblePr(req.actor, numParam(req, 'id'), numParam(req, 'iid'))
    const pr = svc.refreshMergeStatus(pr0)
    return prView(app, pr)
  })

  app.patch('/api/v1/projects/:id/pull_requests/:iid', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const pr = svc.update(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'), body)
    return prView(app, pr)
  })

  app.delete('/api/v1/projects/:id/pull_requests/:iid', { preHandler: auth }, async (req) => {
    svc.delete(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'))
    return { ok: true }
  })

  // Convenience transition endpoints (same gates as state_event).
  app.post('/api/v1/projects/:id/pull_requests/:iid/close', { preHandler: auth }, async (req) =>
    prView(app, svc.close(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'))),
  )
  app.post('/api/v1/projects/:id/pull_requests/:iid/reopen', { preHandler: auth }, async (req) =>
    prView(app, svc.reopen(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'))),
  )

  app.get('/api/v1/projects/:id/pull_requests/:iid/mergeability', async (req) =>
    svc.mergeability(req.actor, numParam(req, 'id'), numParam(req, 'iid')),
  )

  app.post('/api/v1/projects/:id/pull_requests/:iid/merge', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const merged = svc.merge(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'), body)
    return { ...prView(app, merged), merge_method: merged.merge_method, new_tip: merged.new_tip }
  })

  app.put('/api/v1/projects/:id/pull_requests/:iid/reviewers', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const pr = svc.setReviewers(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'), body.reviewer_ids)
    return prView(app, pr)
  })

  app.post('/api/v1/projects/:id/pull_requests/:iid/approve', { preHandler: auth }, async (req) =>
    prView(app, svc.approve(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'))),
  )
  app.post('/api/v1/projects/:id/pull_requests/:iid/unapprove', { preHandler: auth }, async (req) =>
    prView(app, svc.unapprove(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'))),
  )

  app.get('/api/v1/projects/:id/pull_requests/:iid/commits', async (req) => {
    const projectId = numParam(req, 'id')
    const iid = numParam(req, 'iid')
    const pr = svc.visiblePr(req.actor, projectId, iid)
    const project = app.store.projects.byId(projectId)!
    const engine = app.projects.storage.repository(project.disk_path)
    const srcTip = engine.resolveBranch(pr.source_branch)
    const tgtTip = engine.resolveBranch(pr.target_branch)
    if (!srcTip || !tgtTip) throw new AppError(422, 'A branch of this pull request no longer exists', 'branch_missing')
    const base = app.repositories.mergeBase(engine, tgtTip, srcTip)
    const aheadSet = base ? app.repositories.reachableSet(engine, srcTip, base) : new Set<string>()
    const commits = [...aheadSet]
      .map((s) => engine.readCommit(s))
      .sort((a, b) => b.committer.timestamp.time - a.committer.timestamp.time)
      .map((c) => ({
        sha: c.sha,
        short_sha: c.sha.slice(0, 10),
        title: c.message.split('\n')[0] ?? c.message,
        message: c.message,
        author_name: c.author.identity.name,
        author_email: c.author.identity.email,
        committed_at: new Date(c.committer.timestamp.time * 1000).toISOString(),
        parents: c.parents,
      }))
    return { commits, count: commits.length }
  })

  app.get('/api/v1/projects/:id/pull_requests/:iid/changes', async (req) => {
    const projectId = numParam(req, 'id')
    const iid = numParam(req, 'iid')
    const pr = svc.visiblePr(req.actor, projectId, iid)
    const withPatches = (req.query as { with_patches?: string }).with_patches === '1'
    const compare = app.repositories.compareRefs(req.actor, projectId, pr.target_branch, pr.source_branch, {
      with_patches: withPatches,
    })
    void labelView // imported for parity; labels serialize inside prView
    return {
      merge_base: compare.merge_base,
      commits_ahead_count: compare.commits_ahead_count,
      commits_behind_count: compare.commits_behind_count,
      files: compare.files,
    }
  })

  app.get('/api/v1/projects/:id/pull_requests/:iid/notes', async (req) => {
    const pr = svc.visiblePr(req.actor, numParam(req, 'id'), numParam(req, 'iid'))
    const includeSystem = (req.query as { include_system?: string }).include_system !== 'false'
    return {
      notes: svc.timeline(pr, { includeSystem }).map((n) => ({
        id: n.id,
        noteable_type: n.noteable_type,
        body: n.note,
        system: !!n.system,
        author: userBrief(app, n.author_id),
        created_at: n.created_at,
        updated_at: n.updated_at,
      })),
    }
  })

  app.post('/api/v1/projects/:id/pull_requests/:iid/notes', { preHandler: auth }, async (req, reply) => {
    const body = String((req.body as { body?: unknown } | undefined)?.body ?? '')
    const note = svc.comments(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'), body)
    reply.code(201)
    return {
      id: note.id,
      noteable_type: note.noteable_type,
      body: note.note,
      system: !!note.system,
      author: userBrief(app, note.author_id),
      created_at: note.created_at,
    }
  })

  app.patch('/api/v1/projects/:id/pull_requests/:iid/notes/:note_id', { preHandler: auth }, async (req) => {
    const body = String((req.body as { body?: unknown } | undefined)?.body ?? '')
    svc.editComment(actorOf(req), numParam(req, 'id'), numParam(req, 'note_id'), body)
    return { ok: true }
  })

  app.delete('/api/v1/projects/:id/pull_requests/:iid/notes/:note_id', { preHandler: auth }, async (req) => {
    svc.deleteComment(actorOf(req), numParam(req, 'id'), numParam(req, 'note_id'))
    return { ok: true }
  })
}

function actorOf(req: FastifyRequest) {
  if (!req.actor) throw new AppError(401, 'Authentication required')
  return req.actor
}
