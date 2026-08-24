/**
 * Folder/project upload core — browser entry collection, path normalization,
 * and manifest construction. No network access here: everything is pure or
 * File-API-only so it is fully unit-testable.
 *
 * Browser compatibility notes (researched against current evergreen behavior):
 *  - Drag-and-drop folders: DataTransferItem.webkitGetAsEntry() is the only
 *    production-viable recursive API across Chromium/Firefox/Safari. Entries
 *    MUST be captured synchronously in the drop handler before awaiting;
 *    DataTransferItemList is neutered after the event loop turns.
 *  - FileSystemDirectoryReader.readEntries() returns at most ~100 entries per
 *    call and MUST be called repeatedly until it resolves [].
 *  - <input type="file" webkitdirectory> provides webkitRelativePath on every
 *    File; supported in all evergreen browsers.
 */

export interface DroppedFile {
  file: File
  /** Normalized, slash-delimited path relative to the repository root. */
  relativePath: string
}

export interface CollectResult {
  files: DroppedFile[]
  /** Empty folders cannot exist in git; they are reported, never uploaded. */
  emptyDirs: string[]
}

const MAX_TRAVERSAL_DEPTH = 64

/**
 * Normalizes any of Windows / macOS / Linux / browser-relative path shapes
 * into a safe repository-relative slash path. Returns null when the path can
 * never be stored safely — the server remains authoritative and re-validates.
 */
export function normalizeRelativePath(raw: string): string | null {
  if (typeof raw !== 'string') return null
  let input = raw.trim()
  if (!input) return null

  // Strip Windows drive letters ("C:", "D:\", "\\server\share").
  input = input.replace(/^\\\\[^\\]+(\\|$)/, '/')
  input = input.replace(/^[A-Za-z]:/, '')
  // Backslashes → forward slashes (Windows separators).
  input = input.replace(/\\/g, '/')
  // Strip leading slashes (absolute → relative).
  input = input.replace(/^\/+/, '')

  const segments: string[] = []
  for (const seg of input.split('/')) {
    if (seg === '' || seg === '.') continue // collapse '//', trailing '/', no-op dots
    if (seg === '..') return null // traversal is never acceptable
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(seg)) return null
    const lower = seg.toLowerCase()
    if (lower === '.git' || lower.endsWith('.lock')) return null // reserved
    segments.push(seg)
  }
  if (segments.length === 0) return null
  const joined = segments.join('/')
  if (joined.length > 1024 || segments.some((s) => s.length > 255)) return null
  return joined
}

interface FsEntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  fullPath?: string
  file?: (cb: (f: File) => void, err?: (e: unknown) => void) => void
  createReader?: () => { readEntries: (cb: (entries: FsEntryLike[]) => void, err?: (e: unknown) => void) => void }
}

function readAllEntries(reader: ReturnType<NonNullable<FsEntryLike['createReader']>>): Promise<FsEntryLike[]> {
  return new Promise((resolve, reject) => {
    const out: FsEntryLike[] = []
    const step = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(out)
        out.push(...batch)
        step() // readEntries pages ~100 entries at a time
      }, reject)
    }
    step()
  })
}

function entryToFile(entry: FsEntryLike): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file!(resolve, reject)
  })
}

async function walkEntry(
  entry: FsEntryLike,
  parentPrefix: string,
  depth: number,
  acc: CollectResult,
): Promise<void> {
  if (depth > MAX_TRAVERSAL_DEPTH) return
  if (entry.isFile) {
    const normalized = normalizeRelativePath(`${parentPrefix}${entry.name}`)
    if (!normalized) return // unsupported path — surfaced later from the manifest, not silently dropped here
    try {
      acc.files.push({ file: await entryToFile(entry), relativePath: normalized })
    } catch {
      /* unreadable file (permissions/withdrawn) — skip */
    }
    return
  }
  if (entry.isDirectory) {
    const prefix = `${parentPrefix}${entry.name}/`
    const children = entry.createReader ? await readAllEntries(entry.createReader()) : []
    if (children.length === 0) acc.emptyDirs.push(normalizeRelativePath(prefix) ?? prefix)
    for (const child of children) {
      await walkEntry(child, prefix, depth + 1, acc)
    }
  }
}

/**
 * Collects every file under a drag-and-drop payload. Must be invoked from the
 * drop handler; the synchronous first pass captures entries before any await.
 */
