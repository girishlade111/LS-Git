import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError } from '../../services/identity.js'

/**
 * Release routes (GitLab release behavior; see services/releases.ts).
 *
 *   POST  GET  /api/v1/projects/:id/releases
 *   GET        /api/v1/projects/:id/releases/latest
 *   GET PATCH DELETE /api/v1/projects/:id/releases/:tag
 *   POST       /api/v1/projects/:id/releases/:tag/notes/generate     {previous_tag?}
 *   PUT        /api/v1/projects/:id/releases/:tag/assets             raw upload (?filename=&content_type=)
 *   GET        /api/v1/projects/:id/releases/:tag/assets/:name/download
 *   DELETE     /api/v1/projects/:id/releases/:tag/assets/:name
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

export function registerReleaseRoutes(app: FastifyInstance): void {
  const svc = app.releases
  const auth = app.requireAuth()

  app.post('/api/v1/projects/:id/releases', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const release = svc.create(actorOf(req), numParam(req, 'id'), body)
    reply.code(201)
    return { release }
  })

  app.get('/api/v1/projects/:id/releases', async (req) => {
    return svc.list(req.actor, numParam(req, 'id'))
  })

  app.get('/api/v1/projects/:id/releases/latest', async (req) => {
    return svc.latest(req.actor, numParam(req, 'id'))
  })

  app.get('/api/v1/projects/:id/releases/:tag', async (req) => {
    const tag = decodeURIComponent((req.params as Record<string, string>).tag ?? '')
    return svc.get(req.actor, numParam(req, 'id'), tag)
  })

  app.patch('/api/v1/projects/:id/releases/:tag', { preHandler: auth }, async (req) => {
    const patch = (req.body ?? {}) as Record<string, unknown>
    const r = svc.update(actorOf(req), numParam(req, 'id'), decodeURIComponent((req.params as Record<string, string>).tag ?? ''), patch)
    return { release: { ...svc.releaseView(r), assets: svc['assetViews'](r.id) } }
  })

  app.delete('/api/v1/projects/:id/releases/:tag', { preHandler: auth }, async (req) => {
    svc.delete(actorOf(req), numParam(req, 'id'), decodeURIComponent((req.params as Record<string, string>).tag ?? ''))
    return { ok: true }
  })

  // ── notes generation (explicit only — never auto-saved) ────────────────────

  app.post('/api/v1/projects/:id/releases/:tag/notes/generate', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const projectId = numParam(req, 'id')
    const tag = decodeURIComponent((req.params as Record<string, string>).tag ?? '')
    const result = app.releases.generateNotes(actorOf(req), projectId, tag, {
      previous_tag: typeof body.previous_tag === 'string' ? body.previous_tag : undefined,
    })
    return { markdown: result.markdown, commit_count: result.commit_count, merged_prs: result.merged_prs,
      hint: 'Review and PATCH the release description to adopt these notes.' }
  })

  // ── assets ────────────────────────────────────────────────────────────────

  app.addContentTypeParser('application/octet-stream-release', { parseAs: 'buffer' }, (_req, _body, done) => done(null))

  app.put('/api/v1/projects/:id/releases/:tag/assets', { preHandler: auth }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    if (typeof req.body === 'string' || req.body === undefined || Buffer.isBuffer(req.body) === false) {
      throw new AppError(415, 'Asset uploads must use application/octet-stream bodies')
    }
    const contentType = req.headers['content-type']
    const result = svc.uploadAsset(
      actorOf(req),
      numParam(req, 'id'),
      decodeURIComponent((req.params as Record<string, string>).tag ?? ''),
      q.filename,
      contentType,
      req.body as Buffer,
    )
    reply.code(result.replaced ? 200 : 201)
    return {
      replaced: result.replaced,
      asset: {
        id: result.asset.id,
        filename: result.asset.filename,
        size: result.asset.size,
        sha256: result.asset.sha256,
        content_type: result.asset.content_type,
      },
    }
  })

  app.get('/api/v1/projects/:id/releases/:tag/assets/:name/download', async (req, reply) => {
    const filename = decodeURIComponent((req.params as Record<string, string>).name ?? '')
    const { path, asset } = svc.download(req.actor, numParam(req, 'id'), decodeURIComponent((req.params as Record<string, string>).tag ?? ''), filename)
    reply.header('content-type', asset.content_type)
    reply.header('content-length', asset.size)
    reply.header('content-disposition', `attachment; filename="${asset.filename}"`)
    reply.header('x-checksum-sha256', asset.sha256)
    reply.header('x-content-type-options', 'nosniff')
    reply.send(require('node:fs').readFileSync(path))
  })

  app.delete('/api/v1/projects/:id/releases/:tag/assets/:name', { preHandler: auth }, async (req) => {
    svc.deleteAsset(
      actorOf(req),
      numParam(req, 'id'),
      decodeURIComponent((req.params as Record<string, string>).tag ?? ''),
      decodeURIComponent((req.params as Record<string, string>).name ?? ''),
    )
    return { ok: true }
  })
}
