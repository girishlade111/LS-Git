import { randomUUID } from 'node:crypto'
import { AppError } from './identity.js'
import type { IdentityServices } from './identity.js'
import type {
  ProjectRow,
  WebhookDeliveryRow,
  WebhookRow,
} from '../db/store.js'
import type { Actor } from '../authz.js'
import { can } from '../authz.js'
import type { AppConfig } from '../config.js'
import {
  decryptSecret,
  encryptSecret,
  generateToken,
  hmacSha256Hex,
  tokenDigest,
} from '../lib/crypto.js'

/**
 * Webhooks (EVENTS.md §3–5; GitLab project-hooks semantics on LSGit naming).
 *
 * Delivery model — never synchronous with user-facing operations:
 *
 *   domain event → events outbox → webhookEnqueueFromEvent() (fan-out, one
 *   delivery row per subscribed hook) → processDue() worker → HTTP POST →
 *   record result → exponential-backoff retry while eligible.
 *
 * Security: every payload is signed with HMAC-SHA256 over the exact request
 * body (`X-LSGit-Signature-256`) and carries the raw token
 * (`X-LSGit-Token`). Secrets are stored only as SHA-256 digests plus AES-GCM
 * ciphertext; rotation keeps the previous secret verifying for a grace window
 * so in-flight deliveries never break. Hooks that keep failing are
 * auto-disabled after a threshold of consecutive failures (4xx counts double:
 * a misconfigured receiver should trip the breaker faster).
 */

export const WEBHOOK_EVENT_TYPES = [
  'push',
  'repository',
  'fork',
  'star',
  'issue',
  'pull_request',
  'discussion',
  'release',
  'deployment',
  'workflow',
] as const

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number]

/** Additive-only contract: bump + changelog when breaking (EVENTS.md §7). */
export const PAYLOAD_SCHEMA_VERSION = 1

const KIND_TITLES: Partial<Record<WebhookEventType | 'test', string>> = {
  push: 'Push Hook',
  repository: 'Project Hook',
  fork: 'Fork Hook',
  star: 'Star Hook',
  issue: 'Issue Hook',
  pull_request: 'Merge Request Hook',
  discussion: 'Discussion Hook',
  release: 'Release Hook',
  deployment: 'Deployment Hook',
  workflow: 'Pipeline Hook',
  test: 'Test Hook',
}

function kindTitle(kind: string): string {
  return KIND_TITLES[kind as keyof typeof KIND_TITLES] ?? `${kind.charAt(0).toUpperCase()}${kind.slice(1)} Hook`
}

// -- domain-event → webhook-kind classification -------------------------------

const EXACT_EVENT_MAP: Record<string, { kind: WebhookEventType; eventType?: string }> = {
  'repo.push': { kind: 'push' },
  'repo.tag_push': { kind: 'push', eventType: 'tag_push' },
  'repository.file_committed': { kind: 'push' },
  'repository.files_committed': { kind: 'push' },
  'project.created': { kind: 'repository', eventType: 'create' },
  'project.updated': { kind: 'repository', eventType: 'update' },
  'project.transferred': { kind: 'repository', eventType: 'transfer' },
  'project.destroyed': { kind: 'repository', eventType: 'destroy' },
  'project.forked': { kind: 'fork', eventType: 'create' },
  'star.added': { kind: 'star', eventType: 'create' },
  'star.removed': { kind: 'star', eventType: 'destroy' },
}

const PREFIX_EVENT_MAP: Array<{ prefix: string; kind: WebhookEventType }> = [
  { prefix: 'issue.', kind: 'issue' },
  { prefix: 'mr.', kind: 'pull_request' },
  { prefix: 'note.', kind: 'discussion' },
  { prefix: 'discussion.', kind: 'discussion' },
  { prefix: 'release.', kind: 'release' },
  { prefix: 'deployment.', kind: 'deployment' },
  { prefix: 'pipeline.', kind: 'workflow' },
  { prefix: 'job.', kind: 'workflow' },
  { prefix: 'workflow.', kind: 'workflow' },
]

