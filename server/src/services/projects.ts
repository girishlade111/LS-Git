import { AppError } from './identity.js'
import type { IdentityServices } from './identity.js'
import type { AppConfig } from '../config.js'
import type { Visibility, ProjectRow } from '../db/store.js'
import { LocalHashedStorage } from '../storage/local.js'
import { gitignoreFor, licenseFor } from '../storage/templates.js'
import type { Actor } from '../authz.js'
import { can } from '../authz.js'

/**
 * Project/repository service. All authorization flows through the central
 * service (authz.ts); this layer only supplies context and performs effects.
 *
 * Consistency pattern: metadata rows are written inside a transaction; the
 * disk effect (hashed bare repo) happens after commit, with compensating
 * metadata cleanup if storage fails — Git objects never live in PostgreSQL.
 */

export class ProjectsService {
  readonly storage: LocalHashedStorage

  constructor(private s: IdentityServices, private cfg: AppConfig) {
    this.storage = new LocalHashedStorage(cfg.repositoriesRoot)
  }

  // -- helpers ---------------------------------------------------------------

  private requireProject(id: number): ProjectRow {
    const p = this.s.projects.byId(id)
    if (!p) throw new AppError(404, 'Project not found')
    return p
  }

  ownerUsernameOf(project: ProjectRow): string {
    return this.s.users.byId(project.owner_id)?.username ?? ''
  }

  fullPath(project: ProjectRow): string {
    return `${this.ownerUsernameOf(project)}/${project.path}`
  }

  private projectCtx(project: ProjectRow) {
    return {
      resourceProject: {
        ownerId: project.owner_id,
        visibility: project.visibility,
        archived: !!project.archived,
      },
    }
  }

  /** Central-authorization gate used by routes AND internally. */
  authorize(actor: Actor | null, permission: Parameters<typeof can>[1], project?: ProjectRow): void {
    const ok = can(actor, permission, project ? this.projectCtx(project) : {})
    if (!ok) {
      throw new AppError(
        actor ? 403 : 401,
        actor
          ? 'You are not allowed to perform this action on this project'
          : 'Authentication required',
        actor ? 'forbidden' : 'unauthenticated',
      )
    }
  }

  resolveByFullPath(fullPath: string): ProjectRow | undefined {
    const [ownerUsername, path] = fullPath.split('/')
    if (!ownerUsername || !path) return undefined
    return this.s.projects.byOwnerPath(ownerUsername, path)
  }

  // -- creation ----------------------------------------------------------------

  create(
    actor: Actor | null,
    input: {
      name: string
      path: string
      visibility: Visibility
      description: string
      website_url: string
      default_branch: string
      initialize_with_readme: boolean
      gitignore_template: string | null
      license_template: string | null
      topics: string[]
      template_project_id: number | null
    },
  ): ProjectRow {
    this.authorize(actor, 'project:create')

    if (input.template_project_id !== null) {
      return this.createFromTemplate(actor, input.template_project_id, input)
    }

    const owner = this.requireUser(actor!.userId)

    if (this.s.projects.byOwnerPath(owner.username, input.path)) {
      throw new AppError(409, 'Path has already been taken', 'path_taken')
    }

    // Compose initial files (README / .gitignore / LICENSE).
    const files: Array<{ path: string; content: string }> = []
    if (input.initialize_with_readme || input.gitignore_template || input.license_template) {
      files.push({
        path: 'README.md',
        content:
          `# ${input.name}\n\n` +
          (input.description ? `${input.description}\n` : ''),
      })
    }
    if (input.gitignore_template) {
      const gi = gitignoreFor(input.gitignore_template)
      if (!gi) {
        throw new AppError(400, `Unknown .gitignore template: ${input.gitignore_template}`, 'validation_failed')
      }
      files.push({ path: '.gitignore', content: gi })
    }
    if (input.license_template) {
      const lic = licenseFor(input.license_template)
      if (!lic) {
        throw new AppError(400, `Unknown license template: ${input.license_template}`, 'validation_failed')
      }
      files.push({ path: lic.fileName, content: lic.body })
    }

    const shouldInitialize = files.length > 0

    // 1) Metadata row inside a transaction (id drives the hashed disk path).
    let project!: ProjectRow
    try {
      project = this.s.db.transaction(() =>
        this.s.projects.create({
          owner_id: owner.id,
          name: input.name,
          path: input.path,
          visibility: input.visibility,
          description: input.description,
          website_url: input.website_url,
          default_branch: input.default_branch,
          disk_path: '', // patched below once id exists — see post-create fixup
          initialized: false,
        }),
      )
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) {
        throw new AppError(409, 'Path has already been taken', 'path_taken')
      }
      throw err
    }

