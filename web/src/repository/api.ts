import type { Project } from '../projects/api'

/**
 * Repository browser API client (server/src/http/routes/repository.ts).
 * All URLs are LSGit's own stable scheme; `:ref` accepts branches, tags and
 * full SHAs — a SHA in the ref position is the permalink form.
 */

export interface CommitView {
  sha: string
  short_sha: string
  message: string
  title: string
  author_name: string
  author_email: string
  committed_at: string
  parents: string[]
}

export interface TreeEntry {
  name: string
  path: string
  type: 'tree' | 'blob'
  mode: string
  sha: string
}

export interface Crumb {
  name: string
  path: string
}

export interface TreeResult {
  ref: string
  resolved_sha: string
  resolved_via: string
  path: string
  breadcrumbs: Crumb[]
  tip_commit: CommitView | null
  entries: TreeEntry[]
  pagination: { page: number; per_page: number; total: number; has_more: boolean }
  empty_repository: boolean
}

export interface BlobResult {
  ref: string
  resolved_sha: string
  resolved_via: string
  commit: CommitView
  path: string
  name: string
  dir: string
  breadcrumbs: Crumb[]
  mode: 'regular' | 'executable'
  sha: string
  size: number
  is_binary: boolean
  too_large: boolean
  text: string | null
  line_count: number | null
}

export interface BranchInfo {
  name: string
  sha: string
  default: boolean
  protected: boolean
}

export interface TagInfo {
  name: string
  sha: string
  annotated: boolean
  target: string
}

export interface RefsResult {
  branches: BranchInfo[]
  tags: TagInfo[]
}

export interface HistoryCommit extends CommitView {
  kind: 'added' | 'modified' | 'deleted'
}

export interface BlameRange {
  start_line: number
  end_line: number
  commit_sha: string
}

export interface BlameResult {
  ref: string
  resolved_sha: string
  path: string
  ranges: BlameRange[]
  lines: Array<{ number: number; content: string; commit_sha: string }>
}

export interface CommitDetail extends CommitView {
  changed_files: Array<{ path: string; kind: 'added' | 'modified' | 'deleted' }>
  stats: { added: number; modified: number; deleted: number }
  lists_truncated: boolean
}

export interface SearchMatch {
  path: string
  type: 'blob'
  sha: string
  line_matches?: Array<{ line: number; text: string }>
}

export interface BranchBrowseInfo extends BranchInfo {
  title: string
  author_name: string
  committed_at: string
}

export interface CompareFile {
  path: string
  kind: 'added' | 'modified' | 'deleted'
  patch?: string
  stats?: { added: number; removed: number }
}

export interface CompareResult {
  from: { ref: string; sha: string }
  to: { ref: string; sha: string }
  merge_base: string | null
  ahead: CommitView[]
  behind: CommitView[]
  commits_ahead_count: number
  commits_behind_count: number
  files: CompareFile[]
}

export interface CommitDiffFile {
  path: string
  kind: 'added' | 'modified' | 'deleted'
  patch: string
  stats: { added: number; removed: number }
}

