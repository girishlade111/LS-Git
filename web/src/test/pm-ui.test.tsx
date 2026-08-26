import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BoardsPage } from '../pm/BoardsPage'

/**
 * PM board UI: table renders items with typed field values; board view
 * groups by status column; status changes PATCH via inline selects.
 */

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

const FIELDS = [
  { id: 1, key: 'status', label: 'Status', type: 'status', options: ['Backlog', 'Todo', 'Done'], position: 0 },
  { id: 2, key: 'priority', label: 'Priority', type: 'single_select', options: ['High', 'Low'], position: 1 },
]

const ITEM = {
  id: 10,
  kind: 'issue' as const,
  issue_iid: 3,
  pr_iid: null,
  title: 'Implement export',
  field_values: { status: 'Todo', priority: 'High' } as Record<string, string | null>,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

beforeEach(() => {
  vi.unstubAllGlobals()
  document.cookie = 'lsgit_csrf=t; Path=/'
})

function makePmMock(handlers?: { onPatchItem?: (body: Record<string, unknown>) => void }) {
  return (url: string, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (/pm\/boards\/\d+$/.test(u)) {
      return Promise.resolve(jsonResponse({ board: { id: 1, name: 'Sprint board', description: '' }, fields: FIELDS, workflows: [] }))
    }
    if (u.includes('/fields')) return Promise.resolve(jsonResponse(FIELDS))
    if (u.includes('/items/10') && method === 'PATCH') {
      handlers?.onPatchItem?.(JSON.parse(String(init!.body)) as Record<string, unknown>)
      return Promise.resolve(jsonResponse({ ok: true }))
    }
    if (u.includes('/items')) return Promise.resolve(jsonResponse({ items: [ITEM], total: 1 }))
    if (u.includes('/views')) return Promise.resolve(jsonResponse({ views: [] }))
    if (u.includes('/insights')) return Promise.resolve(jsonResponse({ total_items: 1, by_kind: {}, status_distribution: [], progress: {}, throughput_last_30_days: 0 }))
    return Promise.resolve(jsonResponse({ boards: [{ id: 1, name: 'Sprint board', description: '' }] }))
  }
}

describe('PM boards UI', () => {
  it('renders the TABLE view with typed field columns and inline selects', async () => {
    vi.stubGlobal('fetch', vi.fn(makePmMock()))
    render(<BoardsPage projectId={5} isMaintainer />)
    await waitFor(() => expect(screen.getByText(/Implement export/)).toBeTruthy())

    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeTruthy()
    const select = screen.getByLabelText(/Status for Implement export/) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('Todo'))
  })

  it('BOARD view groups items under status columns', async () => {
    vi.stubGlobal('fetch', vi.fn(makePmMock()))
    const user = userEvent.setup()
    render(<BoardsPage projectId={5} isMaintainer={false} />)
    await waitFor(() => expect(screen.getByText(/Implement export/)).toBeTruthy())

    await user.click(screen.getByRole('radio', { name: 'Board' }))
    await waitFor(() => {
      expect(screen.getByLabelText('Todo column').textContent).toContain('Implement export')
    })
    expect(screen.getByLabelText('Backlog column').textContent).toContain('0')
  })

  it('changing an inline status select PATCHes the item with the new value', async () => {
    let patchBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'PATCH') {
        patchBody = JSON.parse(String(init!.body)) as Record<string, unknown>
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      return makePmMock({
        onPatchItem: (b) => { patchBody = b },
      })(url, init)
    }))
    const user = userEvent.setup()
    render(<BoardsPage projectId={5} isMaintainer />)
    await waitFor(() => expect(screen.getByText(/Implement export/)).toBeTruthy())

    const select = screen.getByLabelText(/Status for Implement export/) as HTMLSelectElement
    await user.selectOptions(select, 'Done')
    await waitFor(() => expect(patchBody).toBeTruthy())
    expect(patchBody!.field_key).toBe('status')
    expect(patchBody!.value).toBe('Done')
  })
})
