import type { FastifyInstance } from 'fastify'
import { AppError } from '../../services/identity.js'
import { Buffer } from 'node:buffer'

/**
 * Resumable upload session API (UPLOADS.md) — headless infrastructure,
 * independent of the visual upload UI. Conventions follow /uploads:
 * JSON control plane, raw octet-stream chunk bodies, CSRF-protected
 * cookie mutations, PAT scope gates.
 *
 *   POST   /projects/:id/upload_sessions                              → create + manifest → items
 *   GET    /projects/:id/upload_sessions/:sid                         → structured state (resume/reconcile)
 *   DELETE /projects/:id/upload_sessions/:sid                         → cancel + staging discard
 *   PUT    /projects/:id/upload_sessions/:sid/items/:item/chunks/:i   → idempotent chunk transfer
 *   GET    /projects/:id/upload_sessions/:sid/items/:item/chunks      → received-chunk map (resume)
 *   POST   /projects/:id/upload_sessions/:sid/finalize                → verify → ONE commit → events
 */
export function registerUploadSessionRoutes(app: FastifyInstance): void {
  app.post('/api/v1/projects/:id/upload_sessions', { preHandler: app.requireAuth('write_api') }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id)) throw new AppError(400, 'Invalid project id')
    const result = await app.uploadSessions.createSession(req.actor, id, (req.body ?? {}) as Record<string, unknown>)
    return reply.code(201).send(result)
  })

  app.get('/api/v1/projects/:id/upload_sessions/:sid', { preHandler: app.requireAuth('read_api') }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    const sid = String((req.params as { sid: string }).sid)
    return app.uploadSessions.getSession(req.actor, id, sid)
  })

  app.delete('/api/v1/projects/:id/upload_sessions/:sid', { preHandler: app.requireAuth('write_api') }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    const sid = String((req.params as { sid: string }).sid)
    app.uploadSessions.cancel(req.actor, id, sid)
    return { ok: true }
  })

  app.put('/api/v1/projects/:id/upload_sessions/:sid/items/:itemId/chunks/:index', { preHandler: app.requireAuth('write_api') }, async (req) => {
    const p = req.params as { id: string; sid: string; itemId: string; index: string }
    const id = Number(p.id)
    if (!Number.isInteger(id)) throw new AppError(400, 'Invalid project id')
    const body = req.body as Buffer | undefined
    if (!Buffer.isBuffer(body)) throw new AppError(400, 'Expected application/octet-stream body')
    const declaredSha = req.headers['x-chunk-sha256']
    return app.uploadSessions.putChunk(req.actor, id, p.sid, p.itemId, p.index, body, {
      declaredSha256: typeof declaredSha === 'string' ? declaredSha : undefined,
    })
  })

  app.get('/api/v1/projects/:id/upload_sessions/:sid/items/:itemId/chunks', { preHandler: app.requireAuth('read_api') }, async (req) => {
    const p = req.params as { id: string; sid: string; itemId: string }
    const id = Number(p.id)
    if (!Number.isInteger(id)) throw new AppError(400, 'Invalid project id')
    return app.uploadSessions.getChunkMap(req.actor, id, p.sid, p.itemId)
  })

  app.post('/api/v1/projects/:id/upload_sessions/:sid/finalize', { preHandler: app.requireAuth('write_api') }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const sid = String((req.params as { sid: string }).sid)
    const result = await app.uploadSessions.finalize(req.actor, id, sid, (req.body ?? {}) as Record<string, unknown>)
    // Idempotent replays answer 200; first successful commit answers 201.
    return reply.code(result.already_committed ? 200 : 201).send(result)
  })
}