export function classifyDomainEvent(
  type: string,
): { kind: WebhookEventType; eventType: string } | null {
  const exact = EXACT_EVENT_MAP[type]
  if (exact) return { kind: exact.kind, eventType: exact.eventType ?? type.split('.')[1] ?? type }
  for (const rule of PREFIX_EVENT_MAP) {
    if (type.startsWith(rule.prefix)) {
      return { kind: rule.kind, eventType: type.slice(rule.prefix.length) }
    }
  }
  // Unknown kinds are IGNORED by receivers per documented guidance — the
  // dispatcher mirrors that by not enqueueing them at all.
  return null
}

// -- versioned payload construction -------------------------------------------

const PUSH_FIELDS = ['before', 'after', 'ref', 'total_commits_count', 'commits'] as const
const OBJECT_FIELDS = [
  'iid', 'title', 'description', 'state', 'action', 'url',
  'tag', 'name', 'category', 'body',
] as const

function pick(source: Record<string, unknown>, keys: ReadonlyArray<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (source[k] !== undefined) out[k] = source[k]
  return out
}

function userBlock(s: IdentityServices, actorUserId: unknown): Record<string, unknown> | null {
  if (typeof actorUserId !== 'number') return null
  const u = s.users.byId(actorUserId)
  if (!u) return null
  return {
    id: u.id,
    name: u.name ?? u.username,
    username: u.username,
    // Author email is redacted unless a public profile email exists (EVENTS.md §3).
    ...(u.public_email ? { email: u.public_email } : {}),
  }
}

export function buildWebhookPayload(
  s: IdentityServices,
  cfg: AppConfig,
  project: ProjectRow,
  kind: string,
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const owner = s.users.byId(project.owner_id)
  const fullPath = `${owner?.username ?? ''}/${project.path}`
  const envelope: Record<string, unknown> = {
    object_kind: kind,
    event_type: eventType,
    schema_version: PAYLOAD_SCHEMA_VERSION,
    project: {
      id: project.id,
      name: project.name,
      path_with_namespace: fullPath,
      web_url: `${cfg.origin}/${fullPath}`,
      default_branch: project.default_branch,
      visibility: project.visibility,
    },
  }
  const user = userBlock(s, payload.actor_user_id)
  if (user) envelope.user = user
  const push = pick(payload, PUSH_FIELDS)
  if (Object.keys(push).length > 0) Object.assign(envelope, push)
  const objectAttributes = pick(payload, OBJECT_FIELDS)
  if (Object.keys(objectAttributes).length > 0) envelope.object_attributes = objectAttributes
  return envelope
}

// -- HTTP transport -------------------------------------------------------------

export interface WebhookTransportResult {
  ok: boolean
  responseStatus: number | null
  snippet: string | null
  durationMs: number
  error: string | null
  timedOut: boolean
}

export interface WebhookTransport {
  post(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutMs: number,
  ): Promise<WebhookTransportResult>
}

const SNIPPET_BYTES = 4096

