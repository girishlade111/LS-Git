import { useEffect, useMemo, useState } from 'react'
import { EmptyState } from '../design-system/EmptyState'
import { Icon } from '../design-system/Icon'
import { Input } from '../design-system/Input'
import { projectsApi, type Project } from '../projects/api'
import { repositoryApi, encodePath, type RefsResult } from './api'
import { BranchesView, CompareView, TagsView } from './branches'
import { FileEditorView } from './editor/FileEditorView'
import {
  BlobViewPage,
  BlameViewPage,
  CommitDetailView,
  ErrorState,
  HistoryView,
  SearchResults,
  TreeView,
  type BrowserNav,
} from './views'
import { RefSelector } from './widgets'

export interface BrowserRoute {
  /** tree | blob | commits | commit | blame | search */
  action: string
  ref: string
  path: string
  line: number | null
  page: number
  query: URLSearchParams
}

/**
 * Route adapter: parses the hash-router path into a BrowserRoute.
 * Supports a trailing `#L<n>` line-permalink fragment on blob URLs and
 * `?page=` for paginated listings.
 */
export function RepositoryRoute({
  owner,
  projectPath,
  rawPath,
  query,
}: {
  owner: string
  projectPath: string
  /** Hash-router path WITHOUT the leading '#', e.g. /proj/alice/web/blob/main/src/a.ts */
  rawPath: string
  query: URLSearchParams
}) {
  const lineMatch = /#L(\d+)$/.exec(rawPath)
  const line = lineMatch ? Number(lineMatch[1]) : null
  const cleanPath = rawPath.replace(/#L\d+$/, '')
  const segments = cleanPath.split('/').filter(Boolean)
  const action = segments[3] ?? 'tree'
  // ref + path remain joined; RepositoryBrowser resolves greedily against refs.
  const refAndRest = segments.slice(4).join('/')
  const route: BrowserRoute = {
    action,
    ref: refAndRest,
    path: '',
    line,
    page: Math.max(1, Number(query.get('page') ?? 1)),
    query,
  }
  return <RepositoryBrowser owner={owner} projectPath={projectPath} route={route} />
}

/**
 * Repository code-browser shell: loads project + refs, resolves the ref
 * segment greedily against known branches/tags (branch names may contain '/'),
 * then renders the requested view.
 */
export function RepositoryBrowser({
  owner,
  projectPath,
  route,
}: {
  owner: string
  projectPath: string
  route: BrowserRoute
}) {
  const [project, setProject] = useState<Project | null>(null)
  const [refs, setRefs] = useState<RefsResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    projectsApi.byPath(owner, projectPath)
      .then((p) => { if (alive) setProject(p) })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Project not found') })
    return () => { alive = false }
  }, [owner, projectPath])

  useEffect(() => {
    if (!project) return
    let alive = true
    repositoryApi.refs(project.id)
      .then((r) => { if (alive) setRefs(r) })
      .catch(() => { if (alive) setRefs({ branches: [], tags: [] }) })
    return () => { alive = false }
  }, [project])

  // Greedy ref resolution over remaining segments (longest match wins).
  const resolved = useMemo<{ ref: string; restSegments: string[] }>(() => {
    const raw = route.ref.split('/').filter(Boolean)
    const known: string[] = [
      ...(refs?.branches.map((b) => b.name) ?? []),
      ...(refs?.tags.map((t) => t.name) ?? []),
    ]
    for (let take = Math.min(raw.length, 6); take >= 1; take--) {
      const candidate = decodeURIComponent(raw.slice(0, take).join('/'))
      if (known.includes(candidate)) return { ref: candidate, restSegments: raw.slice(take) }
    }
    // Fall back: first segment is a SHA or unknown ref (server resolves).
    return { ref: decodeURIComponent(raw[0] ?? ''), restSegments: raw.slice(1) }
  }, [route.ref, refs])

  if (error) return <ErrorState message={error} />
  if (!project) {
    return <div className="ls-rb__loading" role="status">Loading repository…</div>
  }

  const nav = makeNav(owner, projectPath)

  function switchRef(next: string) {
    window.location.hash = nav.tree(next, '').replace(/^#/, '')
  }

  return (
    <div className="ls-rb__shell">
      <div className="ls-rb__toolbar">
        {refs && (
          <RefSelector
            branches={refs.branches}
            tags={refs.tags}
            current={resolved.ref || project.default_branch}
            onChange={switchRef}
          />
        )}
        <div className="ls-rb__navlinks">
          {(['tree', 'commits', 'branches', 'tags', 'compare'] as const).map((section) => (
            <a
              key={section}
              className={`ls-rb__navlink${(route.action === section || (section === 'tree' && !['commits', 'branches', 'tags', 'compare', 'search', 'edit', 'new'].includes(route.action))) ? ' ls-rb__navlink--current' : ''}`}
              href={`#${sectionUrl(section)}`}
            >
              {section === 'commits' && <Icon name="clock" size={13} />}
              {section === 'branches' && <Icon name="branch" size={13} />}
              {section === 'tags' && <Icon name="tag" size={13} />}
              {section === 'compare' && <Icon name="merge" size={13} />}
              {labelFor(section)}
            </a>
          ))}
        </div>
      </div>

      <BrowserBody
        project={project}
        owner={owner}
        projectPath={projectPath}
        route={route}
        resolvedRef={resolved.ref || project.default_branch}
        restSegments={resolved.restSegments}
        nav={nav}
      />
    </div>
  )
}