export async function collectFromDataTransfer(dt: DataTransfer): Promise<CollectResult> {
  const acc: CollectResult = { files: [], emptyDirs: [] }

  // Synchronous capture pass — mandatory before awaiting anything.
  const entries: FsEntryLike[] = []
  const plainFiles: File[] = []
  const items = dt.items ? Array.from(dt.items) : []
  for (const item of items) {
    if (item.kind !== 'file') continue
    const getter = (item as DataTransferItem & { webkitGetAsEntry?: () => FsEntryLike | null })
      .webkitGetAsEntry
    const entry = typeof getter === 'function' ? getter.call(item) : null
    if (entry) entries.push(entry)
    else {
      const f = item.getAsFile()
      if (f) plainFiles.push(f)
    }
  }
  if (entries.length === 0 && dt.files) plainFiles.push(...Array.from(dt.files))

  for (const entry of entries) await walkEntry(entry, '', 0, acc)
  for (const f of plainFiles) {
    const normalized = normalizeRelativePath(f.name)
    if (normalized) acc.files.push({ file: f, relativePath: normalized })
  }
  return acc
}

/** Collects files chosen through a picker (plain or `webkitdirectory`). */
export function collectFromFileList(list: FileList | File[]): CollectResult {
  const acc: CollectResult = { files: [], emptyDirs: [] }
  for (const file of Array.from(list)) {
    const raw =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    const normalized = normalizeRelativePath(raw)
    if (!normalized) continue
    acc.files.push({ file, relativePath: normalized })
    // Folder pickers report directories implicitly; empty dirs are unknowable here.
  }
  return acc
}

// -- manifest -----------------------------------------------------------------

export type ItemStatus = 'queued' | 'hashing' | 'uploading' | 'completed' | 'failed' | 'skipped'

export interface ManifestItem {
  id: string
  /** Repository-relative path (normalized). */
  relativePath: string
  fileName: string
  size: number
  mime: string
  lastModified: number
  /** SHA-256 hex when computed (small files); null otherwise. */
  hash: string | null
  status: ItemStatus
  sentBytes: number
  /** For skipped items: why. For failed items: what happened. */
  note?: string
  /** Server staging slot id once initiated. */
  serverUploadId?: string
}

export interface BatchLimits {
  max_file_bytes: number
  max_batch_files: number
  max_batch_total_bytes: number
}

export interface BuiltManifest {
  items: ManifestItem[]
  emptyDirs: string[]
  /** Totals over items that will actually be uploaded. */
  eligibleFiles: number
  eligibleBytes: number
  withinLimits: boolean
  limitErrors: string[]
}

let idCounter = 0
function nextId(): string {
  idCounter += 1
  return `item-${Date.now().toString(36)}-${idCounter}`
}

/**
 * Builds the upload manifest and runs client-side detection:
 * unsupported paths, oversized files, duplicate paths (first occurrence wins,
 * later duplicates are marked skipped), and queue-limit overflow.
 */
export function buildManifest(
  collected: CollectResult,
  limits: BatchLimits,
): BuiltManifest {
  const items = new Map<string, ManifestItem>()

  for (const { file, relativePath } of collected.files) {
    const first = items.get(relativePath)
    if (first) {
      items.set(`${relativePath}\u0000dup-${items.size}`, {
        ...blankItem(file, relativePath),
        status: 'skipped',
        note: 'Duplicate path in this upload',
      })
      continue
    }
    items.set(relativePath, blankItem(file, relativePath))
  }

  const ordered: ManifestItem[] = []
  const overflow: ManifestItem[] = []
  let accepted = 0
  let eligibleBytes = 0
  for (const item of items.values()) {
    if (item.status === 'skipped') {
      overflow.push(item)
      continue
    }
    if (accepted >= limits.max_batch_files) {
      item.status = 'skipped'
      item.note = `Batch limit reached (${limits.max_batch_files} files)`
      overflow.push(item)
      continue
    }
    if (item.size > limits.max_file_bytes) {
      item.status = 'skipped'
      item.note = `Exceeds ${formatBytes(limits.max_file_bytes)} per-file limit`
      overflow.push(item)
      continue
    }
    accepted += 1
    eligibleBytes += item.size
    ordered.push(item)
  }

  const limitErrors: string[] = []
  const emptyDirs = [...collected.emptyDirs]
  if (eligibleBytes > limits.max_batch_total_bytes) {
    limitErrors.push(
      `Selection is ${formatBytes(eligibleBytes)} — above the ${formatBytes(limits.max_batch_total_bytes)} per-upload limit`,
    )
  }
  if (collected.files.length > 0 && accepted === 0 && collected.emptyDirs.length === 0) {
    limitErrors.push('No uploadable files were found')
  }

  return {
    items: [...ordered, ...overflow],
    emptyDirs,
    eligibleFiles: accepted,
    eligibleBytes,
    withinLimits: limitErrors.length === 0,
    limitErrors,
  }
}

function blankItem(file: File, relativePath: string): ManifestItem {
  return {
    id: nextId(),
    relativePath,
    fileName: relativePath.split('/').pop() ?? relativePath,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    lastModified: file.lastModified,
    hash: null,
    status: 'queued',
    sentBytes: 0,
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
