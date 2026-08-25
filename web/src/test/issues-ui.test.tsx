import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IssuesListPage } from '../issues/IssuesListPage'
import { IssueDetailPage } from '../issues/IssueDetailPage'
import { LabelsView } from '../issues/LabelsView'
import { MilestonesView } from '../issues/MilestonesView'
import { LabelChip } from '../issues/LabelChip'

/**
 * UI-level coverage for the issues domain: list rendering + filters +
 * pagination, task-list toggling, comments, reactions, and label/milestone
 * management. Server contracts are covered in server/test/issues*.test.ts.
 */

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

const ISSUE = {
  id: 1,
  iid: 1,
  project_id: 5,
  title: 'Login page crashes',
  description: '- [x] repro\n- [ ] fix it',
  state: 'opened',
  confidential: false,
  author: { id: 2, username: 'bob', name: 'Bob' },
  assignees: [],
  labels: [{ id: 3, title: 'bug', color: '#e5484d', description: '' }],
  milestone: { id: 9, project_id: 5, title: 'v1.0', description: '', due_date: null, state: 'active' },
  task_progress: { total: 2, completed: 1 },
  has_tasks: true,
  due_date: null,
  closed_at: null,
  closed_by: null,
  web_path: '/proj/alice/web/issues/1',
  created_at: new Date(Date.now() - 60_000).toISOString(),
  updated_at: new Date().toISOString(),
}

beforeEach(() => {
  vi.unstubAllGlobals()
  document.cookie = 'lsgit_csrf=t; Path=/'
})

const NAV = (to: string) => void to

// ---------------------------------------------------------------------------
// List: rendering · filters · pagination
// ---------------------------------------------------------------------------

describe('issues list page', () => {
  const LIST_PAYLOAD = {
    issues: [ISSUE],
    pagination: { page: 1, per_page: 20, total: 1, total_pages: 1, has_more: false },
  }

  function mockList(fetchMock: ReturnType<typeof vi.fn>) {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('/labels')) return Promise.resolve(jsonResponse([]))
      if (u.includes('/milestones')) return Promise.resolve(jsonResponse([]))
      return Promise.resolve(jsonResponse(LIST_PAYLOAD))
    })
    vi.stubGlobal('fetch', fetchMock)
  }

  it('renders issue rows with labels, milestone and task progress', async () => {
    const fetchMock = vi.fn()
    mockList(fetchMock)
    render(<IssuesListPage projectId={5} owner="alice" projectPath="web" navigate={NAV} />)

    await waitFor(() => expect(screen.getByText('Login page crashes')).toBeTruthy())
    expect(screen.getByText('bug')).toBeTruthy()
    expect(screen.getByText(/v1\.0/)).toBeTruthy()
    // Task progress "1/2" is exposed to assistive tech.
    expect(screen.getByLabelText('Tasks 1 of 2 complete')).toBeTruthy()
  })

  it('re-fetches with the chosen state filter when switching tabs', async () => {
    const fetchMock = vi.fn()
    mockList(fetchMock)
    const user = userEvent.setup()
    render(<IssuesListPage projectId={5} owner="alice" projectPath="web" navigate={NAV} />)
    await waitFor(() => expect(screen.getAllByText(/Open|Closed/).length).toBeGreaterThan(0))

    await user.click(screen.getByRole('button', { name: /Closed/ }))
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(calls.some((u) => u.includes('state=closed'))).toBe(true)
    })
  })

  it('requests page 2 through the pagination control', async () => {
    const payload = {
      issues: [ISSUE],
      pagination: { page: 1, per_page: 10, total: 12, total_pages: 2, has_more: true },
    }
    const fetchMock = vi.fn((_url: string) => Promise.resolve(jsonResponse(payload)))
    fetchMock.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes('/labels')) return Promise.resolve(jsonResponse([]))
      if (u.includes('/milestones')) return Promise.resolve(jsonResponse([]))
      return Promise.resolve(jsonResponse(payload))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<IssuesListPage projectId={5} owner="alice" projectPath="web" navigate={NAV} />)
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeTruthy())

    await user.click(screen.getByRole('button', { name: 'Page 2' }))
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(calls.some((u) => u.includes('page=2'))).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// Detail: task lists · comments · reactions
// ---------------------------------------------------------------------------

