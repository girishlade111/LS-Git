import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError } from '../../services/identity.js'

/**
 * Project management routes (boards / items / fields / views / workflows /
 * insights). See services/pm.ts.
 *
 *   POST  GET              /api/v1/projects/:id/pm/boards
 *   GET  PATCH DELETE      /api/v1/projects/:id/pm/boards/:bid
 *   GET  POST              /api/v1/projects/:id/pm/boards/:bid/fields
 *   PATCH DELETE           /api/v1/projects/:id/pm/boards/:bid/fields/:fid
 *   GET  POST              /api/v1/projects/:id/pm/boards/:bid/items
 *   PATCH DELETE           /api/v1/projects/:id/pm/boards/:bid/items/:item_id
 *   POST                   /api/v1/projects/:id/pm/boards/:bid/items/:item_id/values/:key
 *   GET  POST DELETE       /api/v1/projects/:id/pm/boards/:bid/views[/:vid]
 *   GET  PUT               /api/v1/projects/:id/pm/boards/:bid/workflows
 *   GET                    /api/v1/projects/:id/pm/boards/:bid/insights
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

export function registerPmRoutes(app: FastifyInstance): void {
  const svc = app.pm
  const auth = app.requireAuth()

  const bid = (req: FastifyRequest) => numParam(req, 'bid')

  // ── boards ────────────────────────────────────────────────────────────────

  app.post('/api/v1/projects/:id/pm/boards', { preHandler: auth }, async (req, reply) => {
    const board = svc.createBoard(actorOf(req), numParam(req, 'id'), (req.body ?? {}) as Record<string, unknown>)
    reply.code(201)
    return { board }
  })

  app.get('/api/v1/projects/:id/pm/boards', async (req) => {
    return svc.listBoards(req.actor, numParam(req, 'id'))
  })

  app.get('/api/v1/projects/:id/pm/boards/:bid', async (req) => {
    return svc.getBoard(req.actor, numParam(req, 'id'), bid(req))
  })

  app.patch('/api/v1/projects/:id/pm/boards/:bid', { preHandler: auth }, async (req) => {
    return { board: svc.updateBoard(actorOf(req), numParam(req, 'id'), bid(req), (req.body ?? {}) as Record<string, unknown>) }
  })

  app.delete('/api/v1/projects/:id/pm/boards/:bid', { preHandler: auth }, async (req) => {
    svc.deleteBoard(actorOf(req), numParam(req, 'id'), bid(req))
    return { ok: true }
  })

  // ── fields ────────────────────────────────────────────────────────────────

  app.get('/api/v1/projects/:id/pm/boards/:bid/fields', async (req) => {
    return { fields: svc.listFields(req.actor, numParam(req, 'id'), bid(req)) }
  })

  app.post('/api/v1/projects/:id/pm/boards/:bid/fields', { preHandler: auth }, async (req, reply) => {
    const field = svc.createField(actorOf(req), numParam(req, 'id'), bid(req), (req.body ?? {}) as Record<string, unknown>)
    reply.code(201)
    return { field }
  })

  app.patch('/api/v1/projects/:id/pm/boards/:bid/fields/:fid', { preHandler: auth }, async (req) => {
    const field = svc.updateField(actorOf(req), numParam(req, 'id'), bid(req), numParam(req, 'fid'), (req.body ?? {}) as Record<string, unknown>)
    return { field }
  })

  app.delete('/api/v1/projects/:id/pm/boards/:bid/fields/:fid', { preHandler: auth }, async (req) => {
    svc.deleteField(actorOf(req), numParam(req, 'id'), bid(req), numParam(req, 'fid'))
    return { ok: true }
  })

  // ── items ─────────────────────────────────────────────────────────────────

  app.get('/api/v1/projects/:id/pm/boards/:bid/items', async (req) => {
    const q = req.query as Record<string, string | undefined>
    return svc.listItems(req.actor, numParam(req, 'id'), bid(req), q)
  })

  app.post('/api/v1/projects/:id/pm/boards/:bid/items', { preHandler: auth }, async (req, reply) => {
    const item = svc.addItem(actorOf(req), numParam(req, 'id'), bid(req), (req.body ?? {}) as Record<string, unknown>)
    reply.code(201)
    return { item }
  })

  app.patch('/api/v1/projects/:id/pm/boards/:bid/items/:item_id', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as { field_key?: unknown; value?: unknown }
    const key = String(body.field_key ?? '')
    if (!key) throw new AppError(400, 'field_key is required')
    const r = svc.setItemValue(actorOf(req), numParam(req, 'id'), bid(req), numParam(req, 'item_id'), key, body.value)
    return {
      from_status: r.from_status,
      to_status: r.to_status,
      item: svc.itemViewFull(app.store.pmBoards.byId(bid(req))!, r.item),
    }
  })

  app.delete('/api/v1/projects/:id/pm/boards/:bid/items/:item_id', { preHandler: auth }, async (req) => {
    svc.removeItem(actorOf(req), numParam(req, 'id'), bid(req), numParam(req, 'item_id'))
    return { ok: true }
  })

  // ── saved views ────────────────────────────────────────────────────────────

  app.get('/api/v1/projects/:id/pm/boards/:bid/views', async (req) => {
    return svc.listSavedViews(req.actor, numParam(req, 'id'), bid(req))
  })

  app.post('/api/v1/projects/:id/pm/boards/:bid/views', { preHandler: auth }, async (req, reply) => {
    const view = svc.createSavedView(actorOf(req), numParam(req, 'id'), bid(req), (req.body ?? {}) as Record<string, unknown>)
    reply.code(201)
    return { view }
  })

  app.delete('/api/v1/projects/:id/pm/boards/:bid/views/:vid', { preHandler: auth }, async (req) => {
    svc.deleteSavedView(actorOf(req), numParam(req, 'id'), bid(req), numParam(req, 'vid'))
    return { ok: true }
  })

  // ── workflows ──────────────────────────────────────────────────────────────

  app.get('/api/v1/projects/:id/pm/boards/:bid/workflows', async (req) => {
    return svc.listWorkflowRules(req.actor, numParam(req, 'id'), bid(req))
  })

  app.put('/api/v1/projects/:id/pm/boards/:bid/workflows', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const event = String(body.event ?? '')
    const target = body.target_status
    svc.setWorkflowRule(actorOf(req), numParam(req, 'id'), bid(req), event, target === null ? null : String(target))
    return { rules: svc.listWorkflowRules(req.actor, numParam(req, 'id'), bid(req)).rules }
  })

  // ── insights ────────────────────────────────────────────────────────────────

  app.get('/api/v1/projects/:id/pm/boards/:bid/insights', async (req) => {
    return svc.insights(req.actor, numParam(req, 'id'), bid(req))
  })
}
