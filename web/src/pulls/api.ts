/**
 * Pull request API client (server/src/http/routes/pullRequests.ts).
 * GitLab Merge Request semantics on LSGit naming.
 */

import type { LabelRef, MilestoneRef, Note, Pagination, UserBrief } from '../issues/api'

export type PrState = 'opened' | 'closed' | 'merged'
export type MergeMethod = 'merge' | 'squash' | 'rebase'

export interface PullRequest {
  id: number
  iid: number
  project_id: number
  title: string
  description: string
  state: PrState
  draft: boolean
  author: UserBrief | null
  source_branch: string
  target_branch: string
  assignees: Array<UserBrief | null>
  reviewers: Array<UserBrief & { review_state: 'unreviewed' | 'approved' | 'changes_requested' }>
  labels: LabelRef[]
  milestone: { id: number; title: string; due_date: string | null; state: string } | null
  linked_issue_iids: number[]
  approvals: { count: number; required: number; user_ids: number[] }
  merge_status: 'unchecked' | 'can_be_merged' | 'cannot_be_merged'
  merge_status_reason: string | null
  merge_commit_sha: string | null
  squash_commit_sha: string | null
  closed_at: string | null
  closed_by: UserBrief | null
  merged_at: string | null
  merged_by: UserBrief | null
  web_path: string
  created_at: string
  updated_at: string
}

export interface Mergeability {
  state: PrState
  draft: boolean
  merge_status: PullRequest['merge_status']
  merge_status_reason: string | null
  approvals: { count: number; required: number; user_ids: number[] }
  can_merge: boolean
  blockers: Array<{ code: string; message: string }>
}

export interface CommitRow {
  sha: string
  short_sha: string
  title: string
  message: string
  author_name: string
  author_email: string
  committed_at: string
  parents: string[]
}

export interface ChangedFile {
  path: string
  kind: 'added' | 'modified' | 'deleted'
  patch?: string
  stats?: { added: number; removed: number }
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
  if (!res.ok) throw new Error(String((data as { message?: string }).message ?? 'Request failed'))
  return data as T
}

function base(projectId: number): string {
  return `/api/v1/projects/${projectId}/pull_requests`
}

export const pullsApi = {
  list: (
    projectId: number,
    f: { state?: string; draft?: boolean; search?: string; page?: number; per_page?: number; sort?: string } = {},
  ) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(f)) {
      if (v !== undefined && v !== '' && !(k === 'state' && v === 'all') && !(k === 'page' && Number(v) <= 1)) q.set(k, String(v))
    }
    const qs = q.toString()
    return request<{ pull_requests: PullRequest[]; pagination: Pagination }>(`${base(projectId)}${qs ? `?${qs}` : ''}`)
  },
  byIid: (projectId: number, iid: number) => request<PullRequest>(`${base(projectId)}/${iid}`),
  create: (
    projectId: number,
    input: { title: string; description?: string; source_branch: string; target_branch: string; draft?: boolean },
  ) => request<PullRequest>(base(projectId), 'POST', input),
  update: (projectId: number, iid: number, patch: Record<string, unknown>) =>
    request<PullRequest>(`${base(projectId)}/${iid}`, 'PATCH', patch),
  close: (projectId: number, iid: number) => request<PullRequest>(`${base(projectId)}/${iid}/close`, 'POST', {}),
  reopen: (projectId: number, iid: number) => request<PullRequest>(`${base(projectId)}/${iid}/reopen`, 'POST', {}),
  mergeability: (projectId: number, iid: number) => request<Mergeability>(`${base(projectId)}/${iid}/mergeability`),
  merge: (projectId: number, iid: number, payload: { method: MergeMethod; should_remove_source_branch?: boolean }) =>
    request<PullRequest & { new_tip?: string }>(`${base(projectId)}/${iid}/merge`, 'POST', payload),
  setReviewers: (projectId: number, iid: number, reviewerIds: number[]) =>
    request<PullRequest>(`${base(projectId)}/${iid}/reviewers`, 'PUT', { reviewer_ids: reviewerIds }),
  approve: (projectId: number, iid: number) => request<PullRequest>(`${base(projectId)}/${iid}/approve`, 'POST', {}),
  unapprove: (projectId: number, iid: number) => request<PullRequest>(`${base(projectId)}/${iid}/unapprove`, 'POST', {}),
  commits: (projectId: number, iid: number) =>
    request<{ commits: CommitRow[]; count: number }>(`${base(projectId)}/${iid}/commits`),
  changes: (projectId: number, iid: number, withPatches: boolean) =>
    request<{ merge_base: string | null; files: ChangedFile[] }>(
      `${base(projectId)}/${iid}/changes${withPatches ? '?with_patches=1' : ''}`,
    ),
  timeline: (projectId: number, iid: number) =>
    request<{ notes: Array<Omit<Note, 'reactions'>> }>(`${base(projectId)}/${iid}/notes`),
  comment: (projectId: number, iid: number, body: string) =>
    request<Note>(`${base(projectId)}/${iid}/notes`, 'POST', { body }),
}
