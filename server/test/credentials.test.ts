import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, authed, extractSession, loginRaw } from './helpers.js'

function ed25519Line(seed = 7): string {
  const typeStr = Buffer.from('ssh-ed25519')
  const keyBytes = Buffer.alloc(32)
  keyBytes.fill(seed) // deterministic per seed
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), typeStr, Buffer.from([0, 0, 0, 32]), keyBytes])
  return `ssh-ed25519 ${blob.toString('base64')} dev@machine`
}

async function setup() {
  const app = makeApp()
  const { session } = await registerUser(app)
  return { app, session: session! }
}

describe('SSH keys', () => {
  it('creates, lists, and deletes a key', async () => {
    const { app, session } = await setup()

    const created = await authed(app, 'POST', '/api/v1/user/keys', {
      session,
      payload: { title: 'work laptop', key: ed25519Line(1), usage_mode: 'auth' },
    })
    expect(created.statusCode).toBe(201)
    const key = created.json()
    expect(key).toMatchObject({ title: 'work laptop', key_type: 'ssh-ed25519', bits: 256 })
    expect(String(key.fingerprint)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)

    const list = (await authed(app, 'GET', '/api/v1/user/keys', { session })).json() as unknown[]
    expect(list).toHaveLength(1)

    const del = await authed(app, 'DELETE', `/api/v1/user/keys/${key.id}`, { session })
    expect(del.statusCode).toBe(200)
    expect(((await authed(app, 'GET', '/api/v1/user/keys', { session })).json()) as unknown[]).toHaveLength(0)

    // Deleting again → 404
    const gone = await authed(app, 'DELETE', `/api/v1/user/keys/${key.id}`, { session })
    expect(gone.statusCode).toBe(404)
  })

  it('rejects the same key twice across all users (unique fingerprint)', async () => {
    const app = makeApp()
    const { session } = await registerUser(app)
    await registerUser(app, { username: 'bob', email: 'bob@example.com' })
    const bob = extractSession((await loginRaw(app, 'bob')).cookies)

    const ok = await authed(app, 'POST', '/api/v1/user/keys', { session, payload: { title: 'a', key: ed25519Line(2) } })
    expect(ok.statusCode).toBe(201)

    const dup = await authed(app, 'POST', '/api/v1/user/keys', { session: bob, payload: { title: 'b', key: `${ed25519Line(2)} trailing-comment` } })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().message).toMatch(/Fingerprint has already been taken/)
  })

  it('rejects invalid public keys with actionable messages', async () => {
    const { app, session } = await setup()
    for (const [payload, match] of [
      [{ title: 'x', key: 'definitely not a key' }, /Invalid public key/],
      [{ title: 'x', key: '-----BEGIN OPENSSH PRIVATE KEY-----' }, /private/i],
      [{ title: 'x', key: 'ssh-dss AAAAB3NzaC1kc3MAAACB' }, /unsupported/],
      [{ title: '', key: ed25519Line(3) }, /title/i],
      [{ key: ed25519Line(4) }, /title/i],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      const res = await authed(app, 'POST', '/api/v1/user/keys', { session, payload })
      expect(res.statusCode).toBe(400)
      expect(String(res.json().message)).toMatch(match)
    }
  })
})

