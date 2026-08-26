import { describe, expect, it } from 'vitest'
import { authed } from './helpers.js'
import {
  setupWebhooks,
  hooksBase,
  deliveriesOf,
  emit,
  type Setup,
} from './webhooks.test.js'

/**
 * Webhooks — lifecycle & administration.
 *
 * Coverage map:
 *   - replay .............. same body + same event UUID re-sent via the ledger
 *   - permission .......... maintainer-only management; 401 anonymous
 *   - secret rotation ..... new secret signs; old secret invalid after grace
 *   - failure tracking .... auto-disable after threshold, owner mail, re-enable
 *   - HTTPS validation .... https required with SSL verify on; http opt-in
 */

async function deliverOnce(s: Setup): Promise<void> {
  emit(s, 'issue.opened', { iid: 42, title: 'Lifecycle', action: 'open' })
  await s.app.webhooks.processDue()
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

describe('replay', () => {
  it('re-sends the recorded body with the SAME event UUID through the ledger', async () => {
    const s = await setupWebhooks()
    await deliverOnce(s)
    const delivered = (await deliveriesOf(s))[0]!
    expect(delivered.state).toBe('delivered')

    const res = await authed(s.app, 'POST', `${hooksBase(s.projectId)}/${s.hookId}/deliveries/${delivered.id}/replay`, {
      session: s.ownerSession,
    })
    expect(res.statusCode).toBe(202)

    await s.app.webhooks.processDue()
    expect(s.fake.calls.length).toBe(2)
    expect(s.fake.calls[1]!.body).toBe(s.fake.calls[0]!.body)
    expect(s.fake.calls[1]!.headers['x-lsgit-event-uuid']).toBe(s.fake.calls[0]!.headers['x-lsgit-event-uuid'])

    // The SAME ledger row was reset and re-driven end-to-end (history stays one line).
    const row = (await deliveriesOf(s))[0]!
    expect(row.id).toBe(delivered.id)
    expect(row.attempts).toBe(1)
    expect(row.state).toBe('delivered')
  })

  it('refuses to replay a delivery that is still queued', async () => {
    const s = await setupWebhooks()
    emit(s, 'issue.opened', { iid: 43, title: 'queued', action: 'open' })
    const pending = (await deliveriesOf(s))[0]!
    expect(pending.state).toBe('pending')
    const res = await authed(s.app, 'POST', `${hooksBase(s.projectId)}/${s.hookId}/deliveries/${pending.id}/replay`, {
      session: s.ownerSession,
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { code?: string }).code).toBe('already_queued')
  })

  it('404s replays of unknown deliveries and foreign-hook ids', async () => {
    const s = await setupWebhooks()
    const res = await authed(
      s.app,
      'POST',
      `${hooksBase(s.projectId)}/${s.hookId}/deliveries/00000000-0000-4000-8000-000000000000/replay`,
      { session: s.ownerSession },
    )
    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe('webhook permissions', () => {
  it('strangers cannot list, create, update, delete, test or replay', async () => {
    const s = await setupWebhooks()

    expect((await authed(s.app, 'GET', hooksBase(s.projectId), { session: s.strangerSession })).statusCode).toBe(403)
    expect((
      await authed(s.app, 'POST', hooksBase(s.projectId), {
        session: s.strangerSession,
        payload: { url: 'https://evil.example/x', events: ['push'] },
      })
    ).statusCode).toBe(403)
    expect((await authed(s.app, 'PATCH', `${hooksBase(s.projectId)}/${s.hookId}`, { session: s.strangerSession, payload: { name: 'x' } })).statusCode).toBe(403)
    expect((await authed(s.app, 'DELETE', `${hooksBase(s.projectId)}/${s.hookId}`, { session: s.strangerSession })).statusCode).toBe(403)
    expect((await authed(s.app, 'POST', `${hooksBase(s.projectId)}/${s.hookId}/test`, { session: s.strangerSession })).statusCode).toBe(403)
    expect((await authed(s.app, 'GET', `${hooksBase(s.projectId)}/${s.hookId}/deliveries`, { session: s.strangerSession })).statusCode).toBe(403)

    // Nothing mutated by any denied request.
    const list = await authed(s.app, 'GET', hooksBase(s.projectId), { session: s.ownerSession })
    expect(((list.json() as { webhooks: Array<unknown> }).webhooks).length).toBe(1)
  })

  it('anonymous callers get 401 everywhere on the webhook surface', async () => {
    const s = await setupWebhooks()
    expect((await authed(s.app, 'GET', hooksBase(s.projectId))).statusCode).toBe(401)
    expect((await authed(s.app, 'POST', `${hooksBase(s.projectId)}/${s.hookId}/test`)).statusCode).toBe(401)
  })

  it('the owner retains full management including rotation and enable/disable', async () => {
    const s = await setupWebhooks()
    const disable = await authed(s.app, 'PATCH', `${hooksBase(s.projectId)}/${s.hookId}`, {
      session: s.ownerSession, payload: { state_event: 'disable' },
    })
    expect(disable.statusCode).toBe(200)
    expect(((disable.json() as { webhook: { state: string } }).webhook).state).toBe('disabled')

    const enable = await authed(s.app, 'PATCH', `${hooksBase(s.projectId)}/${s.hookId}`, {
      session: s.ownerSession, payload: { state_event: 'enable' },
    })
    expect(((enable.json() as { webhook: { state: string } }).webhook).state).toBe('enabled')

    // Disabled hooks reject test deliveries; enabled ones accept them.
    expect((await authed(s.app, 'POST', `${hooksBase(s.projectId)}/${s.hookId}/test`, { session: s.ownerSession })).statusCode).toBe(202)
  })
})

// ---------------------------------------------------------------------------
// Secret rotation
// ---------------------------------------------------------------------------

describe('secret rotation', () => {
  it('issues a NEW raw secret once; subsequent deliveries sign under it', async () => {
    const s = await setupWebhooks()
    const rot = await authed(s.app, 'POST', `${hooksBase(s.projectId)}/${s.hookId}/secret/rotate`, { session: s.ownerSession })
    expect(rot.statusCode).toBe(200)
    const { secret: newSecret } = rot.json() as { secret: string }
    expect(newSecret).toBeTruthy()
    expect(newSecret).not.toBe(s.secret)

    emit(s, 'issue.opened', { iid: 50, title: 'after rotate', action: 'open' })
    await s.app.webhooks.processDue()
    expect(s.fake.calls[0]!.headers['x-lsgit-token']).toBe(newSecret)
  })

  it('keeps the old secret verifiable only within the grace window (digest history)', async () => {
    const s = await setupWebhooks(['issue'], { webhookSecretGraceHours: 24 })
    const rot = await authed(s.app, 'POST', `${hooksBase(s.projectId)}/${s.hookId}/secret/rotate`, { session: s.ownerSession })
    const { secret: newSecret } = rot.json() as { secret: string }
    void newSecret

    const secretsRepo = s.app.store.webhookSecrets
    const rows = secretsRepo.verifiable(s.hookId, new Date(Date.now() - 60_000).toISOString())
    expect(rows.length).toBe(2) // active + still-graced predecessor

    // Old row is deactivated but its ciphertext still decrypts (in-flight deliveries keep verifying).
    const oldRow = rows.find((r) => !r.active)!
    expect(oldRow.deactivated_at).toBeTruthy()
    const { decryptSecret } = await import('../src/lib/crypto.js')
    expect(decryptSecret(oldRow.cipher, s.app.cfg.secret)).toBe(s.secret)

    // After the grace window elapses only the active secret remains verifiable.
    const afterGrace = secretsRepo.verifiable(s.hookId, new Date(Date.now() + 25 * 3600_000).toISOString())
    expect(afterGrace.length).toBe(1)
    expect(afterGrace[0]!.active).toBe(1)
  })

  it('never exposes secrets through read APIs', async () => {
    const s = await setupWebhooks()
    const detail = await authed(s.app, 'GET', `${hooksBase(s.projectId)}/${s.hookId}`, { session: s.ownerSession })
    const raw = JSON.stringify(detail.json())
    expect(raw).not.toContain(s.secret)
  })
})

// ---------------------------------------------------------------------------
// Failure tracking / auto-disable
// ---------------------------------------------------------------------------

describe('failure tracking & auto-disable', () => {
  it('disables the hook after the consecutive-failure threshold and notifies the owner', async () => {
    const s = await setupWebhooks(['issue'])
    s.fake.respond = () => ({ ok: false, responseStatus: 500, snippet: null, durationMs: 1, error: null, timedOut: false })

    for (let i = 1; i <= 6; i++) {
      emit(s, 'issue.opened', { iid: 100 + i, title: `f${i}`, action: 'open' })
      await s.app.webhooks.processDue(Date.now() + i * 10_000)
    }

    const hookRow = s.app.store.webhooks.byId(s.hookId)!
    expect(hookRow.state).toBe('auto_disabled')
    expect(hookRow.consecutive_failures).toBeGreaterThanOrEqual(4)
    expect(hookRow.failed_deliveries).toBeGreaterThan(0)

    // Owner notified via the outbox.
    const mail = s.app.store.outbox.drain().find((m) => String(m.subject).includes('auto-disabled'))
    expect(mail).toBeTruthy()

    // Disabled hooks stop consuming their queue — no further HTTP attempts.
    const callsBefore = s.fake.calls.length
    emit(s, 'issue.opened', { iid: 999, title: 'ignored', action: 'open' })
    await s.app.webhooks.processDue(Date.now() + 99_000)
    expect(s.fake.calls.length).toBe(callsBefore)

    // Re-enable manually → delivery resumes and failure streak resets.
    await authed(s.app, 'PATCH', `${hooksBase(s.projectId)}/${s.hookId}`, {
      session: s.ownerSession, payload: { state_event: 'enable' },
    })
    expect(s.app.store.webhooks.byId(s.hookId)!.consecutive_failures).toBe(0)

    s.fake.respond = () => ({ ok: true, responseStatus: 204, snippet: null, durationMs: 1, error: null, timedOut: false })
    emit(s, 'issue.opened', { iid: 1000, title: 'healthy again', action: 'open' })
    await s.app.webhooks.processDue(Date.now() + 100_000)
    const hookAfter = s.app.store.webhooks.byId(s.hookId)!
    expect(hookAfter.consecutive_failures).toBe(0)
    expect(hookAfter.total_deliveries).toBeGreaterThan(0)
  })

  it('counts 4xx misconfigurations double toward the disable threshold', async () => {
    const s = await setupWebhooks(['issue'], { webhookDisableThreshold: 5 })
    s.fake.respond = () => ({ ok: false, responseStatus: 404, snippet: 'no route', durationMs: 1, error: null, timedOut: false })

    // attempts: 1→cf=2, 2→cf=4, 3→cf=6 ≥ 5 → disabled by the third failed attempt.
    for (let i = 1; i <= 3; i++) {
      emit(s, 'issue.opened', { iid: 200 + i, title: `m${i}`, action: 'open' })
      await s.app.webhooks.processDue(Date.now() + i * 10_000)
    }
    expect(s.app.store.webhooks.byId(s.hookId)!.state).toBe('auto_disabled')
    expect(s.fake.calls.length).toBe(3)
  })

  it('a successful delivery resets the consecutive-failure counter', async () => {
    const s = await setupWebhooks(['issue'])
    s.fake.respond = () => ({ ok: false, responseStatus: 500, snippet: null, durationMs: 1, error: null, timedOut: false })
    emit(s, 'issue.opened', { iid: 301, title: 'f1', action: 'open' })
    await s.app.webhooks.processDue(Date.now())
    expect(s.app.store.webhooks.byId(s.hookId)!.consecutive_failures).toBe(1)

    s.fake.respond = () => ({ ok: true, responseStatus: 200, snippet: null, durationMs: 1, error: null, timedOut: false })
    emit(s, 'issue.opened', { iid: 302, title: 'ok', action: 'open' })
    await s.app.webhooks.processDue(Date.now() + 9_999)
    expect(s.app.store.webhooks.byId(s.hookId)!.consecutive_failures).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// HTTPS validation & input hygiene
// ---------------------------------------------------------------------------

describe('URL & event validation', () => {
  it('requires https:// while SSL verification is enabled', async () => {
    const s = await setupWebhooks()
    const denied = await authed(s.app, 'POST', hooksBase(s.projectId), {
      session: s.ownerSession,
      payload: { url: 'http://insecure.example/hook', events: ['push'] },
    })
    expect(denied.statusCode).toBe(422)
    expect((denied.json() as { code?: string }).code).toBe('https_required')

    // Opting out of SSL verification accepts plain http (documented escape hatch).
    const allowed = await authed(s.app, 'POST', hooksBase(s.projectId), {
      session: s.ownerSession,
      payload: { url: 'http://devbox.local/hook', events: ['push'], ssl_verify: false },
    })
    expect(allowed.statusCode).toBe(201)
    expect(((allowed.json() as { webhook: { ssl_verify: boolean } }).webhook).ssl_verify).toBe(false)
  })

  it('rejects garbage URLs, embedded credentials and unknown event names', async () => {
    const s = await setupWebhooks()
    const bad = async (payload: Record<string, unknown>) =>
      (await authed(s.app, 'POST', hooksBase(s.projectId), { session: s.ownerSession, payload })).statusCode
    expect(await bad({ url: 'not-a-url', events: ['push'] })).toBe(400)
    expect(await bad({ url: 'https://user:pass@example.com/hook', events: ['push'] })).toBe(400)
    expect(await bad({ url: 'ftp://files.example/x', events: ['push'], ssl_verify: false })).toBe(422)
    expect(await bad({ url: 'https://ok.example/hook', events: ['not-an-event'] })).toBe(400)
    expect(await bad({ url: 'https://ok.example/hook', events: [] })).toBe(400)
  })
})
