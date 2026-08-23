import type { FastifyInstance } from 'fastify'
import {
  selfUser,
  publicUser,
  sessionView,
  sshKeyView,
  patView,
} from '../serializers.js'

/**
 * Account routes. Authorization is delegated to the central service via
 * requirePermission / ownership checks against req.actor — no ad-hoc role logic.
 */

export function registerAccountRoutes(app: FastifyInstance): void {
  const auth = app.requireAuth()

  // -- current user -----------------------------------------------------------
  app.get('/api/v1/user', { preHandler: app.requireAuth('read_api') }, async (req) => {
    return selfUser(app.identity.requireUser(req.actor!.userId))
  })

  app.patch('/api/v1/user', { preHandler: [app.requireAuth('write_api'), app.requirePermission('profile:update_self', {})] }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const updated = app.identity.updateProfile(req.actor!.userId, body)
    return selfUser(updated)
  })

  app.put('/api/v1/user/password', { preHandler: [app.requireAuth('write_api'), app.requirePermission('account:manage_credentials', {})] }, async (req) => {
    const body = (req.body ?? {}) as { current_password?: unknown; new_password?: unknown }
    await app.identity.changePassword(
      req.actor!.userId,
      String(body.current_password ?? ''),
      String(body.new_password ?? ''),
      req.actor?.via.kind === 'session' ? req.sessionId : null,
    )
    return { ok: true }
  })

  app.put('/api/v1/user/avatar', { preHandler: auth }, async (req) => {
    const data = String((req.body as { data_base64?: unknown })?.data_base64 ?? '')
    const out = app.identity.setAvatar(req.actor!.userId, data)
    return out
  })

  app.delete('/api/v1/user/avatar', { preHandler: auth }, async (req) => {
    app.identity.removeAvatar(req.actor!.userId)
    return { ok: true }
  })

  // -- public profiles ----------------------------------------------------------
  app.get('/api/v1/users/:username', async (req, reply) => {
    const { username } = req.params as { username: string }
    const user = app.store.users.byUsername(username.toLowerCase())
    if (!user || user.state !== 'active') {
      reply.code(404).send({ message: 'User not found' })
      return
    }
    return publicUser(user)
  })

  app.get('/api/v1/users/:username/avatar', async (req, reply) => {
    const { username } = req.params as { username: string }
    const user = app.store.users.byUsername(username.toLowerCase())
    const avatar = user ? app.store.users.avatar(user.id) : undefined
    if (!avatar) {
      reply.code(404).send({ message: 'No avatar' })
      return
    }
    reply.header('content-type', avatar.content_type)
    reply.header('cache-control', 'private, max-age=60')
    return reply.send(avatar.bytes)
  })

  // -- sessions -----------------------------------------------------------------
  app.get('/api/v1/sessions', { preHandler: [app.requireAuth('write_api'), app.requirePermission('account:manage_credentials', {})] }, async (req) => {
    const rows = app.store.sessions.listForUser(req.actor!.userId)
    return rows.map((s) => sessionView(s, req.sessionId ?? undefined))
  })

  app.post('/api/v1/sessions/revoke-others', { preHandler: [app.requireAuth('write_api'), app.requirePermission('account:manage_credentials', {})] }, async (req) => {
    const n = app.identity.revokeOtherSessions(req.actor!.userId, req.sessionId)
    return { revoked: n }
  })

  app.delete('/api/v1/sessions/:id', { preHandler: [app.requireAuth('write_api'), app.requirePermission('account:manage_credentials', {})] }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const row = app.store.sessions.listForUser(req.actor!.userId).find((s) => s.id === id)
    if (!row) {
      reply.code(404).send({ message: 'Session not found' })
      return
    }
    app.store.sessions.delete(id)
    app.store.audit.record({
      userId: req.actor!.userId,
      name: 'session_revoked',
      detail: { scope: 'single', session_id: id },
    })
    return { ok: true }
  })

  // -- SSH keys ---------------------------------------------------------------
  app.get('/api/v1/user/keys', { preHandler: [app.requireAuth('write_api'), app.requirePermission('account:manage_credentials', {})] }, async (req) => {
    return app.credentials.listSshKeys(req.actor!.userId).map(sshKeyView)
  })

  app.post('/api/v1/user/keys', { preHandler: [app.requireAuth('write_api'), app.requirePermission('account:manage_credentials', {})] }, async (req, reply) => {
    const row = app.credentials.addSshKey(req.actor!.userId, (req.body ?? {}) as Record<string, unknown>)
    reply.code(201)
    return sshKeyView(row)
  })

  app.delete('/api/v1/user/keys/:id', { preHandler: [app.requireAuth('write_api'), app.requirePermission('account:manage_credentials', {})] }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id)) {
      reply.code(400).send({ message: 'Invalid key id' })
      return
    }
    // Ownership enforced inside the service via actor userId scoping.
    app.credentials.deleteSshKey(req.actor!.userId, id)
    return { ok: true }
  })

  // -- personal access tokens -----------------------------------------------------
  app.get('/api/v1/user/personal_access_tokens', { preHandler: [app.requireAuth('write_api'), app.requirePermission('account:manage_credentials', {})] }, async (req) => {
    return app.credentials.listPats(req.actor!.userId).map(patView)
  })

  app.post('/api/v1/user/personal_access_tokens', { preHandler: [app.requireAuth('write_api'), app.requirePermission('account:manage_credentials', {})] }, async (req, reply) => {
    const { record, plaintext } = app.credentials.createPat(
      req.actor!.userId,
      (req.body ?? {}) as Record<string, unknown>,
    )
    reply.code(201)
    // The plaintext token appears exactly once, in this creation response.
    return { ...patView(record), token: plaintext }
  })

  app.delete('/api/v1/user/personal_access_tokens/:id', { preHandler: [app.requireAuth('write_api'), app.requirePermission('account:manage_credentials', {})] }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id)) {
      reply.code(400).send({ message: 'Invalid token id' })
      return
    }
    app.credentials.revokePat(req.actor!.userId, id)
    return { ok: true }
  })

  // -- audit trail (own events only; admin scoping comes with the admin phase) ------
  app.get('/api/v1/user/audit_events', { preHandler: [auth, app.requirePermission('audit:read_own', {})] }, async (req) => {
    const limitRaw = Number((req.query as { limit?: string }).limit ?? '50')
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50
    return app.store.audit.listForUser(req.actor!.userId, limit).map((r) => ({
      event: r.event,
      ip: r.ip,
      created_at: r.created_at,
    }))
  })
}
