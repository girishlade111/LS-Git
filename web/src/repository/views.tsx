import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '../design-system/Badge'
import { Button } from '../design-system/Button'
import { EmptyState } from '../design-system/EmptyState'
import { Icon } from '../design-system/Icon'
import { IconButton } from '../design-system/IconButton'
import { Pagination } from '../design-system/Pagination'
import { Skeleton } from '../design-system/Skeleton'
import { Tooltip } from '../design-system/Tooltip'
import {
  repositoryApi,
  type BlobResult,
  type BlameResult,
  type CommitDetail,
  type CommitView,
  type HistoryCommit,
  type SearchMatch,
  type TreeResult,
} from './api'
import { highlightLine, languageForFile } from './highlight'
import { renderMarkdown } from './markdown'
import { CopyButton, CrumbTrail, formatBytes, KindBadge, timeAgo, useVirtualWindow } from './widgets'

/** URL builders shared by all browser views (kept in one place). */
export interface BrowserNav {
  tree: (ref: string, path: string, page?: number) => string
  blob: (ref: string, path: string, line?: number) => string
  history: (ref: string) => string
  fileHistory: (ref: string, path: string) => string
  commit: (sha: string) => string
  blame: (ref: string, path: string) => string
}

// ---------------------------------------------------------------------------
// Tree view
// ---------------------------------------------------------------------------

