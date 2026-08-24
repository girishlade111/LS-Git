import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BranchesView, CompareView, TagsView } from '../repository/branches'
import type { BrowserNav } from '../repository/views'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const nav: BrowserNav = {
  tree: (ref, p) => `/proj/o/p/tree/${ref}/${p}`,
  blob: (ref, p) => `/proj/o/p/blob/${ref}/${p}`,
  history: (ref) => `/proj/o/p/commits/${ref}`,
  fileHistory: (ref, p) => `/proj/o/p/commits/${ref}?path=${p}`,
  commit: (sha) => `/proj/o/p/commit/${sha}`,
  blame: (ref, p) => `/proj/o/p/blame/${ref}/${p}`,
  edit: (ref, p) => `/proj/o/p/edit/${ref}/${p}`,
  createFile: (ref, dir) => `/proj/o/p/new/${ref}/${dir}`,
}

const ctx = {
  projectId: 42,
  defaultBranch: 'main',
  nav,
  navigate: () => undefined,
}

beforeEach(() => vi.unstubAllGlobals())

// ---------------------------------------------------------------------------
// Branches view
// ---------------------------------------------------------------------------

describe('branches view', () => {
  it('renders a dense branch table with default/protected markers and commit links', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      branches: [
        { name: 'main', sha: 'a'.repeat(40), default: true, protected: true, title: 'Initial commit', author_name: 'Alice', committed_at: new Date().toISOString() },
        { name: 'feature/login', sha: 'b'.repeat(40), default: false, protected: false, title: 'Add login', author_name: 'Bob', committed_at: new Date().toISOString() },
      ],
    })))
    render(<BranchesView {...ctx} />)

    await waitFor(() => expect(screen.getByText('feature/login')).toBeTruthy())
    // Rows are links into the tree at that ref.
    const link = screen.getByText('feature/login').closest('a')
    expect(link!.getAttribute('href')).toContain('/tree/feature%2Flogin')
    // Status markers are subtle badges, not bright chips.
    expect(screen.getByText('default')).toBeTruthy()
    expect(screen.getByText('protected')).toBeTruthy()
  })

  it('creates a branch via the dialog and reloads the list', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ branches: [] }))
      .mockResolvedValueOnce(jsonResponse({ branch: 'hotfix', commit_sha: 'c'.repeat(40) }, 201))
      .mockResolvedValueOnce(jsonResponse({
        branches: [
          { name: 'hotfix', sha: 'c'.repeat(40), default: false, protected: false, title: 'x', author_name: 'A', committed_at: new Date().toISOString() },
        ],
      }))
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<BranchesView {...ctx} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'New branch' })).toBeTruthy())

    await user.click(screen.getByRole('button', { name: 'New branch' }))
    await user.type(screen.getByLabelText('Branch name'), 'hotfix')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.getByText('hotfix')).toBeTruthy())
    // POST went to the branches endpoint with the requested name.
    const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit).method === 'POST')!
    expect(String(postCall[0])).toMatch(/\/repository\/branches$/)
    expect(JSON.parse((postCall[1] as RequestInit).body as string).name).toBe('hotfix')
  })

  it('delete confirmation sends the optimistic expected_old guard', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        branches: [
          { name: 'tmp', sha: 'd'.repeat(40), default: false, protected: false, title: 't', author_name: 'A', committed_at: new Date().toISOString() },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ branches: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<BranchesView {...ctx} />)
    await waitFor(() => expect(screen.getByLabelText('Delete tmp')).toBeTruthy())
    await user.click(screen.getByLabelText('Delete tmp'))
    await user.click(screen.getByRole('button', { name: 'Delete branch' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const delCall = fetchMock.mock.calls[1]!
    expect((delCall[1] as RequestInit).method).toBe('DELETE')
    expect(String(delCall[0])).toContain(`/branches/${'d'.repeat(40)}?expected_old=`.replace('/branches/', '/branches/') || '')
    expect(String(delCall[0])).toContain('expected_old=')

    vi.unstubAllGlobals()
  })
})

// ---------------------------------------------------------------------------
// Tags view
// ---------------------------------------------------------------------------

