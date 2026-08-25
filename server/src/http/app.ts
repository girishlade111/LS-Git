import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { randomBytes } from 'node:crypto'
import { Database } from '../db/database.js'
import { makeServices, IdentityService, AppError } from '../services/identity.js'
import { CredentialsService } from '../services/credentials.js'
import type { Actor } from '../authz.js'
import { can, scopeAllows } from '../authz.js'
import { RateLimiter } from '../lib/rateLimiter.js'
import { parsePersonalAccessToken, tokenDigest } from '../lib/crypto.js'
import type { AppConfig } from '../config.js'
import { ProjectsService } from '../services/projects.js'
import { RepositoriesService } from '../services/repositories.js'
import { ForksService } from '../services/forks.js'
import { UploadService } from '../services/uploads.js'
import { ResumableUploadService } from '../services/resumable.js'
import { IssuesService } from '../services/issues.js'
import { IssueFormsService } from '../services/issueForms.js'
import { PullRequestsService } from '../services/pullRequests.js'

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null
    sessionId: number | null
    rawSessionToken: string | null
  }
  interface FastifyInstance {
    cfg: AppConfig
    identity: IdentityService
    credentials: CredentialsService
    projects: ProjectsService
    repositories: RepositoriesService
    forks: ForksService
    uploads: UploadService
    uploadSessions: ResumableUploadService
    issues: IssuesService
    issueForms: IssueFormsService
    pullRequests: PullRequestsService
    authRateLimiter: RateLimiter
    store: ReturnType<typeof makeServices>
    requireAuth: (needed?: 'read_api' | 'write_api' | 'read_user') => PreHandlerFn
    requirePermission: (
      permission: Parameters<typeof can>[1],
      ctx?: Parameters<typeof can>[2],
    ) => PreHandlerFn
  }
}