export function TreeView({
  projectId,
  projectName,
  refName,
  path,
  page,
  perPage = 100,
  nav,
}: {
  projectId: number
  projectName: string
  refName: string
  path: string
  page: number
  perPage?: number
  nav: BrowserNav
}) {
  const [data, setData] = useState<TreeResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setError(null)
    setData(null)
    repositoryApi
      .tree(projectId, refName, path, { page, perPage })
      .then((t) => { if (alive) setData(t) })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Failed to load') })
    return () => { alive = false }
  }, [projectId, refName, path, page, perPage])

  if (error) return <ErrorState message={error} />
  if (!data) return <TreeSkeleton />

  if (data.empty_repository) {
    return (
      <EmptyState
        icon="code"
        title="This repository is empty"
        description="Commit files through the web editor or push an initial commit to start browsing."
      />
    )
  }

  const trail = [
    { name: projectName, href: nav.tree(refName, '') },
    ...data.breadcrumbs.map((c) => ({
      name: c.name,
      href: c.path === data.path ? null : nav.tree(refName, c.path),
    })),
  ]

  const rows = [...data.entries]

  return (
    <section aria-label={`Repository tree at ${refName}`} className="ls-rb">
      <header className="ls-rb__head">
        <CrumbTrail trail={trail} />
        <div className="ls-rb__actions">
          <a className="ls-btn ls-btn--sm ls-btn--secondary" href={repositoryApi.downloadUrl(projectId, refName, data.path || null)}>
            <Icon name="external" size={13} /> Download {data.path ? 'directory' : 'repository'}
          </a>
          <CopyButton value={data.path} label="Copy directory path" />
        </div>
      </header>

      {data.tip_commit && (
        <TipCommit commit={data.tip_commit} historyHref={nav.history(refName)} commitUrl={nav.commit} />
      )}

      {rows.length === 0 ? (
        <EmptyState icon="folder" title="Nothing here" description="This directory has no entries on this page." />
      ) : (
        <div className="ls-rb__tablewrap" role="region" aria-label="Files and directories">
          <table className="ls-rb__table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="ls-rb__colmeta">Type</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr key={entry.path}>
                  <td>
                    <a className="ls-rb__name" href={entry.type === 'tree' ? nav.tree(refName, entry.path) : nav.blob(refName, entry.path)}>
                      <Icon name={entry.type === 'tree' ? 'folder' : 'file'} size={14} />
                      <span>{entry.name}</span>
                    </a>
                  </td>
                  <td className="ls-rb__colmeta">
                    <span className="ls-rb__muted">{entry.type === 'tree' ? 'directory' : 'file'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.pagination.total > perPage && (
        <Pagination
          page={page}
          pageCount={Math.ceil(data.pagination.total / perPage)}
          onChange={(p) => { window.location.hash = nav.tree(refName, data.path, p).replace(/^#/, '') }}
        />
      )}
    </section>
  )
}

function TipCommit({
  commit,
  historyHref,
  commitUrl,
}: {
  commit: CommitView
  historyHref: string
  commitUrl: (sha: string) => string
}) {
  return (
    <div className="ls-rb__tip">
      <span className="ls-rb__tipmsg">{commit.title}</span>
      <a
        className="ls-rb__tipsha"
        href={`#${commitUrl(commit.sha)}`}
        aria-label={`Commit ${commit.short_sha}`}
      >
        {commit.short_sha}
      </a>
      <span className="ls-rb__muted">· {commit.author_name} · {timeAgo(commit.committed_at)}</span>
      <a className="ls-rb__tiplink" href={historyHref}>History</a>
    </div>
  )
}

function TreeSkeleton() {
  return (
    <div className="ls-rb__skeleton" aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} shape="text" width={`${40 + ((i * 13) % 45)}%`} height={10} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Blob view
// ---------------------------------------------------------------------------

const RENDER_TEXT_MAX_LINES = 20_000

export function BlobViewPage({
  projectId,
  projectName,
  refName,
  path,
  line,
  nav,
}: {
  projectId: number
  projectName: string
  refName: string
  path: string
  line: number | null
  nav: BrowserNav
}) {
  const [data, setData] = useState<BlobResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rendered, setRendered] = useState(false)

  useEffect(() => {
    let alive = true
    setError(null)
    setData(null)
    repositoryApi.blob(projectId, refName, path)
      .then((b) => { if (alive) setData(b) })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Failed to load') })
    return () => { alive = false }
  }, [projectId, refName, path])

  if (error) return <ErrorState message={error} />
  if (!data) return <TreeSkeleton />

  const segments = data.path.split('/')
  const fileName = segments[segments.length - 1]!
  const isMarkdown = /\.md$/i.test(fileName)
  const showRendered = rendered && isMarkdown && !data.too_large && !data.is_binary

  const parentTrail = [
    { name: projectName, href: nav.tree(refName, '') },
    ...data.breadcrumbs.map((c) => ({ name: c.name, href: nav.tree(refName, c.path) })),
    { name: fileName, href: null },
  ]

  return (
    <section aria-label={`File ${data.path}`} className="ls-rb">
      <header className="ls-rb__head">
        <CrumbTrail trail={parentTrail} />
        <div className="ls-rb__actions">
          {isMarkdown && !data.too_large && !data.is_binary && (
            <Tooltip content={showRendered ? 'Show source' : 'Render Markdown'}>
              <Button size="sm" variant="ghost" onClick={() => setRendered(!showRendered)}>
                {showRendered ? 'Source' : 'Preview'}
              </Button>
            </Tooltip>
          )}
          {!data.is_binary && data.text !== null && <CopyButton value={data.text} label="Copy file contents" />}
          <CopyButton value={data.path} label="Copy path" />
          <Tooltip content="Copy permalink (fixed SHA)">
            <CopyButton
              value={`${window.location.origin}${window.location.pathname}#${nav.blob(data.resolved_sha, data.path, line ?? undefined)}`}
              label="Copy permalink"
            />
          </Tooltip>
          <IconButton label="File history" icon="clock" onClick={() => { window.location.hash = nav.fileHistory(refName, data.path).replace(/^#/, '') }} />
          {!data.is_binary && (
            <IconButton label="Blame" icon="eye" onClick={() => { window.location.hash = nav.blame(refName, data.path).replace(/^#/, '') }} />
          )}
          <Tooltip content="Raw file">
            <a className="ls-iconbtn" href={repositoryApi.rawUrl(projectId, refName, data.path)} target="_blank" rel="noreferrer noopener">
              <Icon name="code" size={15} />
              <span className="ls-visually-hidden">Raw file</span>
            </a>
          </Tooltip>
          <Tooltip content="Download file">
            <a className="ls-iconbtn" href={repositoryApi.rawUrl(projectId, refName, data.path)} download={fileName}>
              <Icon name="external" size={15} />
              <span className="ls-visually-hidden">Download file</span>
            </a>
          </Tooltip>
        </div>
      </header>

      <div className="ls-rb__filemeta" aria-label="File metadata">
        <Badge variant="neutral">{formatBytes(data.size)}</Badge>
        {data.line_count !== null && <Badge variant="neutral">{data.line_count} lines</Badge>}
        {data.mode === 'executable' && <Badge variant="accent">executable</Badge>}
        {data.is_binary && <Badge variant="neutral">binary</Badge>}
        <a className="ls-rb__tipsha" href={`#${nav.commit(data.commit.sha)}`}>{data.commit.short_sha}</a>
        <span className="ls-rb__muted">{data.commit.title} · {timeAgo(data.commit.committed_at)}</span>
      </div>

      {data.is_binary ? (
        <EmptyState
          icon="file"
          title="Binary file"
          description={`${formatBytes(data.size)} — preview unavailable. Use the actions above for raw access.`}
        />
      ) : data.too_large || (data.line_count ?? 0) > RENDER_TEXT_MAX_LINES ? (
        <EmptyState
          icon="warning"
          title="File too large to render"
          description={`${formatBytes(data.size)} exceeds the inline render limit. Download or open the raw view instead.`}
        />
      ) : showRendered ? (
        <article className="ls-rb__markdown" aria-label="Rendered Markdown">{renderMarkdown(data.text ?? '')}</article>
      ) : (
        <CodeSurface code={data.text ?? ''} fileName={fileName} highlightLine={line} nav={nav} refName={refName} path={data.path} />
      )}
    </section>
  )
}

/**
 * The developer code surface: monospace ONLY inside this block, line-number
 * gutter with #L anchors (line permalinks), horizontal scrolling preserved,
 * per-line copy, subtle current-line emphasis.
 */
export function CodeSurface({
  code,
  fileName,
  highlightLine: pinnedLine,
  nav,
  refName,
  path,
}: {
  code: string
  fileName: string
  highlightLine?: number | null
  nav: BrowserNav
  refName: string
  path: string
}) {
  const lines = useMemo(() => code.replace(/\n$/, '').split('\n'), [code])
  const lang = languageForFile(fileName)
  const { containerRef, startIndex, endIndex, padTop, padBottom } = useVirtualWindow(lines.length, 21)

  const gutterRefs = useRef<Map<number, HTMLSpanElement>>(new Map())
  useEffect(() => {
    if (pinnedLine == null) return
    const el = gutterRefs.current.get(pinnedLine)
    // scrollIntoView is unavailable in some environments (jsdom).
    el?.scrollIntoView?.({ block: 'center' })
  }, [pinnedLine])

  const visible: Array<{ n: number; text: string }> = []
  for (let i = startIndex; i <= endIndex; i++) visible.push({ n: i + 1, text: lines[i]! })

  return (
    <div className="ls-code" ref={containerRef} role="region" aria-label={`Source of ${fileName}`}>
      <table className="ls-code__table"><tbody>
        <tr style={{ height: padTop }}>{/* top spacer */}<td colSpan={3} /></tr>
        {visible.map(({ n, text }) => (
          <tr key={n} id={`L${n}`} className={pinnedLine === n ? 'ls-code__row--pinned' : undefined}>
            <td className="ls-code__gutter">
              <a
                className="ls-code__lineno"
                href={`#${nav.blob(refName, path, n)}`}
                aria-label={`Line ${n}`}
                ref={(el) => { if (el) gutterRefs.current.set(n, el as unknown as HTMLSpanElement); else gutterRefs.current.delete(n) }}
              >
                {n}
              </a>
            </td>
            <td className="ls-code__linecopy">
              <CopyButton value={text} label={`Copy line ${n}`} />
            </td>
            <td className="ls-code__src">
              {highlightLine(text, lang).map((tok, idx) => (
                <span key={idx} className={`ls-tok--${tok.kind}`}>{tok.text}</span>
              ))}
            </td>
          </tr>
        ))}
        <tr style={{ height: padBottom }}><td colSpan={3} /></tr>
      </tbody></table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// History / commit views
// ---------------------------------------------------------------------------

export function HistoryView({
  projectId,
  refName,
  path,
  page,
  nav,
}: {
  projectId: number
  refName: string
  path: string | null
  page: number
  nav: BrowserNav
}) {
  const [commits, setCommits] = useState<CommitView[] | HistoryCommit[] | null>(null)
  const [pagination, setPagination] = useState<{ total: number; has_more: boolean; per_page: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const perPage = 25

  useEffect(() => {
    let alive = true
    repositoryApi.history(projectId, refName, path, { page, perPage })
      .then((h) => {
        if (!alive) return
        setCommits(h.commits)
        setPagination(h.pagination ? { total: h.pagination.total, has_more: h.pagination.has_more, per_page: h.pagination.per_page } : null)
      })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Failed to load history') })
    return () => { alive = false }
  }, [projectId, refName, path, page])

  if (error) return <ErrorState message={error} />
  if (!commits) return <TreeSkeleton />

  return (
    <section aria-label={`Commit history${path ? ` for ${path}` : ''}`} className="ls-rb">
      <header className="ls-rb__head">
        <h2 className="ls-rb__viewtitle">
          Commits <span className="ls-rb__muted">· {refName}{path ? ` · ${path}` : ''}</span>
        </h2>
      </header>
      <ol className="ls-rb__log">
        {(commits as Array<CommitView & Partial<HistoryCommit>>).map((c) => (
          <li key={c.sha} className="ls-rb__logrow">
            {'kind' in c && c.kind && <KindBadge kind={c.kind} />}
            <div className="ls-rb__logmain">
              <a className="ls-rb__logtitle" href={`#${nav.commit(c.sha)}`}>{c.title}</a>
              <div className="ls-rb__logmeta">
                <span>{c.author_name}</span>
                <span> · {timeAgo(c.committed_at)}</span>
                <a className="ls-rb__tipsha" href={`#${nav.blob(refName, path ?? '')}`} onClick={(e) => e.preventDefault()} aria-hidden="true" tabIndex={-1}>
                  {c.short_sha}
                </a>
              </div>
            </div>
          </li>
        ))}
      </ol>
      {pagination && pagination.total > pagination.per_page && (
        <Pagination
          page={page}
          pageCount={Math.ceil(pagination.total / pagination.per_page)}
          onChange={(p) => { window.location.hash = nav.history(refName).replace(/^#/, '') + `?page=${p}` }}
        />
      )}
    </section>
  )
}

export function CommitDetailView({ projectId, sha, nav }: { projectId: number; sha: string; nav: BrowserNav }) {
  const [detail, setDetail] = useState<CommitDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    repositoryApi.commit(projectId, sha)
      .then((d) => { if (alive) setDetail(d) })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Failed to load commit') })
    return () => { alive = false }
  }, [projectId, sha])

  if (error) return <ErrorState message={error} />
  if (!detail) return <TreeSkeleton />

  return (
    <section aria-label="Commit details" className="ls-rb">
      <header className="ls-rb__head">
        <h2 className="ls-rb__viewtitle">{detail.title}</h2>
        <div className="ls-rb__actions">
          <CopyButton value={detail.sha} label="Copy full SHA" />
          <CopyButton value={`${detail.sha}\n\n${detail.message}`} label="Copy commit message" />
        </div>
      </header>
      <pre className="ls-rb__message">{detail.message}</pre>
      <div className="ls-rb__filemeta">
        <span className="ls-rb__muted">{detail.author_name} committed {timeAgo(detail.committed_at)}</span>
        <Badge variant="neutral">{detail.short_sha}</Badge>
        {detail.parents.map((p) => <Badge key={p} variant="neutral">parent {p.slice(0, 8)}</Badge>)}
      </div>
      <div className="ls-rb__stats" aria-label="Change statistics">
        <span className="ls-rb__stat ls-rb__stat--add">{detail.stats.added} added</span>
        <span className="ls-rb__stat ls-rb__stat--mod">{detail.stats.modified} modified</span>
        <span className="ls-rb__stat ls-rb__stat--del">{detail.stats.deleted} deleted</span>
      </div>
      <ul className="ls-rb__changed" aria-label="Changed files">
        {detail.changed_files.map((f) => (
          <li key={`${f.kind}-${f.path}`} className="ls-rb__changedrow">
            <KindBadge kind={f.kind} />
            <a
              className="ls-rb__name"
              href={f.kind === 'deleted' ? nav.tree(detail.sha, f.path.split('/').slice(0, -1).join('/')) : nav.blob(detail.sha, f.path)}
            >
              <Icon name="file" size={13} /> {f.path}
            </a>
          </li>
        ))}
      </ul>
      {detail.lists_truncated && <p className="ls-rb__muted">Large changeset — list truncated.</p>}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Blame view
// ---------------------------------------------------------------------------

export function BlameViewPage({
  projectId,
  projectName,
  refName,
  path,
  nav,
}: {
  projectId: number
  projectName: string
  refName: string
  path: string
  nav: BrowserNav
}) {
  const [data, setData] = useState<BlameResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    repositoryApi.blame(projectId, refName, path)
      .then((b) => { if (alive) setData(b) })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Failed to load blame') })
    return () => { alive = false }
  }, [projectId, refName, path])

  if (error) return <ErrorState message={error} />
  if (!data) return <TreeSkeleton />

  const fileName = path.split('/').pop()!
  const lang = languageForFile(fileName)

  return (
    <section aria-label={`Blame for ${path}`} className="ls-rb">
      <header className="ls-rb__head">
        <CrumbTrail
          trail={[
            { name: projectName, href: nav.tree(refName, '') },
            ...data.path.split('/').slice(0, -1).map((seg) => ({ name: seg, href: null })),
            { name: fileName, href: nav.blob(refName, path) },
          ]}
        />
        <div className="ls-rb__actions">
          <CopyButton value={data.lines.map((l) => l.content).join('\n')} label="Copy file contents" />
          <Button size="sm" variant="ghost" onClick={() => { window.location.hash = nav.blob(refName, path).replace(/^#/, '') }}>
            Back to file
          </Button>
        </div>
      </header>
      <p className="ls-rb__muted ls-rb__blamenote">
        Line attribution over the last {new Set(data.lines.map((l) => l.commit_sha)).size} commits touching this file.
      </p>
      <div className="ls-blame" role="table" aria-label="Line blame">
        {data.ranges.map((r) => (
          <div key={r.start_line} className="ls-blame__range" role="rowgroup">
            <a className="ls-blame__commit" href={`#${nav.commit(r.commit_sha)}`}>
              {r.commit_sha.slice(0, 8)}
            </a>
            <div className="ls-blame__lines">
              {data.lines.slice(r.start_line - 1, r.end_line).map((l) => (
                <div key={l.number} className="ls-blame__line" role="row">
                  <span className="ls-blame__no" aria-hidden="true">{l.number}</span>
                  <code className="ls-blame__code">
                    {highlightLine(l.content, lang).map((tok, idx) => (
                      <span key={idx} className={`ls-tok--${tok.kind}`}>{tok.text}</span>
                    ))}
                  </code>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Search panel
// ---------------------------------------------------------------------------

export function SearchResults({
  matches,
  truncated,
  query,
  refName,
  nav,
}: {
  matches: SearchMatch[]
  truncated: boolean
  query: string
  refName: string
  nav: BrowserNav
}) {
  if (!query.trim()) return null
  if (matches.length === 0) {
    return <EmptyState icon="search" title="No matches" description={`Nothing found for “${query}”.`} />
  }
  return (
    <div className="ls-rb__searchresults" role="region" aria-label="Search results">
      <ul className="ls-rb__searchlist">
        {matches.map((m) => (
          <li key={m.path}>
            <a className="ls-rb__name" href={`#${nav.blob(refName, m.path)}`}>
              <Icon name="file" size={13} /> {m.path}
            </a>
            {m.line_matches?.map((lm) => (
              <a key={lm.line} className="ls-rb__searchhit" href={`#${nav.blob(refName, m.path, lm.line)}`}>
                <span className="ls-rb__searchno">L{lm.line}</span>
                <code>{lm.text}</code>
              </a>
            ))}
          </li>
        ))}
      </ul>
      {truncated && <p className="ls-rb__muted">More matches exist — refine the query.</p>}
    </div>
  )
}

export function ErrorState({ message }: { message: string }) {
  return (
    <EmptyState
      icon="warning"
      title="Could not load"
      description={message}
    />
  )
}

