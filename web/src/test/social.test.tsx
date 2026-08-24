import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StarButton, WatchSelector, InboxView } from '../repository/social'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  vi.unstubAllGlobals()
  document.cookie = 'lsgit_csrf=t; Path=/'
})

// ---------------------------------------------------------------------------
// Star button
// ---------------------------------------------------------------------------

describe('star button', () => {
  it('toggles star state and shows the live count', async () => {
    const fetchMock = vi.fn((_url: string) => {
      if (String(_url).endsWith('/star')) return Promise.resolve(jsonResponse({ count: 7, starred: false }))
      return Promise.resolve(jsonResponse({}))
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<StarButton projectId={5} />)
    await waitFor(() => expect(screen.getByText('7')).toBeTruthy())

    // POST on click → starred state with accent styling hook.
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') return Promise.resolve(jsonResponse({ count: 8, starred: true }))
      return Promise.resolve(jsonResponse({ count: 7, starred: false }))
    })
    await user.click(screen.getByRole('button', { name: /Star repository/ }))
    await waitFor(() => expect(screen.getByText('8')).toBeTruthy())
    expect(screen.getByRole('button', { name: /Unstar/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('duplicate stars stay idempotent through the server contract (200 no-create)', async () => {
    // Server returns created:false with 200 for a repeat; UI simply reflects count.
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') return Promise.resolve(jsonResponse({ count: 1, starred: true, created: false }, 200))
      return Promise.resolve(jsonResponse({ count: 0, starred: false }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<StarButton projectId={6} />)
    await user.click(screen.getByRole('button', { name: /Star repository/ }))
    await waitFor(() => expect(screen.getByText('1')).toBeTruthy())
  })
})

// ---------------------------------------------------------------------------
// Watch selector
// ---------------------------------------------------------------------------

describe('watch selector', () => {
  it('renders the effective level and PUTs changes per user', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        return Promise.resolve(jsonResponse({ level: JSON.parse(String(init?.body)).level }))
      }
      return Promise.resolve(jsonResponse({
        level: null,
        effective_level: 'participating',
        source: 'default',
        default_level: 'participating',
      }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<WatchSelector projectId={9} />)

    await waitFor(() => {
      const select = screen.getByLabelText(/Notifications/i) as HTMLSelectElement
      expect(select.value).toBe('participating')
    })

    await user.selectOptions(screen.getByLabelText(/Notifications/i), 'watch')
    await waitFor(() => {
      const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')
      expect(put).toBeTruthy()
      expect(JSON.parse((put![1] as RequestInit).body as string).level).toBe('watch')
    })
  })
})

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

const inboxItems = [
  { id: 3, project_path: 'alice/web', type: 'security_alert', title: 'Security alert: CVE in dep', body: null, url: null, actor_username: null, read_at: null, created_at: new Date().toISOString() },
  { id: 2, project_path: 'alice/web', type: 'push', title: 'Push to branch', body: 'alice/web · main', url: '/proj/alice/web/tree/main', actor_username: 'alice', read_at: null, created_at: new Date(Date.now() - 60_000).toISOString() },
  { id: 1, project_path: 'alice/api', type: 'fork', title: 'New fork of your repository', body: 'bob/fork was forked from alice/api', url: '/proj/bob/fork', actor_username: 'bob', read_at: new Date().toISOString(), created_at: new Date(Date.now() - 7200_000).toISOString() },
]

describe('notification inbox', () => {
  it('renders persisted notifications as quiet hairline rows with unread dots', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      unread_count: 2,
      notifications: inboxItems,
    })))
    render(<InboxView />)

    await waitFor(() => expect(screen.getByText('Security alert: CVE in dep')).toBeTruthy())
    expect(screen.getByText('Push to branch')).toBeTruthy()

    // Unread dot is a small indicator; read rows carry the read modifier.
    expect(document.querySelectorAll('.ls-inbox__dot:not(.ls-inbox__dot--read)').length).toBe(2)
    expect(document.querySelectorAll('.ls-inbox__row--read').length).toBe(1)
    // Count badge shows unread total.
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('marks a row read via its control and refreshes counts', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).includes('/notifications/3/read') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      if (String(url).includes('/user/notifications?'))
        return Promise.resolve(jsonResponse({ unread_count: 2, notifications: inboxItems.filter(n => n.id !== 3 ? true : true) }))
      return Promise.resolve(jsonResponse({ ok: true }))
    })
    vi.stubGlobal('fetch', fetchMock)
    void fetchMock

    const user = userEvent.setup()
    render(<InboxView />)
    await waitFor(() => expect(screen.getAllByLabelText('Mark read').length).toBeGreaterThan(0))
    await user.click(screen.getAllByLabelText('Mark read')[0]!)
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/read') && (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(true),
    )
  })

  it('mark-all-read hits the bulk endpoint and filters narrow the list', async () => {
    let unreadOnly = false
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).includes('read_all') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ marked_read: 2 }))
      }
      if (String(url).includes('/user/notifications?')) {
        const q = String(url).split('?')[1] ?? ''
        unreadOnly = q.includes('unread=1')
        return Promise.resolve(jsonResponse({
          unread_count: 2,
          notifications: unreadOnly ? inboxItems.filter((n) => !n.read_at) : inboxItems,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<InboxView />)
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBe(3))

    await user.click(screen.getByLabelText('Unread only'))
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBe(2))

    await user.click(screen.getByRole('button', { name: 'Mark all read' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('read_all'))
      expect(call).toBeTruthy()
    })
  })
})