function BrowserBody({
  project,
  owner,
  projectPath: ownerProjectPath,
  route,
  resolvedRef,
  restSegments,
  nav,
}: {
  project: Project
  owner: string
  projectPath: string
  route: BrowserRoute
  resolvedRef: string
  restSegments: string[]
  nav: BrowserNav
}) {
  const path = decodeURIComponent(restSegments.join('/'))
  switch (route.action) {
    case 'tree':
      return (
        <TreeView
          projectId={project.id}
          projectName={project.name}
          refName={resolvedRef}
          path={path}
          page={route.page}
          nav={nav}
        />
      )
    case 'blob':
      if (!path) return <ErrorState message="A file path is required." />
      return (
        <BlobViewPage
          projectId={project.id}
          projectName={project.name}
          refName={resolvedRef}
          path={path}
          line={route.line}
          nav={nav}
        />
      )
    case 'commits':
      return (
        <HistoryView
          projectId={project.id}
          refName={resolvedRef}
          path={route.query.get('path')}
          page={route.page}
          nav={nav}
        />
      )
    case 'commit':
      return <CommitDetailView projectId={project.id} sha={resolvedRef} nav={nav} />
    case 'blame':
      if (!path) return <ErrorState message="A file path is required." />
      return (
        <BlameViewPage
          projectId={project.id}
          projectName={project.name}
          refName={resolvedRef}
          path={path}
          nav={nav}
        />
      )
    case 'search': {
      const q = route.query.get('q') ?? ''
      return (
        <SearchPanel
          projectId={project.id}
          refName={resolvedRef}
          initialQuery={q}
          nav={nav}
        />
      )
    }
    case 'edit':
    case 'new':
      if (route.action === 'edit' && !path) {
        return <EmptyState icon="warning" title="A file path is required" description="Provide the file to edit." />
      }
      return (
        <FileEditorView
          key={`${route.action}:${resolvedRef}:${path}`}
          projectId={project.id}
          projectName={project.name}
          projectPath={`${owner}/${ownerProjectPath}`}
          defaultBranch={project.default_branch}
          refName={resolvedRef}
          path={path}
          mode={route.action === 'edit' ? 'edit' : 'new'}
          navigate={(to) => { window.location.hash = to.replace(/^#/, '') }}
        />
      )
    default:
      return <EmptyState icon="warning" title="Unknown view" description={`'${route.action}' is not a repository browser section.`} />
  }
}

/** Find-file panel: filename search with opt-in content grep. */
function SearchPanel({
  projectId,
  refName,
  initialQuery,
  nav,
}: {
  projectId: number
  refName: string
  initialQuery: string
  nav: BrowserNav
}) {
  const [query, setQuery] = useState(initialQuery)
  const [content, setContent] = useState(false)
  const [matches, setMatches] = useState<import('./api').SearchMatch[]>([])
  const [truncated, setTruncated] = useState(false)
  const [searched, setSearched] = useState(false)

  async function run(q: string, withContent: boolean) {
    try {
      const res = await repositoryApi.search(projectId, refName, q, withContent)
      setMatches(res.matches)
      setTruncated(res.truncated)
      setSearched(true)
    } catch {
      setMatches([])
      setSearched(true)
    }
  }

  return (
    <section aria-label="Find files" className="ls-rb">
      <form
        className="ls-rb__searchbar"
        onSubmit={(e) => { e.preventDefault(); void run(query, content) }}
      >
        <Input
          label="Search repository"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="File name or content…"
          autoFocus
        />
        <label className="ls-checkbox">
          <input type="checkbox" checked={content} onChange={(e) => setContent(e.target.checked)} />
          Also search contents
        </label>
        <button type="submit" className="ls-btn ls-btn--sm ls-btn--primary">Search</button>
      </form>
      {searched && <SearchResults matches={matches} truncated={truncated} query={query} refName={refName} nav={nav} />}
    </section>
  )
}

/** Canonical URL builders for the browser's own scheme. */
export function makeNav(owner: string, projectPath: string): BrowserNav & { searchUrl: (ref: string) => string } {
  const base = `/proj/${encodeURIComponent(owner)}/${encodeURIComponent(projectPath)}`
  const enc = (s: string) => encodeURIComponent(s)
  return {
    tree: (ref, p, page) =>
      `${base}/tree/${enc(ref)}${p ? `/${encodePath(p)}` : ''}${page && page > 1 ? `?page=${page}` : ''}`,
    blob: (ref, p, line) =>
      `${base}/blob/${enc(ref)}${p ? `/${encodePath(p)}` : ''}${line ? `#L${line}` : ''}`,
    history: (ref) => `${base}/commits/${enc(ref)}`,
    fileHistory: (ref, p) => `${base}/commits/${enc(ref)}?path=${encodePath(p)}`,
    commit: (sha) => `${base}/commit/${enc(sha)}`,
    blame: (ref, p) => `${base}/blame/${enc(ref)}/${encodePath(p)}`,
    searchUrl: (ref) => `${base}/search/${enc(ref)}`,
    edit: (ref, p) => `${base}/edit/${enc(ref)}/${encodePath(p)}`,
    createFile: (ref, dir) => `${base}/new/${enc(ref)}${dir ? `/${encodePath(dir)}` : ''}`,
  }
}
