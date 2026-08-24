import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ForkButton, ForkStatusPanel, NetworkView } from '../repository/forks'
import type { Project } from '../projects/api'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

const sourceProject: Project = {
  id: 10,
  name: 'Source Repo',
  path: 'source-repo',
  full_path: 'alice/source-repo',
  visibility: 'public',
  description: '',
  website_url: '',
  default_branch: 'main',
  archived: false,
  is_template: false,
  topics: [],
  owner: { id: 1, username: 'alice', name: 'Alice' },
  created_at: new Date().toISOString(),
  last_activity_at: new Date().toISOString(),
  repository_empty: false,
  upstream_full_path: null,
}

function forkProject(over: Partial<Project> = {}): Project {
  return {
    ...sourceProject,
    id: 20,
    name: 'My Fork',
    path: 'my-fork',
    full_path: 'bob/my-fork',
    owner: { id: 2, username: 'bob', name: 'Bob' },
    upstream_full_path: 'alice/source-repo',
    ...over,
  }
}

beforeEach(() => {
  vi.unstubAllGlobals()
  window.location.hash = ''
})

// ---------------------------------------------------------------------------
// Fork dialog
// ---------------------------------------------------------------------------

describe('fork dialog', () => {
  it('posts the fork request with path + capped visibility and navigates on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      project: { id: 20, path: 'source-repo', name: 'Source Repo', full_path: 'bob/source-repo' },
      source: { id: 10, full_path: 'alice/source-repo' },
    }, 201))
    vi.stubGlobal('fetch', fetchMock)
    document.cookie = 'lsgit_csrf=t; Path=/'

    const user = userEvent.setup()
    render(<ForkButton project={sourceProject} />)
    await user.click(screen.getByRole('button', { name: 'Fork' }))

    // Visibility options never exceed the source's rank.
    const options = screen.getAllByRole('option').map((o) => o.textContent)
    expect(options).toContain('public') // public source → all levels allowed
    await user.click(screen.getByRole('button', { name: 'Fork repository' })) // submit

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('/api/v1/projects/10/fork')
    const body = JSON.parse(init!.body as string)
    expect(body.path).toBe('source-repo')
    expect(window.location.hash).toContain('/proj/bob/source-repo')

    document.cookie = 'lsgit_csrf=; Max-Age=0'
  })

  it('surfaces duplicate-fork conflicts inline without navigating', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(
      { message: 'Path has already been taken in the target namespace', code: 'path_taken' },
      409,
    ))
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<ForkButton project={sourceProject} />)
    await user.click(screen.getByRole('button', { name: 'Fork' }))
    await user.click(screen.getByRole('button', { name: 'Fork repository' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('already been taken'))
    expect(window.location.hash).not.toContain('/proj/bob')
  })
})

// ---------------------------------------------------------------------------
// Fork status panel (upstream reference + sync + detach)
// ---------------------------------------------------------------------------

