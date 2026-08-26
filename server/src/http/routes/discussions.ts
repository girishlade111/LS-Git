import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError } from '../../services/identity.js'

/**
 * Community discussion routes.
 *
 *   GET  /api/v1/projects/:id/discussions                     ?category&search&page&per_page
 *   POST /api/v1/projects/:id/discussions
 *   GET  /api/v1/projects/:id/discussions/:did                detail + comment tree + poll
 *   PATCH/DELETE /api/v1/projects/:id/discussions/:did        edit (author/maintainer) ·
 *                                                             pin/lock via {pinned,locked} (maintainer)
 *   POST /api/v1/projects/:id/discussions/:did/comments       {body, parent_id?}
 *   PATCH/DELETE .../discussions/:did/comments/:cid
 *   POST .../discussions/:did/best_answer                     {comment_id | null}
 *   POST .../discussions/:did/poll/vote                       {option_index}
 *   POST .../discussions/:did/reactions                       {name}
 *   POST .../discussions/:did/comments/:cid/reactions         {name}
 */

function numParam(req: FastifyRequest, name: string): number {
  const n = Number((req.params as Record<string, string>)[name])
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, `Invalid ${name}`)
  return n
}

function actorOf(req: FastifyRequest) {
  if (!req.actor) throw new AppError(401, 'Authentication required')
  return req.actor
}

export function registerDiscussionRoutes(app: FastifyInstance): void {
  const svc = app.discussions
  const auth = app.requireAuth()

  app.get('/api/v1/projects/:id/discussions', async (req) => {
    const q = req.query as Record<string, string | undefined>
    return svc.list(req.actor, numParam(req, 'id'), {
      category: q.category,
      search: q.search,
      page: q.page ? Number(q.page) : undefined,
      perPage: q.per_page ? Number(q.per_page) : undefined,
    })
  })

  app.post('/api/v1/projects/:id/discussions', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const d = svc.create(actorOf(req), numParam(req, 'id'), body)
    reply.code(201)
    return { discussion: d }
  })

  app.get('/api/v1/projects/:id/discussions/:did', async (req) => {
    return svc.detail(req.actor, numParam(req, 'id'), numParam(req, 'did'))
  })

  app.patch('/api/v1/projects/:id/discussions/:did', { preHandler: auth }, async (req) => {
    const patch = (req.body ?? {}) as Record<string, unknown>
    const d = svc.update(actorOf(req), numParam(req, 'id'), numParam(req, 'did'), patch)
    return { discussion: d }
  })

  app.delete('/api/v1/projects/:id/discussions/:did', { preHandler: auth }, async (req) => {
    svc.delete(actorOf(req), numParam(req, 'id'), numParam(req, 'did'))
    return { ok: true }
  })

  app.post('/api/v1/projects/:id/discussions/:did/comments', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const c = svc.addComment(actorOf(req), numParam(req, 'id'), numParam(req, 'did'), body)
    reply.code(201)
    return { comment: c }
  })

  app.patch('/api/v1/projects/:id/discussions/:did/comments/:cid', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    svc.updateComment(actorOf(req), numParam(req, 'id'), numParam(req, 'did'), numParam(req, 'cid'), body)
    return { ok: true }
  })

  app.delete('/api/v1/projects/:id/discussions/:did/comments/:cid', { preHandler: auth }, async (req) => {
    svc.deleteComment(actorOf(req), numParam(req, 'id'), numParam(req, 'did'), numParam(req, 'cid'))
    return { ok: true }
  })

  app.post('/api/v1/projects/:id/discussions/:did/best_answer', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const raw = body.comment_id
    const commentId = raw === null || raw === undefined ? null : Number(raw)
    svc.setBestAnswer(actorOf(req), numParam(req, 'id'), numParam(req, 'did'), commentId)
    return { best_answer_comment_id: commentId }
  })

  app.post('/api/v1/projects/:id/discussions/:did/poll/vote', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    return svc.votePoll(actorOf(req), numParam(req, 'id'), numParam(req, 'did'), body.option_index)
  })

  app.post('/api/v1/projects/:id/discussions/:did/reactions', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const did = numParam(req, 'did')
    const action = svc.toggleReaction(actorOf(req), numParam(req, 'id'), 'discussion', did, body.name)
    return { action, summary: svc.reactionSummary('discussion', did, actorOf(req).userId) }
  })

  app.post('/api/v1/projects/:id/discussions/:did/comments/:cid/reactions', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const cid = numParam(req, 'cid')
    const action = svc.toggleReaction(actorOf(req), numParam(req, 'id'), 'discussion_comment', cid, body.name)
    return { action, summary: svc.reactionSummary('discussion_comment', cid, actorOf(req).userId) }
  })
}
