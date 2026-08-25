import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { within } from '@testing-library/dom'
import { PullDetailPage } from '../pulls/PullDetailPage'
import { ReviewChanges, parsePatchRows } from '../pulls/ReviewChanges'

/**
 * Code-review UI: inline thread creation (single + multi-line via range),
 * suggestion batch apply payload, resolve/reopen actions, and the subtle
 * status colors contract.
 */

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

const PR = {
  id: 1, iid: 7, project_id: 5,
  title: 'Review target', description: '', state: 'opened' as const, draft: false,
  author: { id: 1, username: 'alice', name: null },
  source_branch: 'feature/x', target_branch: 'main',
  assignees: [], reviewers: [], labels: [], milestone: null,
  linked_issue_iids: [],
  approvals: { count: 0, required: 0, user_ids: [] },
  merge_status: 'can_be_merged' as const,
  merge_status_reason: null,
  merge_commit_sha: null, squash_commit_sha: null,
  closed_at: null, closed_by: null, merged_at: null, merged_by: null,
  web_path: '/proj/alice/web/pulls/7',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

const PATCH = [
  'diff --git a/src.txt b/src.txt',
  '--- a/src.txt',
  '+++ b/src.txt',
  '@@ -1,3 +1,3 @@ alpha',
  ' alpha',
  '-beta',
  '+BETA-NEW',
  ' gamma',
].join('\n')

const THREAD = {
  id: 11,
  path: 'src.txt',
  side: 'new' as const,
  line_start: 2,
  line_end: 2,
  resolved: false,
  outdated: false,
  outdated_reason: null,
  head_sha: 'a'.repeat(40),
  created_at: new Date().toISOString(),
  code_owner_users: ['bob'],
  notes: [{
    id: 21,
    author: { id: 2, username: 'bob', name: null },
    body: 'Consider renaming.',
    suggestion: { status: 'pending' as const, applied_commit_sha: null },
    created_at: new Date().toISOString(),
  }],
}

beforeEach(() => {
  vi.unstubAllGlobals()
  document.cookie = 'lsgit_csrf=t; Path=/'
})

describe('patch parsing', () => {
  it('maps unified hunks to rows with correct NEW-side line numbers and signs', () => {
    const rows = parsePatchRows(PATCH)
    expect(rows.map((r) => [r.newLine, r.sign, r.text])).toEqual([
      [1, ' ', 'alpha'],
      [null, '-', 'beta'],
      [2, '+', 'BETA-NEW'],
      [3, ' ', 'gamma'],
    ])
  })
})

// ── inline threads ────────────────────────────────────────────────────────────

function mockSurface(opts: { threads?: typeof THREAD[] } = {}) {
  return vi.fn((url: string, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.includes('/mergeability')) {
      return Promise.resolve(jsonResponse({
        state: 'opened', draft: false, merge_status: 'can_be_merged', merge_status_reason: null,
        approvals: { count: 0, required: 0, user_ids: [] },
        can_merge: true, blockers: [],
      }))
    }
    if (u.includes('/threads')) {
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Promise.resolve(jsonResponse({
          thread: {
            ...THREAD, id: 99, path: body.path, line_start: body.line_start, line_end: body.line_end ?? body.line_start,
            notes: [{ id: 50, author: { id: 9, username: 'carol', name: null }, body: body.body, suggestion: null, created_at: new Date().toISOString() }],
          },
        }, 201))
      }
      return Promise.resolve(jsonResponse({ threads: opts.threads ?? [], head_sha: 'a'.repeat(40) }))
    }
    if (u.endsWith('/notes')) return Promise.resolve(jsonResponse({ notes: [] }))
    if (u.includes('/draft_comments')) return Promise.resolve(jsonResponse({ drafts: [] }))
    if (u.includes('/reviews')) return Promise.resolve(jsonResponse({ reviews: [] }))
    if (u.includes('/commits')) return Promise.resolve(jsonResponse({ commits: [], count: 0 }))
    if (u.includes('/changes')) return Promise.resolve(jsonResponse({ files: [{ path: 'src.txt', kind: 'modified', patch: PATCH }] }))
    return Promise.resolve(jsonResponse(PR))
  })
}

