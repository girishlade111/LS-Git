import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { makeApp, registerUser, authed, extractSession, loginRaw, type Session } from './helpers.js'
import { verifySignature } from './webhookTestSupport.js'
import { FetchWebhookTransport, webhookEnqueueFromEvent, type WebhookTransport, type WebhookTransportResult } from '../src/services/webhooks.js'
import type { FastifyInstance } from 'fastify'

/**
 * Webhooks — delivery mechanics (EVENTS.md §3–5; GitLab project hooks).
 *
 * Coverage map:
 *   - signature ........... HMAC-SHA256 over the exact body; wrong secret fails
 *   - retry ............... exponential backoff scheduling + attempt exhaustion
 *   - duplicate delivery .. UNIQUE(webhook_id, event_id) suppresses outbox replays
 *   - timeout ............. real fetch transport aborts a slow receiver
 *   - event payload ....... versioned envelope, kind shapes, header contract,
 *                           subscription filtering, unknown kinds ignored
 *   - async delivery ...... repository operations never POST inline
 */

export interface Setup {
  app: FastifyInstance
  ownerSession: Session
  strangerSession: Session
  projectId: number
  fake: FakeTransport
  secret: string
  hookId: number
}

/** Deterministic in-memory transport capturing every attempted HTTP call. */
export class FakeTransport implements WebhookTransport {
  calls: Array<{ url: string; headers: Record<string, string>; body: string; timeoutMs: number }> = []
  respond: (call: {
    url: string
    headers: Record<string, string>
    body: string
    timeoutMs: number
    attemptNo: number
  }) => WebhookTransportResult = () => ({ ok: true, responseStatus: 200, snippet: 'ok', durationMs: 5, error: null, timedOut: false })

  async post(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutMs: number,
  ): Promise<WebhookTransportResult> {
    const call = { url, headers, body, timeoutMs }
    this.calls.push(call)
    return this.respond({ ...call, attemptNo: Number(headers['x-lsgit-delivery-attempt']) })
  }
}

const HOOK_DEFAULTS = { webhookBackoffBaseMs: 100, webhookMaxAttempts: 3, webhookDisableThreshold: 4 }

export async function setupWebhooks(
  hookEvents: Array<string> = ['issue', 'push', 'release', 'star'],
  overrides: Record<string, unknown> = {},
): Promise<Setup> {
  const app = makeApp({ ...HOOK_DEFAULTS, ...overrides })
  await registerUser(app) // alice → project owner
  const ownerSession = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'mallory', email: 'mallory@example.com' })
  const strangerSession = extractSession((await loginRaw(app, 'mallory')).cookies)

  const created = await authed(app, 'POST', '/api/v1/projects', {
    session: ownerSession,
    payload: { name: 'Hook Lab', path: 'hook-lab', visibility: 'private', initialize_with_readme: true },
  })
  expect(created.statusCode).toBe(201)
  const projectId = app.store.projects.byOwnerPath('alice', 'hook-lab')!.id

  const hookRes = await authed(app, 'POST', `/api/v1/projects/${projectId}/webhooks`, {
    session: ownerSession,
    payload: { name: 'CI bridge', url: 'https://receiver.example/hook', events: hookEvents },
  })
  expect(hookRes.statusCode).toBe(201)
  const { webhook, secret } = hookRes.json() as { webhook: { id: number }; secret: string }

  const fake = new FakeTransport()
  app.webhooks.transport = fake
  return { app, ownerSession, strangerSession, projectId, fake, secret, hookId: webhook.id }
}

export const hooksBase = (projectId: number): string => `/api/v1/projects/${projectId}/webhooks`

export async function deliveriesOf(s: Setup, hookId?: number) {
  return s.app.store.webhookDeliveries.listForHook(hookId ?? s.hookId, 50)
}

export function emit(s: Setup, type: string, payload: Record<string, unknown>): void {
  s.app.store.events.emit(s.projectId, type, payload)
}

// ---------------------------------------------------------------------------
// Delivery model: async by construction
// ---------------------------------------------------------------------------

