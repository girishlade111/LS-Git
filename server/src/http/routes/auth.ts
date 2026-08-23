import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../services/identity.js'
import { clearAuthCookies, issueCookies } from '../app.js'
import { selfUser } from '../serializers.js'
import { tokenDigest } from '../../lib/crypto.js'

const loginSchema = z.object({
  login: z.string().min(1).max(255),
  password: z.string().min(1).max(128),
})

/** Pull one cookie value from the raw request header. */
export function parseRequestCookieValue(
  req: { headers: Record<string, unknown> },
  name: string,
): string | undefined {
  const header = req.headers.cookie
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

export function registerAuthRoutes(app: FastifyInstance): void {
  // -- registration ---------------------------------------------------------
  app.post('/api/v1/auth/register', async (req, reply) => {
    const user = app.identity.register(req.body)
    const rawSession = app.identity.createSession(user, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })
    const csrf = issueCookies(reply, app.cfg, rawSession)
    reply.code(201)
    return { user: selfUser(user), csrf_token: csrf }
  })

  // -- login ----------------------------------------------------------------
  app.post('/api/v1/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError(400, 'Invalid login or password', 'invalid_credentials')

    const user = app.identity.authenticate(parsed.data.login, parsed.data.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })
    const rawSession = app.identity.createSession(user, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })
    // Fresh session id on every login → session fixation is impossible.
    const csrf = issueCookies(reply, app.cfg, rawSession)
    return { user: selfUser(user), csrf_token: csrf }
  })

  // -- logout ---------------------------------------------------------------
  app.post('/api/v1/auth/logout', async (req, reply) => {
    if (req.rawSessionToken) {
      const session = app.store.sessions.byDigest(tokenDigest(req.rawSessionToken))
      if (session && req.actor?.via.kind === 'session' && session.user_id === req.actor.userId) {
        app.store.sessions.delete(session.id)
        app.store.audit.record({ userId: req.actor.userId, name: 'logout' })
      }
    }
    clearAuthCookies(reply, app.cfg)
    return { ok: true }
  })

  // -- SPA bootstrap ----------------------------------------------------------
  app.get('/api/v1/auth/status', async (req) => {
    if (!req.actor || req.actor.via.kind !== 'session') return { authenticated: false }
    const user = app.identity.requireUser(req.actor.userId)
    return {
      authenticated: true,
      user: selfUser(user),
      csrf_token: parseRequestCookieValue(req, app.cfg.csrfCookieName),
    }
  })

  // -- email verification -------------------------------------------------------
  app.post('/api/v1/auth/verify-email', async (req) => {
    const token = String((req.body as { verification_token?: unknown })?.verification_token ?? '')
    app.identity.verifyEmail(token)
    return { ok: true }
  })

  app.post('/api/v1/auth/resend-verification', {
    preHandler: app.requireAuth(),
    handler: async (req) => {
      await app.identity.resendVerification(req.actor!.userId)
      return { ok: true }
    },
  })

  // -- password recovery ----------------------------------------------------------
  app.post('/api/v1/auth/request-password-reset', async (req, reply) => {
    const email = String((req.body as { email?: unknown })?.email ?? '')
    app.identity.requestPasswordReset(email)
    // Anti-enumeration: identical response whether or not the account exists.
    reply.code(202)
    return { message: 'If that account exists, a reset link has been sent.' }
  })

  app.post('/api/v1/auth/reset-password', async (req) => {
    const body = (req.body ?? {}) as { reset_token?: unknown; password?: unknown }
    await app.identity.completePasswordReset(String(body.reset_token ?? ''), body)
    return { message: 'Password has been reset. Sign in with your new password.' }
  })

  // Central-authorization gate demonstration (admin area).
  app.get('/api/v1/admin/ping', {
    preHandler: app.requirePermission('admin:access'),
    handler: async () => ({ pong: true }),
  })
}
