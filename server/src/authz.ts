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
  | 'project:archive'
  | 'project:delete'
  | 'project:transfer'
  | 'project:template'

export interface AuthzContext {
  /** For *_self permissions: the resource owner being accessed. */
  resourceUserId?: number
  /** Project-scoped checks. */
  resourceProject?: {
    ownerId: number
    visibility: 'private' | 'internal' | 'public'
    archived?: boolean
  }
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
      return ctx.resourceUserId === undefined || ctx.resourceUserId === actor.userId
    case 'profile:read_self':
      return true
    case 'audit:read_own':
      return ctx.resourceUserId === undefined || ctx.resourceUserId === actor.userId
    case 'admin:access':
      return false // non-admins never get admin access
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