describe('fork status panel', () => {
  it('shows the upstream reference and a divergence badge; sync fast-forwards', async () => {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (String(url).includes('/fork/divergence')) {
        return Promise.resolve(jsonResponse({
          state: 'behind', branch: 'main', upstream_branch: 'main',
          fork_tip: 'a'.repeat(40), upstream_tip: 'b'.repeat(40),
          behind_count: 2, ahead_count: 0,
        }))
      }
      if (String(url).includes('/fork/sync')) {
        return Promise.resolve(jsonResponse({
          outcome: 'updated',
          report: {
            state: 'up_to_date', branch: 'main', upstream_branch: 'main',
            fork_tip: 'b'.repeat(40), upstream_tip: 'b'.repeat(40),
            behind_count: 0, ahead_count: 0,
          },
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<ForkStatusPanel project={forkProject()} isOwner />)

    // Upstream reference link.
    expect(screen.getByText('alice/source-repo')).toBeTruthy()

    // Behind badge appears before sync.
    await waitFor(() => expect(screen.getByText('behind')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: 'Sync fork' }))
    await waitFor(() => expect(screen.getByText(/Fast-forwarded main to upstream/)).toBeTruthy())
    expect(screen.getByText('up to date')).toBeTruthy()

    const syncBody = JSON.parse(
      (fetchMock.mock.calls.find((c) => String(c[0]).includes('/fork/sync'))![1] as RequestInit).body as string,
    )
    expect(syncBody).toEqual({}) // default-branch sync
  })

  it('reports DIVERGED refusals — fork changes preserved, nothing overwritten', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (String(url).endsWith('/fork/sync')) {
        return Promise.resolve(jsonResponse({
          message: 'Branch has diverged from upstream (3 local, 5 upstream commits).',
          code: 'fork_diverged',
          ahead_count: 3,
          behind_count: 5,
        }, 409))
      }
      if (String(url).includes('/fork/divergence')) {
        return Promise.resolve(jsonResponse({
          state: 'diverged', branch: 'main', upstream_branch: 'main',
          fork_tip: 'a'.repeat(40), upstream_tip: 'b'.repeat(40),
          behind_count: 5, ahead_count: 3,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<ForkStatusPanel project={forkProject()} isOwner />)
    await waitFor(() => expect(screen.getByText('diverged')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: 'Sync fork' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('diverged'))
  })

  it('detach requires typing the exact full project path', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ detached: true })))
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<ForkStatusPanel project={forkProject()} isOwner />)
    await user.click(screen.getByRole('button', { name: 'Detach fork…' }))

    const confirmInput = screen.getByLabelText('Confirmation path') as HTMLInputElement
    // Wrong confirmation → button stays disabled.
    fireEventChange(confirmInput, 'bob/wrong')
    expect(screen.getByRole('button', { name: 'Detach permanently' }).hasAttribute('disabled')).toBe(true)

    // Exact path unlocks it and submits.
    fireEventChange(confirmInput, 'bob/my-fork')
    await user.click(screen.getByRole('button', { name: 'Detach permanently' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const detachCall = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).find(
      (c) => String(c[0]).includes('/fork/detach'),
    )
    const body = JSON.parse(detachCall![1]!.body as string)
    expect(body.confirm_path).toBe('bob/my-fork')
  })

  it('hides mutation controls from non-owners but keeps the upstream link visible', () => {
    render(<ForkStatusPanel project={forkProject()} isOwner={false} />)
    expect(screen.getByText('alice/source-repo')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sync fork' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Detach fork…' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Network graph view
// ---------------------------------------------------------------------------

describe('fork network graph view', () => {
  it('renders root-first indented rows with upstream links and counts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      total_size: 3,
      max_depth: 2,
      root: {
        id: 1, name: 'Source Repo', path: 'source-repo', full_path: 'alice/source-repo',
        visibility: 'public', default_branch: 'main', forked_from: null,
        is_root: true, direct_forks: 1, total_descendants: 2, children: [],
      },
      members: [
        { id: 1, name: 'Source Repo', path: 'source-repo', full_path: 'alice/source-repo', visibility: 'public', default_branch: 'main', forked_from: null, is_root: true, direct_forks: 1, total_descendants: 2, children: [] },
        { id: 2, name: 'Level One', path: 'level-one', full_path: 'bob/level-one', visibility: 'public', default_branch: 'main', forked_from: 1, is_root: false, direct_forks: 1, total_descendants: 1, children: [] },
        { id: 3, name: 'Level Two', path: 'level-two', full_path: 'carol/level-two', visibility: 'private', default_branch: 'main', forked_from: 2, is_root: false, direct_forks: 0, total_descendants: 0, children: [] },
      ],
    })))

    render(<NetworkView projectId={1} currentFullPath="alice/source-repo" />)

    await waitFor(() => expect(screen.getByText('Source Repo')).toBeTruthy())
    expect(screen.getAllByText(/Level One|Level Two/).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('root')).toBeTruthy()
    expect(screen.getByText(/3 repositor/)).toBeTruthy()

    // Upstream column links child rows back to their parents.
    const parentLinks = screen.getAllByRole('link', { name: 'bob/level-one' })
    expect(parentLinks.length).toBeGreaterThanOrEqual(1)
  })
})

function fireEventChange(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