describe('inline review surface', () => {
  it('clicks a changed line to open the composer and posts a SINGLE-LINE thread', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      if (u.includes('/threads') && method === 'POST') {
        const body = JSON.parse(String(init!.body)) as Record<string, unknown>
        return Promise.resolve(jsonResponse({
          thread: {
            ...THREAD, id: 30, path: body.path as string,
            line_start: body.line_start as number, line_end: body.line_end as number,
            notes: [{ id: 60, author: { id: 9, username: 'carol', name: null }, body: body.body as string, suggestion: null, created_at: new Date().toISOString() }],
          },
        }, 201))
      }
      return mockSurface()(url, init)
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(
      <PullDetailPage projectId={5} owner="alice" projectPath="web" iid={7} canMaintain={false} />,
    )
    await waitFor(() => expect(screen.getByText(/BETA-NEW/)).toBeTruthy())

    // Click the BETA-NEW line (new-side line 2).
    await user.click(screen.getByText(/BETA-NEW/).closest('tr')!)
    const inlineForm = screen.getByPlaceholderText(/Leave an inline comment/).closest('form')!
    await user.type(await screen.findByPlaceholderText(/Leave an inline comment/), 'Rename this variable.')
    await user.click(within(inlineForm).getByRole('button', { name: /^Comment$/ }))

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        (c) => String(c[0]).includes('/threads') && (c[1] as RequestInit).method === 'POST',
      )
      expect(posts.length).toBe(1)
      const body = JSON.parse(String((posts[0]![1] as RequestInit).body)) as Record<string, unknown>
      expect(body.path).toBe('src.txt')
      expect(body.line_start).toBe(2)
      expect(body.line_end).toBe(2) // single-line: start === end
      expect(body.body).toBe('Rename this variable.')
    })
  })

  it('renders existing threads with RESOLVE action and pending SUGGESTION state', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const u = String(url)
      if (u.includes('/mergeability')) {
        return Promise.resolve(jsonResponse({
          state: 'opened', draft: false, merge_status: 'can_be_merged', merge_status_reason: null,
          approvals: { count: 0, required: 0, user_ids: [] }, can_merge: true, blockers: [],
        }))
      }
      if (u.includes('/notes')) return Promise.resolve(jsonResponse({ notes: [] }))
    if (u.includes('/draft_comments')) return Promise.resolve(jsonResponse({ drafts: [] }))
      if (u.includes('/reviews')) return Promise.resolve(jsonResponse({ reviews: [] }))
      if (u.includes('/commits')) return Promise.resolve(jsonResponse({ commits: [], count: 0 }))
      if (u.includes('/changes')) return Promise.resolve(jsonResponse({ files: [{ path: 'src.txt', kind: 'modified', patch: PATCH }] }))
      if (u.includes('/threads')) return Promise.resolve(jsonResponse({ threads: [THREAD], head_sha: 'a'.repeat(40) }))
      return Promise.resolve(jsonResponse(PR))
    }))

    render(<PullDetailPage projectId={5} owner="alice" projectPath="web" iid={7} canMaintain={false} />)
    await waitFor(() => expect(screen.getByText('Consider renaming.')).toBeTruthy())
    expect(screen.getByText('Suggestion · pending')).toBeTruthy()
    expect(screen.getByText(/owner: bob/)).toBeTruthy()

    const resolveBtn = screen.getByRole('button', { name: 'Resolve' })
    await userEvent.setup().click(resolveBtn)
    await waitFor(() => {
      const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).includes('/resolve'))
      expect(calls.length).toBeGreaterThan(0)
    })
  })
})

// ── suggestion batch apply ─────────────────────────────────────────────────────

describe('suggestion batch apply', () => {
  it('submits selected note ids through the batch endpoint', async () => {
    let batchPayload: Record<string, unknown> | undefined
    const base = mockSurface({ threads: [THREAD] })
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/suggestions/apply') && (init?.method ?? 'GET') === 'POST') {
        batchPayload = JSON.parse(String(init!.body)) as Record<string, unknown>
        return Promise.resolve(jsonResponse({ commit_sha: 'f'.repeat(40), applied: 1 }))
      }
      void u
      return base(url, init)
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<ReviewChanges projectId={5} iid={7} files={[{ path: 'src.txt', kind: 'modified', patch: PATCH }]} threads={[THREAD]} drafts={[]} onChanged={() => undefined} />)

    await waitFor(() => expect(screen.getByText('Add to batch')).toBeTruthy())
    await user.click(screen.getByRole('checkbox', { name: /Select suggestion 21 for batch apply/ }))
    await user.click(screen.getByRole('button', { name: /Apply suggestions \(1\)/ }))

    await waitFor(() => expect(batchPayload).toBeTruthy())
    expect(batchPayload!.suggestion_note_ids).toEqual([21])
  })

  it('hides batch controls for OUTDATED suggestions (they cannot apply)', async () => {
    render(
      <ReviewChanges
        projectId={5}
        iid={7}
        files={[{ path: 'src.txt', kind: 'modified', patch: PATCH }]}
        threads={[{ ...THREAD, outdated: true, outdated_reason: 'covered lines changed since review' }]}
        drafts={[]}
        onChanged={() => undefined}
      />,
    )
    await waitFor(() => expect(screen.getByText(/outdated/i)).toBeTruthy())
    expect(screen.queryByText('Add to batch')).toBeNull()
  })
})
