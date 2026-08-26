import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WebhooksSection } from '../webhooks/WebhooksSettings'
import type { Webhook, WebhookDelivery } from '../webhooks/api'

/**
 * Webhooks settings UI: settings-list design language (section title → card →
 * dense table), one-time secret reveal after create/rotate, async test
 * deliveries, and the delivery-history/replay surface.
 */

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const hook: Webhook = {
  id: 7,
  name: 'CI bridge',
  description: '',
  url: 'https://ci.example/hook',
  ssl_verify: true,
  state: 'enabled',
  disabled_reason: null,
  events: ['push', 'issue'],
  consecutive_failures: 2,
  total_deliveries: 12,
  failed_deliveries: 3,
  last_delivery_at: '2026-08-25T10:00:00.000Z',
  created_at: '2026-08-20T09:00:00.000Z',
  updated_at: '2026-08-25T10:00:00.000Z',
}

const delivery: WebhookDelivery = {
  id: '11111111-2222-4333-8444-555555555555',
  webhook_id: 7,
  event_type: 'push',
  schema_version: 1,
  state: 'delivered',
  attempts: 1,
  next_attempt_at: null,
  response_status: 200,
  duration_ms: 42,
  error: null,
  delivered_at: '2026-08-25T10:00:01.000Z',
  created_at: '2026-08-25T10:00:00.000Z',
  request_body: { object_kind: 'push', schema_version: 1 },
}

beforeEach(() => vi.unstubAllGlobals())

describe('webhooks settings section', () => {
  it('renders the webhook list with status, failures and event badges', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ webhooks: [hook] })))

    render(<WebhooksSection projectId={1} notify={() => undefined} />)

    await waitFor(() => expect(screen.getByText('https://ci.example/hook')).toBeTruthy())
    expect(screen.getByText('CI bridge')).toBeTruthy()
    expect(screen.getByText('Enabled')).toBeTruthy()
    expect(screen.getByText(/2 consecutive failures/)).toBeTruthy()
    expect(screen.getByText('push')).toBeTruthy()
    expect(screen.getByText('issue')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New webhook' })).toBeTruthy()
  })

  it('shows the empty state when no hooks exist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ webhooks: [] })))
    render(<WebhooksSection projectId={1} notify={() => undefined} />)
    await waitFor(() => expect(screen.getByText('No webhooks')).toBeTruthy())
  })

  it('creates a webhook through the dialog and reveals the one-time secret', async () => {
    const notify = vi.fn()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ webhooks: [] })) // initial list
      .mockResolvedValueOnce(
        jsonResponse({ webhook: { ...hook, id: 8 }, secret: 'one-time-token-abc' }, 201),
      ) // create
      .mockResolvedValueOnce(jsonResponse({ webhooks: [{ ...hook, id: 8 }] })) // reload
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<WebhooksSection projectId={1} notify={notify} />)
    await user.click(await screen.findByRole('button', { name: 'New webhook' }))

    const urlInput = await screen.findByLabelText('URL')
    await user.type(urlInput, 'https://new.example/hook')

    await user.click(screen.getByRole('button', { name: 'Create webhook' }))

    // Secret is shown exactly once on its own step…
    await waitFor(() => expect(screen.getByText('one-time-token-abc')).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'Done — I saved the token' }))
    expect(screen.queryByText('one-time-token-abc')).toBeNull()

    // …and the POST carried the typed URL + default push subscription.
    const createCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/webhooks') && c[1]?.method === 'POST')!
    expect(createCall[0]).toContain('/api/v1/projects/1/webhooks')
    expect(JSON.parse(String(createCall[1]!.body)).url).toBe('https://new.example/hook')
  })

  it('queues a test delivery asynchronously instead of sending inline', async () => {
    const notify = vi.fn()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ webhooks: [hook] }))
      .mockResolvedValueOnce(jsonResponse({ delivery }, 202))
      .mockResolvedValueOnce(jsonResponse({ webhooks: [hook] }))
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<WebhooksSection projectId={1} notify={notify} />)
    await user.click(await screen.findByRole('button', { name: /Test https:\/\/ci\.example\/hook/ }))

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/webhooks/7/test'))).toBe(true),
    )
    expect(notify).toHaveBeenCalledWith('Test queued', 'A test delivery was enqueued.', 'success')
  })

  it('opens the delivery history, shows attempt details and replays a finished delivery', async () => {
    const notify = vi.fn()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ webhooks: [hook] }))
      .mockResolvedValueOnce(jsonResponse({ deliveries: [delivery] }))
      .mockResolvedValueOnce(jsonResponse({ delivery: { ...delivery, response_snippet: 'ok' } }))
      .mockResolvedValueOnce(jsonResponse({ delivery }, 202)) // replay queued
      .mockResolvedValueOnce(jsonResponse({ webhooks: [hook] })) // reload after replay
      .mockResolvedValueOnce(jsonResponse({ deliveries: [delivery] })) // history refresh
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<WebhooksSection projectId={1} notify={notify} />)
    await user.click(await screen.findByRole('button', { name: new RegExp(`Delivery history ${hook.url}`) }))

    await waitFor(() => expect(screen.getByText('Delivered')).toBeTruthy())
    await user.click(screen.getByText('Delivered'))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Replay delivery' })).toBeTruthy())
    expect(screen.getByText(/"object_kind": "push"/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Replay delivery' }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/deliveries/') && String(c[0]).endsWith('/replay'))).toBe(true),
    )
  })
})
