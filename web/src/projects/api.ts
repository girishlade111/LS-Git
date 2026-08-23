import type { SelfUser } from './api'

export interface Project {
  id: number
  name: string
  path: string
  full_path: string
  visibility: 'private' | 'internal' | 'public'
  description: string
  website_url: string
  default_branch: string
  archived: boolean
  is_template: boolean
  topics: string[]
  owner: { id: number; username: string; name: string | null } | null
  created_at: string
  last_activity_at: string
  repository_empty: boolean
}

export interface Catalog {
  gitignore: string[]
  licenses: Array<{ key: string; name: string }>
}

async function request<T>(url: string, method: string, body?: unknown): Promise<T> {
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

export const projectsApi = {
  catalog: () => request<Catalog>('/api/v1/project_templates/catalog', 'GET'),
  templates: () => request<Project[]>('/api/v1/projects/templates', 'GET'),
  create: (p: Record<string, unknown>) => request<Project>('/api/v1/projects', 'POST', p),
  listMine: () => request<Project[]>('/api/v1/projects', 'GET'),
  explore: (opts: { search?: string; topic?: string }) => {
    const q = new URLSearchParams()
    if (opts.search) q.set('search', opts.search)
    if (opts.topic) q.set('topic', opts.topic)
    const qs = q.toString()
    return request<Project[]>(`/api/v1/projects/explore${qs ? `?${qs}` : ''}`, 'GET')
  },
  byPath: (owner: string, path: string) => request<Project>(`/api/v1/${owner}/${path}`, 'GET'),
  get: (id: number) => request<Project>(`/api/v1/projects/${id}`, 'GET'),
  update: (id: number, p: Record<string, unknown>) => request<Project>(`/api/v1/projects/${id}`, 'PATCH', p),
  archive: (id: number) => request<Project>(`/api/v1/projects/${id}/archive`, 'POST'),
  unarchive: (id: number) => request<Project>(`/api/v1/projects/${id}/unarchive`, 'POST'),
  setTemplate: (id: number, enabled: boolean) => request<Project>(`/api/v1/projects/${id}/template`, 'PUT', { enabled }),
  rename: (id: number, path: string) => request<Project & { redirect_created: boolean }>(`/api/v1/projects/${id}/rename`, 'POST', { path }),
  transfer: (id: number, new_owner: string) => request<Project>(`/api/v1/projects/${id}/transfer`, 'POST', { new_owner }),
  remove: (id: number, confirm_path: string) =>
    request<{ ok: boolean }>(`/api/v1/projects/${id}?confirm_path=${encodeURIComponent(confirm_path)}`, 'DELETE'),
}

export type { SelfUser }
