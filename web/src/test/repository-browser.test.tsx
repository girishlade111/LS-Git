import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { highlightLine, languageForFile } from '../repository/highlight'
import { renderMarkdown } from '../repository/markdown'
import { CodeSurface } from '../repository/views'
import { CrumbTrail, formatBytes, timeAgo, KindBadge } from '../repository/widgets'
import type { BrowserNav } from '../repository/views'

// ---------------------------------------------------------------------------
// Syntax highlighting
// ---------------------------------------------------------------------------

describe('syntax highlighting', () => {
  it('maps file extensions to languages', () => {
    expect(languageForFile('app.tsx')).toBe('clike')
    expect(languageForFile('package.json')).toBe('json')
    expect(languageForFile('ci.yml')).toBe('yaml')
    expect(languageForFile('Dockerfile')).toBe('config')
    expect(languageForFile('README.md')).toBe('markdown')
    expect(languageForFile('blob.bin')).toBe('plain')
  })

  it('tokenizes keywords, strings and comments without throwing', () => {
    const toks = highlightLine('const x = "hi" // note', 'clike')
    expect(toks.some((t) => t.kind === 'keyword' && t.text === 'const')).toBe(true)
    expect(toks.some((t) => t.kind === 'string' && t.text === '"hi"')).toBe(true)
    expect(toks.some((t) => t.kind === 'comment' && t.text.includes('note'))).toBe(true)
  })

  it('identifies JSON keys distinctly from string values', () => {
    const toks = highlightLine('"name": "value"', 'json')
    expect(toks[0]).toMatchObject({ kind: 'key', text: '"name"' })
    expect(toks.some((t) => t.kind === 'string' && t.text === '"value"')).toBe(true)
  })

  it('never corrupts content: joined token text equals the input line', () => {
    for (const line of ['def f(x): return f"{x!r}"', '<div class="a">text</div>', 'SELECT * FROM t;', 'weird \\ " ` chars']) {
      for (const lang of ['clike', 'json', 'yaml', 'markup', 'python', 'sql', 'config']) {
        const joined = highlightLine(line, lang).map((t) => t.text).join('')
        expect(joined).toBe(line)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Markdown renderer (safety + structure)
// ---------------------------------------------------------------------------

describe('markdown rendering', () => {
  it('renders headings, lists, emphasis and code fences', () => {
    const { container } = render(
      <div>{renderMarkdown('# Title\n\n- item **bold**\n- item2\n\n```js\nconst a = 1\n```\n')}</div>,
    )
    expect(screen.getByText('Title').tagName).toBe('H3')
    const items = container.querySelectorAll('.ls-md__list li')
    expect(items).toHaveLength(2)
    expect(container.querySelector('.ls-md__code')).toBeTruthy()
    expect(container.textContent).toContain('const a = 1')
  })

  it('NEVER injects raw HTML — script tags render as inert text or are dropped', () => {
    const { container } = render(
      <div>{renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">')}</div>,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    // The markup survives as escaped text content only.
    expect(container.innerHTML).not.toContain('<script>')
  })

  it('rejects javascript: link targets but keeps safe ones', () => {
    const { container } = render(
      <div>{renderMarkdown('[a](javascript:alert(1)) [b](https://example.com)')}</div>,
    )
    const links = container.querySelectorAll('a')
    expect(links).toHaveLength(1)
    expect(links[0]!.getAttribute('href')).toBe('https://example.com')
  })
})

// ---------------------------------------------------------------------------
// Code surface
// ---------------------------------------------------------------------------

const nav: BrowserNav = {
  tree: (ref, p) => `/proj/o/p/tree/${ref}/${p}`,
  blob: (ref, p, line) => `/proj/o/p/blob/${ref}/${p}${line ? `#L${line}` : ''}`,
  history: (ref) => `/proj/o/p/commits/${ref}`,
  fileHistory: (ref, p) => `/proj/o/p/commits/${ref}?path=${p}`,
  commit: (sha) => `/proj/o/p/commit/${sha}`,
  blame: (ref, p) => `/proj/o/p/blame/${ref}/${p}`,
  edit: (ref, p) => `/proj/o/p/edit/${ref}/${p}`,
  createFile: (ref, dir) => `/proj/o/p/new/${ref}/${dir}`,
}

describe('code surface (developer view)', () => {
  it('renders line-number gutter with #L anchors and highlighted source', () => {
    const { container } = render(
      <CodeSurface code={'const one = 1\nconst two = 2\n'} fileName="a.ts" nav={nav} refName="main" path="src/a.ts" />,
    )
    const rows = container.querySelectorAll('.ls-code__gutter')
    expect(rows).toHaveLength(2)
    const firstAnchor = container.querySelector<HTMLAnchorElement>('a.ls-code__lineno')
    expect(firstAnchor!.getAttribute('href')).toContain('#L1')
    expect(container.querySelectorAll('.ls-tok--keyword').length).toBeGreaterThanOrEqual(2)
  })

  it('pins the requested line permalink row with subtle state', () => {
    const { container } = render(
      <CodeSurface code={'a\nb\nc\n'} fileName="x.txt" highlightLine={2} nav={nav} refName="main" path="x.txt" />,
    )
    expect(container.querySelector('tr.ls-code__row--pinned .ls-code__lineno')?.textContent).toBe('2')
  })

  it('offers per-line copy controls with accessible names', () => {
    render(<CodeSurface code={'hello\n'} fileName="y.txt" nav={nav} refName="main" path="y.txt" />)
    expect(screen.getByLabelText('Copy line 1')).toBeTruthy()
  })

  it('virtualizes very long files instead of mounting every row', () => {
    const manyLines = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join('\n')
    const { container } = render(
      <CodeSurface code={manyLines} fileName="big.log" nav={nav} refName="main" path="big.log" />,
    )
    const renderedRows = container.querySelectorAll('a.ls-code__lineno').length
    expect(renderedRows).toBeLessThan(200)
    expect(renderedRows).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

describe('browser widgets', () => {
  it('formats bytes and relative times readably', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    const now = Date.now()
    vi.useFakeTimers()
    vi.setSystemTime(now)
    expect(timeAgo(new Date(now - 90_000).toISOString())).toBe('1 minute ago')
    expect(timeAgo(new Date(now - 3 * 86400_000).toISOString())).toBe('3 days ago')
    vi.useRealTimers()
  })

  it('renders change-kind badges with visually hidden full words', () => {
    render(<KindBadge kind="deleted" />)
    expect(screen.getByText(/deleted/)).toBeTruthy()
  })

  it('breadcrumb trail marks the final segment as current location', () => {
    render(
      <CrumbTrail
        trail={[
          { name: 'repo', href: '#/proj/o/p/tree/main' },
          { name: 'docs', href: '#/proj/o/p/tree/main/docs' },
          { name: 'guide.md', href: null },
        ]}
      />,
    )
    const crumbs = document.querySelectorAll('.ls-rb__crumb')
    expect(crumbs).toHaveLength(3)
    expect(crumbs[crumbs.length - 1]!.getAttribute('aria-current')).toBe('location')
    expect((crumbs[0] as HTMLAnchorElement).href).toContain('/tree/main')
  })
})
