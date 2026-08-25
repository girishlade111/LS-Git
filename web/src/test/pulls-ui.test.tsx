import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PullsListPage } from '../pulls/PullsListPage'
import { PullDetailPage } from '../pulls/PullDetailPage'

/**
 * UI coverage for pull requests: dense list + state tabs, the compact merge
 * box (blockers disable merging — no giant action panels), strategy payload,
 * approve action, comments.
 */

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

const PR = {
  id: 1,
  iid: 7,
  project_id: 5,
  title: 'Add export flow',
  description: 'Implements the CSV export. Closes #3.',
  state: 'opened' as const,
  draft: false,
  author: { id: 1, username: 'alice', name: null },
  source_branch: 'feature/export',
  target_branch: 'main',
  assignees: [],
  reviewers: [{ id: 2, username: 'bob', name: null, review_state: 'approved' as const }],
  labels: [],
  milestone: null,
  linked_issue_iids: [3],
  approvals: { count: 1, required: 0, user_ids: [2] },
  merge_status: 'can_be_merged' as const,
  merge_status_reason: null,
  merge_commit_sha: null,
  squash_commit_sha: null,
  closed_at: null,
  closed_by: null,
  merged_at: null,
  merged_by: null,
  web_path: '/proj/alice/web/pulls/7',
  created_at: new Date(Date.now() - 60_000).toISOString(),
  updated_at: new Date().toISOString(),
}

beforeEach(() => {
  vi.unstubAllGlobals()
  document.cookie = 'lsgit_csrf=t; Path=/'
})

const NAV = (to: string) => void to

describe('pull request list', () => {
  it('renders dense rows with branch direction and switches state tabs', async () => {
    const fetchMock = vi.fn((url: string) => {
      const u = String(url)
      if (u.includes('/pull_requests')) return Promise.resolve(jsonResponse({ pull_requests: [PR], pagination: { page: 1, per_page: 20, total: 1, total_pages: 1, has_more: false } }))
      return Promise.resolve(jsonResponse({}))
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<PullsListPage projectId={5} owner="alice" projectPath="web" navigate={NAV} refs={[{ name: 'main' }, { name: 'feature/x' }]} />)

    await waitFor(() => expect(screen.getByText('Add export flow')).toBeTruthy())
    expect(screen.getByText(/feature\/export → main/)).toBeTruthy()

    await user.click(screen.getByRole('tab', { name: 'Merged' }))
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(calls.some((u) => u.includes('state=merged'))).toBe(true)
    })
  })

  it('opens the creation dialog with branch pickers and posts the create payload', async () => {
    let created: Record<string, unknown> | undefined
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        created = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Promise.resolve(jsonResponse({ ...PR, web_path: '/proj/alice/web/pulls/8', iid: 8 }, 201))
      }
      return Promise.resolve(jsonResponse({ pull_requests: [], pagination: { page: 1, per_page: 20, total: 0, total_pages: 1, has_more: false } }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<PullsListPage projectId={5} owner="alice" projectPath="web" navigate={NAV} refs={[{ name: 'main' }, { name: 'feature/x' }]} />)
    await user.click(await screen.findByRole('button', { name: /New pull request/ }))

    await user.selectOptions(screen.getByRole('combobox', { name: 'Source branch' }), 'feature/x')
    await fireEvent.change(screen.getByLabelText(/^Title$/), { target: { value: 'New work' } })
    await user.click(screen.getByRole('button', { name: /Open pull request/ }))

    await waitFor(() => expect(created).toBeTruthy())
    expect(created!.source_branch).toBe('feature/x')
    expect(created!.target_branch).toBe('main')
  })
})

describe('pull request detail — merge box contract', () => {
  function mockDetail(opts: { blockers: Array<{ code: string; message: string }>; canMerge: boolean }) {
    return vi.fn((url: string, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      if (u.includes('/mergeability')) {
        return Promise.resolve(jsonResponse({
          state: 'opened', draft: false, merge_status: opts.canMerge ? 'can_be_merged' : 'cannot_be_merged',
          merge_status_reason: null,
          approvals: { count: 0, required: 0, user_ids: [] },
          can_merge: opts.canMerge,
          blockers: opts.blockers,
        }))
      }
      if (u.endsWith('/notes')) return Promise.resolve(jsonResponse({ notes: [] }))
      if (u.includes('/commits')) return Promise.resolve(jsonResponse({ commits: [], count: 0 }))
      if (u.includes('/changes')) return Promise.resolve(jsonResponse({ files: [] }))
      if (method === 'POST' && u.endsWith('/merge')) {
        return Promise.resolve(jsonResponse({ ...PR, state: 'merged' }))
      }
      if (method === 'POST' && u.endsWith('/approve')) {
        return Promise.resolve(jsonResponse({ ...PR, approvals: { count: 1, required: 0, user_ids: [9] } }))
      }
      return Promise.resolve(jsonResponse(PR))
    })
  }

  it('lists BLOCKERS and keeps Merge disabled while any gate fails', async () => {
    vi.stubGlobal('fetch', mockDetail({
      canMerge: false,
      blockers: [
        { code: 'conflicts', message: 'Merge conflicts block this merge' },
        { code: 'required_approvals_missing', message: '1 more approval required' },
      ],
    }))
    render(
      <PullDetailPage projectId={5} owner="alice" projectPath="web" iid={7} canMaintain={false} />,
    )

    await waitFor(() => expect(screen.getByText('Add export flow')).toBeTruthy())
    expect(screen.getByText('Merge conflicts block this merge')).toBeTruthy()
    expect(screen.getByText('1 more approval required')).toBeTruthy()
    expect((screen.getByRole('button', { name: /^Merge$/ }) as HTMLButtonElement).disabled).toBe(true).toBe(true)
  })

  it('enables Merge when clear and submits the chosen STRATEGY', async () => {
    const fetchMock = mockDetail({ canMerge: true, blockers: [] })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(
      <PullDetailPage projectId={5} owner="alice" projectPath="web" iid={7} canMaintain={false} />,
    )

    const mergeBtn = await screen.findByRole('button', { name: /^Merge$/ })
    await waitFor(() => expect(mergeBtn.disabled).toBe(false))

    await user.selectOptions(screen.getByRole('combobox', { name: 'Merge strategy' }), 'squash')
    await user.click(mergeBtn)

    await waitFor(() => {
      const merges = fetchMock.mock.calls.filter(
        (c) => String(c[0]).includes('/merge') && !(String(c[0]).includes('mergeability')) && (c[1] as RequestInit).method === 'POST',
      )
      expect(merges.length).toBe(1)
      expect(JSON.parse(String((merges[0]![1] as RequestInit).body))).toEqual({
        method: 'squash',
        should_remove_source_branch: false,
      })
    })
  })

  it('renders linked issues with close-on-merge hint and posts comments', async () => {
    const fetchMock = mockDetail({ canMerge: true, blockers: [] })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(
      <PullDetailPage projectId={5} owner="alice" projectPath="web" iid={7} canMaintain={false} />,
    )
    await waitFor(() => expect(screen.getByText('#3')).toBeTruthy())

    await user.type(await screen.findByLabelText(/Add a comment/i), 'LGTM once CI passes.')
    await user.click(screen.getByRole('button', { name: 'Comment' }))
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        (c) => String(c[0]).endsWith('/notes') && (c[1] as RequestInit).method === 'POST',
      )
      expect(posts.length).toBe(1)
      expect(JSON.parse(String((posts[0]![1] as RequestInit).body))).toEqual({ body: 'LGTM once CI passes.' })
    })
  })
})