describe('issue detail page', () => {
  function mockDetail(fetchMock: ReturnType<typeof vi.fn>) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url)
      if ((init?.method ?? 'GET') === 'GET' && u.endsWith('/award_emoji')) return Promise.resolve(jsonResponse([]))
      if (u.includes('/notes')) return Promise.resolve(jsonResponse({ notes: [] }))
      if (u.includes('/labels')) return Promise.resolve(jsonResponse([]))
      if (u.includes('/milestones')) return Promise.resolve(jsonResponse([]))
      return Promise.resolve(jsonResponse(ISSUE))
    })
    vi.stubGlobal('fetch', fetchMock)
  }

  it('renders markdown checkboxes as live toggles that call the task endpoint', async () => {
    const fetchMock = vi.fn()
    mockDetail(fetchMock)
    const user = userEvent.setup()
    render(
      <IssueDetailPage
        projectId={5}
        owner="alice"
        projectPath="web"
        iid={1}
        canMaintain={false}
        navigate={NAV}
      />,
    )
    await waitFor(() => expect(screen.getByText('Login page crashes')).toBeTruthy())

    const fixBox = screen.getByRole('checkbox', { name: "Mark 'fix it' complete" }) as HTMLInputElement
    expect((fixBox.checked)).toBe(false)
    await user.click(fixBox)

    await waitFor(() => {
      const toggles = fetchMock.mock.calls.filter(
        (c) => String(c[0]).endsWith('/tasks/toggle') && (c[1] as RequestInit).method === 'POST',
      )
      expect(toggles.length).toBe(1)
      expect(JSON.parse(String((toggles[0]![1] as RequestInit).body))).toEqual({ index: 1 })
    })
  })

  it('submits a comment through the composer and clears the field', async () => {
    const fetchMock = vi.fn()
    mockDetail(fetchMock)
    const user = userEvent.setup()
    render(
      <IssueDetailPage
        projectId={5}
        owner="alice"
        projectPath="web"
        iid={1}
        canMaintain={false}
        navigate={NAV}
      />,
    )
    await waitFor(() => expect(screen.getByLabelText(/Add a comment/i)).toBeTruthy())

    await user.type(screen.getByLabelText(/Add a comment/i), 'Confirmed on staging @alice')
    await user.click(screen.getByRole('button', { name: 'Comment' }))

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        (c) => String(c[0]).includes('/notes') && (c[1] as RequestInit).method === 'POST',
      )
      expect(posts.length).toBe(1)
      expect(JSON.parse(String((posts[0]![1] as RequestInit).body))).toEqual({
        body: 'Confirmed on staging @alice',
      })
    })
    await waitFor(() => expect((screen.getByLabelText(/Add a comment/i) as HTMLTextAreaElement).value).toBe(''))
  })

  it('toggles an issue reaction pill optimistically', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') {
        return Promise.resolve(jsonResponse({ action: 'awarded', summary: [{ name: 'tada', count: 1, me: true }] }))
      }
      const u = String(_url)
      if (u.endsWith('/award_emoji')) return Promise.resolve(jsonResponse([]))
      if (u.includes('/notes')) return Promise.resolve(jsonResponse({ notes: [] }))
      if (u.includes('/labels')) return Promise.resolve(jsonResponse([]))
      if (u.includes('/milestones')) return Promise.resolve(jsonResponse([]))
      return Promise.resolve(jsonResponse(ISSUE))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(
      <IssueDetailPage
        projectId={5}
        owner="alice"
        projectPath="web"
        iid={1}
        canMaintain={false}
        navigate={NAV}
      />,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: /^React tada$/ })).toBeTruthy())
    await user.click(screen.getByRole('button', { name: /^React tada$/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /React tada \(1\)/ }).getAttribute('aria-pressed')).toBe('true'),
    )
  })
})

