/**
 * LSGit central authorization service.
 *
 * EVERY permission decision in the application routes through `can()`.
 * Authentication code must never embed authorization rules — it only produces
 * an Actor. This mirrors the boundary described in PERMISSIONS.md §9 and keeps
 * future role/membership logic (group/project levels) inside this service.
 */

export interface Actor {
  userId: number
  username: string
  admin: boolean
  state: 'active' | 'blocked' | 'deactivated'
  /** How the actor authenticated; scopes apply to token-based actors. */
  via: { kind: 'session' } | { kind: 'personal_access_token'; scopes: string[] }
}

export type Permission =
  | 'profile:read_self'
  | 'profile:update_self'
  | 'account:manage_credentials' // ssh keys, PATs, sessions, password change
  | 'audit:read_own'
  | 'admin:access'
  | 'project:create'
  | 'project:read'
  | 'project:update'      // metadata: name/desc/website/topics/default-branch/visibility
  | 'project:push_code'   // commit/upload to repository refs (developer-write equivalent)
  | 'project:archive'
  | 'project:delete'
  | 'project:transfer'
  | 'project:template'
  // Issue domain (PERMISSIONS.md §6). Until membership tables land, Reporter+
  // capabilities map to project owner/admin; Guest capabilities (create issues,
  // comment) extend to any authenticated user who can read the project.
  | 'issue:create'        // guest(10)+: any authenticated reader of the project
  | 'issue:comment'       // guest(10)+
  | 'issue:update'        // author OR reporter+(owner/admin today): title/desc/assign/label/milestone
  | 'issue:set_metadata'  // assignees, labels, milestone, due date — reporter+ only
  | 'issue:close'         // author OR owner/admin
  | 'issue:reopen'        // closer OR author OR owner/admin
  | 'issue:delete'        // owner/admin only
  | 'labels:maintain'     // label CRUD — reporter+ (owner/admin today)
  | 'milestones:maintain' // milestone CRUD — reporter+ (owner/admin today)
  | 'issue_forms:maintain' // issue form template CRUD — maintainer-equivalent (owner/admin today)
  // Pull request domain (developer workflow). Until membership tables land:
  // push-code capabilities map to owner/admin; participation (comment/
  // approve) extends to any authenticated reader of the project.
  | 'pr:create'           // developer+ — needs branch-push rights to be meaningful
  | 'pr:update'           // author OR maintainer+
  | 'pr:comment'          // guest(10)+ — any authenticated reader
  | 'pr:approve'          // authenticated reader EXCEPT the PR author
  | 'pr:merge'            // maintainer+ AND the target branch's protection rule
  // Community discussions (repository / future organization-community policy).
  // Participation is guest-level on readable projects; moderation (pin, lock,
  // delete others, edit others) requires maintainer-equivalent rights.
  | 'discussion:create'   // guest(10)+ — any authenticated reader
  | 'discussion:comment'  // guest(10)+
  | 'discussion:maintain' // pin/lock/moderate — maintainer-equivalent (owner/admin today)
  // Project management (GitHub Projects inspiration). Structured data writes
  // require member-level rights (developer-equivalent); read is viewer-level;
  // field/workflow/view management requires maintainer-equivalent rights.
  | 'pm:read'      // viewer+ — read boards, items, insights
  | 'pm:write'     // member+ — link/unlink items, set field values, save views
  | 'pm:maintain'  // maintainer+ — manage fields, workflows, delete board
  // Releases (GitLab parity): publishing/uploading/deleting releases requires
  // maintainer-equivalent rights; read follows project visibility.
  | 'release:maintain' // create/publish/delete releases and assets — owner/admin today

/** Capabilities any authenticated READER of a project keeps (guest parity). */
const ISSUE_GUEST_PERMISSIONS = new Set<Permission>(['issue:create', 'issue:comment'])

export interface AuthzContext {
  /** For *_self permissions: the resource owner being accessed. */
  resourceUserId?: number
  /** Project-scoped checks. */
  resourceProject?: {
    ownerId: number
    visibility: 'private' | 'internal' | 'public'
    archived?: boolean
    /** Who closed the issue — used by the reopen check. */
    closerId?: number
  }
}

function canReadProject(
  actor: Actor,
  project: NonNullable<AuthzContext['resourceProject']>,
): boolean {
  return (
    project.visibility !== 'private' || actor.userId === project.ownerId || actor.admin
  )
}

/** Reporter-role equivalent until membership tables land: owner or admin. */
function canReporterPlus(
  actor: Actor,
  project: NonNullable<AuthzContext['resourceProject']>,
): boolean {
  return actor.admin || actor.userId === project.ownerId
}

function canOwnerPlus(
  actor: Actor,
  project: NonNullable<AuthzContext['resourceProject']>,
): boolean {
  return actor.admin || actor.userId === project.ownerId
}

/** Developer-role equivalent (branch push rights) until memberships land. */
function canPushCode(
  actor: Actor,
  project: NonNullable<AuthzContext['resourceProject']>,
): boolean {
  return canReporterPlus(actor, project)
}

