import type { FastifyInstance } from 'fastify'
import { AppError } from '../../services/identity.js'
import { Buffer } from 'node:buffer'

/**
 * Upload workflow routes (GitLab files-API semantics, staged transfer):
 *
 *   POST   /api/v1/projects/:id/uploads/batches            → open a multi-file session
 *   GET    /api/v1/projects/:id/uploads/batches/:batchId    → session status (refresh recovery)
 *   DELETE /api/v1/projects/:id/uploads/batches/:batchId    → cancel session + staged bytes
 *   POST   /api/v1/projects/:id/uploads/batches/:batchId/finalize → ONE commit for the whole set
 *
 *   POST   /api/v1/projects/:id/uploads/initiate      → authz + path validation + conflict pre-check
 *   PUT    /api/v1/projects/:id/uploads/:uploadId     → temporary transfer (raw bytes; retryable)
 *   DELETE /api/v1/projects/:id/uploads/:uploadId     → cancellation
 *   POST   /api/v1/projects/:id/uploads/:uploadId/commit → blob→tree→commit→ref→event (single file)
 */
export function registerUploadRoutes(app: FastifyInstance): void {
  // Live upload limits so the UI pre-validates selections against real config.
  app.get('/api/v1/projects/:id/uploads/limits', { preHandler: app.requireAuth('read_api') }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id)) throw new AppError(400, 'Invalid project id')
    return {
      max_file_bytes: app.cfg.maxUploadBytes,
      max_batch_files: app.cfg.maxBatchFiles,
      max_batch_total_bytes: app.cfg.maxBatchTotalBytes,
    }
  })

  app.post('/api/v1/projects/:id/uploads/batches', { preHandler: app.requireAuth('write_api') }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id)) throw new AppError(400, 'Invalid project id')
    const result = app.uploads.createBatch(req.actor, id, (req.body ?? {}) as Record<string, unknown>)
    return reply.code(201).send(result)
  })

  app.get('/api/v1/projects/:id/uploads/batches/:batchId', { preHandler: app.requireAuth('read_api') }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    const batchId = String((req.params as { batchId: string }).batchId)
    return app.uploads.batchStatus(req.actor, id, batchId)
  })

  app.delete('/api/v1/projects/:id/uploads/batches/:batchId', { preHandler: app.requireAuth('write_api') }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    const batchId = String((req.params as { batchId: string }).batchId)
    app.uploads.cancelBatch(req.actor, id, batchId)
    return { ok: true }
  })

  app.post('/api/v1/projects/:id/uploads/batches/:batchId/finalize', { preHandler: app.requireAuth('write_api') }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const batchId = String((req.params as { batchId: string }).batchId)
    const body = (req.body ?? {}) as {
      branch?: string
      new_branch?: string
      start_branch?: string
      commit_message?: string
      replace?: boolean
      create_merge_request?: boolean
    }
    const result = await app.uploads.finalizeBatch(req.actor, id, batchId, body)
    // GitLab files-API parity: created content responds 201.
    return reply.code(201).send(result)
  })

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