describe('delivery model (never synchronous)', () => {
  it('queues deliveries without sending any HTTP while the API request runs', async () => {
    const s = await setupWebhooks()
    emit(s, 'repo.push', { ref: 'refs/heads/main', before: 'a'.repeat(40), after: 'b'.repeat(40), actor_user_id: 1 })
    // The emitting operation returned long ago; nothing was posted inline…
    expect(s.fake.calls.length).toBe(0)
    expect((await deliveriesOf(s)).length).toBe(1)

    // …and the dispatcher worker is what actually performs HTTP.
    await s.app.webhooks.processDue()
    expect(s.fake.calls.length).toBe(1)
  })

  it('creates issues end-to-end with zero synchronous webhook traffic', async () => {
    const s = await setupWebhooks(['issue'])
    const res = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues`, {
      session: s.ownerSession,
      payload: { title: 'Hooked' },
    })
    expect(res.statusCode).toBe(201)
    expect(s.fake.calls.length).toBe(0) // user-facing op never blocks on receivers
    await s.app.webhooks.processDue()
    expect(s.fake.calls.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

describe('signature', () => {
  it('signs the exact request body with HMAC-SHA256 under the raw secret', async () => {
    const s = await setupWebhooks()
    emit(s, 'issue.opened', { iid: 1, title: 'Bug', action: 'open', actor_user_id: 1 })
    await s.app.webhooks.processDue()

    const call = s.fake.calls[0]!
    const expected = createHmac('sha256', s.secret).update(call.body, 'utf8').digest('hex')
    expect(call.headers['x-lsgit-signature-256']).toBe(`sha256=${expected}`)
    expect(call.headers['x-lsgit-token']).toBe(s.secret)
    // Receiver-side verification agrees.
    expect(verifySignature(call.headers['x-lsgit-signature-256']!, call.body, s.secret)).toBe(true)
  })

  it('fails verification with any other secret (receiver-side check)', async () => {
    const s = await setupWebhooks()
    emit(s, 'issue.opened', { iid: 1, title: 'Bug', action: 'open' })
    await s.app.webhooks.processDue()
    const call = s.fake.calls[0]!
    expect(verifySignature(call.headers['x-lsgit-signature-256']!, call.body, 'not-the-secret')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Retry & backoff
// ---------------------------------------------------------------------------

describe('retry with exponential backoff', () => {
  it('schedules retries at doubling intervals and marks exhausted attempts failed', async () => {
    const s = await setupWebhooks()
    s.fake.respond = () => ({ ok: false, responseStatus: 500, snippet: 'boom', durationMs: 3, error: null, timedOut: false })
    emit(s, 'issue.opened', { iid: 7, title: 'Flaky', action: 'open' })

    const t0 = Date.now()
    await s.app.webhooks.processDue(t0)
    let rows = await deliveriesOf(s)
    expect(rows[0]!.state).toBe('retrying')
    expect(rows[0]!.attempts).toBe(1)
    const firstGap = Date.parse(rows[0]!.next_attempt_at!) - t0
    expect(firstGap).toBe(100) // base

    await s.app.webhooks.processDue(t0 + firstGap + 1)
    rows = await deliveriesOf(s)
    expect(rows[0]!.attempts).toBe(2)
    const secondGap = Date.parse(rows[0]!.next_attempt_at!) - (t0 + firstGap + 1)
    expect(secondGap).toBe(200) // base × 2^1 — exponential

    await s.app.webhooks.processDue(t0 + 10_000)
    rows = await deliveriesOf(s)
    // maxAttempts=3 → terminal failure after the third attempt.
    expect(rows[0]!.state).toBe('failed')
    expect(rows[0]!.attempts).toBe(3)
    expect(s.fake.calls.length).toBe(3)
  })

  it('does not run due retries before their backoff slot elapses', async () => {
    const s = await setupWebhooks()
    s.fake.respond = () => ({ ok: false, responseStatus: 500, snippet: null, durationMs: 1, error: null, timedOut: false })
    emit(s, 'issue.opened', { iid: 8, title: 'x', action: 'open' })
    const t0 = Date.now()
    await s.app.webhooks.processDue(t0)
    await s.app.webhooks.processDue(t0 + 50) // inside the 100ms window
    expect(s.fake.calls.length).toBe(1)
    await s.app.webhooks.processDue(t0 + 150)
    expect(s.fake.calls.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Duplicate suppression
// ---------------------------------------------------------------------------

describe('duplicate delivery suppression', () => {
  it('enqueues exactly ONE row when the same outbox event is replayed (crash safety)', async () => {
    const s = await setupWebhooks()
    emit(s, 'star.added', { actor_user_id: 1 })
    const row = s.app.store.db.get('SELECT * FROM events ORDER BY id DESC LIMIT 1') as { id: number }

    // Simulate dispatcher crash + outbox sweep replaying the SAME event row.
    webhookEnqueueFromEvent(s.app.store, s.app.cfg, { id: row.id, project_id: s.projectId, type: 'star.added', payload: {} })
    webhookEnqueueFromEvent(s.app.store, s.app.cfg, { id: row.id, project_id: s.projectId, type: 'star.added', payload: {} })

    const rows = await deliveriesOf(s)
    expect(rows.length).toBe(1)
  })

  it('keeps a stable X-LSGit-Event-UUID across retries for receiver-side idempotency', async () => {
    const s = await setupWebhooks()
    s.fake.respond = () => ({ ok: false, responseStatus: 503, snippet: null, durationMs: 1, error: null, timedOut: false })
    emit(s, 'issue.opened', { iid: 2, title: 'y', action: 'open' })
    await s.app.webhooks.processDue(Date.now())
    await s.app.webhooks.processDue(Date.now() + 9_999)
    expect(s.fake.calls.length).toBe(2)
    expect(s.fake.calls[0]!.headers['x-lsgit-event-uuid']).toBe(s.fake.calls[1]!.headers['x-lsgit-event-uuid'])
  })
})

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe('timeout', () => {
  it('aborts a receiver that responds slower than the deadline (real socket)', async () => {
    const server: Server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200)
        res.end('finally')
      }, 500)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      const transport = new FetchWebhookTransport()
      const started = Date.now()
      const result = await transport.post(`http://127.0.0.1:${port}/hook`, {}, '{"object_kind":"push"}', 60)
      expect(result.ok).toBe(false)
      expect(result.timedOut).toBe(true)
      expect(result.error).toContain('timeout')
      expect(result.responseStatus).toBeNull()
      expect(Date.now() - started).toBeLessThan(450)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('records timeouts as retryable failures on the ledger', async () => {
    const s = await setupWebhooks()
    s.fake.respond = () => ({ ok: false, responseStatus: null, snippet: null, durationMs: 60, error: 'timeout after 60ms', timedOut: true })
    emit(s, 'issue.opened', { iid: 3, title: 'slow', action: 'open' })
    await s.app.webhooks.processDue(Date.now())
    const row = (await deliveriesOf(s))[0]!
    expect(row.state).toBe('retrying')
    expect(row.response_status).toBeNull()
    expect(row.error).toContain('timeout')
  })
})

// ---------------------------------------------------------------------------
// Event payloads & subscription filtering
// ---------------------------------------------------------------------------

describe('event payloads', () => {
  it('carries the versioned envelope and push-kind fields with the header contract', async () => {
    const s = await setupWebhooks()
    emit(s, 'repo.push', {
      ref: 'refs/heads/main',
      before: '0'.repeat(40),
      after: 'f'.repeat(40),
      total_commits_count: 2,
      commits: [{ id: 'c1', message: 'feat: x' }],
      actor_user_id: 1,
    })
    await s.app.webhooks.processDue()

    const call = s.fake.calls[0]!
    const body = JSON.parse(call.body) as Record<string, unknown>
    expect(body.object_kind).toBe('push')
    expect(body.event_type).toBe('push')
    expect(body.schema_version).toBe(1)
    const project = body.project as Record<string, unknown>
    expect(project.path_with_namespace).toBe('alice/hook-lab')
    expect(String(project.web_url)).toContain('/alice/hook-lab')
    expect(((body.user as Record<string, unknown>).username)).toBe('alice')
    expect(body.ref).toBe('refs/heads/main')
    expect(body.total_commits_count).toBe(2)
    expect(call.headers['x-lsgit-event']).toBe('Push Hook')
    expect(call.headers['x-lsgit-webhook-uuid']).toBe(String(s.hookId))
  })

  it('redacts author email unless a public profile email exists', async () => {
    const s = await setupWebhooks()
    emit(s, 'issue.opened', { iid: 4, title: 'no public email', action: 'open', actor_user_id: 1 })
    await s.app.webhooks.processDue()
    const user = (JSON.parse(s.fake.calls[0]!.body) as Record<string, unknown>).user as Record<string, unknown>
    expect(user.email).toBeUndefined()
  })

  it('delivers only to subscribed hooks and ignores unmapped internal kinds', async () => {
    const s = await setupWebhooks(['issue'])
    const relHook = await authed(s.app, 'POST', hooksBase(s.projectId), {
      session: s.ownerSession,
      payload: { url: 'https://rel.example/x', events: ['release'] },
    })
    expect(relHook.statusCode).toBe(201)

    emit(s, 'issue.opened', { iid: 5, title: 'only for issue hook', action: 'open' })
    emit(s, 'form.submitted', { form: 'bug' }) // unmapped kind → ignored everywhere
    await s.app.webhooks.processDue()

    expect(s.fake.calls.length).toBe(1)
    expect(s.fake.calls[0]!.url).toBe('https://receiver.example/hook')
    expect(JSON.parse(s.fake.calls[0]!.body).object_kind).toBe('issue')

    emit(s, 'release.published', { tag: 'v1.0.0', action: 'published', title: 'One' })
    await s.app.webhooks.processDue()
    // Exactly one call per subscribed hook — never cross-delivered.
    const relCalls = s.fake.calls.filter((c) => c.url === 'https://rel.example/x')
    expect(relCalls.length).toBe(1)
    expect(JSON.parse(relCalls[0]!.body).object_kind).toBe('release')
    expect(JSON.parse(relCalls[0]!.body).object_attributes.tag).toBe('v1.0.0')
    expect(relCalls[0]!.headers['x-lsgit-event']).toBe('Release Hook')
    expect(s.fake.calls.filter((c) => c.url === 'https://rel.example/x').length).toBe(1)
  })

  it('test deliveries flow through the real queue with object_kind "test"', async () => {
    const s = await setupWebhooks()
    const res = await authed(s.app, 'POST', `${hooksBase(s.projectId)}/${s.hookId}/test`, { session: s.ownerSession })
    expect(res.statusCode).toBe(202)
    expect(s.fake.calls.length).toBe(0) // queued, not sent inline
    await s.app.webhooks.processDue()
    expect(s.fake.calls.length).toBe(1)
    expect(JSON.parse(s.fake.calls[0]!.body).object_kind).toBe('test')
  })
})
