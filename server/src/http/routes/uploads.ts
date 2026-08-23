import type { FastifyInstance } from 'fastify'
import { AppError } from '../../services/identity.js'
import { Buffer } from 'node:buffer'

/**
 * Upload workflow routes (GitLab files-API semantics, staged transfer):
 *
 *   POST   /api/v1/projects/:id/uploads/initiate      → authz + path validation + conflict pre-check
 *   PUT    /api/v1/projects/:id/uploads/:uploadId     → temporary transfer (raw bytes; retryable)
 *   DELETE /api/v1/projects/:id/uploads/:uploadId     → cancellation
 *   POST   /api/v1/projects/:id/uploads/:uploadId/commit → blob→tree→commit→ref→event
 */
export function registerUploadRoutes(app: FastifyInstance): void {
  app.post('/api/v1/projects/:id/uploads/initiate', { preHandler: app.requireAuth('write_api') }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id)) throw new AppError(400, 'Invalid project id')
    return app.uploads.initiate(req.actor, id, (req.body ?? {}) as Record<string, unknown>)
  })

  app.put('/api/v1/projects/:id/uploads/:uploadId', { preHandler: app.requireAuth('write_api') }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    const uploadId = String((req.params as { uploadId: string }).uploadId)
    const body = req.body as Buffer | undefined
    if (!Buffer.isBuffer(body)) throw new AppError(400, 'Expected application/octet-stream body')
    return app.uploads.storeBytes(req.actor, id, uploadId, body)
  })

  app.delete('/api/v1/projects/:id/uploads/:uploadId', { preHandler: app.requireAuth('write_api') }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    const uploadId = String((req.params as { uploadId: string }).uploadId)
    app.uploads.cancel(req.actor, id, uploadId)
    return { ok: true }
  })

  app.post('/api/v1/projects/:id/uploads/:uploadId/commit', { preHandler: app.requireAuth('write_api') }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const uploadId = String((req.params as { uploadId: string }).uploadId)
    const body = (req.body ?? {}) as {
      branch?: string
      new_branch?: string
      start_branch?: string
      commit_message?: string
      replace?: boolean
    }
    // GitLab files-API parity: 201 for created, 200 for replaced.
    const result = await app.uploads.commit(req.actor, id, uploadId, body)
    return reply.code(result.replaced ? 200 : 201).send(result)
  })
}
