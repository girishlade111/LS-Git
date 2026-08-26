import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderMarkdown } from '../repository/markdown'
import { DiscussionsListPage, type DiscussionListItem } from '../discussions/DiscussionsPages'

/**
 * Discussions UI: list rendering + category chips, and SANITIZATION of
 * user-generated markdown (XSS protection through the safe renderer).
 */

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

const ROW: DiscussionListItem = {
  id: 1,
  author: { id: 2, username: 'bob', name: null },
  category: 'question',
  title: 'How do I configure exports?',
  body_preview: '',
  comment_count: 3,
  pinned: true,
  locked: false,
  last_activity_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
}

beforeEach(() => {
  vi.unstubAllGlobals()
  document.cookie = 'lsgit_csrf=t; Path=/'
})

describe('discussions list', () => {
  it('renders rows with category badge, pin flag and comment count', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(jsonResponse({ discussions: [ROW], pagination: { page: 1, per_page: 20, total: 1, total_pages: 1, has_more: false } })),
    ))
    render(<DiscussionsListPage projectId={5} />)
    await waitFor(() => expect(screen.getByText('How do I configure exports?')).toBeTruthy())
    expect(screen.getByText('pinned')).toBeTruthy()
    expect(screen.getByText('3 comments')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'question', selected: false })).toBeTruthy()
  })

  it('filters by category chip (refetches with ?category=…)', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('/discussions')) return Promise.resolve(jsonResponse({ discussions: [], pagination: { page: 1, per_page: 20, total: 0, total_pages: 1, has_more: false } }))
      return Promise.resolve(jsonResponse({}))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<DiscussionsListPage projectId={5} />)

    await user.click(await screen.findByRole('tab', { name: 'idea' }))
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(calls.some((u) => u.includes('category=idea'))).toBe(true)
    })
  })
})

// ── sanitization ────────────────────────────────────────────────────────────────

describe('markdown sanitization (XSS protection)', () => {
  it('renders <script> tags as INERT TEXT — never as executable DOM', () => {
    const { container } = render(<div>{renderMarkdown('<script>alert(1)</script>')}</div>)
    expect(container.querySelector('script')).toBeNull()
    // The raw text still appears (escaped by React), harmless.
    expect(container.textContent).toContain('<script>')
  })

  it('renders <img onerror=…> markup as text, not an element with a handler', () => {
    const { container } = render(
      <div>{renderMarkdown('<img src=x onerror="alert(1)">')}</div>,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelectorAll('[onerror]').length).toBe(0)
  })

  it('allows only SAFE link protocols; javascript: URLs are stripped to text', () => {
    const { container } = render(<div>{renderMarkdown('[click me](javascript:alert(1))')}</div>)
    const anchor = container.querySelector('a')
    expect(anchor).toBeNull() // unsafe scheme → rendered as plain text
    expect(container.textContent).toContain('click me')
  })

  it('keeps legitimate https links working', () => {
    const { container } = render(<div>{renderMarkdown('[docs](https://example.com/a)')}</div>)
    const anchor = container.querySelector('a')
    expect(anchor?.getAttribute('href')).toBe('https://example.com/a')
    expect(anchor?.getAttribute('rel')).toContain('noreferrer')
  })

  it('renders task-list syntax as text lines without executing embedded HTML', () => {
    const md = '- [ ] todo item\n- [x] done\n<script>alert("tasks")</script>'
    const { container } = render(<div>{renderMarkdown(md)}</div>)
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('todo item')
  })

  it('code blocks render content as inert code — no HTML interpretation inside fences', () => {
    const md = ['```html', '<img src=x onerror=alert(1)>', '```'].join('\n')
    const { container } = render(<div>{renderMarkdown(md)}</div>)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