type PreHandlerFn = (req: FastifyRequest, reply: FastifyReply, done: () => void) => void

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
/** Endpoints that establish the very first credential are CSRF-exempt (no ambient session yet). */
const CSRF_EXEMPT = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/request-password-reset',
])

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; httpOnly?: boolean; secure?: boolean; path?: string; expires?: Date } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`]
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`)
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`)
  if (opts.httpOnly) parts.push('HttpOnly')
  if (opts.secure) parts.push('Secure')
  parts.push('SameSite=Lax')
  return parts.join('; ')
}

export function buildApp(cfg: AppConfig, dbFile?: string): FastifyInstance {
  const db = new Database(dbFile ?? cfg.databaseFile)
  const services = makeServices(db)

  const app = Fastify({ logger: false, bodyLimit: 1_500_000 })
  app.cfg = cfg

  // Raw binary bodies for upload transfer (route-level cap enforced too).
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: cfg.maxUploadBytes },
    (_req, body, done) => done(null, body as Buffer),
  )
  app.store = services

  // Outbox-backed mail transport; a real SMTP adapter plugs in at deploy time.
  app.identity = new IdentityService(services, cfg, services.outbox)
  app.credentials = new CredentialsService(services, cfg.patMaxTtlDays, cfg.patDefaultTtlDays)
  app.projects = new ProjectsService(services, cfg)
  app.repositories = new RepositoriesService(services, cfg, app.projects.storage)
  app.forks = new ForksService(services, cfg, app.projects.storage)
  app.uploads = new UploadService(services, cfg, app.projects.storage)
  app.uploadSessions = new ResumableUploadService(
    services,
    cfg,
    app.projects.storage,
  )
  app.issues = new IssuesService(services, cfg)
  app.pullRequests = new PullRequestsService(services, cfg, app.repositories, app.issues, app.projects.storage)
  app.issueForms = new IssueFormsService(
    services,
    cfg,
    app.projects.storage,
    app.repositories,
    app.issues,
  )
  app.authRateLimiter = new RateLimiter(cfg.authRateLimit.max, cfg.authRateLimit.windowSeconds * 1000)

  // ---- authentication resolution ------------------------------------------
  app.addHook('onRequest', async (req) => {
    req.actor = null
    req.sessionId = null
    req.rawSessionToken = null

    // 1) Personal access token (Authorization: Bearer lspat_x / PRIVATE-TOKEN)
    const authHeader = req.headers.authorization
    const privateToken = req.headers['private-token']
    const presented =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : typeof privateToken === 'string'
          ? privateToken.trim()
          : null
    if (presented) {
      const raw = parsePersonalAccessToken(presented)
      if (!raw) return // invalid format → anonymous; protected routes will 401
      const resolved = app.credentials.resolvePat(raw)
      if (!resolved) return // revoked/expired/unknown → anonymous
      const user = services.users.byId(resolved.userId)
      if (!user || user.state !== 'active') return
      req.actor = {
        userId: user.id,
        username: user.username,
        admin: !!user.admin,
        state: user.state,
        via: { kind: 'personal_access_token', scopes: resolved.scopes },
      }
      return
    }

    // 2) Cookie session (opaque id; only its SHA-256 digest is stored)
    const rawSession = parseCookies(req.headers.cookie)[cfg.cookieName]
    if (!rawSession) return
    const session = services.sessions.byDigest(tokenDigest(rawSession))
    if (!session) return
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      services.sessions.delete(session.id) // lazy expiration sweep
      return
    }
    const user = services.users.byId(session.user_id)
    if (!user || user.state !== 'active') return // blocked users lose all sessions
    // Sliding expiration (GitLab session_expire_delay parity).
    services.sessions.touch(session.id, isoPlusLocal(cfg.sessionTtlMinutes * 60_000))
    req.actor = {
      userId: user.id,
      username: user.username,
      admin: !!user.admin,
      state: user.state,
      via: { kind: 'session' },
    }
    req.sessionId = session.id
    req.rawSessionToken = rawSession
  })

  // ---- CSRF protection (double-submit cookie for cookie-authenticated mutations)
  app.addHook('onRequest', async (req, reply) => {
    if (SAFE_METHODS.has(req.method)) return
    if (!req.url.startsWith('/api/')) return
    if (CSRF_EXEMPT.has(stripQuery(req.url))) return
    // Token-authenticated requests carry no ambient credential → no CSRF surface.
    if (req.headers.authorization || req.headers['private-token']) return
    const cookies = parseCookies(req.headers.cookie)
    if (!cookies[cfg.csrfCookieName]) return // no session context yet
    if (req.actor?.via.kind !== 'session') return
    const header = req.headers['x-csrf-token']
    if (typeof header !== 'string' || header !== cookies[cfg.csrfCookieName]) {
      // Returning the reply halts the request lifecycle (single-send contract).
      return reply.code(403).send({ message: 'CSRF verification failed' })
    }
  })

  // ---- brute-force rate limiting on sensitive auth endpoints ---------------
  const limitedPaths = new Set([
    '/api/v1/auth/login',
    '/api/v1/auth/register',
    '/api/v1/auth/request-password-reset',
  ])
  app.addHook('onRequest', async (req, reply) => {
    const path = stripQuery(req.url)
    if (req.method !== 'POST' || !limitedPaths.has(path)) return
    const ip = req.ip ?? 'unknown'
    const verdict = app.authRateLimiter.hit(`${path}:${ip}`)
    reply.header('x-ratelimit-limit', cfg.authRateLimit.max)
    reply.header('x-ratelimit-remaining', verdict.remaining)
    if (!verdict.allowed) {
      reply.header('retry-after', verdict.retryAfterSeconds)
      return reply.code(429).send({ message: 'Too many requests. Try again later.' })
    }
  })

  // ---- guards --------------------------------------------------------------
  app.requireAuth = (needed?: 'read_api' | 'write_api' | 'read_user') =>
    ((req, reply, done) => {
      if (!req.actor) {
        // Sync pre-handler: sending the reply (without done) halts the chain.
        void done
        return reply.code(401).send({ message: 'Authentication required' })
      }
      if (needed && !scopeAllows(req.actor.via, needed)) {
        return reply.code(403).send({ message: `Insufficient token scope for ${needed}` })
      }
      done()
    }) as PreHandlerFn

  app.requirePermission = (permission, ctx) =>
    ((req, reply, done) => {
      const ok = can(req.actor, permission, { resourceUserId: ctx?.resourceUserId })
      if (!ok) {
        void done
        return reply
          .code(req.actor ? 403 : 401)
          .send({
            message: req.actor ? 'You are not allowed to perform this action' : 'Authentication required',
          })
      }
      done()
    }) as PreHandlerFn

  // ---- error mapping -------------------------------------------------------
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      reply.code(err.status).send({
        message: err.message,
        ...(err.code ? { code: err.code } : {}),
        ...(err.extras ?? {}),
      })
      return
    }
    const status = (err as { statusCode?: number }).statusCode
    if (status === 400) {
      reply.code(400).send({ message: 'Malformed request body' })
      return
    }
    if (status === 413) {
      reply.code(413).send({ message: 'Payload exceeds the configured size limit' })
      return
    }
    if (status === 404 || status === 415) {
      reply.code(status).send({ message: 'Request could not be processed' })
      return
    }
    reply.code(500).send({ message: 'Internal server error' })
  })

  registerAuthRoutes(app)
  registerAccountRoutes(app)
  registerProjectRoutes(app)
  registerRepositoryRoutes(app)
  registerForkRoutes(app)
  registerSocialRoutes(app)
  registerUploadRoutes(app)
  registerUploadSessionRoutes(app)
  registerIssueRoutes(app)
  registerIssueFormRoutes(app)
  registerPullRequestRoutes(app)

  app.get('/', async () => ({
    name: 'LSGit API Server',
    status: 'running',
    version: 'v1',
    ui: cfg.origin,
    health: '/healthz',
  }))
  app.get('/healthz', async () => ({ status: 'ok' }))
  return app
}

// ---------------------------------------------------------------------------
// Shared cookie helpers (used by auth routes)
// ---------------------------------------------------------------------------

export function issueCookies(
  reply: FastifyReply,
  cfg: AppConfig,
  rawSessionToken: string,
): string /* csrf token */ {
  // CSRF token is rotated on every session establishment.
  const csrf = randomBytes(24).toString('base64url')
  const sessionCookie = serializeCookie(cfg.cookieName, rawSessionToken, {
    maxAge: cfg.sessionTtlMinutes * 60,
    httpOnly: true,
    secure: cfg.secureCookies,
  })
  const csrfCookie = serializeCookie(cfg.csrfCookieName, csrf, {
    maxAge: cfg.sessionTtlMinutes * 60,
    httpOnly: false, // readable by the SPA for double-submit
    secure: cfg.secureCookies,
  })
  reply.header('set-cookie', [sessionCookie, csrfCookie])
  return csrf
}

export function clearAuthCookies(reply: FastifyReply, cfg: AppConfig): void {
  const clear = (name: string) =>
    serializeCookie(name, '', { expires: new Date(0), httpOnly: name === cfg.cookieName, secure: cfg.secureCookies })
  reply.header('set-cookie', [clear(cfg.cookieName), clear(cfg.csrfCookieName)])
}

function isoPlusLocal(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}

function stripQuery(url: string): string {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

import { registerAuthRoutes } from './routes/auth.js'
import { registerAccountRoutes } from './routes/account.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerRepositoryRoutes } from './routes/repository.js'
import { registerForkRoutes } from './routes/forks.js'
import { registerSocialRoutes } from './routes/social.js'
import { registerUploadRoutes } from './routes/uploads.js'
import { registerUploadSessionRoutes } from './routes/uploadsessions.js'
import { registerIssueRoutes } from './routes/issues.js'
import { registerIssueFormRoutes } from './routes/issueForms.js'
import { registerPullRequestRoutes } from './routes/pullRequests.js'
