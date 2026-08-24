/**
 * FolderUploadSession — the client half of the upload session abstraction.
 *
 * Owns the manifest, a small worker pool (concurrency 3) driving
 * initiate → transfer → (finalize happens once per batch from the dialog),
 * and a throttled external store so React re-renders at most every ~120ms
 * even with thousands of items streaming progress events.
 *
 * Pause is technically safe because each file transfer is an atomic PUT:
 * pausing stops scheduling new transfers while in-flight ones complete.
 * Cancel aborts in-flight XHRs and destroys every server staging slot.
 */

import type { BatchLimits, ManifestItem } from './folderUpload'
import { formatBytes } from './folderUpload'

export type SessionPhase =
  | 'ready'      // manifest built; not started
  | 'running'
  | 'paused'
  | 'awaiting-commit' // all transfers settled; commit screen shown
  | 'finalizing'
  | 'committed'
  | 'cancelled'

export interface SessionStats {
  totalFiles: number
  totalBytes: number
  completed: number
  failed: number
  skipped: number
  remaining: number
  transferredBytes: number
  currentPath: string | null
}

export interface SessionSnapshot {
  phase: SessionPhase
  items: readonly ManifestItem[]
  stats: SessionStats
}

export interface CommitRequest {
  branch?: string
  newBranch?: string
  startBranch?: string
  commitMessage: string
  replace: boolean
  createMergeRequest?: boolean
}

export interface FinalizeOutcome {
  branch: string
  commitSha: string
  committedFiles: number
  identicalSkipped: number
  replacedCount: number
  mergeRequestNote: string
}

function csrfToken(): string {
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=')
    if (part.slice(0, eq).trim() === 'lsgit_csrf') return decodeURIComponent(part.slice(eq + 1).trim())
  }
  throw new Error('Missing session')
}

async function requestJson<T>(
  url: string,
  init: RequestInit & { body?: BodyInit | null },
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { ...(init.headers ?? {}), 'x-csrf-token': csrfToken() },
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw Object.assign(new Error(String(data.message ?? 'Request failed')), {
      status: res.status,
      code: data.code,
      conflictPaths: data.conflict_paths,
      pendingPaths: data.pending_paths,
    })
  }
  return data as T
}

const HASH_MAX_BYTES = 8 * 1024 * 1024

