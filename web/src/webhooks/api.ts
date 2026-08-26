/**
 * Webhook API client (server/src/http/routes/webhooks.ts).
 * GitLab project-hooks parity on LSGit naming; secrets are returned exactly
 * once by create/rotate and never again.
 */

export const WEBHOOK_EVENTS = [
  'push', 'repository', 'fork', 'star', 'issue',
  'pull_request', 'discussion', 'release', 'deployment', 'workflow',
] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
  push: 'Push events',
  repository: 'Repository events',
  fork: 'Fork events',
  star: 'Star events',
  issue: 'Issue events',
  pull_request: 'Pull request events',
  discussion: 'Discussion events',
  release: 'Release events',
  deployment: 'Deployment events',
  workflow: 'Workflow events',
}

export interface Webhook {
  id: number
  name: string
  description: string
  url: string
  ssl_verify: boolean
  state: 'enabled' | 'disabled' | 'auto_disabled'
  disabled_reason: string | null
  events: WebhookEvent[]
  consecutive_failures: number
  total_deliveries: number
  failed_deliveries: number
  last_delivery_at: string | null
  created_at: string
  updated_at: string
}

export interface WebhookDelivery {
  id: string
  webhook_id: number
  event_type: string
  schema_version: number
  state: 'pending' | 'retrying' | 'delivered' | 'failed'
  attempts: number
  next_attempt_at: string | null
  response_status: number | null
  duration_ms: number | null
  error: string | null
  delivered_at: string | null
  created_at: string
  request_body: Record<string, unknown>
}

async function request<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (!['GET', 'HEAD'].includes(method)) {
    for (const part of document.cookie.split(';')) {
      const eq = part.indexOf('=')
      if (part.slice(0, eq).trim() === 'lsgit_csrf') {
        headers['x-csrf-token'] = decodeURIComponent(part.slice(eq + 1).trim())
        break
      }
    }
  }
  const res = await fetch(url, { method, headers, credentials: 'same-origin', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new Error(String((data as { message?: string }).message ?? 'Request failed'))
  return data as T
}

function base(projectId: number): string {
  return `/api/v1/projects/${projectId}/webhooks`
}

const enc = encodeURIComponent

export const webhooksApi = {
  list: (projectId: number) => request<{ webhooks: Webhook[] }>(base(projectId)),
  get: (projectId: number, hookId: number) =>
    request<{ webhook: Webhook & { recent_deliveries: WebhookDelivery[] } }>(
      `${base(projectId)}/${hookId}`,
    ),
  create: (
    projectId: number,
    input: { name?: string; description?: string; url: string; events: WebhookEvent[]; ssl_verify?: boolean },
  ) => request<{ webhook: Webhook; secret: string }>(base(projectId), 'POST', input),
  update: (projectId: number, hookId: number, patch: Record<string, unknown>) =>
    request<{ webhook: Webhook }>(`${base(projectId)}/${hookId}`, 'PATCH', patch),
  remove: (projectId: number, hookId: number) => request<{ ok: true }>(`${base(projectId)}/${hookId}`, 'DELETE'),
  rotateSecret: (projectId: number, hookId: number) =>
    request<{ secret: string }>(`${base(projectId)}/${hookId}/secret/rotate`, 'POST'),
  /** Queued asynchronously server-side — never sent inside this request. */
  test: (projectId: number, hookId: number) =>
    request<{ delivery: WebhookDelivery }>(`${base(projectId)}/${hookId}/test`, 'POST'),
  deliveries: (projectId: number, hookId: number) =>
    request<{ deliveries: WebhookDelivery[] }>(`${base(projectId)}/${hookId}/deliveries`),
  delivery: (projectId: number, hookId: number, id: string) =>
    request<{ delivery: WebhookDelivery & { response_snippet?: string | null } }>(
      `${base(projectId)}/${hookId}/deliveries/${enc(id)}`,
    ),
  replay: (projectId: number, hookId: number, id: string) =>
    request<{ delivery: WebhookDelivery }>(`${base(projectId)}/${hookId}/deliveries/${enc(id)}/replay`, 'POST'),
}
