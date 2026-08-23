import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, authed, extractSession, PASSWORD, type Session } from './helpers.js'

async function setup(overrides = {}): Promise<{ app: ReturnType<typeof makeApp>; alice: Session }> {
  const app = makeApp(overrides)
  const { session } = await registerUser(app)
  return { app, alice: session! }
}

describe('session management', () => {
  it('requires authentication for protected routes', async () => {
    const app = makeApp()
    const res = await authed(app, 'GET', '/api/v1/user')
    expect(res.statusCode).toBe(401)
  })

  it('expires sessions after the inactivity window (sliding TTL)', async () => {
    const app = makeApp({ sessionTtlMinutes: 60 })
    const { session } = await registerUser(app)

    // Simulate the passage of time past the TTL.
    const past = new Date(Date.now() - 61 * 60_000).toISOString()
    app.store.db.run('UPDATE sessions SET expires_at = ?', past)

    const res = await authed(app, 'GET', '/api/v1/user', { session })
    expect(res.statusCode).toBe(401)
    // Expired row was swept lazily.
    expect(app.store.sessions.listForUser(app.store.users.byUsername('alice')!.id)).toHaveLength(0)
  })

  it('touches last_active_at and extends expiry on use', async () => {
    const app = makeApp()
    const { session } = await registerUser(app)
    const before = app.store.sessions.listForUser(1)[0]!
    const res = await authed(app, 'GET', '/api/v1/user', { session })
    expect(res.statusCode).toBe(200)
    const after = app.store.sessions.listForUser(1)[0]!
    expect(new Date(after.last_active_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before.last_active_at).getTime(),
    )
    expect(new Date(after.expires_at).getTime()).toBeGreaterThan(
      new Date(before.expires_at).getTime(),
    )
  })

  it('enforces CSRF on cookie-authenticated mutations and exempts tokens', async () => {
    const app = makeApp()
    const { session } = await registerUser(app)

    // No CSRF header → rejected.
    const noHeader = await app.inject({
      method: 'POST', url: '/api/v1/sessions/revoke-others',
      headers: { cookie: session.cookie },
    })
    expect(noHeader.statusCode).toBe(403)

    // Wrong header value → rejected.
    const badHeader = await app.inject({
      method: 'POST', url: '/api/v1/sessions/revoke-others',
      headers: { cookie: session.cookie, 'x-csrf-token': 'wrong-value' },
    })
    expect(badHeader.statusCode).toBe(403)

    // Correct double-submit pair → allowed.
    const good = await app.inject({
      method: 'POST', url: '/api/v1/sessions/revoke-others',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    })
    expect(good.statusCode).toBe(200)
  })

  it('lists sessions with current flag; revokes one or all others', async () => {
    const app = makeApp()
    const first = await registerUser(app, { username: 'dana', email: 'dana@example.com' })
    const s1 = extractSession((await loginUserDirect(app, 'dana')).cookies)
    void first
    const s2 = extractSession((await loginUserDirect(app, 'dana')).cookies)

    const list = await authed(app, 'GET', '/api/v1/sessions', { session: s2 })
    const rows = list.json() as unknown as Array<{ id: number; current: boolean }>
    expect(rows).toHaveLength(2)

    // Revoke the OTHER session by id.
    const other = rows.find((r) => !r.current)!
    const del = await authed(app, 'DELETE', `/api/v1/sessions/${other.id}`, { session: s2 })
    expect(del.statusCode).toBe(200)

    // The revoked session can no longer authenticate.
    const stale = await authed(app, 'GET', '/api/v1/user', { session: s1 })
    expect(stale.statusCode).toBe(401)
  })

  it('invalidates every session when a blocked user attempts to authenticate', async () => {
    const { app, alice } = await setup()
    app.store.users.updateProfile(alice && 1, {}) as never
    void alice
    const user = app.store.users.byUsername('alice')!
    app.store.users.updateProfile(user.id, { state: 'blocked' })

    const res = await authed(app, 'GET', '/api/v1/user', { session: await currentSession(app) })
    expect(res.statusCode).toBe(401)
  })
})

// -- helpers local to this file -------------------------------------------------

function loginUserDirect(app: ReturnType<typeof makeApp>, login: string) {
  return import('./helpers.js').then((h) =>
    h.app2injectLogin(app, login, PASSWORD),
  )
}

async function currentSession(app: ReturnType<typeof makeApp>): Promise<Session> {
  const h = await import('./helpers.js')
  const r = await h.app2injectLogin(app, 'alice', PASSWORD)
  return extractSession(r.cookies)
}
