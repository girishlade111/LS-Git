import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginUser, authed, extractSession, PASSWORD } from './helpers.js'

describe('registration', () => {
  it('registers the first user as admin (GitLab parity) and starts a session', async () => {
    const app = makeApp()
    const { status } = await registerUser(app)
    expect(status).toBe(201)

    const me = await authed(app, 'GET', '/api/v1/user', { session: (await registerUser(app, { username: 'x1', email: 'x1@e.com' }), null) })
    void me

    const root = app.store.users.byUsername('alice')!
    expect(root.admin).toBe(1)

    // Second user is not admin.
    const r2 = await registerUser(app, { username: 'bob', email: 'bob@example.com' })
    expect(r2.status).toBe(201)
    expect(app.store.users.byUsername('bob')!.admin).toBe(0)
  })

  it('rejects duplicate usernames case-insensitively', async () => {
    const app = makeApp()
    await registerUser(app, { username: 'alice' })
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: { username: 'ALICE', email: 'other@example.com', password: PASSWORD },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ message: 'Username has already been taken' })
  })

  it('rejects duplicate emails case-insensitively', async () => {
    const app = makeApp()
    await registerUser(app, { username: 'alice', email: 'alice@example.com' })
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: { username: 'someoneelse', email: '  Alice@Example.COM ', password: PASSWORD },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toBe('Email has already been taken')
  })

  it('enforces password policy and reserved usernames', async () => {
    const app = makeApp()
    const weak = await registerUser(app, { username: 'u1', password: 'short' })
    expect(weak.status).toBe(400)

    const reserved = await registerUser(app, { username: 'root' })
    expect(reserved.status).toBe(400)
  })

  it('queues a verification email in the outbox', async () => {
    const app = makeApp()
    await registerUser(app)
    const mail = app.store.outbox.drain().find((m) => m.subject === 'Verify your LSGit email address')
    expect(mail).toBeTruthy()
    expect(String(mail!.to_email)).toBe('alice@example.com')
  })
})

describe('login / logout', () => {
  it('logs in by username or email and issues fresh session cookies', async () => {
    const app = makeApp()
    await registerUser(app)
    const byName = await loginUser(app, 'alice')
    expect(byName.status).toBe(200)
    // alice was the FIRST user → instance admin (GitLab parity).
    expect(byName.body.user).toMatchObject({ username: 'alice', admin: true })

    const byEmail = await loginUser(app, 'ALICE@example.com')
    expect(byEmail.status).toBe(200)
  })

  it('returns a generic failure for wrong passwords AND unknown users', async () => {
    const app = makeApp()
    await registerUser(app)
    for (const login of ['alice', 'ghost']) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login, password: 'nope-not-it-1234' } })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ message: 'Invalid login or password' })
    }
  })

  it('locks the account after repeated failures and rejects correct passwords while locked', async () => {
    const app = makeApp({ maxFailedLogins: 3, lockoutMinutes: 60 })
    await registerUser(app, { username: 'carol', email: 'carol@example.com' })

    for (let i = 0; i < 3; i++) {
      const res = await loginUser(app, 'carol', 'bad-password-xyz')
      expect(res.status).toBe(400)
    }
    // Correct password now rejected because the account is locked.
    const locked = await loginUser(app, 'carol')
    expect(locked.status).toBe(423)
    expect(locked.body.message).toMatch(/locked/i)
    expect((locked.body as { retry_after_seconds?: number }).retry_after_seconds).toBeGreaterThan(0)

    const events = app.store.audit.listForUser(app.store.users.byUsername('carol')!.id, 100)
      .map((e) => e.event)
    expect(events).toContain('account_locked')
  })

  it('logs out: clears cookies and invalidates the session server-side', async () => {
    const app = makeApp()
    const { session } = await registerUser(app)
    const res = await authed(app, 'POST', '/api/v1/auth/logout', { session: session! })
    expect(res.statusCode).toBe(200)

    // Old cookie no longer authenticates.
    const after = await app.inject({
      method: 'GET', url: '/api/v1/user',
      headers: { cookie: `lsgit_session=${session!.cookie.split('=')[1]}` },
    })
    expect(after.statusCode).toBe(401)
  })
})

describe('password reset', () => {
  it('responds identically for known and unknown emails (anti-enumeration)', async () => {
    const app = makeApp()
    await registerUser(app)
    for (const email of ['alice@example.com', 'nobody@example.com']) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/request-password-reset', payload: { email } })
      expect(res.statusCode).toBe(202)
      expect(res.json().message).toContain('If that account exists')
    }
  })

  it('completes the full reset flow: token → new password → old sessions revoked', async () => {
    const app = makeApp()
    const { session: oldSession } = await registerUser(app)

    await app.inject({ method: 'POST', url: '/api/v1/auth/request-password-reset', payload: { email: 'alice@example.com' } })
    const mail = app.store.outbox.drain().find((m) => m.subject === 'LSGit password reset')!
    const token = String(mail.body).match(/token=([A-Za-z0-9_-]+)/)![1]

    const newPassword = 'brand-new-passphrase-77'
    const done = await app.inject({
      method: 'POST', url: '/api/v1/auth/reset-password',
      payload: { reset_token: token, password: newPassword },
    })
    expect(done.statusCode).toBe(200)

    // New password works; old one does not.
    expect((await loginUser(app, 'alice', newPassword)).status).toBe(200)
    expect((await loginUser(app, 'alice', PASSWORD)).status).toBe(400)

    // The pre-reset session was revoked.
    const stale = await authed(app, 'GET', '/api/v1/user', { session: oldSession! })
    expect(stale.statusCode).toBe(401)

    // Token is single-use.
    const reuse = await app.inject({
      method: 'POST', url: '/api/v1/auth/reset-password',
      payload: { reset_token: token, password: 'another-passphrase-99' },
    })
    expect(reuse.statusCode).toBe(400)
  })

  it('rejects expired reset tokens', async () => {
    const app = makeApp({ resetTokenTtlHours: -0.01 }) // already expired
    await registerUser(app)
    await app.inject({ method: 'POST', url: '/api/v1/auth/request-password-reset', payload: { email: 'alice@example.com' } })
    const mail = app.store.outbox.drain()[0]!
    const token = String(mail.body).match(/token=([A-Za-z0-9_-]+)/)![1]
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/reset-password',
      payload: { reset_token: token, password: 'some-new-password-1' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('email verification', () => {
  it('verifies via outboxed token and marks the account verified once', async () => {
    const app = makeApp()
    await registerUser(app)
    const mail = app.store.outbox.drain().find((m) => String(m.subject).includes('Verify'))!
    const token = String(mail.body).match(/token=([A-Za-z0-9_-]+)/)![1]

    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', payload: { verification_token: token } })
    expect(ok.statusCode).toBe(200)
    expect(app.store.users.byUsername('alice')!.email_verified).toBe(1)

    const reuse = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', payload: { verification_token: token } })
    expect(reuse.statusCode).toBe(400)
  })
})

describe('rate limiting on auth endpoints', () => {
  it('throttles excessive login attempts per IP', async () => {
    const app = makeApp({ authRateLimit: { max: 3, windowSeconds: 60 } })
    let lastStatus = 0
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'nobody', password: 'irrelevant-pw-1' } })
      lastStatus = res.statusCode
      if (res.statusCode === 429) break
    }
    expect(lastStatus).toBe(429)
    expect(lastStatus).toBeDefined()
  })
})
