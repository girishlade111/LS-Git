/** Client for the staged upload workflow: initiate → PUT (progress/retry/abort) → commit. */

import type { Project } from './api'

export interface UploadCommitOptions {
  branch?: string
  newBranch?: string
  startBranch?: string
  commitMessage: string
  replace: boolean
  createMergeRequest?: boolean
}

function csrfToken(): string {
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=')
    if (part.slice(0, eq).trim() === 'lsgit_csrf') return decodeURIComponent(part.slice(eq + 1).trim())
  }
  throw new Error('Missing session')
}

async function json<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const err = new Error(String(data.message ?? 'Request failed')) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return data as T
}

export class Uploader {
  private xhr: XMLHttpRequest | null = null

  abort(): void {
    this.xhr?.abort()
    this.xhr = null
  }

  /** Step 1: initiate — returns whether the target file already exists. */
  async initiate(projectId: number, filePath: string, size: number): Promise<{ uploadId: string; exists: boolean }> {
    const res = await fetch(`/api/v1/projects/${projectId}/uploads/initiate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() },
      credentials: 'same-origin',
      body: JSON.stringify({ file_path: filePath, size }),
    })
    const body = await json<{ uploadId: string; exists: boolean }>(res)
    return { uploadId: body.uploadId, exists: body.exists }
  }

  /** Step 2: transfer bytes with progress. Resolves when stored; rejects on failure/abort. */
  transfer(
    projectId: number,
    uploadId: string,
    file: File,
    onProgress: (sentBytes: number, totalBytes: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      this.xhr = xhr
      xhr.open('PUT', `/api/v1/projects/${projectId}/uploads/${uploadId}`)
      xhr.setRequestHeader('content-type', 'application/octet-stream')
      xhr.setRequestHeader('x-csrf-token', csrfToken())
      xhr.withCredentials = true
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total)
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve()
        else {
          let message = 'Upload failed'
          try {
            message = String(JSON.parse(xhr.responseText).message ?? message)
          } catch { /* keep default */ }
          reject(Object.assign(new Error(message), { status: xhr.status }))
        }
      }
      xhr.onerror = () => reject(new Error('Network error during upload'))
      xhr.onabort = () => reject(Object.assign(new Error('cancelled'), { cancelled: true }))
      xhr.send(file)
    })
  }

  /** Step 3: commit onto a branch (or a new branch forked from start). */
  static async commit(
    projectId: number,
    uploadId: string,
    project: Project,
    opts: UploadCommitOptions,
  ): Promise<{ commit_sha: string; branch: string; replaced: boolean; merge_request_note: string }> {
    const res = await fetch(`/api/v1/projects/${projectId}/uploads/${uploadId}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken() },
      credentials: 'same-origin',
      body: JSON.stringify({
        branch: opts.newBranch ? undefined : (opts.branch ?? project.default_branch),
        new_branch: opts.newBranch,
        start_branch: opts.newBranch ? (opts.startBranch ?? project.default_branch) : undefined,
        commit_message: opts.commitMessage,
        replace: opts.replace,
        create_merge_request: opts.createMergeRequest ?? false,
      }),
    })
    const body = await json<{
      commit_sha: string
      branch: string
      replaced: boolean
      merge_request: { created: false; reason: string }
    }>(res)
    return {
      commit_sha: body.commit_sha,
      branch: body.branch,
      replaced: body.replaced,
      merge_request_note: body.merge_request.reason,
    }
  }

  static cancel(projectId: number, uploadId: string): Promise<void> {
    return fetch(`/api/v1/projects/${projectId}/uploads/${uploadId}`, {
      method: 'DELETE',
      headers: { 'x-csrf-token': csrfToken() },
      credentials: 'same-origin',
    }).then(() => undefined)
  }
}
