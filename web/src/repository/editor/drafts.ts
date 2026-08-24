/**
 * Local draft persistence for the web editor.
 *
 * Drafts live in localStorage under a versioned namespace, keyed by project +
 * path, so an accidental tab close or refresh never loses work. A draft is
 * INDEPENDENT of the branch it started on: restoring always shows what the
 * user typed, while the base tip recorded alongside drives stale-commit
 * detection at commit time.
 */

const NAMESPACE = 'lsgit.editor.draft.v1'
const MAX_DRAFT_BYTES = 2 * 1024 * 1024

export interface StoredDraft {
  path: string
  projectId: number
  /** Branch the edit session started on. */
  ref: string
  /** Ref tip when the file was loaded (stale-commit detection input). */
  baseTip: string | null
  content: string
  savedAt: string
}

function key(projectId: number, path: string): string {
  return `${NAMESPACE}:${projectId}:${path}`
}

export function saveDraft(draft: Omit<StoredDraft, 'savedAt'>): void {
  if (new Blob([draft.content]).size > MAX_DRAFT_BYTES) return // never blow the storage quota silently
  const entry: StoredDraft = { ...draft, savedAt: new Date().toISOString() }
  try {
    localStorage.setItem(key(draft.projectId, draft.path), JSON.stringify(entry))
  } catch {
    // Storage full/unavailable — editing continues without persistence.
  }
}

export function loadDraft(projectId: number, path: string): StoredDraft | null {
  try {
    const raw = localStorage.getItem(key(projectId, path))
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredDraft
    if (
      typeof parsed.content !== 'string' ||
      typeof parsed.savedAt !== 'string' ||
      parsed.projectId !== projectId ||
      parsed.path !== path
    ) {
      discardDraft(projectId, path)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function discardDraft(projectId: number, path: string): void {
  try {
    localStorage.removeItem(key(projectId, path))
  } catch { /* unavailable */ }
}

/** All drafts for one project — powers "unsaved changes" indicators. */
export function listDrafts(projectId: number): Array<StoredDraft> {
  const out: Array<StoredDraft> = []
  try {
    const prefix = `${NAMESPACE}:${projectId}:`
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(prefix)) continue
      try {
        out.push(JSON.parse(localStorage.getItem(k)!) as StoredDraft)
      } catch { /* skip malformed */ }
    }
  } catch { /* unavailable */ }
  return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}