async function request<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (!['GET', 'HEAD'].includes(method)) {
    for (const part of document.cookie.split(';')) {
      const eq = part.indexOf('=')
      if (part.slice(0, eq).trim() === 'lsgit_csrf') {
        headers['x-csrf-token'] = decodeURIComponent(part.slice(eq + 1).trim())
        break
      }
    }
  }
  const res = await fetch(url, { method, headers, credentials: 'same-origin', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new Error(String(data.message ?? 'Request failed'))
  return data as T
}

function repoBase(projectId: number): string {
  return `/api/v1/projects/${projectId}/repository`
}

/** Encodes each path segment individually so slashes stay structural. */
export function encodePath(path: string): string {
  return path.split('/').map((s) => encodeURIComponent(s)).join('/')
}

export const repositoryApi = {
  refs: (projectId: number) => request<RefsResult>(`${repoBase(projectId)}/refs`),
  tree: (
    projectId: number,
    ref: string,
    path: string,
    opts: { page?: number; perPage?: number } = {},
  ) => {
    const q = new URLSearchParams()
    if (path) q.set('path', path)
    if (opts.page && opts.page > 1) q.set('page', String(opts.page))
    if (opts.perPage) q.set('per_page', String(opts.perPage))
    const qs = q.toString()
    return request<TreeResult>(`${repoBase(projectId)}/tree/${encodeURIComponent(ref)}${qs ? `?${qs}` : ''}`)
  },
  blob: (projectId: number, ref: string, path: string) =>
    request<BlobResult>(`${repoBase(projectId)}/blob/${encodeURIComponent(ref)}/${encodePath(path)}`),
  history: (projectId: number, ref: string, path: string | null, opts: { page?: number; perPage?: number } = {}) => {
    const q = new URLSearchParams()
    if (path) q.set('path', path)
    if (opts.page && opts.page > 1) q.set('page', String(opts.page))
    if (opts.perPage) q.set('per_page', String(opts.perPage))
    return request<{ ref: string; commits: CommitView[]; pagination?: { page: number; per_page: number; total: number; has_more: boolean } | null }>(
      `${repoBase(projectId)}/commits/${encodeURIComponent(ref)}?${q.toString()}`,
    )
  },
  fileHistory: (projectId: number, ref: string, path: string) =>
    request<{ ref: string; path: string; commits: HistoryCommit[] }>(
      `${repoBase(projectId)}/commits/${encodeURIComponent(ref)}?path=${encodeURIComponent(path)}`,
    ),
  commit: (projectId: number, sha: string) =>
    request<CommitDetail>(`${repoBase(projectId)}/commit/${encodeURIComponent(sha)}`),
  blame: (projectId: number, ref: string, path: string) =>
    request<BlameResult>(`${repoBase(projectId)}/blame/${encodeURIComponent(ref)}/${encodePath(path)}`),
  search: (projectId: number, ref: string, query: string, content = false) =>
    request<{ ref: string; query: string; matches: SearchMatch[]; truncated: boolean }>(
      `${repoBase(projectId)}/search/${encodeURIComponent(ref)}?q=${encodeURIComponent(query)}${content ? '&content=1' : ''}`,
    ),
  /** Points the browser at the raw endpoint (inline view or download). */
  rawUrl: (projectId: number, ref: string, path: string) =>
    `${repoBase(projectId)}/raw/${encodeURIComponent(ref)}/${encodePath(path)}`,
  downloadUrl: (projectId: number, ref: string, dirPath: string | null) =>
    dirPath
      ? `${repoBase(projectId)}/download/${encodeURIComponent(ref)}/${encodePath(dirPath)}`
      : `${repoBase(projectId)}/download/${encodeURIComponent(ref)}`,
  // -- branch/tag management ------------------------------------------------
  branches: (projectId: number, opts: { search?: string; sort?: 'name' | 'recent' } = {}) => {
    const q = new URLSearchParams()
    if (opts.search) q.set('search', opts.search)
    if (opts.sort && opts.sort !== 'name') q.set('sort', opts.sort)
    const qs = q.toString()
    return request<{ branches: BranchBrowseInfo[] }>(`${repoBase(projectId)}/branches${qs ? `?${qs}` : ''}`)
  },
  createBranch: (projectId: number, name: string, startPoint: string | null) =>
    request<{ branch: string; commit_sha: string }>(`${repoBase(projectId)}/branches`, 'POST', {
      name,
      ...(startPoint ? { start_point: startPoint } : {}),
    }),
  deleteBranch: (projectId: number, name: string, expectedOld?: string | null) =>
    request<{ ok: boolean }>(
      `${repoBase(projectId)}/branches/${encodePath(name)}${expectedOld ? `?expected_old=${encodeURIComponent(expectedOld)}` : ''}`,
      'DELETE',
    ),
  renameBranch: (projectId: number, name: string, newName: string) =>
    request<{ from: string; to: string; sha: string }>(`${repoBase(projectId)}/branches/rename`, 'POST', { name, new_name: newName }),
  setDefaultBranch: (projectId: number, name: string) =>
    request<{ default_branch: string; previous: string }>(`${repoBase(projectId)}/default_branch`, 'PUT', { name }),
  compare: (projectId: number, from: string, to: string, withPatches = false) =>
    request<CompareResult>(
      `${repoBase(projectId)}/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${withPatches ? '&with_patches=1' : ''}`,
    ),
  commitDiff: (projectId: number, sha: string) =>
    request<{ commit_sha: string; parent_sha: string | null; files: CommitDiffFile[] }>(
      `${repoBase(projectId)}/commit/${encodeURIComponent(sha)}/diff`,
    ),
  tagsList: (projectId: number) => request<{ tags: TagInfo[] }>(`${repoBase(projectId)}/tags`),
  createTag: (projectId: number, name: string, refName: string, message: string | null) =>
    request<{ name: string; annotated: boolean; target: string }>(`${repoBase(projectId)}/tags`, 'POST', {
      name,
      ref: refName,
      ...(message ? { message } : {}),
    }),
  deleteTag: (projectId: number, name: string) =>
    request<{ ok: boolean }>(`${repoBase(projectId)}/tags/${encodePath(name)}`, 'DELETE'),
}

export type { Project }
