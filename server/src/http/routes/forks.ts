import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError } from '../../services/identity.js'

/**
 * Fork system routes (GitLab fork-network parity).
 *
 *   POST /api/v1/projects/:id/fork               fork into a namespace
 *   GET  /api/v1/projects/:id/fork/divergence    behind/ahead/diverged/up_to_date
 *   POST /api/v1/projects/:id/fork/sync          fast-forward sync (never overwrites)
 *   POST /api/v1/projects/:id/fork/detach        strong-confirmed detach (owner/admin)
 *   GET  /api/v1/projects/:id/fork/network       upstream + forks + descendants graph
 */

export function registerForkRoutes(app: FastifyInstance): void {
  const forks = app.forks
  const auth = app.requireAuth()

  function projectId(req: FastifyRequest): number {
    return Number((req.params as { id: string }).id)
  }

  app.post('/api/v1/projects/:id/fork', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const result = forks.createFork(req.actor, projectId(req), {
      path: typeof body.path === 'string' ? body.path : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
      visibility: (body.visibility === 'public' || body.visibility === 'internal' || body.visibility === 'private')
        ? body.visibility
        : undefined,
      namespace: typeof body.namespace === 'string' ? body.namespace : undefined,
    })
    reply.code(201)
    return {
      project: projectLite(result.project),
      source: result.source,
    }
  })

  app.get('/api/v1/projects/:id/fork/divergence', { preHandler: auth }, async (req) => {
    const q = req.query as { branch?: string }
    return forks.divergence(req.actor, projectId(req), { branch: q.branch ?? null })
  })

  app.post('/api/v1/projects/:id/fork/sync', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    return forks.syncBranch(req.actor, projectId(req), {
      branch: typeof body.branch === 'string' ? body.branch : null,
    })
  })

  app.post('/api/v1/projects/:id/fork/detach', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    return forks.detachFork(req.actor, projectId(req), String(body.confirm_path ?? ''))
  })

  app.get('/api/v1/projects/:id/fork/network', async (req) => {
    return forks.networkGraph(req.actor, projectId(req))
  })
}

function projectLite(p: NonNullable<ReturnType<InstanceType<typeof import('../../services/identity.js').IdentityService>['requireUser']>>) {
  void p
  throw new Error('replaced below')
}
void AppError
