import { useRef, useState } from 'react'
import { Button } from '../design-system/Button'
import { Dialog } from '../design-system/Dialog'
import { Input } from '../design-system/Input'
import { StatusIndicator } from '../design-system/StatusIndicator'
import { Uploader } from './upload'
import type { Project } from './api'

type Phase = 'idle' | 'uploading' | 'committing' | 'done' | 'error'

/**
 * Single-file upload dialog (GitLab Web-Editor parity):
 * file picker → path → commit message → current/new branch (+ optional MR)
 * → staged transfer with progress → retry / cancel.
 */
export function UploadDialog({
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
  const fileRef = useRef<HTMLInputElement>(null)
  const uploaderRef = useRef<Uploader>(new Uploader())
  const [file, setFile] = useState<File | null>(null)
  const [filePath, setFilePath] = useState('')
  const [message, setMessage] = useState('')
  const [targetMode, setTargetMode] = useState<'current' | 'new'>('current')
  const [newBranch, setNewBranch] = useState('')
  const [wantMr, setWantMr] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [sent, setSent] = useState(0)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [resultNote, setResultNote] = useState<string | null>(null)

  function reset() {
    setFile(null); setFilePath(''); setMessage(''); setPhase('idle'); setSent(0)
    setError(null); setResultNote(null); setTargetMode('current'); setNewBranch(''); setWantMr(false)
    uploaderRef.current = new Uploader()
  }

  function close() {
    if (phase === 'uploading' || phase === 'committing') return // cancel explicitly
    onClose()
    if (phase === 'done') reset()
    else reset()
  }

  function pickFile(f: File | undefined) {
    if (!f) return
    setFile(f)
    setFilePath(f.name)
    setMessage(`Upload ${f.name}`)
    setError(null)
  }

  async function run(replace: boolean) {
    if (!file) return
    setError(null)
    setSent(0)
    setTotal(file.size)
    setPhase('uploading')

    try {
      let uploadId: string
      let existsAlready = false
      try {
        const init = await uploaderRef.current.initiate(project.id, filePath.trim(), file.size)
        uploadId = init.uploadId
        existsAlready = init.exists
        if (init.exists && !replace) {
          setPhase('idle')
          setError(`"${filePath.trim()}" already exists. Tick “Replace the existing file” to overwrite it.`)
          return
        }
        void existsAlready
      } catch (err) {
        setPhase('error')
        setError(err instanceof Error ? err.message : 'Initiation failed')
        return
      }

      await uploaderRef.current.transfer(project.id, uploadId, file, (loaded) => setSent(loaded))

      setPhase('committing')
      const result = await Uploader.commit(project.id, uploadId, project, {
        branch: targetMode === 'current' ? project.default_branch : undefined,
        newBranch: targetMode === 'new' ? newBranch : undefined,
        startBranch: project.default_branch,
        commitMessage: message,
        replace,
        createMergeRequest: wantMr,
      })
      setPhase('done')
      setResultNote(
        wantMr
          ? `Committed to ${result.branch}. Merge requests arrive with the collaboration phase — your branch is ready.`
          : `Committed to ${result.branch}.`,
      )
      onCommitted()
    } catch (err) {
      const e = err as Error & { cancelled?: boolean }
      if (e.cancelled) {
        setPhase('idle')
        return
      }
      setPhase('error')
      setError(e.message)
    }
  }

  function cancel() {
    if (phase === 'uploading' || phase === 'committing') {
      uploaderRef.current.abort()
    }
    reset()
    onClose()
  }

  const busy = phase === 'uploading' || phase === 'committing'
  const pct = total > 0 ? Math.round((sent / total) * 100) : 0

  return (
    <Dialog open={open} onClose={close} title="Upload file" footer={
      <>
        {(phase === 'idle' || phase === 'done') && <Button onClick={() => { close() }}>{phase === 'done' ? 'Close' : 'Cancel'}</Button>}
        {(phase === 'idle') && (
          <Button variant="primary" data-autofocus disabled={!file || !filePath.trim() || !message.trim()} onClick={() => void run(false)}>
            Upload &amp; commit
          </Button>
        )}
        {busy && <Button variant="danger" onClick={() => cancel()}>Cancel upload</Button>}
        {phase === 'error' && (
          <>
            <Button onClick={() => cancel()}>Dismiss</Button>
            <Button variant="primary" data-autofocus onClick={() => void run(true)}>Retry</Button>
          </>
        )}
      </>
    }>
      <div className="ds-stack">
        {phase === 'done' ? (
          <>
            <StatusIndicator status="success" label="File committed" />
            {resultNote && <p style={{ fontSize: 'var(--ls-fs-desc)', color: 'var(--ls-text-secondary)' }}>{resultNote}</p>}
          </>
        ) : (
          <>
            <div>
              <Button size="sm" iconStart="file" onClick={() => fileRef.current?.click()} disabled={busy}>
                Choose file…
              </Button>
              <input
                ref={fileRef}
                type="file"
                hidden
                onChange={(e) => {
                  pickFile(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
              {file && (
                <span style={{ marginLeft: 10, fontSize: 'var(--ls-fs-desc)', color: 'var(--ls-text-secondary)' }}>
                  {file.name} · {(file.size / 1024).toFixed(1)} KB
                </span>
              )}
            </div>

            <Input label="Repository path" required value={filePath} onChange={(e) => setFilePath(e.target.value)} hint="Relative to repository root, e.g. docs/guide.md" />

            <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
              <legend className="sr-only-label">Target branch</legend>
              <label className="ls-checkbox">
                <input
                  type="radio"
                  name="target"
                  checked={targetMode === 'current'}
                  onChange={() => setTargetMode('current')}
                  disabled={busy}
                />
                Commit to <code style={{ fontFamily: 'var(--ls-font-mono)' }}>{project.default_branch}</code>
              </label>
              <label className="ls-checkbox" style={{ marginTop: 6 }}>
                <input
                  type="radio"
                  name="target"
                  checked={targetMode === 'new'}
                  onChange={() => setTargetMode('new')}
                  disabled={busy}
                />
                Commit to a new branch
              </label>
              {targetMode === 'new' && (
                <div style={{ marginTop: 8 }}>
                  <Input
                    label="New branch name"
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    placeholder="feature/upload"
                    hint={`Forked from ${project.default_branch}`}
                  />
                  <label className="ls-checkbox" style={{ marginTop: 8 }}>
                    <input type="checkbox" checked={wantMr} onChange={(e) => setWantMr(e.target.checked)} disabled={busy} />
                    Start a merge request with these changes
                  </label>
                </div>
              )}
            </fieldset>

            <Input label="Commit message" required value={message} onChange={(e) => setMessage(e.target.value)} />

            {phase === 'uploading' && (
              <div aria-live="polite">
                <StatusIndicator status="running" label={`Uploading… ${pct}%`} />
                <div className="ls-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <div className="ls-progress__fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )}
            {phase === 'committing' && <StatusIndicator status="running" label="Creating blob → tree → commit…" />}
            {error && (
              <p role="alert" style={{ fontSize: 'var(--ls-fs-desc)', color: 'var(--ls-danger)' }}>
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}

// tiny helper classnames used above exist in design system css
void 0