async function sha256Hex(file: File): Promise<string | null> {
  if (file.size > HASH_MAX_BYTES || typeof crypto?.subtle === 'undefined') return null
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

export class FolderUploadSession {
  private items: ManifestItem[]
  private fileMap = new Map<string, File>()
  private batchId: string | null = null
  private limits: BatchLimits
  private phase: SessionPhase = 'ready'
  private paused = false
  private cancelled = false
  private xhrByItemId = new Map<string, XMLHttpRequest>()
  private listeners = new Set<() => void>()
  private notifyTimer: ReturnType<typeof setTimeout> | null = null
  private snapshotCache: SessionSnapshot | null = null
  readonly projectId: number

  constructor(projectId: number, entries: Array<{ item: ManifestItem; file: File }>, limits: BatchLimits) {
    this.projectId = projectId
    this.items = entries.map((e) => e.item)
    for (const e of entries) this.fileMap.set(e.item.id, e.file)
    this.limits = limits
  }

  get batch(): string | null {
    return this.batchId
  }

  // -- external store ---------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): SessionSnapshot => {
    if (!this.snapshotCache) this.snapshotCache = this.buildSnapshot()
    return this.snapshotCache
  }

  private buildSnapshot(): SessionSnapshot {
    let completed = 0
    let failed = 0
    let skipped = 0
    let remaining = 0
    let transferred = 0
    let totalBytes = 0
    let currentPath: string | null = null
    for (const it of this.items) {
      switch (it.status) {
        case 'completed':
          completed += 1
          break
        case 'failed':
          failed += 1
          remaining += 1
          break
        case 'skipped':
          skipped += 1
          break
        case 'uploading':
          currentPath = currentPath ?? it.relativePath
          remaining += 1
          break
        default:
          remaining += 1
      }
      transferred += it.status === 'completed' ? it.size : it.sentBytes
      if (it.status !== 'skipped') totalBytes += it.size
    }
    return {
      phase: this.phase,
      items: [...this.items],
      stats: {
        totalFiles: this.items.filter((i) => i.status !== 'skipped').length,
        totalBytes,
        completed,
        failed,
        skipped,
        remaining,
        transferredBytes: transferred,
        currentPath,
      },
    }
  }

  /** Coalesced notification — keeps React cheap during byte-level progress. */
  private notify(): void {
    this.snapshotCache = null
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      for (const l of this.listeners) l()
    }, 120)
  }

  private setItem(id: string, patch: Partial<ManifestItem>): void {
    const item = this.items.find((i) => i.id === id)
    if (!item) return
    Object.assign(item, patch)
    this.notify()
  }

  // -- lifecycle ----------------------------------------------------------------

  async start(): Promise<void> {
    if (this.phase !== 'ready') return
    this.phase = 'running'
    this.notify()

    try {
      const created = await requestJson<{ batchId: string }>(
        `/api/v1/projects/${this.projectId}/uploads/batches`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            file_count: this.stats().totalFiles,
            total_bytes: this.stats().totalBytes,
          }),
        },
      )
      this.batchId = created.batchId
    } catch (err) {
      this.failAll(err as Error)
      return
    }

    await this.runPool()
    if (this.cancelled) return
    this.phase = 'awaiting-commit'
    this.notify()
  }

  /** Worker pool over queued items; returns when the queue drains or cancel fires. */
  private async runPool(): Promise<void> {
    const queue = this.items.filter((i) => i.status === 'queued')
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (!this.cancelled) {
        if (this.paused) {
          await new Promise((r) => setTimeout(r, 150))
          continue
        }
        const item = queue[cursor]
        cursor += 1
        if (!item) return
        await this.processItem(item)
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker))
  }

  pause(): void {
    if (this.phase === 'running') {
      this.paused = true
      this.phase = 'paused'
      this.notify()
    }
  }

  resume(): void {
    if (this.phase === 'paused') {
      this.paused = false
      this.phase = 'running'
      this.notify()
    }
  }

  /** Aborts everything: in-flight XHRs, server slots, and the session row. */
  cancel(): void {
    if (['committed', 'cancelled'].includes(this.phase)) return
    this.cancelled = true
    this.paused = false
    for (const xhr of this.xhrByItemId.values()) xhr.abort()
    this.xhrByItemId.clear()
    const projectId = this.projectId
    for (const item of this.items) {
      if (item.serverUploadId && !['completed', 'cancelled'].includes(item.status)) {
        item.status = 'skipped'
        item.note = 'Cancelled'
        void fetch(`/api/v1/projects/${projectId}/uploads/${item.serverUploadId}`, {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: { 'x-csrf-token': csrfToken() },
        }).catch(() => undefined)
      }
    }
    if (this.batchId) {
      void fetch(`/api/v1/projects/${projectId}/uploads/batches/${this.batchId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': csrfToken() },
      }).catch(() => undefined)
    }
    this.phase = 'cancelled'
    this.notify()
  }

  /** Removes one queued/failed item from the queue (never a committed one). */
  removeItem(id: string): void {
    const item = this.items.find((i) => i.id === id)
    if (!item || ['completed', 'uploading', 'hashing'].includes(item.status)) return
    this.xhrByItemId.get(id)?.abort()
    if (item.serverUploadId) {
      void fetch(`/api/v1/projects/${this.projectId}/uploads/${item.serverUploadId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': csrfToken() },
      }).catch(() => undefined)
    }
    item.status = 'skipped'
    item.note = 'Removed'
    this.notify()
  }

  /** Resets failed items to queued and restarts the pool. */
  retryFailed(): void {
    if (this.phase !== 'awaiting-commit' && this.phase !== 'running' && this.phase !== 'paused') return
    let hadFailures = false
    for (const item of this.items) {
      if (item.status === 'failed') {
        item.status = 'queued'
        item.sentBytes = 0
        item.note = undefined
        hadFailures = true
      }
    }
    if (!hadFailures) return
    this.phase = 'running'
    this.paused = false
    this.notify()
    void this.runPool().then(() => {
      if (this.cancelled) return
      if (!this.items.some((i) => i.status === 'queued' || i.status === 'hashing' || i.status === 'uploading')) {
        this.phase = 'awaiting-commit'
      }
      this.notify()
    })
  }

  /**
   * Commits the whole staged batch as ONE server-side commit. Conflict
   * responses surface `conflictPaths` so the UI can prompt for replace.
   */
  async finalize(opts: CommitRequest): Promise<FinalizeOutcome> {
    if (this.phase !== 'awaiting-commit' || !this.batchId) {
      throw new Error('Upload session is not ready to commit')
    }
    this.phase = 'finalizing'
    this.notify()
    try {
      const result = await requestJson<{
        branch: string
        commit_sha: string
        committed_files: number
        identical_skipped: number
        replaced_count: number
        merge_request: { reason: string }
      }>(`/api/v1/projects/${this.projectId}/uploads/batches/${this.batchId}/finalize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          branch: opts.newBranch ? undefined : (opts.branch ?? undefined),
          new_branch: opts.newBranch,
          start_branch: opts.newBranch ? (opts.startBranch ?? undefined) : undefined,
          commit_message: opts.commitMessage,
          replace: opts.replace,
          create_merge_request: opts.createMergeRequest ?? false,
        }),
      })
      this.phase = 'committed'
      this.notify()
      return {
        branch: result.branch,
        commitSha: result.commit_sha,
        committedFiles: result.committed_files,
        identicalSkipped: result.identical_skipped,
        replacedCount: result.replaced_count,
        mergeRequestNote: result.merge_request.reason,
      }
    } catch (err) {
      this.phase = 'awaiting-commit'
      this.notify()
      throw err
    }
  }

  stats(): SessionStats {
    return this.getSnapshot().stats
  }

  // -- per-item pipeline ----------------------------------------------------------

  private async processItem(item: ManifestItem): Promise<void> {
    if (this.cancelled || item.status !== 'queued') return
    try {
      // Hash small files for integrity display ("hash when appropriate").
      this.setItem(item.id, { status: 'hashing' })
      const hash = await sha256Hex(this.fileOf(item))

      // Server slot (validates path authoritatively).
      this.setItem(item.id, { status: 'hashing' })
      const init = await requestJson<{ uploadId: string }>(
        `/api/v1/projects/${this.projectId}/uploads/initiate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            file_path: item.relativePath,
            size: item.size,
            batch_id: this.batchId,
          }),
        },
      )
      item.serverUploadId = init.uploadId
      item.hash = hash
      this.setItem(item.id, { status: 'uploading', sentBytes: 0 })

      await this.transfer(item)
      this.setItem(item.id, { status: 'completed', sentBytes: item.size })
    } catch (err) {
      const e = err as Error & { status?: number; cancelled?: boolean }
      if (e.cancelled || this.cancelled) {
        item.status = item.status === 'completed' ? item.status : 'skipped'
        item.note = item.note ?? 'Cancelled'
        this.notify()
        return
      }
      this.setItem(item.id, {
        status: 'failed',
        note: e.message === 'size_mismatch' ? 'Transfer interrupted — retry' : e.message,
      })
    }
  }

  private fileOf(item: ManifestItem): File {
    const f = this.fileMap.get(item.id)
    if (!f) throw new Error('File handle missing')
    return f
  }

  private transfer(item: ManifestItem): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = this.fileOf(item)
      const xhr = new XMLHttpRequest()
      this.xhrByItemId.set(item.id, xhr)
      xhr.open(
        'PUT',
        `/api/v1/projects/${this.projectId}/uploads/${item.serverUploadId}`,
      )
      xhr.setRequestHeader('content-type', 'application/octet-stream')
      xhr.setRequestHeader('x-csrf-token', csrfToken())
      xhr.withCredentials = true
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          item.sentBytes = e.loaded
          this.notify()
        }
      }
      xhr.onload = () => {
        this.xhrByItemId.delete(item.id)
        if (xhr.status >= 200 && xhr.status < 300) return resolve()
        let message = 'Upload failed'
        try {
          message = String(JSON.parse(xhr.responseText).message ?? message)
        } catch {
          /* keep default */
        }
        reject(Object.assign(new Error(message), { status: xhr.status }))
      }
      xhr.onerror = () => {
        this.xhrByItemId.delete(item.id)
        reject(new Error('Network error during upload'))
      }
      xhr.onabort = () => {
        this.xhrByItemId.delete(item.id)
        reject(Object.assign(new Error('Transfer cancelled'), { cancelled: true }))
      }
      xhr.send(file)
    })
  }

  private failAll(err: Error): void {
    for (const item of this.items) {
      if (item.status === 'queued' || item.status === 'hashing' || item.status === 'uploading') {
        item.status = 'failed'
        item.note = err.message
      }
    }
    this.phase = 'awaiting-commit'
    this.notify()
  }
}

export function describeProgress(stats: SessionStats): string {
  return `${formatBytes(stats.transferredBytes)} of ${formatBytes(stats.totalBytes)}`
}
