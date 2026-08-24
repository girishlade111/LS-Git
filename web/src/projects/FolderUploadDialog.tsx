import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button } from '../design-system/Button'
import { Dialog } from '../design-system/Dialog'
import { Icon } from '../design-system/Icon'
import { IconButton } from '../design-system/IconButton'
import { Input } from '../design-system/Input'
import { StatusIndicator } from '../design-system/StatusIndicator'
import { Textarea } from '../design-system/Textarea'
import {
  buildManifest,
  collectFromDataTransfer,
  collectFromFileList,
  formatBytes,
  type BatchLimits,
  type ManifestItem,
} from './folderUpload'
import { FolderUploadSession, type FinalizeOutcome } from './uploadSession'
import type { Project } from './api'

type Stage = 'select' | 'committing' | 'committed'

const DEFAULT_LIMITS: BatchLimits = {
  max_file_bytes: 50 * 1024 * 1024,
  max_batch_files: 5000,
  max_batch_total_bytes: 256 * 1024 * 1024,
}

const MAX_RENDERED_ROWS = 150

/**
 * Folder/project upload dialog (LSgit's primary differentiated feature;
 * GitLab multi-file upload parity). Drag files OR folders — or pick them —
 * review the manifest, transfer with pause/cancel/retry, then commit the
 * whole set as ONE commit on the current branch or a new branch (+ optional
 * merge request intent).
 */