export function can(actor: Actor | null, permission: Permission, ctx: AuthzContext = {}): boolean {
  // Anonymous actors may ONLY read public projects (existence not leaked for others).
  if (!actor) {
    return permission === 'project:read' && ctx.resourceProject?.visibility === 'public'
  }
  if (actor.state !== 'active') return false

  const project = ctx.resourceProject

  switch (permission) {
    case 'profile:update_self':
    case 'account:manage_credentials':
      return (
        actor.admin ||
        ctx.resourceUserId === undefined ||
        ctx.resourceUserId === actor.userId
      )
    case 'profile:read_self':
      return true
    case 'audit:read_own':
      return actor.admin || ctx.resourceUserId === undefined || ctx.resourceUserId === actor.userId
    case 'admin:access':
      return actor.admin
    case 'project:create':
      return true // any active user may create projects (rate-limited elsewhere)
    case 'project:read': {
      if (!project) return false
      if (project.visibility === 'public') return true
      if (project.visibility === 'internal') return true // any authenticated user
      return actor.userId === project.ownerId || actor.admin
    }
    case 'project:update':
      if (!project) return false
      return actor.admin || actor.userId === project.ownerId
    case 'project:push_code':
      // GitLab Developer-role equivalent; membership tables arrive with the
      // collaboration phase, so until then: owner or instance admin.
      if (!project) return false
      return actor.admin || actor.userId === project.ownerId
    case 'project:archive':
      if (!project) return false
      return actor.admin || actor.userId === project.ownerId
    case 'project:template':
      if (!project) return false
      return actor.admin || actor.userId === project.ownerId
    case 'project:transfer':
      // GitLab parity: instance admins and the project Owner.
      if (!project) return false
      return actor.admin || actor.userId === project.ownerId
    case 'project:delete':
      // GitLab parity: Owner role or admin only (Maintainers cannot delete).
      if (!project) return false
      return actor.admin || actor.userId === project.ownerId
    case 'issue:create':
    case 'issue:comment': {
      // Guests may create/comment on issues in any project they can read.
      if (ISSUE_GUEST_PERMISSIONS.has(permission) && project && canReadProject(actor, project)) {
        return true
      }
      return false
    }
    case 'issue:update': {
      if (!project) return false
      if (canReporterPlus(actor, project)) return true
      return ctx.resourceUserId === actor.userId // the author's own issue
    }
    case 'issue:set_metadata':
    case 'labels:maintain':
    case 'milestones:maintain':
    case 'issue_forms:maintain':
      if (!project) return false
      return canReporterPlus(actor, project)
    case 'pr:create':
      // Developer-role equivalent: same gate as pushing branches.
      if (!project) return false
      return canPushCode(actor, project)
    case 'pr:update': {
      if (!project) return false
      if (canReporterPlus(actor, project)) return true
      return ctx.resourceUserId === actor.userId
    }
    case 'pr:comment': {
      if (project && canReadProject(actor, project)) return true
      return false
    }
    case 'pr:approve': {
      if (!project) return false
      if (!canReadProject(actor, project)) return false
      return ctx.resourceUserId !== undefined ? ctx.resourceUserId !== actor.userId : true
    }
    case 'pr:merge':
      // Maintainer-equivalent; the protected-branch rule is evaluated in the
      // service where the target branch context exists.
      if (!project) return false
      return canPushCode(actor, project)
    case 'discussion:create':
    case 'discussion:comment': {
      if (project && canReadProject(actor, project)) return true
      return false
    }
    case 'discussion:maintain':
      if (!project) return false
      return canReporterPlus(actor, project)
    case 'pm:read': {
      if (!project) return false
      return canReadProject(actor, project)
    }
    case 'pm:write':
      // Member-equivalent: structured-data writes need developer-level rights.
      if (!project) return false
      return canPushCode(actor, project)
    case 'pm:maintain':
      if (!project) return false
      return canReporterPlus(actor, project)
    case 'release:maintain':
      if (!project) return false
      return canReporterPlus(actor, project)
    case 'issue:close': {
      if (!project) return false
      if (canReporterPlus(actor, project)) return true
      return ctx.resourceUserId === actor.userId
    }
    case 'issue:reopen': {
      if (!project) return false
      if (canReporterPlus(actor, project)) return true
      // Author or the closing user may reopen their own thread.
      return (
        ctx.resourceUserId === actor.userId ||
        (ctx.resourceProject?.closerId !== undefined && ctx.resourceProject.closerId === actor.userId)
      )
    }
    case 'issue:delete':
      // Deleting issues is an owner/admin action (GitLab restricts to Owner+).
      if (!project) return false
      return canOwnerPlus(actor, project)
    default: {
      const exhaustive: never = permission
      void exhaustive
      return false
    }
  }
}

/** Token scope gate — orthogonal to role checks; PATs must carry a sufficient scope. */
export function scopeAllows(
  via: Actor['via'],
  needed: 'read_api' | 'write_api' | 'read_user',
): boolean {
  if (via.kind === 'session') return true
  const scopes = via.scopes
  switch (needed) {
    // GitLab parity: read_user grants /user-profile reads; read_api implies it.
    case 'read_user':
      return (
        scopes.includes('api') || scopes.includes('read_api') || scopes.includes('read_user')
      )
    case 'read_api':
      return scopes.includes('api') || scopes.includes('read_api')
    // write_api requires full api scope (GitLab parity: read_* cannot write)
    case 'write_api':
      return scopes.includes('api') || scopes.includes('write_api')
  }
}
