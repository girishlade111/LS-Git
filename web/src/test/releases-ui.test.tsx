import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReleasesView } from '../releases/ReleasesView'
import type { Release, ReleaseAsset } from '../releases/api'

/**
 * Releases UI: compact timeline/table (version · date · tag · pre-release
 * badge · asset count · download action) and maintainer lifecycle actions.
 */

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const published: Release = {
  id: 1,
  tag_name: 'v1.0.0',
  name: 'v1.0.0 "Aurora"',
  description: 'First stable',
  state: 'published',
  is_prerelease: false,
  released_at: '2026-08-20T10:00:00.000Z',
  author: { id: 1, username: 'alice', name: 'Alice' },
  created_at: '2026-08-20T09:59:00.000Z',
  updated_at: '2026-08-20T10:00:00.000Z',
  asset_count: 1,
  assets_path: '/api/v1/projects/42/releases/v1.0.0/assets',
}

const beta: Release = {
  ...published,
  id: 2,
  tag_name: 'v2.0.0-beta1',
  name: 'v2.0.0-beta1',
  state: 'published',
  is_prerelease: true,
  released_at: '2026-08-24T10:00:00.000Z',
  asset_count: 0,
}

const draft: Release = {
  ...published,
  id: 3,
  tag_name: 'v3.0.0',
  name: 'v3.0.0',
  state: 'draft',
  released_at: null,
  asset_count: 0,
}

const asset: ReleaseAsset = {
  id: 9,
  filename: 'app.tar.gz',
  size: 2048,
  sha256: 'a'.repeat(64),
  content_type: 'application/gzip',
  download_url: '/api/v1/projects/42/releases/v1.0.0/assets/app.tar.gz/download',
}

function listResponse(rows: Release[]): Response {
  return jsonResponse({ releases: rows })
}

beforeEach(() => vi.unstubAllGlobals())

describe('releases view', () => {
  it('renders a compact table with version, date, tag, pre-release badge and asset count', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(listResponse([published, beta])))

    render(<ReleasesView projectId={42} isMaintainer={false} />)

    await waitFor(() => expect(screen.getByText('v1.0.0 "Aurora"')).toBeTruthy())
    // Pre-release badge on the beta row.
    expect(screen.getByText('pre-release')).toBeTruthy()
    // Latest badge lands on the newest stable.
    expect(screen.getByText('latest')).toBeTruthy()
    // Dates and tags render in their own columns.
    expect(screen.getByText('2026-08-20')).toBeTruthy()
    expect(screen.getByText('v2.0.0-beta1')).toBeTruthy()
    expect(screen.getByText(/sha256|Assets|1/).toBeTruthy)
  })

  it('expands the download panel listing assets with checksum and direct link', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(listResponse([published]))
      .mockResolvedValueOnce(jsonResponse({ release: { ...published, assets: [asset] } }))
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<ReleasesView projectId={42} isMaintainer={false} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^Download/ })).toBeTruthy())
    await user.click(screen.getByRole('button', { name: /^Download/ }))

    await waitFor(() => expect(screen.getByText('app.tar.gz')).toBeTruthy())
    const link = screen.getByText('app.tar.gz').closest('a')
    expect(link!.getAttribute('href')).toBe(asset.download_url)
    expect(screen.getByText(new RegExp(`${'a'.repeat(12)}`))).toBeTruthy()
    expect(fetchMock.mock.calls[1]![0]).toContain('/releases/v1.0.0')
  })

  it('creates a pre-release draft through the New release dialog', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(jsonResponse({ release: { ...draft, is_prerelease: true } }, 201))
      .mockResolvedValueOnce(listResponse([draft]))
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<ReleasesView projectId={42} isMaintainer={true} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'New release' })).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'New release' }))

    const setVal = (label: RegExp | string, value: string) => {
      const el = screen.getByLabelText(label) as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setVal('Tag name', 'v3.0.0')
    await user.click(screen.getByRole('switch', { name: 'Pre-release' }))
    await user.click(screen.getByRole('switch', { name: 'Save as draft' }))
    await user.click(screen.getByRole('button', { name: 'Create release' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const post = fetchMock.mock.calls.find(([, i]) => (i as RequestInit).method === 'POST')!
    expect(String(post[0])).toMatch(/\/releases$/)
    expect(JSON.parse((post[1] as RequestInit).body as string)).toMatchObject({
      tag_name: 'v3.0.0',
      prerelease: true,
      draft: true,
    })
  })

  it('publishes drafts via the row action (state_event publish)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(listResponse([draft]))
      .mockResolvedValueOnce(jsonResponse({ release: { ...draft, state: 'published' } }))
      .mockResolvedValueOnce(listResponse([{ ...draft, state: 'published' }]))
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<ReleasesView projectId={42} isMaintainer={true} />)
    await waitFor(() => expect(screen.getByLabelText('Publish v3.0.0')).toBeTruthy())
    await user.click(screen.getByLabelText('Publish v3.0.0'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const patch = fetchMock.mock.calls[1]!
    expect((patch[1] as RequestInit).method).toBe('PATCH')
    expect(String(patch[0])).toContain('/releases/v3.0.0')
    expect(JSON.parse((patch[1] as RequestInit).body as string).state_event).toBe('publish')
  })

  it('hides maintainer actions from non-maintainers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(listResponse([draft, published])))
    render(<ReleasesView projectId={42} isMaintainer={false} />)
    await waitFor(() => expect(screen.getByText('v1.0.0 "Aurora"')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'New release' })).toBeNull()
    expect(screen.queryByLabelText('Publish v3.0.0')).toBeNull()
    expect(screen.queryByLabelText('Delete v1.0.0')).toBeNull()
  })

  it('deletes a release after confirmation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(listResponse([draft]))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(listResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<ReleasesView projectId={42} isMaintainer={true} />)
    await waitFor(() => expect(screen.getByLabelText('Delete v3.0.0')).toBeTruthy())
    await user.click(screen.getByLabelText('Delete v3.0.0'))
    await user.click(screen.getByRole('button', { name: 'Delete release' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const del = fetchMock.mock.calls[1]!
    expect((del[1] as RequestInit).method).toBe('DELETE')
    expect(String(del[0])).toContain('/releases/v3.0.0')
  })
})
