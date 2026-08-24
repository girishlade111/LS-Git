import type { FastifyInstance } from 'fastify'
import { AppError } from '../../services/identity.js'
import { validateCreateProject, projectPathSchema, projectNameSchema } from '../../lib/projects.js'
import { normalizeTopic } from '../../lib/projects.js'
import { GITIGNORE_TEMPLATES, LICENSE_TEMPLATES } from '../../storage/templates.js'
import type { ProjectRow } from '../../db/store.js'
import { can as authzCan } from '../../authz.js'

export function projectView(app: FastifyInstance, p: ProjectRow) {
  const owner = app.store.users.byId(p.owner_id)
  const upstream = p.forked_from_project_id ? app.store.projects.byId(p.forked_from_project_id) : undefined
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    full_path: `${owner?.username ?? ''}/${p.path}`,
    visibility: p.visibility,
    description: p.description,
    website_url: p.website_url,
    default_branch: p.default_branch,
    archived: !!p.archived,
    is_template: !!p.is_template,
    topics: app.store.topics.listForProject(p.id),
    owner: owner ? { id: owner.id, username: owner.username, name: owner.name } : null,
    created_at: p.created_at,
    last_activity_at: p.last_activity_at,
    // Existence-only booleans; no storage internals leak (hashed paths stay server-side).
    repository_empty: !p.initialized,
    fork_of: null as null, // fork relationships arrive with the collaboration phase
    upstream_full_path:
      p.forked_from_project_id != null
        ? (() => {
            const src = app.store.projects.byId(p.forked_from_project_id)
            if (!src) return null
            const srcOwner = app.store.users.byId(src.owner_id)
            return srcOwner ? `${srcOwner.username}/${src.path}` : null
          })()
        : null,
  }
}