export function FolderUploadDialog({
  project,
  open,
  onClose,
  onCommitted,
}: {
  project: Project
  open: boolean
  onClose: () => void
  onCommitted: () => void
}) {
  const [session, setSession] = useState<FolderUploadSession | null>(null)
  const subscribe = useCallback(
    (cb: () => void) => session?.subscribe(cb) ?? (() => undefined),
    [session],
  )
  const getSnapshot = useCallback(() => session?.getSnapshot() ?? null, [session])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  const [limits, setLimits] = useState<BatchLimits | null>(null)
  const [stage, setStage] = useState<Stage>('select')
  const [dragActive, setDragActive] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<string[] | null>(null)
  const [outcome, setOutcome] = useState<FinalizeOutcome | null>(null)
  const [finalizeError, setFinalizeError] = useState<string | null>(null)

  // Commit form
  const [message, setMessage] = useState('')
  const [targetMode, setTargetMode] = useState<'current' | 'new'>('current')
  const [newBranch, setNewBranch] = useState('')
  const [wantMr, setWantMr] = useState(false)
  const [replace, setReplace] = useState(false)

  useEffect(() => {
    if (!open) return
    fetch(`/api/v1/projects/${project.id}/uploads/limits`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => body && setLimits(body as BatchLimits))
      .catch(() => undefined)
  }, [open, project.id])

  // Warn before leaving with transfers in flight (browser refresh loses File handles).
  useEffect(() => {
    if (!snapshot) return
    if (!['running', 'paused'].includes(snapshot.phase)) return
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [snapshot?.phase])

  const phase = snapshot?.phase ?? null

  function resetAll() {
    setSession(null)
    setStage('select')
    setDragActive(false)
    setNotice(null)
    setConflicts(null)
    setOutcome(null)
    setFinalizeError(null)
    setMessage('')
    setTargetMode('current')
    setNewBranch('')
    setWantMr(false)
    setReplace(false)
  }

  function close() {
    if (phase === 'running' || phase === 'paused' || phase === 'finalizing') return
    onClose()
    resetAll()
  }

  async function ingest(dt: DataTransfer | FileList | File[]) {
    setNotice(null)
    const effective = limits ?? DEFAULT_LIMITS
    const collected =
      dt instanceof DataTransfer ? await collectFromDataTransfer(dt) : collectFromFileList(dt)
    if (collected.files.length === 0) {
      setNotice(
        collected.emptyDirs.length > 0
          ? 'Only empty folders were dropped — Git repositories cannot store empty directories.'
          : 'No uploadable files were found in that drop.',
      )
      return
    }
    const manifest = buildManifest(collected, effective)
    setSession(
      new FolderUploadSession(
        project.id,
        manifest.items.map((item) => ({ item, file: fileFor(collected.files, item) })),
      ),
    )
    setStage('select')
    if (manifest.emptyDirs.length > 0) {
      setNotice(`${manifest.emptyDirs.length} empty folder(s) will be omitted — git cannot store empty directories.`)
    }
  }

  function start() {
    void session?.start()
  }

  async function doFinalize() {
    if (!session) return
    setFinalizeError(null)
    try {
      const result = await session.finalize({
        branch: targetMode === 'current' ? project.default_branch : undefined,
        newBranch: targetMode === 'new' ? newBranch.trim() : undefined,
        startBranch: project.default_branch,
        commitMessage: message.trim(),
        replace,
        createMergeRequest: wantMr && targetMode === 'new',
      })
      setOutcome(result)
      setStage('committed')
      onCommitted()
    } catch (err) {
      const e = err as Error & { code?: string; conflictPaths?: unknown }
      if (e.code === 'file_exists' && Array.isArray(e.conflictPaths)) {
        setReplace(true)
        setConflicts(e.conflictPaths as string[])
      } else if (e.code === 'protected_branch') {
        setFinalizeError(e.message)
        setTargetMode('new')
      } else {
        setFinalizeError(e.message)
      }
    }
  }

  const stats = snapshot?.stats
  const items = snapshot?.items ?? []
  const visibleItems = items.slice(0, MAX_RENDERED_ROWS)

  const canCommit = useMemo(() => {
    if (targetMode === 'new') return /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(newBranch.trim()) && !!message.trim()
    return !!message.trim()
  }, [targetMode, newBranch, message])

  // ---- footer actions per stage -------------------------------------------------

  let footer
  if (stage === 'select' && !phase) {
    footer = (
      <>
        <Button onClick={() => close()}>Cancel</Button>
        <Button variant="primary" data-autofocus disabled={!session || !stats || stats.totalFiles < 1} onClick={start}>
          Upload {stats ? `${stats.totalFiles} file${stats.totalFiles === 1 ? '' : 's'}` : ''}
        </Button>
      </>
    )
  } else if (phase === 'ready') {
    footer = (
      <>
        <Button onClick={() => close()}>Cancel</Button>
        <Button variant="primary" data-autofocus onClick={start}>
          Upload {stats ? `${stats.totalFiles} file${stats.totalFiles === 1 ? '' : 's'}` : ''}
        </Button>
      </>
    )
  } else if (phase === 'running' || phase === 'paused') {
    footer = (
      <>
        <Button variant="danger" onClick={() => session?.cancel()}>
          Cancel upload
        </Button>
        {phase === 'running' ? (
          <Button data-autofocus iconStart="more" onClick={() => session?.pause()}>
            Pause
          </Button>
        ) : (
          <Button variant="primary" data-autofocus iconStart="check" onClick={() => session?.resume()}>
            Resume
          </Button>
        )}
      </>
    )
  } else if (phase === 'awaiting-commit' || stage === 'committing') {
    footer = (
      <>
        <Button variant="danger" onClick={() => { session?.cancel(); resetAll(); onClose() }}>
          Discard upload
        </Button>
        <Button variant="primary" data-autofocus disabled={!canCommit || phase === 'finalizing'} onClick={() => void doFinalize()}>
          {phase === 'finalizing' ? 'Committing…' : 'Commit changes'}
        </Button>
      </>
    )
  } else if (stage === 'committed') {
    footer = (
      <Button variant="primary" data-autofocus onClick={() => { onClose(); resetAll() }}>
        Done
      </Button>
    )
  } else if (phase === 'cancelled') {
    footer = (
      <Button variant="primary" data-autofocus onClick={() => { onClose(); resetAll() }}>
        Close
      </Button>
    )
  }

  const overallPct =
    stats && stats.totalBytes > 0 ? Math.min(100, Math.round((stats.transferredBytes / stats.totalBytes) * 100)) : 0

  return (
    <Dialog open={open} onClose={close} title="Upload files" footer={footer}>
      {/* ---------- selection & transfer ---------- */}
      {(stage === 'select' || phase === 'running' || phase === 'paused') && (
        <div className="ds-stack">
          {!phase && (
            <>
              <div
                className="ls-dropzone"
                data-dragging={dragActive}
                tabIndex={0}
                role="button"
                aria-label="Drop files or folders to upload"
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragActive(true)
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget === e.target) setDragActive(false)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragActive(false)
                  void ingest(e.dataTransfer)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.currentTarget.querySelector<HTMLInputElement>('input[data-pick=files]')?.click()
                  }
                }}
              >
                <span className="ls-dropzone__icon">
                  <Icon name="folder" size={28} />
                </span>
                <span className="ls-dropzone__title">Drag files or folders here</span>
                <span className="ls-dropzone__hint">
                  Folders are uploaded recursively and become one commit. Empty folders are skipped.
                </span>
                <div className="ls-dropzone__actions">
                  <label>
                    <Button size="sm" iconStart="file" onClick={(e) => {
                      const input = e.currentTarget.closest('.ls-dropzone')?.querySelector<HTMLInputElement>('input[data-pick=files]')
                      input?.click()
                    }}>
                      Choose files…
                    </Button>
                    <input
                      data-pick="files"
                      type="file"
                      hidden
                      multiple
                      onChange={(e) => {
                        if (e.target.files) void ingest(e.target.files)
                        e.target.value = ''
                      }}
                    />
                  </label>
                  <label>
                    <Button size="sm" iconStart="folder" onClick={(e) => {
                      const input = e.currentTarget.closest('.ls-dropzone')?.querySelector<HTMLInputElement>('input[data-pick=folder]')
                      input?.click()
                    }}>
                      Choose folder…
                    </Button>
                    <input
                      data-pick="folder"
                      type="file"
                      hidden
                      multiple
                      {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                      onChange={(e) => {
                        if (e.target.files) void ingest(e.target.files)
                        e.target.value = ''
                      }}
                    />
                  </label>
                </div>
              </div>

              {notice && (
                <p className="ls-upnote" style={{ margin: 0 }} role="status">
                  <Icon name="warning" size={14} />
                  {notice}
                </p>
              )}
            </>
          )}

          {stats && (
            <>
              {(phase === 'running' || phase === 'paused') && (
                <div aria-live="polite" className="ds-stack" style={{ gap: 10 }}>
                  <StatusIndicator
                    status={phase === 'paused' ? 'pending' : 'running'}
                    label={
                      phase === 'paused'
                        ? `Paused — ${overallPct}%`
                        : `Uploading… ${overallPct}% · ${formatBytes(stats.transferredBytes)} of ${formatBytes(stats.totalBytes)}`
                    }
                  />
                  <div
                    className="ls-progress ls-progress--success"
                    role="progressbar"
                    aria-valuenow={overallPct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Overall upload progress"
                  >
                    <div className="ls-progress__fill" style={{ width: `${overallPct}%` }} />
                  </div>
                  <dl className="ls-upstats">
                    <div>
                      <dt>Current file</dt>
                      <dd>{stats.currentPath ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Completed</dt>
                      <dd>{stats.completed} of {stats.totalFiles}</dd>
                    </div>
                    <div>
                      <dt>Remaining</dt>
                      <dd>{Math.max(0, stats.remaining)}</dd>
                    </div>
                    <div>
                      <dt>Transferred</dt>
                      <dd>{formatBytes(stats.transferredBytes)}</dd>
                    </div>
                  </dl>
                </div>
              )}

              <ItemList
                items={visibleItems}
                overflowCount={items.length - visibleItems.length}
                onRemove={(id) => session?.removeItem(id)}
              />

              {stats.failed > 0 && (
                <div className="ds-row" style={{ justifyContent: 'space-between' }}>
                  <p className="ls-upnote ls-upnote--danger" style={{ margin: 0 }}>
                    <Icon name="warning" size={14} />
                    {stats.failed} file{stats.failed === 1 ? '' : 's'} failed
                  </p>
                  <Button size="sm" onClick={() => session?.retryFailed()}>
                    Retry failed
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ---------- commit screen ---------- */}
      {(phase === 'awaiting-commit' || phase === 'finalizing') && (
        <fieldset className="ds-stack" style={{ border: 'none', margin: 0, padding: 0 }}>
          <legend className="sr-only-label">Commit options</legend>

          {conflicts && (
            <p className="ls-upnote ls-upnote--danger" style={{ margin: 0 }} role="alert">
              <Icon name="warning" size={14} />
              {conflicts.length} file{conflicts.length === 1 ? ' already exists' : 's already exist'} on{' '}
              {project.default_branch}: {conflicts.slice(0, 5).join(', ')}
              {conflicts.length > 5 ? ` … +${conflicts.length - 5} more` : ''}
            </p>
          )}
          {finalizeError && (
            <p className="ls-upnote ls-upnote--danger" style={{ margin: 0 }} role="alert">
              <Icon name="warning" size={14} />
              {finalizeError}
            </p>
          )}

          <Textarea
            label="Commit message"
            required
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={`Upload ${stats?.completed ?? ''} files`}
          />

          <div className="ds-stack" style={{ gap: 6 }}>
            <label className="ls-checkbox">
              <input
                type="radio"
                name="up-target"
                checked={targetMode === 'current'}
                onChange={() => setTargetMode('current')}
              />
              Commit to <code style={{ fontFamily: 'var(--ls-font-mono)' }}>{project.default_branch}</code>
            </label>
            <label className="ls-checkbox">
              <input
                type="radio"
                name="up-target"
                checked={targetMode === 'new'}
                onChange={() => setTargetMode('new')}
              />
              Commit to a new branch
            </label>
          </div>

          {targetMode === 'new' && (
            <div className="ds-stack" style={{ gap: 8 }}>
              <Input
                label="New branch name"
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                placeholder="feature/uploaded-project"
                hint={`Forked from ${project.default_branch}`}
              />
              <label className="ls-checkbox">
                <input type="checkbox" checked={wantMr} onChange={(e) => setWantMr(e.target.checked)} />
                Start a merge request with these changes
              </label>
            </div>
          )}

          <label className="ls-checkbox">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            Replace existing files with the same path
          </label>

          {stats && stats.failed > 0 && (
            <p className="ls-upnote ls-upnote--danger" style={{ margin: 0 }}>
              <Icon name="warning" size={14} />
              {stats.failed} file(s) were not uploaded. Retry them before committing.
            </p>
          )}
        </fieldset>
      )}

      {/* ---------- committed ---------- */}
      {stage === 'committed' && outcome && (
        <div className="ds-stack">
          <StatusIndicator status="success" label="Files committed" />
          <dl className="ls-upstats">
            <div>
              <dt>Branch</dt>
              <dd>{outcome.branch}</dd>
            </div>
            <div>
              <dt>Commit</dt>
              <dd style={{ fontFamily: 'var(--ls-font-mono)' }}>{outcome.commitSha.slice(0, 12)}</dd>
            </div>
            <div>
              <dt>Files</dt>
              <dd>{outcome.committedFiles} committed</dd>
            </div>
            {outcome.identicalSkipped > 0 && (
              <div>
                <dt>Unchanged</dt>
                <dd>{outcome.identicalSkipped} identical</dd>
              </div>
            )}
          </dl>
          {wantMr && targetMode === 'new' && (
            <p className="ls-upnote" style={{ margin: 0 }}>
              <Icon name="merge" size={14} />
              {outcome.mergeRequestNote}
            </p>
          )}
        </div>
      )}
    </Dialog>
  )
}

function fileFor(files: Array<{ file: File; relativePath: string }>, item: ManifestItem): File {
  const match = files.find((f) => f.relativePath === item.relativePath && f.file.size === item.size)
  if (!match) throw new Error(`Missing file handle for ${item.relativePath}`)
  return match.file
}

function ItemList({
  items,
  overflowCount,
  onRemove,
}: {
  items: ManifestItem[]
  overflowCount: number
  onRemove: (id: string) => void
}) {
  const label = useCallback((it: ManifestItem): string => {
    switch (it.status) {
      case 'queued':
        return 'Queued'
      case 'hashing':
        return 'Preparing'
      case 'uploading':
        return 'Uploading'
      case 'completed':
        return 'Completed'
      case 'failed':
        return 'Failed'
      case 'skipped':
        return it.note === 'Removed' ? 'Removed' : it.note === 'Cancelled' ? 'Cancelled' : 'Skipped'
    }
  }, [])

  return (
    <div className="ls-uplist">
      <ul className="ls-uplist__scroll" style={{ margin: 0, padding: 0, listStyle: 'none' }} aria-label="Upload queue">
        {items.length === 0 && (
          <li className="ls-uplist__row" style={{ justifyContent: 'center', padding: '16px 12px' }}>
            No files yet — drop folders above
          </li>
        )}
        {items.map((it) => (
          <li key={it.id} className={`ls-uplist__row ls-uplist__row--${it.status}`} title={it.note ?? it.relativePath}>
            <span className="ls-uplist__path">{it.relativePath}</span>
            <span className="ls-uplist__size">{it.status === 'uploading' ? formatBytes(it.sentBytes) : formatBytes(it.size)}</span>
            <span className="ls-uplist__state">{label(it)}</span>
            {(it.status === 'queued' || it.status === 'failed') && (
              <IconButton label={`Remove ${it.relativePath}`} icon="close" className="ls-uplist__remove" onClick={() => onRemove(it.id)} />
            )}
          </li>
        ))}
        {overflowCount > 0 && (
          <li className="ls-uplist__row" style={{ justifyContent: 'center' }}>
            + {overflowCount} more file{overflowCount === 1 ? '' : 's'}
          </li>
        )}
      </ul>
    </div>
  )
}
