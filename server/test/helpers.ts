import { loadConfig, type AppConfig } from '../src/config.js'
import { buildApp } from '../src/http/app.js'
import type { FastifyInstance } from 'fastify'

// Keep the test suite fast: reduced scrypt cost (hashes embed their params, so
// production data at full cost still verifies).
process.env.LSGIT_SCRYPT_N ??= '512'
process.env.LSGIT_SCRYPT_R ??= '8'
process.env.LSGIT_SCRYPT_P ??= '1'

export const PASSWORD = 'correct horse battery staple 42'

export function makeApp(overrides: Partial<AppConfig> = {}): FastifyInstance {
  const cfg = loadConfig({
    env: 'test',
    secret: 'test-secret-do-not-use-in-production-0123456789',
    databaseFile: ':memory:',
    origin: 'http://localhost:5173',
    secureCookies: false,
    sessionTtlMinutes: overrides.sessionTtlMinutes ?? 60 * 24 * 7,
    // Generous by default; the rate-limit tests override this.
    authRateLimit: overrides.authRateLimit ?? { max: 10_000, windowSeconds: 60 },
    ...overrides,
  })
  return buildApp(cfg, ':memory:')
}

export interface Session {
  cookie: string // full Cookie header value for subsequent requests
  csrf: string
}

export function sessionHeader(s: Session): string {
  return s.cookie
}

export function extractSession(injectResultCookies: Array<{ name: string; value: string }>): Session {
  const sess = injectResultCookies.find((c) => c.name === 'lsgit_session')!
  const csrf = injectResultCookies.find((c) => c.name === 'lsgit_csrf')!
  return { cookie: `lsgit_session=${sess.value}; lsgit_csrf=${csrf.value}`, csrf: csrf.value }
}

export async function registerUser(
  app: FastifyInstance,
  over: Partial<{ username: string; email: string; password: string; name: string }> = {},
): Promise<{ session: Session | null; status: number }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      username: over.username ?? 'alice',
      email: over.email ?? 'alice@example.com',
      password: over.password ?? PASSWORD,
      name: over.name ?? 'Alice Example',
    },
  })
  return {
    session: res.statusCode === 201 ? extractSession(res.cookies) : null,
    status: res.statusCode,
  }
}

export async function loginUser(
  app: FastifyInstance,
  login: string,
  password = PASSWORD,
): Promise<{ session: Session | null; status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login, password },
  })
  const body = res.json()
  return {
    session: res.statusCode === 200 ? extractSession(res.cookies) : null,
    status: res.statusCode,
    body,
  }
}

/** Login returning raw response (for cookie inspection in tests). */
export async function loginRaw(app: FastifyInstance, login: string, password = PASSWORD) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login, password } })
}

/** Authenticated request helper (session or token). */
export async function authed(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  opts: {
    session?: Session | null
    bearer?: string
    payload?: unknown
  } = {},
): Promise<{
  statusCode: number
  json(): Record<string, unknown>
  cookies: Array<{ name: string; value: string }>
}> {
  const headers: Record<string, string> = {}
  if (opts.bearer) {
    headers.authorization = `Bearer ${opts.bearer}`
  } else if (opts.session) {
    headers.cookie = opts.session.cookie
    if (!['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = opts.session.csrf
  }
  const options: {
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
    url: string
    headers: Record<string, string>
    payload?: unknown
  } = { method, url, headers }
  if (opts.payload !== undefined) options.payload = opts.payload
  const res = await app.inject(options)
  return {
    statusCode: res.statusCode,
    json: () => res.json() as Record<string, unknown>,
    cookies: res.cookies as Array<{ name: string; value: string }>,
  }
}