export function registerProjectRoutes(app: FastifyInstance): void {
  const auth = app.requireAuth()

  // -- catalogs for the creation form ---------------------------------------
  app.get('/api/v1/project_templates/catalog', async () => ({
    gitignore: Object.keys(GITIGNORE_TEMPLATES),
    licenses: LICENSE_TEMPLATES.map((l) => ({ key: l.key, name: l.name })),
  }))

  app.get('/api/v1/projects/templates', async () => {
    return app.projects.listTemplates().map((p) => projectView(app, p))
  })

  // -- create -----------------------------------------------------------------
  app.post('/api/v1/projects', { preHandler: auth }, async (req, reply) => {
    const parsed = validateCreateProject(req.body)
    if (!parsed.ok) throw new AppError(400, parsed.error, 'validation_failed')
    const project = app.projects.create(req.actor, parsed.value)
    reply.code(201)
    return projectView(app, project)
  })

  // -- lists --------------------------------------------------------------------
  app.get('/api/v1/projects', { preHandler: auth }, async (req) => {
    return app.projects.listMine(req.actor!.userId).map((p) => projectView(app, p))
  })

  app.get('/api/v1/projects/explore', async (req) => {
    const q = req.query as { search?: string; topic?: string }
    return app.projects
      .explorePublic({ search: q.search?.slice(0, 100), topic: q.topic ? normalizeTopic(q.topic) ?? undefined : undefined })
      .map((p) => projectView(app, p))
  })

  app.get('/api/v1/topics/search', async (req) => {
    const q = String((req.query as { q?: string }).q ?? '')
    return app.store.topics.search(q.slice(0, 100))
  })

  // -- resolve by path (redirect-aware) --------------------------------------------
  app.get('/api/v1/:owner/:path', async (req, reply) => {
    const { owner, path } = req.params as { owner: string; path: string }
    const clean = path.replace(/\.git$/, '')
    let project = app.store.projects.byOwnerPath(owner, clean)
    if (!project) {
      // Renames/transfers leave redirects so old URLs keep resolving.
      const redirected = app.store.redirects.resolve(owner, clean)
      if (redirected !== undefined) {
        project = app.store.projects.byId(redirected)
        if (project) reply.header('x-lsgit-redirected-from', `${owner}/${clean}`)
      }
    }
    if (!project) {
      reply.code(404).send({ message: 'Project not found' })
      return
    }
    app.projects.authorize(req.actor, 'project:read', project)
    return projectView(app, project)
  })

  // -- single project -------------------------------------------------------------
  app.get('/api/v1/projects/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const project = app.store.projects.byId(id)
    if (!project) {
      reply.code(404).send({ message: 'Project not found' })
      return
    }
    app.projects.authorize(req.actor, 'project:read', project)
    return projectView(app, project)
  })

  // -- metadata ----------------------------------------------------------------------
  app.patch('/api/v1/projects/:id', { preHandler: auth }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    const body = (req.body ?? {}) as Record<string, unknown>
    const fields: Record<string, unknown> = {}

    if (body.name !== undefined) {
      const n = projectNameSchema.safeParse(body.name)
      if (!n.success) throw new AppError(400, n.error.issues[0]!.message)
      fields.name = n.data
    }
    if (body.description !== undefined) fields.description = String(body.description).slice(0, 1000)
    if (body.website_url !== undefined) fields.website_url = String(body.website_url).trim().slice(0, 500)
    if (body.visibility !== undefined) {
      if (!['private', 'internal', 'public'].includes(String(body.visibility))) {
        throw new AppError(400, 'Invalid visibility level')
      }
      fields.visibility = body.visibility
    }
    if (body.default_branch !== undefined) {
      const b = String(body.default_branch).trim()
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(b) || b.length > 255 || b.includes('..')) {
        throw new AppError(400, 'Invalid default branch name')
      }
      fields.default_branch = b
    }
    if (body.topics !== undefined) {
      if (!Array.isArray(body.topics)) throw new AppError(400, 'topics must be an array')
      const normalized = (body.topics as unknown[]).slice(0, app.cfg.maxTopicsPerProject + 1).map((t) => normalizeTopic(String(t)))
      if (normalized.some((t) => t === null)) throw new AppError(400, 'Invalid topic value')
      const unique = [...new Set(normalized as string[])]
      if (unique.length > app.cfg.maxTopicsPerProject) {
        throw new AppError(400, `A project can have at most ${app.cfg.maxTopicsPerProject} topics`)
      }
      fields.topics = unique
    }

    const updated = app.projects.updateMetadata(req.actor, id, fields)
    return projectView(app, updated)
  })

  // -- archive / unarchive / template flag -----------------------------------------------
  app.post('/api/v1/projects/:id/archive', { preHandler: auth }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    return projectView(app, app.projects.setArchived(req.actor, id, true))
  })
  app.post('/api/v1/projects/:id/unarchive', { preHandler: auth }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    return projectView(app, app.projects.setArchived(req.actor, id, false))
  })
  app.put('/api/v1/projects/:id/template', { preHandler: auth }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    const enabled = (req.body as { enabled?: boolean })?.enabled === true
    return projectView(app, app.projects.setTemplate(req.actor, id, enabled))
  })

  // -- rename / transfer --------------------------------------------------------------------
  app.post('/api/v1/projects/:id/rename', { preHandler: auth }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    const newPath = String((req.body as { path?: unknown })?.path ?? '')
    const parsed = projectPathSchema.safeParse(newPath)
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0]!.message)
    const { project, redirectCreated } = app.projects.rename(req.actor, id, parsed.data)
    return { ...projectView(app, project), redirect_created: redirectCreated }
  })

  app.post('/api/v1/projects/:id/transfer', { preHandler: auth }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    const newOwner = String((req.body as { new_owner?: unknown })?.new_owner ?? '')
    const project = app.projects.transfer(req.actor, id, newOwner)
    return projectView(app, project)
  })

  // -- protected branches (minimal enforcement point; globs arrive later) -----------
  app.get('/api/v1/projects/:id/protected_branches', { preHandler: auth }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    const project = app.store.projects.byId(id)
    if (!project) throw new AppError(404, 'Project not found')
    app.projects.authorize(req.actor, 'project:read', project)
    return app.store.protectedBranches.listForProject(id)
  })

  app.put('/api/v1/projects/:id/protected_branches', { preHandler: auth }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    const body = (req.body ?? {}) as { name?: unknown; push_access_level?: unknown }
    const name = String(body.name ?? '').trim()
    const level = String(body.push_access_level ?? '')
    if (!name || name.length > 255) throw new AppError(400, 'A branch name is required')
    if (!['no_one', 'maintainer'].includes(level)) {
      throw new AppError(400, "push_access_level must be 'no_one' or 'maintainer'")
    }
    const project = app.projects.visibleTo(req.actor, id)
    app.projects.authorize(req.actor, 'project:update', project)
    app.store.protectedBranches.set(id, name, level as 'no_one' | 'maintainer')
    return app.store.protectedBranches.listForProject(id)
  })

  // -- deletion ----------------------------------------------------------------------------------
  app.delete('/api/v1/projects/:id', { preHandler: auth }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    const confirmPath = String((req.query as { confirm_path?: string }).confirm_path ?? '')
    app.projects.delete(req.actor, id, confirmPath)
    return { ok: true, message: 'Project deleted' }
  })

  void authzCan
}
