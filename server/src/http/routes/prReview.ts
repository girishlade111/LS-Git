import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError } from '../../services/identity.js'
import { prView } from './pullRequests.js'

/**
 * Code-review routes (GitLab review/suggestion semantics).
 *
 *   GET  /api/v1/projects/:id/pull_requests/:iid/threads
 *   POST /api/v1/projects/:id/pull_requests/:iid/threads              inline/multi-line
 *   POST /api/v1/projects/:id/pull_requests/:iid/threads/:tid/replies
 *   POST /api/v1/projects/:id/pull_requests/:iid/threads/:tid/resolve | /unresolve
 *   GET/POST /api/v1/projects/:id/pull_requests/:iid/draft_comments   (+ PATCH/DELETE :did)
 *   POST /api/v1/projects/:id/pull_requests/:iid/reviews              submit review
 *   GET  /api/v1/projects/:id/pull_requests/:iid/reviews              latest per reviewer
 *   POST /api/v1/projects/:id/pull_requests/:iid/suggestions/apply    batch (all-or-nothing)
 *   POST /api/v1/projects/:id/pr_thread_notes/:note_id/suggestions/apply | /reject
 *   GET  /api/v1/projects/:id/pull_requests/:iid/codeowners           coverage foundation
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

export function registerPrReviewRoutes(app: FastifyInstance): void {
  const svc = app.prReview
  const auth = app.requireAuth()

  // ── threads ──────────────────────────────────────────────────────────────

  app.get('/api/v1/projects/:id/pull_requests/:iid/threads', async (req) => {
    return svc.listThreads(req.actor, numParam(req, 'id'), numParam(req, 'iid'))
  })

  app.post('/api/v1/projects/:id/pull_requests/:iid/threads', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const thread = svc.createThread(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'), body)
    reply.code(201)
    return { thread }
  })

  app.post('/api/v1/projects/:id/pull_requests/:iid/threads/:thread_id/replies', { preHandler: auth }, async (req, reply) => {
    const body = String((req.body as { body?: unknown } | undefined)?.body ?? '')
    const note = svc.reply(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'), numParam(req, 'thread_id'), { body })
    reply.code(201)
    return { note }
  })

  app.post('/api/v1/projects/:id/pull_requests/:iid/threads/:thread_id/resolve', { preHandler: auth }, async (req) => {
    const t = svc.resolve(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'), numParam(req, 'thread_id'))
    return { id: t.id, resolved: !!t.resolved }
  })

  app.post('/api/v1/projects/:id/pull_requests/:iid/threads/:thread_id/unresolve', { preHandler: auth }, async (req) => {
    const t = svc.unresolve(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'), numParam(req, 'thread_id'))
    return { id: t.id, resolved: !!t.resolved }
  })

  // ── suggestions ───────────────────────────────────────────────────────────

  app.post('/api/v1/projects/:id/pull_requests/:iid/suggestions/apply', { preHandler: auth }, async (req) => {
    const ids = (req.body as { suggestion_note_ids?: unknown } | undefined)?.suggestion_note_ids
    if (ids === undefined) {
      throw new AppError(400, 'suggestion_note_ids is required (batch of one or more)')
    }
    return svc.batchApplySuggestions(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'), ids)
  })

  // Single-suggestion convenience — same real-commit semantics as batch of one.
  app.post('/api/v1/projects/:id/pull_requests/:iid/thread_notes/:note_id/suggestions/apply', { preHandler: auth }, async (req) => {
    return svc.applySuggestion(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'), numParam(req, 'note_id'))
  })

  app.post('/api/v1/projects/:id/pull_requests/:iid/thread_notes/:note_id/suggestions/reject', { preHandler: auth }, async (req) => {
    svc.rejectSuggestion(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'), numParam(req, 'note_id'))
    return { ok: true }
  })

  // ── reviews & drafts ──────────────────────────────────────────────────────

  app.get('/api/v1/projects/:id/pull_requests/:iid/reviews', async (req) => {
    return svc.listReviews(req.actor, numParam(req, 'id'), numParam(req, 'iid'))
  })

  app.post('/api/v1/projects/:id/pull_requests/:iid/reviews', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const result = svc.submitReview(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'), body)
    const fresh = app.store.pullRequests.byIid(numParam(req, 'id'), numParam(req, 'iid'))
    return { ...result, pull_request: fresh ? prView(app, fresh) : null }
  })

  app.get('/api/v1/projects/:id/pull_requests/:iid/draft_comments', { preHandler: auth }, async (req) => {
    return svc.listDrafts(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'))
  })

  app.post('/api/v1/projects/:id/pull_requests/:iid/draft_comments', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const draft = svc.addDraft(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'), body)
    reply.code(201)
    return { draft }
  })

  app.patch('/api/v1/projects/:id/pull_requests/:iid/draft_comments/:draft_id', { preHandler: auth }, async (req) => {
    const patch = (req.body ?? {}) as Record<string, unknown>
    svc.updateDraft(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'), numParam(req, 'draft_id'), patch)
    return { ok: true }
  })

  app.delete('/api/v1/projects/:id/pull_requests/:iid/draft_comments/:draft_id', { preHandler: auth }, async (req) => {
    svc.deleteDraft(actorOf(req), numParam(req, 'id'), numParam(req, 'iid'), numParam(req, 'draft_id'))
    return { ok: true }
  })

  // ── CODEOWNERS coverage foundation ────────────────────────────────────────

  app.get('/api/v1/projects/:id/pull_requests/:iid/codeowners', async (req) => {
    return svc.codeownersCoverage(req.actor, numParam(req, 'id'), numParam(req, 'iid'))
  })
}
