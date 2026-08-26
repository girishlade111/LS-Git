/**
 * Release API client (server/src/http/routes/releases.ts).
 * GitLab release/tag behavior on LSGit naming.
 */

export interface ReleaseAsset {
  id: number
  filename: string
  size: number
  sha256: string
  content_type: string
  download_url: string
}

export interface Release {
  id: number
  tag_name: string
  name: string
  description: string
  state: 'draft' | 'published'
  is_prerelease: boolean
  released_at: string | null
  author: { id: number; username: string; name: string | null } | null
  created_at: string
  updated_at: string
  asset_count: number
  assets_path: string
  draft?: boolean
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
  return `/api/v1/projects/${projectId}/releases`
}

const enc = encodeURIComponent

export const releasesApi = {
  list: (projectId: number) => request<{ releases: Release[] }>(base(projectId)),
  latest: (projectId: number) => request<{ release: Release; is_prerelease_fallback: boolean }>(`${base(projectId)}/latest`),
  get: (projectId: number, tag: string) => request<{ release: Release & { assets: ReleaseAsset[] } }>(`${base(projectId)}/${enc(tag)}`),
  create: (
    projectId: number,
    input: { tag_name: string; ref?: string; name?: string; description?: string; prerelease?: boolean; draft?: boolean; tag_message?: string },
  ) => request<{ release: Release }>(base(projectId), 'POST', input),
  update: (projectId: number, tag: string, patch: Record<string, unknown>) =>
    request<{ release: Release }>(`${base(projectId)}/${enc(tag)}`, 'PATCH', patch),
  remove: (projectId: number, tag: string) => request<{ ok: true }>(`${base(projectId)}/${enc(tag)}`, 'DELETE'),
  generateNotes: (projectId: number, tag: string, previousTag?: string) =>
    request<{ markdown: string; commit_count: number; merged_prs: number }>(
      `${base(projectId)}/${enc(tag)}/notes/generate`,
      'POST',
      previousTag ? { previous_tag: previousTag } : {},
    ),
  /** Raw octet-stream upload; the logical MIME travels in ?content_type=. */
  uploadAsset: async (projectId: number, tag: string, file: File): Promise<{ replaced: boolean }> => {
    const qs = new URLSearchParams({ filename: file.name })
    if (file.type) qs.set('content_type', file.type)
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream' }
    for (const part of document.cookie.split(';')) {
      const eq = part.indexOf('=')
      if (part.slice(0, eq).trim() === 'lsgit_csrf') {
        headers['x-csrf-token'] = decodeURIComponent(part.slice(eq + 1).trim())
        break
      }
    }
    const res = await fetch(`${base(projectId)}/${enc(tag)}/assets?${qs.toString()}`, {
      method: 'PUT',
      headers,
      credentials: 'same-origin',
      body: await file.arrayBuffer(),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new Error(String((data as { message?: string }).message ?? 'Upload failed'))
    return data as { replaced: boolean }
  },
  deleteAsset: (projectId: number, tag: string, filename: string) =>
    request<{ ok: true }>(`${base(projectId)}/${enc(tag)}/assets/${enc(filename)}`, 'DELETE'),
}
