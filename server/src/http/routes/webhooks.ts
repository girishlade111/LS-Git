import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError } from '../../services/identity.js'

/**
 * Webhook routes (GitLab project-hooks API parity; see services/webhooks.ts).
 *
 *   GET    /api/v1/projects/:id/webhooks                     list
 *   POST   /api/v1/projects/:id/webhooks                     create  → 201 {webhook, secret}
 *   GET    /api/v1/projects/:id/webhooks/:hid                detail + recent deliveries
 *   PATCH  /api/v1/projects/:id/webhooks/:hid                update (url/name/desc/events/ssl_verify/state_event)
 *   DELETE /api/v1/projects/:id/webhooks/:hid                delete
 *   POST   /api/v1/projects/:id/webhooks/:hid/secret/rotate  rotate  → {secret} (shown once)
 *   POST   /api/v1/projects/:id/webhooks/:hid/test           test delivery → 202 {delivery}
 *   GET    /api/v1/projects/:id/webhooks/:hid/deliveries     delivery history
 *   GET    /api/v1/projects/:id/webhooks/:hid/deliveries/:did  delivery detail (incl. response snippet)
 *   POST   /api/v1/projects/:id/webhooks/:hid/deliveries/:did/replay → 202 {delivery}
 *
 * Delivery itself NEVER happens inside these request handlers — they only
 * enqueue; the dispatcher worker performs HTTP.
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

export function registerWebhookRoutes(app: FastifyInstance): void {
  const svc = app.webhooks
  const auth = app.requireAuth()

  app.get('/api/v1/projects/:id/webhooks', { preHandler: auth }, async (req) =>
    svc.list(req.actor, numParam(req, 'id')),
  )

  app.post('/api/v1/projects/:id/webhooks', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const created = svc.create(actorOf(req), numParam(req, 'id'), body)
    reply.code(201)
    return created
  })

  app.get('/api/v1/projects/:id/webhooks/:hid', { preHandler: auth }, async (req) =>
    svc.get(req.actor, numParam(req, 'id'), numParam(req, 'hid')),
  )

  app.patch('/api/v1/projects/:id/webhooks/:hid', { preHandler: auth }, async (req) => {
    const patch = (req.body ?? {}) as Record<string, unknown>
    const webhook = svc.update(actorOf(req), numParam(req, 'id'), numParam(req, 'hid'), patch)
    return { webhook }
  })

  app.delete('/api/v1/projects/:id/webhooks/:hid', { preHandler: auth }, async (req) => {
    svc.remove(actorOf(req), numParam(req, 'id'), numParam(req, 'hid'))
    return { ok: true }
  })

  app.post('/api/v1/projects/:id/webhooks/:hid/secret/rotate', { preHandler: auth }, async (req) =>
    svc.rotateSecret(actorOf(req), numParam(req, 'id'), numParam(req, 'hid')),
  )

  // 202 Accepted: the test delivery is queued, not sent inline.
  app.post('/api/v1/projects/:id/webhooks/:hid/test', { preHandler: auth }, async (req, reply) => {
    const delivery = svc.testDelivery(actorOf(req), numParam(req, 'id'), numParam(req, 'hid'))
    reply.code(202)
    return { delivery }
  })

  app.get('/api/v1/projects/:id/webhooks/:hid/deliveries', { preHandler: auth }, async (req) => {
    const q = req.query as Record<string, string | undefined>
    const limit = q.limit !== undefined ? Number(q.limit) || undefined : undefined
    return svc.listDeliveries(req.actor, numParam(req, 'id'), numParam(req, 'hid'), limit)
  })

  app.get('/api/v1/projects/:id/webhooks/:hid/deliveries/:did', { preHandler: auth }, async (req) =>
    svc.getDelivery(
      req.actor,
      numParam(req, 'id'),
      numParam(req, 'hid'),
      decodeURIComponent((req.params as Record<string, string>).did ?? ''),
    ),
  )

  app.post('/api/v1/projects/:id/webhooks/:hid/deliveries/:did/replay', { preHandler: auth }, async (req, reply) => {
    const delivery = svc.replayDelivery(
      actorOf(req),
      numParam(req, 'id'),
      numParam(req, 'hid'),
      decodeURIComponent((req.params as Record<string, string>).did ?? ''),
    )
    reply.code(202)
    return { delivery }
  })
}