    // The hashed path needs the generated id; update within the same logical step.
    const diskPath = this.storage.diskPathFor(project.id)
    this.s.db.transaction(() => {
      this.s.db.run('UPDATE projects SET disk_path = ?, initialized = ? WHERE id = ?', diskPath, shouldInitialize ? 1 : 0, project.id)
      if (input.topics.length > 0) this.s.topics.setForProject(project.id, input.topics)
    })
    project = this.requireProject(project.id)

    // 2) Disk effect + compensation.
    try {
      if (shouldInitialize) {
        this.storage.initializeWithFiles(
          diskPath,
          input.default_branch,
          files,
          { name: owner.name ?? owner.username, email: `${owner.username}@users.lsgit.local` },
          'Initial commit',
        )
      } else {
        this.storage.createRepository(diskPath, input.default_branch)
      }
    } catch (err) {
      // Compensating cleanup keeps metadata consistent with storage.
      this.db.transaction(() => {
        this.s.redirects.deleteForProject(project.id)
        this.db.run('DELETE FROM projects WHERE id = ?', project.id)
        this.s.topics.pruneOrphans()
      })
      throw new AppError(500, 'Failed to create repository storage')
    }

    this.touchActivity(project.id)
    return this.requireProject(project.id)
  }

  // -- read --------------------------------------------------------------------

  listMine(userId: number): Array<ProjectRow> {
    return this.s.projects.listByOwner(userId)
  }

  explorePublic(opts: { search?: string; topic?: string }): Array<ProjectRow> {
    return this.s.projects.listPublic(opts)
  }

  visibleTo(actor: Actor | null, id: number): ProjectRow {
    const project = this.requireProject(id)
    // Archived projects remain readable; visibility rules still apply.
    this.authorize(actor, 'project:read', project)
    return project
  }

  // -- metadata ------------------------------------------------------------------

  updateMetadata(
    actor: Actor | null,
    projectId: number,
    fields: Partial<{
      name: string
      description: string
      website_url: string
      visibility: Visibility
      default_branch: string
      topics: string[]
    }>,
  ): ProjectRow {
    const project = this.requireProject(projectId)
    this.authorize(actor, 'project:update', project)

    const updates: Record<string, unknown> = {}
    if (fields.name !== undefined) updates.name = String(fields.name).trim().slice(0, 255)
    if (fields.description !== undefined) updates.description = String(fields.description).slice(0, 1000)
    if (fields.website_url !== undefined) updates.website_url = String(fields.website_url).slice(0, 500)
    if (fields.visibility !== undefined) updates.visibility = fields.visibility
    if (fields.default_branch !== undefined) updates.default_branch = fields.default_branch

    this.db.transaction(() => {
      if (Object.keys(updates).length > 0) this.s.projects.update(projectId, updates)
      if (fields.topics !== undefined) {
        this.s.topics.setForProject(projectId, fields.topics)
        this.s.topics.pruneOrphans()
      }
    })
    this.touchActivity(projectId)
    return this.requireProject(projectId)
  }

  // -- archive -----------------------------------------------------------------

  setArchived(actor: Actor | null, projectId: number, archived: boolean): ProjectRow {
    const project = this.requireProject(projectId)
    this.authorize(actor, 'project:archive', project)
    this.s.projects.update(projectId, { archived: archived ? 1 : 0 })
    return this.requireProject(projectId)
  }

  setTemplate(actor: Actor | null, projectId: number, enabled: boolean): ProjectRow {
    const project = this.requireProject(projectId)
    this.authorize(actor, 'project:template', project)
    this.s.projects.update(projectId, { is_template: enabled ? 1 : 0 })
    return this.requireProject(projectId)
  }

  listTemplates(): Array<ProjectRow> {
    return this.s.projects.listTemplates()
  }

  createFromTemplate(
    actor: Actor | null,
    templateId: number,
    spec: {
      name: string
      path: string
      visibility: Visibility
      description?: string
      topics?: string[]
      default_branch?: string
    },
  ): ProjectRow {
    const template = this.requireProject(templateId)
    if (!template.is_template) throw new AppError(400, 'Source project is not a template')

    const owner = this.requireUser(actor!.userId)
    if (this.s.projects.byOwnerPath(owner.username, spec.path)) {
      throw new AppError(409, 'Path has already been taken', 'path_taken')
    }

    const diskPath = '' as string
    let project!: ProjectRow
    project = this.db.transaction(() =>
      this.s.projects.create({
        owner_id: owner.id,
        name: spec.name,
        path: spec.path,
        visibility: spec.visibility,
        description: spec.description ?? template.description,
        default_branch: spec.default_branch ?? template.default_branch,
        disk_path: diskPath,
        initialized: false,
      }),
    )
    const newPath = this.storage.diskPathFor(project.id)
    this.db.transaction(() => {
      this.db.run('UPDATE projects SET disk_path = ?, initialized = 1 WHERE id = ?', newPath, project.id)
      const topics = this.s.topics.listForProject(template.id)
      if (topics.length > 0) this.s.topics.setForProject(project.id, topics.slice(0, this.cfg.maxTopicsPerProject))
      if (spec.topics?.length) this.s.topics.setForProject(project.id, spec.topics)
    })

    // Copy tip-of-default-branch files into an initial commit.
    try {
      const files = this.storage.readBranchFiles(template.disk_path, template.default_branch)
      this.storage.initializeWithFiles(
        newPath,
        spec.default_branch ?? template.default_branch,
        [...files.entries()].map(([path, content]) => ({ path, content })),
        {
          name: owner.name ?? owner.username,
          email: `${owner.username}@users.lsgit.local`,
        },
        spec.description?.trim() ? spec.description : `Copy of ${template.name}`,
      )
    } catch (err) {
      this.db.transaction(() => {
        this.s.redirects.deleteForProject(project.id)
        this.db.run('DELETE FROM projects WHERE id = ?', project.id)
        this.s.topics.pruneOrphans()
      })
      if (err instanceof AppError) throw err
      throw new AppError(500, `Failed to copy template repository contents: ${(err as Error).message}`)
    }
    return this.requireProject(project.id)
  }

  // -- rename & transfer ---------------------------------------------------------

  rename(actor: Actor | null, projectId: number, newPathRaw: string): { project: ProjectRow; redirectCreated: boolean } {
    const project = this.requireProject(projectId)
    this.authorize(actor, 'project:update', project)

    const owner = this.ownerUsernameOf(project)
    const newPath = String(newPathRaw ?? '').trim().toLowerCase()

    if (newPath === project.path) return { project, redirectCreated: false }
    if (this.s.projects.byOwnerPath(owner, newPath)) {
      throw new AppError(409, 'Path has already been taken', 'path_taken')
    }

    const oldPath = project.path
    this.db.transaction(() => {
      this.s.projects.update(project.id, { path: newPath })
      // Keep old URLs working (GitLab ProjectRedirect parity).
      this.s.redirects.create(owner, oldPath, project.id)
      this.s.redirects.pruneSuperseded()
    })
    // Hashed storage ⇒ no disk move. History/clone URLs by hash are unaffected.
    return { project: this.requireProject(project.id), redirectCreated: true }
  }

  transfer(actor: Actor | null, projectId: number, newOwnerUsername: string): ProjectRow {
    const project = this.requireProject(projectId)
    this.authorize(actor, 'project:transfer', project)

    const target = this.s.users.byUsername(String(newOwnerUsername ?? '').trim())
    if (!target) throw new AppError(404, 'New owner not found')
    if (target.id === project.owner_id) {
      throw new AppError(409, 'Project is already owned by that user')
    }
    if (target.state !== 'active') throw new AppError(422, 'New owner account is not active')

    const oldOwner = this.ownerUsernameOf(project)
    if (this.s.projects.byOwnerPath(target.username, project.path)) {
      throw new AppError(409, 'New owner already has a project with the same path')
    }

    this.db.transaction(() => {
      this.s.projects.update(project.id, { owner_id: target.id })
      this.s.redirects.create(oldOwner, project.path, project.id)
      this.s.redirects.pruneSuperseded()
    })
    this.touchActivity(project.id)
    return this.requireProject(project.id)
  }

  // -- deletion ---------------------------------------------------------------------

  delete(actor: Actor | null, projectId: number, confirmPath: string): void {
    const project = this.requireProject(projectId)
    this.authorize(actor, 'project:delete', project)

    const expected = this.fullPath(project).toLowerCase()
    if (String(confirmPath ?? '').trim().toLowerCase() !== expected) {
      throw new AppError(400, `Confirmation failed. Type "${expected}" to confirm deletion.`)
    }

    this.db.transaction(() => {
      this.s.redirects.deleteForProject(project.id)
      this.db.run('DELETE FROM project_topic_links WHERE project_id = ?', project.id)
      this.db.run('DELETE FROM projects WHERE id = ?', project.id)
      this.s.topics.pruneOrphans()
    })
    // Storage removal after metadata purge (trash-step inside abstraction).
    this.storage.deleteRepository(project.disk_path)
  }

  // -- misc ------------------------------------------------------------------------------

  touchActivity(projectId: number): void {
    this.s.projects.update(projectId, { last_activity_at: new Date().toISOString() })
  }

  private requireUser(id: number) {
    const u = this.s.users.byId(id)
    if (!u) throw new AppError(404, 'User not found')
    return u
  }

  private get db() {
    return this.s.db
  }
}