describe('personal access tokens', () => {
  it('creates with one-time plaintext, lists without secrets, and revokes', async () => {
    const { app, session } = await setup()

    const created = await authed(app, 'POST', '/api/v1/user/personal_access_tokens', {
      session,
      payload: { name: 'ci-token', scopes: ['read_api', 'read_repository'], expires_in_days: 30 },
    })
    expect(created.statusCode).toBe(201)
    const body = created.json()
    expect(String(body.token)).toMatch(/^lspat_[A-Za-z0-9_-]{40,64}$/)

    // The token authenticates immediately via Bearer or PRIVATE-TOKEN.
    const viaBearer = await authed(app, 'GET', '/api/v1/user', { bearer: String(body.token) })
    expect(viaBearer.statusCode).toBe(200)

    // List view never contains plaintext or digests.
    const listRaw = await authed(app, 'GET', '/api/v1/user/personal_access_tokens', { session })
    const listText = JSON.stringify(listRaw.json())
    expect(listText).not.toContain(String(body.token))
    expect(listText).not.toContain('token_digest')
    const listed = (listRaw.json() as unknown as Array<Record<string, unknown>>)[0]!
    expect(listed).toMatchObject({ id: body.id, revoked_at: null, scopes: ['read_api', 'read_repository'] })

    // Revoke → token stops working; double revoke fails cleanly.
    const revoke = await authed(app, 'DELETE', `/api/v1/user/personal_access_tokens/${body.id}`, { session })
    expect(revoke.statusCode).toBe(200)
    expect((await authed(app, 'GET', '/api/v1/user', { bearer: String(body.token) })).statusCode).toBe(401)
    const again = await authed(app, 'DELETE', `/api/v1/user/personal_access_tokens/${body.id}`, { session })
    expect(again.statusCode).toBe(400)

    // Audit trail records creation and revocation without secrets.
    const audit = JSON.stringify(await authed(app, 'GET', '/api/v1/user/audit_events', { session }).then((r) => r.json()))
    expect(audit).toContain('pat_created')
    expect(audit).toContain('pat_revoked')
    expect(audit).not.toContain(String(body.token))
  })

  it('normalizes api scope and validates input', async () => {
    const { app, session } = await setup()
    const created = await authed(app, 'POST', '/api/v1/user/personal_access_tokens', {
      session,
      payload: { name: 't', scopes: ['api', 'read_api'], expires_in_days: 10 },
    })
    const record = created.json()
    void record

    const list = (await authed(app, 'GET', '/api/v1/user/personal_access_tokens', { session })).json() as unknown as Array<{ scopes: string[] }>
    expect(list[0]!.scopes).toEqual(['api'])

    for (const payload of [
      { name: 't', scopes: [] },
      { name: 't', scopes: ['super_scope'] },
      { scopes: ['read_api'] },
      { name: '', scopes: ['read_api'] },
      { name: 't', scopes: ['read_api'], expires_in_days: 366 },
      { name: 't', scopes: ['read_api'], expires_in_days: 0 },
    ]) {
      const res = await authed(app, 'POST', '/api/v1/user/personal_access_tokens', { session, payload })
      expect(res.statusCode).toBe(400)
    }
  })

  it('expired tokens stop authenticating; read-scope tokens cannot write', async () => {
    const { app, session } = await setup()
    const created = await authed(app, 'POST', '/api/v1/user/personal_access_tokens', {
      session, payload: { name: 'short-lived', scopes: ['read_api'], expires_in_days: 5 },
    })
    const token = String(created.json().token)

    // Rewind expiry into the past.
    app.store.db.run("UPDATE access_tokens SET expires_at = '2000-01-01T00:00:00.000Z'")
    expect((await authed(app, 'GET', '/api/v1/user', { bearer: token })).statusCode).toBe(401)

    // Fresh read-only token: reads OK, writes blocked by scope gate.
    const ro = await authed(app, 'POST', '/api/v1/user/personal_access_tokens', {
      session, payload: { name: 'ro', scopes: ['read_user'] },
    })
    const roToken = String(ro.json().token)
    expect((await authed(app, 'GET', '/api/v1/user', { bearer: roToken })).statusCode).toBe(200)
    const writeAttempt = await app.inject({
      method: 'PATCH', url: '/api/v1/user',
      headers: { authorization: `Bearer ${roToken}` },
      payload: { bio: 'nope' },
    })
    expect(writeAttempt.statusCode).toBe(403)
    expect(writeAttempt.json()).toMatchObject({ message: expect.stringContaining('scope') as unknown })
  })

  it('PAT-authenticated requests bypass CSRF (no ambient credential)', async () => {
    const { app, session } = await setup()
    const created = await authed(app, 'POST', '/api/v1/user/personal_access_tokens', {
      session, payload: { name: 'csrf-free', scopes: ['api'] },
    })
    const token = String(created.json().token)
    // No cookie, no CSRF header — mutation succeeds under Bearer auth.
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/user',
      headers: { authorization: `Bearer ${token}` },
      payload: { bio: 'token-driven update' },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('secrets hygiene across identity surfaces', () => {
  it('never leaks password hashes, digests, or emails in profile responses', async () => {
    const { app, session } = await setup()
    const self = JSON.stringify((await authed(app, 'GET', '/api/v1/user', { session })).json())
    expect(self).not.toContain('password_hash')
    expect(self).toContain('"email"') // self view may include own email

    const pub = await app.inject({ method: 'GET', url: '/api/v1/users/alice' })
    const pubText = JSON.stringify(pub.json())
    expect(pub.statusCode).toBe(200)
    expect(pubText).not.toContain('alice@example.com') // no private email on public profile
    expect(pubText).not.toContain('password_hash')

    const sessionsList = JSON.stringify((await authed(app, 'GET', '/api/v1/sessions', { session })).json())
    expect(sessionsList).not.toContain('token_digest')
  })

  it('audit events for auth failures do not store passwords', async () => {
    const { app } = await setup()
    await loginUser(app, 'alice', 'wrong-password-here-1')
    const rows = app.store.db.all("SELECT detail FROM audit_events WHERE event='login_failed'")
    for (const r of rows) {
      expect(String(r.detail)).not.toContain('wrong-password-here-1')
    }
  })
})
