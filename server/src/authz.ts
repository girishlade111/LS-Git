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

export interface AuthzContext {
  /** For *_self permissions: the resource owner being accessed. */
  resourceUserId?: number
}

export function can(actor: Actor | null, permission: Permission, ctx: AuthzContext = {}): boolean {
  if (!actor) return false
  if (actor.state !== 'active') return false

  // Admins may act on any account (audited at the call site).
  if (actor.admin) return true

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
  needed: 'read_api' | 'write_api',
): boolean {
  if (via.kind === 'session') return true
  const scopes = via.scopes
  if (needed === 'read_api') {
    return scopes.includes('api') || scopes.includes('read_api')
  }
  // write_api requires full api scope (GitLab parity: read_* cannot write)
  return scopes.includes('api') || scopes.includes('write_api')
}
