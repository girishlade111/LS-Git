import { discardDraft, loadDraft, saveDraft } from './drafts'

/**
 * Multi-file editing session — the in-memory buffer set behind the web IDE
 * foundation. Each buffer tracks its base (content + ref tip at load) and the
 * working copy; dirty buffers commit together as ONE atomic git commit.
 */

export interface EditBuffer {
  key: string
  projectId: number
  ref: string
  path: string
  /** Content at load time ('' for new files). */
  baseContent: string
  /** Ref tip when loaded — the optimistic-concurrency anchor. */
  baseTip: string | null
  content: string
  isNew: boolean
}

/** Change payloads for RepositoriesService.commitChanges. */
export interface SessionChange {
  path: string
  content?: string
  content_base64?: string
  delete?: boolean
}

type Listener = () => void

class EditSession {
  private buffers = new Map<string, EditBuffer>()
  private listeners = new Set<Listener>()

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  list(): EditBuffer[] {
    return [...this.buffers.values()].sort((a, b) => a.path.localeCompare(b.path))
  }

  get(projectId: number, path: string): EditBuffer | undefined {
    return this.buffers.get(bufferKey(projectId, path))
  }

  open(input: {
    projectId: number
    ref: string
    path: string
    baseContent: string
    baseTip: string | null
    isNew: boolean
    /** Restored draft content (user's prior unsaved work). */
    draftContent?: string
  }): EditBuffer {
    const k = bufferKey(input.projectId, input.path)
    const buffer: EditBuffer = {
      key: k,
      projectId: input.projectId,
      ref: input.ref,
      path: input.path,
      baseContent: input.baseContent,
      baseTip: input.baseTip,
      // A stored draft wins over pristine base content; otherwise start clean.
      content: input.draftContent ?? input.baseContent,
      isNew: input.isNew,
    }
    this.buffers.set(k, buffer)
    this.emit()
    return buffer
  }

  update(projectId: number, path: string, content: string): void {
    const b = this.buffers.get(bufferKey(projectId, path))
    if (!b || b.content === content) return
    b.content = content
    saveDraft({ projectId, path, ref: b.ref, baseTip: b.baseTip, content })
    this.emit()
  }

  isDirty(b: EditBuffer): boolean {
    return b.content !== b.baseContent
  }

  dirtyBuffers(): EditBuffer[] {
    return this.list().filter((b) => this.isDirty(b))
  }

  close(projectId: number, path: string): void {
    this.buffers.delete(bufferKey(projectId, path))
    this.emit()
  }

  /** Drops the draft but keeps editing state in memory. */
  discardDraft(projectId: number, path: string): void {
    const b = this.buffers.get(bufferKey(projectId, path))
    if (!b) return
    discardDraft(projectId, path)
    this.emit()
  }

  /** Restores persisted work into a buffer (draft recovery flow). */
  restoreDraft(projectId: number, path: string): EditBuffer | null {
    const draft = loadDraft(projectId, path)
    if (!draft) return null
    const existing = this.buffers.get(bufferKey(projectId, path))
    if (existing) {
      existing.content = draft.content
      existing.baseTip = draft.baseTip
      this.emit()
      return existing
    }
    return null // caller opens a fresh buffer with draft content instead
  }

  clearAll(projectId: number): void {
    for (const b of this.buffers.values()) {
      if (b.projectId !== projectId) continue
      discardDraft(projectId, b.path)
    }
    this.buffers.clear()
    this.emit()
  }

  /** Change set for the commit call — renames become move pairs upstream. */
  toChanges(): Array<SessionChange & { path: string }> {
    return this.dirtyBuffers().map((b) => ({
      path: b.path,
      ...(b.content === '' && !b.isNew ? {} : { content: b.content }),
      ...(b.isNew ? {} : {}),
    }))
  }
}

export function bufferKey(projectId: number, path: string): string {
  return `${projectId}:${path}`
}

/** Module-level session: survives route changes within the SPA lifetime. */
export const editSession = new EditSession()
