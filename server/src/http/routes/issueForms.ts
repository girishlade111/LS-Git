import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError } from '../../services/identity.js'
import { issueView } from './issues.js'
import { FORM_LIMITS } from '../../lib/forms.js'

/**
 * Issue form template routes (templates live in the repository at
 * .lsgit/issues/forms/*.yml — see services/issueForms.ts).
 *
 *   GET    /api/v1/projects/:id/issue_forms                list (readers)
 *   GET    /api/v1/projects/:id/issue_forms/:name           parsed definition
 *   PUT    /api/v1/projects/:id/issue_forms/:name           upsert {yaml} (maintainer)
 *   DELETE /api/v1/projects/:id/issue_forms/:name
 *   POST   /api/v1/projects/:id/issue_forms/:name/submissions   → 201 issue
 */

function numParam(req: FastifyRequest, name: string): number {
  const n = Number((req.params as Record<string, string>)[name])
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, `Invalid ${name}`)
  return n
}

export function registerIssueFormRoutes(app: FastifyInstance): void {
  const svc = app.issueForms
  const auth = app.requireAuth()

  app.get('/api/v1/projects/:id/issue_forms', async (req) => {
    return { forms: svc.listForms(req.actor, numParam(req, 'id')) }
  })

  app.get('/api/v1/projects/:id/issue_forms/:name', async (req) => {
    const name = String((req.params as Record<string, string>).name ?? '')
    return { form: svc.getForm(req.actor, numParam(req, 'id'), name) }
  })

  app.put('/api/v1/projects/:id/issue_forms/:name', { preHandler: auth }, async (req) => {
    const name = String((req.params as Record<string, string>).name ?? '')
    const yamlText = (req.body as { yaml?: unknown } | undefined)?.yaml
    return svc.saveForm(req.actor!, numParam(req, 'id'), name, yamlText)
  })

  app.delete('/api/v1/projects/:id/issue_forms/:name', { preHandler: auth }, async (req) => {
    const name = String((req.params as Record<string, string>).name ?? '')
    return svc.deleteForm(req.actor!, numParam(req, 'id'), name)
  })

  app.post('/api/v1/projects/:id/issue_forms/:name/submissions', { preHandler: auth }, async (req, reply) => {
    const name = String((req.params as Record<string, string>).name ?? '')
    const body = (req.body ?? {}) as { title?: unknown; answers?: unknown }
    const { issue } = svc.submit(req.actor!, numParam(req, 'id'), name, body)
    reply.code(201)
    return { issue: issueView(app, issue) }
  })

  // Exposed for clients that want to pre-flight file size before upload.
  void FORM_LIMITS.maxTemplateBytes
}