/** Default transport: global fetch + AbortController deadline. */
export class FetchWebhookTransport implements WebhookTransport {
  async post(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutMs: number,
  ): Promise<WebhookTransportResult> {
    const startedAt = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        redirect: 'manual', // never follow redirects to other hosts silently
      })
      let snippet: string | null = null
      try {
        const text = await res.text()
        snippet = text.slice(0, SNIPPET_BYTES)
      } catch {
        snippet = null
      }
      return {
        ok: res.status >= 200 && res.status < 300,
        responseStatus: res.status,
        snippet,
        durationMs: Date.now() - startedAt,
        error: null,
        timedOut: false,
      }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      return {
        ok: false,
        responseStatus: null,
        snippet: null,
        durationMs: Date.now() - startedAt,
        error: aborted ? `timeout after ${timeoutMs}ms` : String(err instanceof Error ? err.message : err),
        timedOut: aborted,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

// -- service --------------------------------------------------------------------

export interface WebhookView {
  id: number
  name: string
  description: string
  url: string
  ssl_verify: boolean
  state: WebhookRow['state']
  disabled_reason: string | null
  events: Array<WebhookEventType>
  consecutive_failures: number
  total_deliveries: number
  failed_deliveries: number
  last_delivery_at: string | null
  created_at: string
  updated_at: string
}

export interface DeliveryView {
  id: string
  webhook_id: number
  event_type: string
  schema_version: number
  state: WebhookDeliveryRow['state']
  attempts: number
  next_attempt_at: string | null
  response_status: number | null
  duration_ms: number | null
  error: string | null
  delivered_at: string | null
  created_at: string
  request_body: Record<string, unknown>
  response_snippet?: string | null
}

export class WebhookService {
  /** Swap point for tests: deterministic fake transports replace this. */
  transport: WebhookTransport = new FetchWebhookTransport()

  constructor(private s: IdentityServices, private cfg: AppConfig) {}

  // ── gates ────────────────────────────────────────────────────────────────

  private projectCtx(p: ProjectRow) {
    return { resourceProject: { ownerId: p.owner_id, visibility: p.visibility } }
  }

  private requireManageableProject(actor: Actor | null, projectId: number): ProjectRow {
    const p = this.s.projects.byId(projectId)
    if (!p) throw new AppError(404, 'Project not found')
    if (!can(actor, 'project:manage_webhooks', this.projectCtx(p))) {
      throw new AppError(actor ? 403 : 401, 'Only maintainers can manage webhooks', 'forbidden')
    }
    return p
  }

  private hookOf(projectId: number, hookId: number): WebhookRow {
    const hook = this.s.webhooks.byId(hookId)
    if (!hook || hook.project_id !== projectId) throw new AppError(404, 'Webhook not found')
    return hook
  }

  // ── validation ───────────────────────────────────────────────────────────

  /**
   * HTTPS-first URL policy. With SSL verification ON (the default) only
   * https:// targets are accepted; turning verification off explicitly opts
   * into plain http:// (self-signed/dev receivers), mirroring GitLab's toggle.
   */
  private validateUrl(raw: unknown, sslVerify: boolean): string {
    const value = String(raw ?? '').trim()
    if (!value || value.length > 2048) throw new AppError(400, 'url is required (max 2048 chars)')
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new AppError(400, 'Invalid webhook URL', 'invalid_url')
    }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && !sslVerify)) {
      throw new AppError(
        422,
        sslVerify
          ? 'SSL verification is enabled — the webhook URL must use https://'
          : 'Only http(s) webhook URLs are supported',
        sslVerify ? 'https_required' : 'scheme_unsupported',
      )
    }
    if (parsed.username || parsed.password) {
      throw new AppError(400, 'Webhook URLs must not embed credentials')
    }
    return value
  }

  private validateEvents(raw: unknown): Array<WebhookEventType> {
    if (!Array.isArray(raw)) throw new AppError(400, 'events must be an array of event names')
    const events = [...new Set(raw.map(String))]
    if (events.length === 0) throw new AppError(400, 'Select at least one event to trigger on')
    for (const e of events) {
      if (!(WEBHOOK_EVENT_TYPES as readonly string[]).includes(e)) {
        throw new AppError(400, `Unknown webhook event: ${e}`)
      }
    }
    return events as Array<WebhookEventType>
  }

  // ── secrets ──────────────────────────────────────────────────────────────

  private mintSecret(hookId: number): string {
    const raw = generateToken(24)
    this.s.db.transaction(() => {
      this.s.webhookSecrets.deactivateAll(hookId)
      this.s.webhookSecrets.create(hookId, tokenDigest(raw), encryptSecret(raw, this.cfg.secret))
    })
    return raw
  }

  /** Raw secret of the ACTIVE row — decrypted only at send time. */
  private activeRawSecret(hookId: number): string | null {
    const row = this.s.webhookSecrets.active(hookId)
    if (!row) return null
    return decryptSecret(row.cipher, this.cfg.secret)
  }

  rotateSecret(actor: Actor, projectId: number, hookId: number): { secret: string } {
    const project = this.requireManageableProject(actor, projectId)
    void project
    const hook = this.hookOf(projectId, hookId)
    const secret = this.mintSecret(hook.id)
    this.s.audit.record({
      userId: actor.userId,
      name: 'webhook_secret_rotated',
      detail: { project_id: projectId, webhook_id: hookId },
    })
    return { secret }
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  create(actor: Actor, projectId: number, input: Record<string, unknown>): { webhook: WebhookView; secret: string } {
    this.requireManageableProject(actor, projectId)
    const sslVerify = input.ssl_verify !== false
    const url = this.validateUrl(input.url, sslVerify)
    const events = this.validateEvents(input.events)

    const hook = this.s.db.transaction(() => {
      const row = this.s.webhooks.create({
        project_id: projectId,
        url,
        name: typeof input.name === 'string' ? input.name.trim().slice(0, 255) : '',
        description: typeof input.description === 'string' ? input.description.trim().slice(0, 1000) : '',
        ssl_verify: sslVerify,
        created_by_id: actor.userId,
      })
      this.s.webhookEvents.setForHook(row.id, events)
      return row
    })
    const secret = this.mintSecret(hook.id) // shown exactly once
    this.s.audit.record({
      userId: actor.userId,
      name: 'webhook_created',
      detail: { project_id: projectId, webhook_id: hook.id, url },
    })
    return { webhook: this.view(hook), secret }
  }

  list(actor: Actor | null, projectId: number): { webhooks: Array<WebhookView> } {
    const project = this.requireManageableProject(actor, projectId)
    void project
    return { webhooks: this.s.webhooks.listForProject(projectId).map((h) => this.view(h)) }
  }

  get(actor: Actor | null, projectId: number, hookId: number): { webhook: WebhookView & { recent_deliveries: DeliveryView[] } } {
    const project = this.requireManageableProject(actor, projectId)
    void project
    const hook = this.hookOf(projectId, hookId)
    return {
      webhook: {
        ...this.view(hook),
        recent_deliveries: this.s.webhookDeliveries.listForHook(hook.id, 20).map((d) => this.deliveryView(d)),
      },
    }
  }

  update(actor: Actor, projectId: number, hookId: number, patch: Record<string, unknown>): WebhookView {
    const project = this.requireManageableProject(actor, projectId)
    void project
    const hook = this.hookOf(projectId, hookId)

    const sets: Record<string, unknown> = {}
    if (patch.name !== undefined) sets.name = String(patch.name ?? '').trim().slice(0, 255)
    if (patch.description !== undefined) sets.description = String(patch.description ?? '').trim().slice(0, 1000)

    let sslVerify = !!hook.ssl_verify
    if (patch.ssl_verify !== undefined) {
      sslVerify = patch.ssl_verify !== false
      sets.ssl_verify = sslVerify ? 1 : 0
    }
    if (patch.url !== undefined) sets.url = this.validateUrl(patch.url, sslVerify)

    this.s.db.transaction(() => {
      this.s.webhooks.update(hook.id, sets as never)
      if (patch.events !== undefined) {
        this.s.webhookEvents.setForHook(hook.id, this.validateEvents(patch.events))
      }
      const stateEvent = patch.state_event
      if (stateEvent === 'enable') {
        this.s.webhooks.update(hook.id, {
          state: 'enabled',
          disabled_reason: null,
          consecutive_failures: 0,
        } as never)
      } else if (stateEvent === 'disable') {
        this.s.webhooks.update(hook.id, { state: 'disabled', disabled_reason: null } as never)
      } else if (stateEvent !== undefined) {
        throw new AppError(400, "state_event must be 'enable' or 'disable'")
      }
    })
    return this.view(this.s.webhooks.byId(hook.id)!)
  }

  remove(actor: Actor, projectId: number, hookId: number): void {
    const project = this.requireManageableProject(actor, projectId)
    void project
    const hook = this.hookOf(projectId, hookId)
    this.s.webhooks.delete(hook.id)
    this.s.audit.record({
      userId: actor.userId,
      name: 'webhook_removed',
      detail: { project_id: projectId, webhook_id: hookId },
    })
  }

  // ── test delivery ────────────────────────────────────────────────────────

  /** Synthetic ping through the REAL pipeline (queued, signed, retried). */
  testDelivery(actor: Actor, projectId: number, hookId: number): DeliveryView {
    const project = this.requireManageableProject(actor, projectId)
    const hook = this.hookOf(projectId, hookId)
    if (hook.state !== 'enabled') {
      throw new AppError(409, 'Enable the webhook before sending a test delivery', 'hook_disabled')
    }
    const payload = buildWebhookPayload(this.s, this.cfg, project, 'test', 'test', {})
    return this.deliveryView(
      this.enqueue(hook, null, 'test', payload),
    )
  }

  // ── deliveries ───────────────────────────────────────────────────────────

  listDeliveries(actor: Actor | null, projectId: number, hookId: number, limit = 20): { deliveries: DeliveryView[] } {
    const project = this.requireManageableProject(actor, projectId)
    void project
    const hook = this.hookOf(projectId, hookId)
    return { deliveries: this.s.webhookDeliveries.listForHook(hook.id, limit).map((d) => this.deliveryView(d)) }
  }

  getDelivery(actor: Actor | null, projectId: number, hookId: number, deliveryId: string): { delivery: DeliveryView } {
    const project = this.requireManageableProject(actor, projectId)
    void project
    const hook = this.hookOf(projectId, hookId)
    const d = this.s.webhookDeliveries.byId(deliveryId)
    if (!d || d.webhook_id !== hook.id) throw new AppError(404, 'Delivery not found')
    return { delivery: this.deliveryView(d, true) }
  }

  /**
   * Replay re-sends the SAME recorded body with the SAME event UUID — the
   * receiver-side idempotency key survives, duplicates stay detectable.
   */
  replayDelivery(actor: Actor, projectId: number, hookId: number, deliveryId: string): DeliveryView {
    const project = this.requireManageableProject(actor, projectId)
    void project
    const hook = this.hookOf(projectId, hookId)
    if (hook.state !== 'enabled') {
      throw new AppError(409, 'Enable the webhook before replaying deliveries', 'hook_disabled')
    }
    const d = this.s.webhookDeliveries.byId(deliveryId)
    if (!d || d.webhook_id !== hook.id) throw new AppError(404, 'Delivery not found')
    if (d.state === 'pending' || d.state === 'retrying') {
      throw new AppError(409, 'This delivery is still queued — wait for it to finish first', 'already_queued')
    }
    this.s.webhookDeliveries.resetForReplay(d.id, new Date().toISOString())
    return this.deliveryView(this.s.webhookDeliveries.byId(d.id)!)
  }

  // ── fan-out (event-bus subscriber) ----------------------------------------

  private enqueue(
    hook: WebhookRow,
    eventId: number | null,
    eventType: string,
    payload: Record<string, unknown>,
  ): WebhookDeliveryRow {
    return this.s.webhookDeliveries.create({
      id: randomUUID(),
      webhookId: hook.id,
      eventId, // UNIQUE(webhook_id, event_id) makes duplicate outbox replays impossible
      eventType,
      schemaVersion: PAYLOAD_SCHEMA_VERSION,
      requestBody: JSON.stringify(payload),
      nextAttemptAt: new Date().toISOString(),
    })
  }

  // ── dispatcher (worker) -----------------------------------------------------

  backoffDelay(attempt: number): number {
    return Math.min(this.cfg.webhookBackoffBaseMs * 2 ** Math.max(0, attempt - 1), this.cfg.webhookBackoffMaxMs)
  }

  /**
   * Processes due deliveries. Returns how many were attempted. Deterministic:
   * tests call this directly instead of relying on timers.
   */
  async processDue(nowMs: number = Date.now(), limit = 25): Promise<number> {
    const due = this.s.webhookDeliveries.due(new Date(nowMs).toISOString(), limit)
    let processed = 0
    for (const d of due) {
      await this.attemptOne(d, nowMs)
      processed++
    }
    return processed
  }

  private async attemptOne(d: WebhookDeliveryRow, nowMs: number): Promise<void> {
    const hook = this.s.webhooks.byId(d.webhook_id)
    if (!hook) return

    // A hook disabled mid-flight stops consuming its queue; the ledger keeps
    // the rows visible with an explicit reason instead of looping forever.
    if (hook.state !== 'enabled') {
      this.s.webhookDeliveries.recordResult(d.id, {
        state: 'failed',
        attemptsDelta: 0,
        error: `webhook_${hook.state}`,
      })
      return
    }

    const rawSecret = this.activeRawSecret(hook.id)
    const attemptNo = d.attempts + 1
    const result = rawSecret
      ? await this.transport.post(
          hook.url,
          {
            'content-type': 'application/json',
            'user-agent': 'LSGit-Webhook/1.0',
            'x-lsgit-event': kindTitle(d.event_type),
            'x-lsgit-token': rawSecret,
            'x-lsgit-signature-256': `sha256=${hmacSha256Hex(rawSecret, d.request_body)}`,
            'x-lsgit-webhook-uuid': String(hook.id),
            'x-lsgit-event-uuid': d.id,
            'x-lsgit-delivery-attempt': String(attemptNo),
          },
          d.request_body,
          this.cfg.webhookTimeoutMs,
        )
      : {
          ok: false,
          responseStatus: null,
          snippet: null,
          durationMs: 0,
          error: 'missing signing secret',
          timedOut: false,
        }

    if (result.ok) {
      this.s.db.transaction(() => {
        this.s.webhookDeliveries.recordResult(d.id, {
          state: 'delivered',
          attemptsDelta: 1,
          responseStatus: result.responseStatus,
          snippet: result.snippet,
          durationMs: result.durationMs,
          error: null,
        })
        this.s.webhooks.update(hook.id, {
          consecutive_failures: 0,
          total_deliveries: hook.total_deliveries + 1,
          last_delivery_at: new Date(nowMs).toISOString(),
        } as never)
      })
      return
    }

    // Retry eligibility: network errors, timeouts, 408/429 and any 5xx.
    const status = result.responseStatus
    const retryable =
      status === null ||
      status === 408 ||
      status === 429 ||
      status >= 500 ||
      result.timedOut
    const canRetry = retryable && attemptNo < this.cfg.webhookMaxAttempts
    const nextState = canRetry ? 'retrying' : 'failed'
    const attemptsAfter = attemptNo

    // Failure tracking: 4xx signals receiver misconfiguration → counts DOUBLE
    // toward auto-disable (EVENTS.md §5).
    const misconfigured = status !== null && status >= 400 && status < 500 && !retryable
    const failureWeight = misconfigured ? 2 : 1
    const consecutive = hook.consecutive_failures + failureWeight
    const shouldDisable = consecutive >= this.cfg.webhookDisableThreshold

    this.s.db.transaction(() => {
      this.s.webhookDeliveries.recordResult(d.id, {
        state: nextState,
        attemptsDelta: 1,
        nextAttemptAt: canRetry ? new Date(nowMs + this.backoffDelay(attemptsAfter)).toISOString() : null,
        responseStatus: result.responseStatus,
        snippet: result.snippet,
        durationMs: result.durationMs,
        error: canRetry ? `attempt ${attemptsAfter} failed: ${result.error ?? `HTTP ${status}`}` : result.error ?? `HTTP ${status ?? 'network error'}`,
      })
      this.s.webhooks.update(hook.id, {
        total_deliveries: hook.total_deliveries + 1,
        failed_deliveries: hook.failed_deliveries + 1,
        last_delivery_at: new Date(nowMs).toISOString(),
        consecutive_failures: consecutive,
        ...(shouldDisable
          ? {
              state: 'auto_disabled' as const,
              disabled_reason: `Auto-disabled after ${consecutive} consecutive failed deliveries`,
            }
          : {}),
      } as never)
    })

    if (shouldDisable && hook.state === 'enabled') {
      this.notifyOwnerDisabled(hook, consecutive)
    }
  }

  /** Owner notification on auto-disable (EVENTS.md §5 "owner notified"). */
  private notifyOwnerDisabled(hook: WebhookRow, failures: number): void {
    try {
      const owner = this.s.users.byId(
        this.s.projects.byId(hook.project_id)?.owner_id ?? -1,
      )
      if (!owner) return
      this.s.outbox.send(
        owner.email,
        `[LSGit] Webhook auto-disabled: ${hook.name || hook.url}`,
        `Your webhook ${hook.name ? `"${hook.name}" ` : ''}${hook.url} was disabled after ${failures} consecutive failed deliveries.\nRe-enable it in the project's Settings → Webhooks.`,
      )
    } catch {
      // Notification must never break the dispatch loop.
    }
  }

  // ── views ────────────────────────────────────────────────────────────────

  view(h: WebhookRow): WebhookView {
    return {
      id: h.id,
      name: h.name,
      description: h.description,
      url: h.url,
      ssl_verify: !!h.ssl_verify,
      state: h.state,
      disabled_reason: h.disabled_reason,
      events: this.s.webhookEvents.listForHook(h.id) as Array<WebhookEventType>,
      consecutive_failures: h.consecutive_failures,
      total_deliveries: h.total_deliveries,
      failed_deliveries: h.failed_deliveries,
      last_delivery_at: h.last_delivery_at,
      created_at: h.created_at,
      updated_at: h.updated_at,
    }
  }

  deliveryView(d: WebhookDeliveryRow, includeSnippet = false): DeliveryView {
    return {
      id: d.id,
      webhook_id: d.webhook_id,
      event_type: d.event_type,
      schema_version: d.schema_version,
      state: d.state,
      attempts: d.attempts,
      next_attempt_at: d.next_attempt_at,
      response_status: d.response_status,
      duration_ms: d.duration_ms,
      error: d.error,
      delivered_at: d.delivered_at,
      created_at: d.created_at,
      request_body: safeParse(d.request_body),
      ...(includeSnippet ? { response_snippet: d.response_snippet } : {}),
    }
  }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Event-bus subscriber (wired in makeServices): enqueues one delivery row per
 * enabled hook subscribed to the event's webhook kind. Runs inside the
 * EventsRepo post-commit callback — must NEVER throw or do network I/O.
 */
export function webhookEnqueueFromEvent(
  s: IdentityServices,
  cfg: AppConfig,
  row: { id: number; project_id: number | null; type: string; payload: Record<string, unknown> },
): void {
  try {
    if (row.project_id === null) return
    const classified = classifyDomainEvent(row.type)
    if (!classified) return // unknown kinds are ignored, not errored (EVENTS.md §5)
    const project = s.projects.byId(row.project_id)
    if (!project) return
    const hookIds = s.webhookEvents.hooksForProjectEvent(project.id, classified.kind)
    if (hookIds.length === 0) return

    const body = JSON.stringify(
      buildWebhookPayload(s, cfg, project, classified.kind, classified.eventType, row.payload),
    )
    for (const hookId of hookIds) {
      const hook = s.webhooks.byId(hookId)
      if (!hook || hook.state !== 'enabled') continue
      s.webhookDeliveries.create({
        id: randomUUID(),
        webhookId: hook.id,
        // UNIQUE(webhook_id, event_id): a replayed outbox row can never
        // double-enqueue — duplicate suppression is a database constraint.
        eventId: row.id,
        // The ledger records the webhook KIND (drives X-LSGit-Event); the
        // finer action stays inside the signed body (event_type field).
        eventType: classified.kind,
        schemaVersion: PAYLOAD_SCHEMA_VERSION,
        requestBody: body,
        nextAttemptAt: new Date().toISOString(),
      })
    }
  } catch {
    // Fan-out must never break the emitting operation.
  }
}
