/**
 * Issues API client (server/src/http/routes/issues.ts).
 * GitLab REST v4-shaped payloads; LSGit URL scheme.
 */

export interface UserBrief {
  id: number
  username: string
  name: string | null
}

export interface LabelRef {
  id: number
  title: string
  color: string
  description: string
}

export interface MilestoneRef {
  id: number
  project_id: number
  title: string
  description: string
  due_date: string | null
  state: 'active' | 'closed'
}

export interface TaskProgress {
  total: number
  completed: number
}

export interface Issue {
  id: number
  iid: number
  project_id: number
  title: string
  description: string
  state: 'opened' | 'closed'
  confidential: boolean
  author: UserBrief | null
  assignees: Array<UserBrief | null>
  labels: LabelRef[]
  milestone: MilestoneRef | null
  task_progress: TaskProgress
  has_tasks: boolean
  due_date: string | null
  closed_at: string | null
  closed_by: UserBrief | null
  web_path: string
  created_at: string
  updated_at: string
}

export interface Pagination {
  page: number
  per_page: number
  total: number
  total_pages: number
  has_more: boolean
}

export interface IssueListResult {
  issues: Issue[]
  pagination: Pagination
}

export interface LabelFull extends LabelRef {
  project_id: number
  scope: 'project' | 'group'
  open_issues_count?: number
  created_at: string
  updated_at: string
}

export interface MilestoneFull extends MilestoneRef {
  merge_requests_count: number
  total_issues?: number
  opened_issues?: number
  closed_issues?: number
  completion_percent?: number
}

export type ReactionSummary = Array<{ name: string; count: number; me: boolean }>

export interface Note {
  id: number
  noteable_type: 'issue'
  noteable_iid: number
  body: string
  system: boolean
  author: UserBrief | null
  reactions: ReactionSummary
  created_at: string
  updated_at: string
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

function issuesBase(projectId: number): string {
  return `/api/v1/projects/${projectId}/issues`
}

export interface IssueFilters {
  state?: 'opened' | 'closed' | 'all'
  labels?: string
  milestone?: string
  assignee_username?: string
  author_username?: string
  search?: string
  order_by?: 'created_at' | 'updated_at'
  sort?: 'asc' | 'desc'
  page?: number
  per_page?: number
}

export const issuesApi = {
  list: (projectId: number, f: IssueFilters = {}) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(f)) {
      if (v !== undefined && v !== '' && !(k === 'state' && v === 'all') && !(k === 'page' && Number(v) <= 1) && !(k === 'per_page' && Number(v) === 20)) {
        q.set(k, String(v))
      }
    }
    const qs = q.toString()
    return request<IssueListResult>(`${issuesBase(projectId)}${qs ? `?${qs}` : ''}`)
  },
  byIid: (projectId: number, iid: number) => request<Issue>(`${issuesBase(projectId)}/${iid}`),
  create: (
    projectId: number,
    input: { title: string; description?: string; confidential?: boolean; assignee_ids?: number[]; labels?: string[]; milestone_id?: number | null },
  ) => request<Issue>(issuesBase(projectId), 'POST', input),
  update: (projectId: number, iid: number, patch: Record<string, unknown>) =>
    request<Issue>(`${issuesBase(projectId)}/${iid}`, 'PATCH', patch),
  close: (projectId: number, iid: number) =>
    request<Issue>(`${issuesBase(projectId)}/${iid}/close`, 'POST', {}),
  reopen: (projectId: number, iid: number) =>
    request<Issue>(`${issuesBase(projectId)}/${iid}/reopen`, 'POST', {}),
  remove: (projectId: number, iid: number) =>
    request<{ ok: boolean }>(`${issuesBase(projectId)}/${iid}`, 'DELETE'),
  toggleTask: (projectId: number, iid: number, index: number) =>
    request<{ task_progress: TaskProgress }>(`${issuesBase(projectId)}/${iid}/tasks/toggle`, 'POST', { index }),
  timeline: (projectId: number, iid: number) =>
    request<{ notes: Note[] }>(`${issuesBase(projectId)}/${iid}/notes`),
  comment: (projectId: number, iid: number, body: string) =>
    request<Note>(`${issuesBase(projectId)}/${iid}/notes`, 'POST', { body }),
  // Reactions (award emoji).
  issueReactions: (projectId: number, iid: number) =>
    request<ReactionSummary>(`${issuesBase(projectId)}/${iid}/award_emoji`),
  toggleIssueReaction: (projectId: number, iid: number, name: string) =>
    request<{ action: 'awarded' | 'revoked'; summary: ReactionSummary }>(
      `${issuesBase(projectId)}/${iid}/award_emoji`, 'POST', { name },
    ),
  toggleNoteReaction: (projectId: number, iid: number, noteId: number, name: string) =>
    request<{ action: 'awarded' | 'revoked'; summary: ReactionSummary }>(
      `${issuesBase(projectId)}/${iid}/notes/${noteId}/award_emoji`, 'POST', { name },
    ),
  // Labels.
  labels: (projectId: number, withCounts = false) =>
    request<LabelFull[]>(`/api/v1/projects/${projectId}/labels${withCounts ? '?with_counts=true' : ''}`),
  createLabel: (projectId: number, input: { title: string; description?: string; color?: string }) =>
    request<LabelFull>(`/api/v1/projects/${projectId}/labels`, 'POST', input),
  updateLabel: (projectId: number, labelId: number, patch: { title?: string; description?: string; color?: string }) =>
    request<LabelFull>(`/api/v1/projects/${projectId}/labels/${labelId}`, 'PATCH', patch),
  deleteLabel: (projectId: number, labelId: number) =>
    request<{ ok: boolean }>(`/api/v1/projects/${projectId}/labels/${labelId}`, 'DELETE'),
  // Milestones.
  milestones: (projectId: number) =>
    request<MilestoneFull[]>(`/api/v1/projects/${projectId}/milestones`),
  createMilestone: (projectId: number, input: { title: string; description?: string; due_date?: string | null }) =>
    request<MilestoneFull>(`/api/v1/projects/${projectId}/milestones`, 'POST', input),
  updateMilestone: (projectId: number, mid: number, patch: Record<string, unknown>) =>
    request<MilestoneFull>(`/api/v1/projects/${projectId}/milestones/${mid}`, 'PATCH', patch),
  deleteMilestone: (projectId: number, mid: number) =>
    request<{ ok: boolean }>(`/api/v1/projects/${projectId}/milestones/${mid}`, 'DELETE'),
}