describe('tags view', () => {
  it('lists tags with annotated markers and target links', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      tags: [
        { name: 'v1.0.0', sha: 'e'.repeat(40), annotated: true, target: 'f'.repeat(40) },
      ],
    })))
    render(<TagsView {...ctx} />)

    await waitFor(() => expect(screen.getByText('v1.0.0')).toBeTruthy())
    expect(screen.getByText('annotated')).toBeTruthy()
    expect(screen.getByText('f'.repeat(40).slice(0, 8))).toBeTruthy()
  })

  it('tags a commit through the create dialog (annotated by default)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ tags: [] }))
      .mockResolvedValueOnce(jsonResponse({ name: 'v2.0.0', annotated: true, target: 'f'.repeat(40) }, 201))
      .mockResolvedValueOnce(jsonResponse({
        tags: [{ name: 'v2.0.0', sha: '9'.repeat(40), annotated: true, target: 'f'.repeat(40) }],
      }))
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<TagsView {...ctx} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'New tag' }))
    await user.type(screen.getByLabelText('Tag name'), 'v2.0.0')
    await user.type(screen.getByLabelText(/Point at/i), 'main')
    await user.type(screen.getByLabelText('Message'), 'Release')
    await user.click(screen.getByRole('button', { name: 'Create tag' }))

    await waitFor(() => expect(screen.getByText('v2.0.0')).toBeTruthy())
    const postBody = JSON.parse(
      (fetchMock.mock.calls.find(([, i]) => (i as RequestInit).method === 'POST')![1] as RequestInit).body as string,
    )
    expect(postBody).toMatchObject({ name: 'v2.0.0', ref: 'main', message: 'Release' })

    vi.unstubAllGlobals()
  })
})

// ---------------------------------------------------------------------------
// Compare view
// ---------------------------------------------------------------------------

describe('compare view', () => {
  it('shows ahead commits and per-file patches between two refs', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/branches')) {
        return Promise.resolve(jsonResponse({
          branches: [
            { name: 'main', sha: 'a'.repeat(40), default: true, protected: true, title: '', author_name: '', committed_at: '' },
            { name: 'feature/x', sha: 'b'.repeat(40), default: false, protected: false, title: '', author_name: '', committed_at: '' },
          ],
        }))
      }
      if (String(url).includes('/tags')) return Promise.resolve(jsonResponse({ tags: [] }))
      if (String(url).includes('/compare')) {
        return Promise.resolve(jsonResponse({
          from: { ref: 'main', sha: 'a'.repeat(40) },
          to: { ref: 'feature/x', sha: 'b'.repeat(40) },
          merge_base: 'c'.repeat(40),
          ahead: [{ sha: 'b'.repeat(40), short_sha: 'b'.repeat(10), title: 'Feature work', message: 'Feature work', author_name: 'Bob', author_email: 'b@x', committed_at: new Date().toISOString(), parents: ['c'.repeat(40)] }],
          behind: [],
          commits_ahead_count: 1,
          commits_behind_count: 0,
          files: [
            { path: 'new.ts', kind: 'added', patch: `diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,1 @@\n+export {}\n`, stats: { added: 1, removed: 0 } },
            { path: 'dropped.txt', kind: 'deleted', patch: '', stats: { added: 0, removed: 0 } },
          ],
        }))
      }
      return Promise.resolve(jsonResponse({}))
    }))

    render(<CompareView {...ctx} initialFrom="main" initialTo="feature/x" />)

    await waitFor(() => expect(screen.getByText('Feature work')).toBeTruthy())
    // Merge-base link rendered.
    expect(screen.getByText('c'.repeat(8))).toBeTruthy()
    // Changed files listed with subtle kind badges.
    expect(screen.getAllByText(/new\.ts|dropped\.txt/).length).toBeGreaterThanOrEqual(2)
    // Patch rendered through the design-system diff rows.
    expect(document.querySelector('.ls-diff__row--add')).toBeTruthy()
  })

  it('prompts to pick two different refs when they match', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/branches')) {
        return Promise.resolve(jsonResponse({ branches: [] }))
      }
      if (String(url).includes('/tags')) return Promise.resolve(jsonResponse({ tags: [] }))
      return Promise.resolve(jsonResponse({}))
    }))
    render(<CompareView {...ctx} initialFrom="main" initialTo="main" />)
    await waitFor(() => expect(screen.getByText(/Pick two different refs/)).toBeTruthy())
    vi.unstubAllGlobals()
  })
})
