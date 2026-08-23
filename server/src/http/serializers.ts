import type { UserRow, SshKeyRow, AccessTokenRow, SessionRow } from '../db/store.js'

/**
 * Output serializers. The rule: password hashes, token digests, raw cookies and
 * any credential material NEVER appear here. Grep-able by design.
 */

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    state: u.state,
    admin: !!u.admin,
    bio: u.bio,
    location: u.location,
    website_url: u.website_url,
    public_email: u.public_email,
    avatar_url: `/api/v1/users/${encodeURIComponent(u.username)}/avatar`,
    created_at: u.created_at,
  }
}

export function selfUser(u: UserRow) {
  // Self view may include the private email + verification status.
  return {
    ...publicUser(u),
    email: u.email,
    email_verified: !!u.email_verified,
  }
}

export function sshKeyView(k: SshKeyRow) {
  return {
    id: k.id,
    title: k.title,
    key_type: k.key_type,
    bits: k.bits,
    fingerprint: k.fingerprint,
    comment: k.comment,
    usage_mode: k.usage_mode,
    expires_at: k.expires_at,
    created_at: k.created_at,
  }
}

export function patView(t: AccessTokenRow) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    scopes: JSON.parse(t.scopes) as string[],
    expires_at: t.expires_at,
    revoked_at: t.revoked_at,
    last_used_at: t.last_used_at,
    created_at: t.created_at,
  }
}

export function sessionView(s: SessionRow, currentId?: number) {
  return {
    id: s.id,
    ip: s.ip,
    user_agent: s.user_agent,
    created_at: s.created_at,
    last_active_at: s.last_active_at,
    expires_at: s.expires_at,
    current: s.id === currentId,
  }
}
