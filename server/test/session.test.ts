import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginUser, loginRaw, authed, extractSession, PASSWORD, type Session } from './helpers.js'

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

  it('expires sessions after the inactivity window and sweeps the row', async () => {
    const app = makeApp({ sessionTtlMinutes: 60 })
    const { session } = await registerUser(app)

    // Simulate the passage of time past the TTL.
    const past = new Date(Date.now() - 61 * 60_000).toISOString()
    app.store.db.run('UPDATE sessions SET expires_at = ?', past)

    const res = await authed(app, 'GET', '/api/v1/user', { session })
    expect(res.statusCode).toBe(401)
    expect(
      app.store.sessions.listForUser(app.store.users.byUsername('alice')!.id),
    ).toHaveLength(0)
  })

  it('slides expiry forward on use', async () => {
    const app = makeApp()
    const { session } = await registerUser(app)
    const before = app.store.sessions.listForUser(1)[0]!
    await authed(app, 'GET', '/api/v1/user', { session })
    const after = app.store.sessions.listForUser(1)[0]!
    expect(new Date(after.expires_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before.expires_at).getTime(),
    )
  })

  it('enforces CSRF (double-submit) on cookie-authenticated mutations', async () => {
    const app = makeApp()
    const { session } = await registerUser(app)

    const noHeader = await app.inject({
      method: 'POST', url: '/api/v1/sessions/revoke-others',
      headers: { cookie: session.cookie },
    })
    expect(noHeader.statusCode).toBe(403)

    const badHeader = await app.inject({
      method: 'POST', url: '/api/v1/sessions/revoke-others',
      headers: { cookie: session.cookie, 'x-csrf-token': 'wrong-value' },
    })
    expect(badHeader.statusCode).toBe(403)

    const good = await app.inject({
      method: 'POST', url: '/api/v1/sessions/revoke-others',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    })
    expect(good.statusCode).toBe(200)
  })

  it('lists sessions with a current flag and revokes individually', async () => {
    const app = makeApp()
    await registerUser(app, { username: 'dana', email: 'dana@example.com' })
    const s1 = extractSession((await loginRaw(app, 'dana')).cookies)
    const s2 = extractSession((await loginRaw(app, 'dana')).cookies)

    const list = (await authed(app, 'GET', '/api/v1/sessions', { session: s2 })).json() as unknown as Array<{ id: number; current: boolean }>
    expect(list).toHaveLength(2)
    expect(list.filter((r) => r.current)).toHaveLength(1)

    const other = list.find((r) => !r.current)!
    const del = await authed(app, 'DELETE', `/api/v1/sessions/${other.id}`, { session: s2 })
    expect(del.statusCode).toBe(200)

    const stale = await authed(app, 'GET', '/api/v1/user', { session: s1 })
    expect(stale.statusCode).toBe(401)
  })

  it('revoke-others keeps only the current session; password change does the same', async () => {
    const app = makeApp()
    await registerUser(app, { username: 'erin', email: 'erin@example.com' })
    const keep = extractSession((await loginRaw(app, 'erin')).cookies)
    const drop = extractSession((await loginRaw(app, 'erin')).cookies)

    const res = await authed(app, 'POST', '/api/v1/sessions/revoke-others', { session: keep })
    expect(res.json()).toEqual({ revoked: 1 })

    expect((await authed(app, 'GET', '/api/v1/user', { session: keep })).statusCode).toBe(200)
    expect((await authed(app, 'GET', '/api/v1/user', { session: drop })).statusCode).toBe(401)

    // Password change revokes everything except the initiating session.
    const extra = extractSession((await loginRaw(app, 'erin')).cookies)
    const pw = await authed(app, 'PUT', '/api/v1/user/password', {
      session: keep,
      payload: { current_password: PASSWORD, new_password: 'rotated-passphrase-11' },
    })
    expect(pw.statusCode).toBe(200)
    expect((await authed(app, 'GET', '/api/v1/user', { session: extra })).statusCode).toBe(401)
    expect((await loginUser(app, 'erin', 'rotated-passphrase-11')).status).toBe(200)
    // Old password no longer works.
    expect((await loginUser(app, 'erin', PASSWORD)).status).toBe(400)
  })

  it('blocks blocked users from authenticating even with a valid session cookie', async () => {
    const { app, alice } = await setup()
    const user = app.store.users.byUsername('alice')!
    app.store.users.updateProfile(user.id, { state: 'blocked' })

    const res = await authed(app, 'GET', '/api/v1/user', { session: alice })
    expect(res.statusCode).toBe(401)
  })

  it('admin gate routes through the central authorization service', async () => {
    const app = makeApp()
    const admin = extractSession((await loginRaw(app, 'alice')).cookies) // first user = admin
    const nonAdminRes = await registerUser(app, { username: 'bob', email: 'bob@example.com' })
    void nonAdminRes
    const bob = extractSession((await loginRaw(app, 'bob')).cookies)

    expect((await authed(app, 'GET', '/api/v1/admin/ping', { session: admin })).statusCode).toBe(200)
    expect((await authed(app, 'GET', '/api/v1/admin/ping', { session: bob })).statusCode).toBe(403)
    expect((await authed(app, 'GET', '/api/v1/admin/ping')).statusCode).toBe(401)
  })
})