// ---------------------------------------------------------------------------
// Label chip color contract
// ---------------------------------------------------------------------------

describe('label chips', () => {
  it('renders neon colors as constrained tints — never the raw hue at full strength', () => {
    render(<LabelChip label={{ id: 1, title: 'neon', color: '#00ff00', description: '' }} />)
    const chip = screen.getByText('neon')
    const style = chip.getAttribute('style') ?? ''
    expect(style).toContain('rgba(0, 255, 0, 0.16)') // low-alpha tint background
    expect(style).toContain('var(--ls-text)') // text stays a token
    expect(style).not.toMatch(/color:\s*#00ff00/) // raw hue never becomes text/fill
  })

  it('falls back to neutral tokens for invalid colors', () => {
    render(<LabelChip label={{ id: 1, title: 'odd', color: '#zzz', description: '' }} />)
    const chip = screen.getByText('odd')
    expect(chip.getAttribute('style')).toContain('var(--ls-surface-2)')
  })
})

// ---------------------------------------------------------------------------
// Labels & milestones managers
// ---------------------------------------------------------------------------

describe('labels manager', () => {
  it('creates a label with the entered color', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const u = String(url)
      if ((init?.method ?? 'GET') === 'POST' && u.endsWith('/labels')) {
        const body = JSON.parse(String(init?.body)) as Record<string, string>
        return Promise.resolve(jsonResponse({ id: 99, project_id: 5, scope: 'project', ...body }, 201))
      }
      if (u.includes('/labels')) {
        return Promise.resolve(jsonResponse([
          { id: 1, project_id: 5, title: 'bug', description: '', color: '#e5484d', scope: 'project' },
        ]))
      }
      return Promise.resolve(jsonResponse([]))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<LabelsView projectId={5} />)
    await waitFor(() => expect(screen.getByText('bug')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: /New label/ }))
    // Direct change event: the dialog's focus trap can steal focus mid-type.
    fireEvent.change(screen.getByLabelText(/^Name$/), { target: { value: 'performance' } })
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        (c) => String(c[0]).endsWith('/labels') && (c[1] as RequestInit).method === 'POST',
      )
      expect(posts.length).toBe(1)
      const body = JSON.parse(String((posts[0]![1] as RequestInit).body)) as Record<string, unknown>
      expect(body.title).toBe('performance')
      expect(typeof body.color).toBe('string')
    })
  })
})

describe('milestones manager', () => {
  it('lists milestones with completion percentage', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(jsonResponse([
        {
          id: 7, project_id: 5, title: 'v1.0', description: 'First release', due_date: null,
          state: 'active', merge_requests_count: 0,
          total_issues: 4, opened_issues: 3, closed_issues: 1, completion_percent: 25,
        },
      ])),
    ))
    render(<MilestonesView projectId={5} />)
    await waitFor(() => expect(screen.getByText('v1.0')).toBeTruthy())
    expect(screen.getByText('25% complete')).toBeTruthy()
    expect(screen.getByLabelText('v1.0 completion').getAttribute('aria-valuenow')).toBe('25')
  })

  it('closes a milestone via the lifecycle button', async () => {
    const ms = {
      id: 7, project_id: 5, title: 'v1.0', description: '', due_date: null,
      state: 'active' as const, merge_requests_count: 0,
      total_issues: 0, opened_issues: 0, closed_issues: 0, completion_percent: 0,
    }
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Promise.resolve(jsonResponse({ ...ms, state: body.state_event === 'close' ? 'closed' : 'active' }))
      }
      return Promise.resolve(jsonResponse([ms]))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<MilestonesView projectId={5} />)
    await waitFor(() => expect(screen.getByText('v1.0')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: 'Close v1.0' }))
    await waitFor(() => {
      const patches = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit).method === 'PATCH')
      expect(patches.length).toBe(1)
      expect(JSON.parse(String((patches[0]![1] as RequestInit).body))).toEqual({ state_event: 'close' })
    })
  })
})
