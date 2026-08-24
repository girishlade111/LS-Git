import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge } from '../../design-system/Badge'
import { Button } from '../../design-system/Button'
import { Dialog } from '../../design-system/Dialog'
import { DiffViewer } from '../../design-system/DiffViewer'
import { EmptyState } from '../../design-system/EmptyState'
import { Icon } from '../../design-system/Icon'
import { Input } from '../../design-system/Input'
import { Tooltip } from '../../design-system/Tooltip'
import { repositoryApi, type BlobResult, encodePath } from '../api'
import { unifiedDiff } from './linesdiff'
import { CrumbTrail, CopyButton, formatBytes } from '../widgets'
import { CodeEditor } from './CodeEditor'
import { CommitDialog, type CommitOutcomeView } from './CommitDialog'
import { discardDraft, loadDraft, type StoredDraft } from './drafts'
import { editSession } from './session'

export interface FileEditorProps {
  projectId: number
  projectName: string
  /** owner/project path used to build hash routes. */
  projectPath: string
  defaultBranch: string
  refName: string
  path: string
  /** 'edit' opens an existing file; 'new' creates one under `path` (a directory). */
  mode: 'edit' | 'new'
  /** Navigates after successful operations (hash URLs without '#'). */
  navigate: (to: string) => void
}

/**
 * The web-editor page: create/edit a single file with local draft
 * persistence, replace (binary upload), rename/delete, live diff preview and
 * the multi-file commit workflow. All mutations funnel through the session so
 * several buffers can be committed together later.
 */
export function FileEditorView({
  projectId,
  projectName,
  projectPath,
  defaultBranch,
  refName,
  path,
  mode,
  navigate,
}: FileEditorProps) {
  const [blob, setBlob] = useState<BlobResult | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState<StoredDraft | null>(null)
  const [content, setContent] = useState('')
  const [showDiff, setShowDiff] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)

  const effectiveRef = refName || defaultBranch
  const isNew = mode === 'new'

  // Load base content.
  useEffect(() => {
    let alive = true
    setLoadError(null)
    if (isNew) {
      setBlob(null)
      setContent('')
      return () => { alive = false }
    }
    repositoryApi.blob(projectId, effectiveRef, path)
      .then((b) => {
        if (!alive) return
        setBlob(b)
        // Binary files are not editable as text — surface guidance instead.
        if (!b.is_binary && !b.too_large && b.text !== null) setContent(b.text)
      })
      .catch((e) => { if (alive) setLoadError(e instanceof Error ? e.message : 'Failed to load file') })
    return () => { alive = false }
  }, [projectId, effectiveRef, path, isNew])

  // Existing draft?
  useEffect(() => {
    setDraft(isNew || !blob ? loadDraft(projectId, path) : loadDraft(projectId, path))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, path])

  // Session buffer lifecycle.
  useEffect(() => {
    if (isNew) {
      editSession.open({
        projectId, ref: effectiveRef, path,
        baseContent: '', baseTip: null, isNew: true,
        ...(draft ? { draftContent: draft.content } : {}),
      })
      if (draft) setContent(draft.content)
    } else if (blob && blob.text !== null) {
      editSession.open({
        projectId, ref: effectiveRef, path,
        baseContent: blob.text,
        baseTip: blob.resolved_sha,
        isNew: false,
        ...(draft ? { draftContent: draft.content } : {}),
      })
      setContent(editSession.get(projectId, path)?.content ?? blob.text)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, blob?.sha, path])

  const buffer = editSession.get(projectId, path)
  const dirty = buffer ? editSession.isDirty(buffer) : false

  const onChangeContent = useCallback(
    (next: string) => {
      setContent(next)
      editSession.update(projectId, path, next)
    },
    [projectId, path],
  )

  const segments = useMemo(() => path.split('/').filter(Boolean), [path])
  const fileName = segments[segments.length - 1] ?? ''

  function restoreDraft() {
    const stored = loadDraft(projectId, path)
    if (!stored) { setDraft(null); return }
    onChangeContent(stored.content)
    setDraft(null) // banner dismissed once restored into the buffer
  }

  function discardStoredDraft() {
    discardDraft(projectId, path)
    setDraft(null)
  }

  async function doDelete() {
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/repository/commit`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: await csrfHeaders(),
        body: JSON.stringify({
          commit_message: `Delete ${path}`,
          changes: [{ path, delete: true }],
          branch: effectiveRef,
          expected_base_tip: buffer?.baseTip ?? null,
        }),
      })
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) throw new Error(String(body.message ?? 'Delete failed'))
      editSession.close(projectId, path)
      discardDraft(projectId, path)
      navigate(`/proj/${projectPath}/tree/${encodeURIComponent(effectiveRef)}`)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Delete failed')
    }
    setDeleteOpen(false)
  }


  async function doRename() {
    const target = renameTarget.trim()
    if (!target) return
    try {
      const contentForMove = content
      const res = await fetch(`/api/v1/projects/${projectId}/repository/commit`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: await csrfHeaders(),
        body: JSON.stringify({
          commit_message: `Rename ${path} → ${target}`,
          changes: [
            { path: target, content: contentForMove },
            { path, delete: true },
          ],
          branch: effectiveRef,
          expected_base_tip: buffer?.baseTip ?? null,
        }),
      })
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) throw new Error(String(body.message ?? 'Rename failed'))
      editSession.close(projectId, path)
      discardDraft(projectId, path)
      navigate(
        `/proj/${projectPath}/blob/${encodeURIComponent(effectiveRef)}/${encodePath(target)}`,
      )
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Rename failed')
    }
    setRenameOpen(false)
  }

  /** Replace file contents with an uploaded file (binary-safe). */
  async function doReplace(file: File) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = false
      for (let i = 0; i < Math.min(bytes.length, 8192); i++) {
        if (bytes[i] === 0) { binary = true; break }
      }
      const payload: Record<string, unknown> = binary
        ? { path, content_base64: btoa(String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 32)))) /* probe */ }
        : { path, content: new TextDecoder().decode(bytes) }
      void payload
      // Full replacement always posts complete bytes (base64 for transport).
      const base64 = (() => {
        let s = ''
        const chunk = 0x8000
        for (let i = 0; i < bytes.length; i += chunk) {
          s += String.fromCharCode(...bytes.subarray(i, i + chunk))
        }
        return btoa(s)
      })()
      const res = await fetch(`/api/v1/projects/${projectId}/repository/commit`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: await csrfHeaders(),
        body: JSON.stringify({
          commit_message: `Replace ${path} with upload`,
          changes: [{ path, content_base64: base64 }],
          branch: effectiveRef,
          expected_base_tip: buffer?.baseTip ?? null,
        }),
      })
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) throw new Error(String(body.message ?? 'Replace failed'))
      window.location.reload()
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Replace failed')
    }
  }

  if (loadError) {
    return (
      <div className="ls-rb">
        <EmptyState icon="warning" title="Could not open the editor" description={loadError} />
      </div>
    )
  }

  const editableText = isNew || (!!blob && !blob.is_binary && !blob.too_large && blob.text !== null)
  const trail = [
    { name: projectName, href: `#/proj/${projectPath}/tree/${encodeURIComponent(effectiveRef)}` },
    ...segments.slice(0, -1).map((seg, i) => ({
      name: seg,
      href: `#/proj/${projectPath}/tree/${encodeURIComponent(effectiveRef)}/${encodePath(segments.slice(0, i + 1).join('/'))}`,
    })),
    ...(isNew
      ? [{ name: fileName || 'new file', href: null }]
      : [{ name: fileName, href: `#/proj/${projectPath}/blob/${encodeURIComponent(effectiveRef)}/${encodePath(path)}` }]),
  ]

  return (
    <section aria-label={`Edit ${path}`} className="ls-rb ls-editor-page">
      <header className="ls-rb__head">
        <CrumbTrail trail={trail} />
        <div className="ls-rb__actions">
          {dirty && <Badge variant="accent">unsaved changes</Badge>}
          {!isNew && editableText && (
            <>
              <Tooltip content="Restore this file from an uploaded replacement">
                <label className="ls-btn ls-btn--sm ls-btn--secondary" style={{ cursor: 'pointer' }}>
                  Replace…
                  <input
                    type="file"
                    style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) void doReplace(f)
                    }}
                  />
                </label>
              </Tooltip>
              <Tooltip content="Rename or move this file">
                <Button size="sm" variant="ghost" onClick={() => { setRenameTarget(path); setRenameOpen(true) }}>
                  Rename
                </Button>
              </Tooltip>
              <Tooltip content="Delete this file">
                <Button size="sm" variant="danger" onClick={() => setDeleteOpen(true)}>Delete</Button>
              </Tooltip>
            </>
          )}
          {editableText && dirty && (
            <Tooltip content="Preview your uncommitted change">
              <Button size="sm" variant="secondary" onClick={() => setShowDiff(!showDiff)}>
                {showDiff ? 'Hide diff' : 'Preview diff'}
              </Button>
            </Tooltip>
          )}
          {editableText && (
            <Button size="sm" variant="primary" onClick={() => setCommitOpen(true)} disabled={!dirty}>
              Commit changes…
            </Button>
          )}
          <CopyButton value={path} label="Copy path" />
        </div>
      </header>

      <div className="ls-rb__filemeta">
        {isNew ? <Badge variant="accent">new file</Badge> : blob && (
          <>
            <Badge variant="neutral">{formatBytes(blob.size)}</Badge>
            {blob.line_count !== null && <Badge variant="neutral">{blob.line_count} lines</Badge>}
            <span className="ls-rb__muted">on {effectiveRef}</span>
          </>
        )}
        <Icon name="file" size={12} />
      </div>

      {draft && (
        <div className="ls-editor-draft" role="status">
          <Icon name="clock" size={14} />
          <span>
            Unsaved draft from {new Date(draft.savedAt).toLocaleString()} found for this file.
          </span>
          <Button size="sm" variant="primary" onClick={restoreDraft}>Restore draft</Button>
          <Button size="sm" onClick={discardStoredDraft}>Discard</Button>
        </div>
      )}

      {editableText ? (
        <>
          {isNew && (
            <Input
              label="File path"
              value={path}
              onChange={(e) => onNewPath(e.target.value)}
              placeholder="docs/new-file.md"
              hint="Directories are created implicitly. Commit when ready."
            />
          )}
          {showDiff && buffer && (
            <div className="ls-editor-diffpreview" aria-label="Uncommitted diff preview">
              {(() => {
                const d = unifiedDiff(buffer.baseContent, buffer.content, path)
                return d.text
                  ? <DiffViewer diff={d.text} />
                  : <p className="ls-rb__muted">No textual difference against the committed version.</p>
              })()}
            </div>
          )}
          <CodeEditor value={content} onChange={onChangeContent} fileName={fileName || 'file.txt'} />
        </>
      ) : (
        <EmptyState
          icon="file"
          title="This file cannot be edited as text"
          description={
            blob?.too_large
              ? 'The file exceeds the web-editor size limit. Use Replace… to swap its contents.'
              : 'Binary files cannot be edited in the browser. Use Replace… to upload new contents.'
          }
        />
      )}

      {/* Rename */}
      <Dialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title="Rename / move file"
        description="The file keeps its contents; history follows both paths."
        footer={
          <>
            <Button onClick={() => setRenameOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              data-autofocus
              disabled={!renameTarget.trim() || renameTarget.trim() === path}
              onClick={() => void doRename()}
            >
              Rename
            </Button>
          </>
        }
      >
        <Input label="New path" value={renameTarget} onChange={(e) => setRenameTarget(e.target.value)} />
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`Delete ${path}?`}
        description="This removes the file in a new commit. Its history remains recoverable."
        footer={
          <>
            <Button onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="danger" data-autofocus onClick={() => void doDelete()}>Delete file</Button>
          </>
        }
      >
        <p style={{ fontSize: 'var(--ls-fs-body)', color: 'var(--ls-text-secondary)', margin: 0 }}>
          Commits directly to <strong>{effectiveRef}</strong>.
        </p>
      </Dialog>

      {/* Multi-file commit workflow */}
      <CommitDialog
        key={`${projectId}:${path}:${commitOpen}`}
        open={commitOpen}
        onClose={() => setCommitOpen(false)}
        buffers={[...(buffer ? [buffer] : [])]}
        defaultBranch={defaultBranch}
        onCommitted={(outcome: CommitOutcomeView | null) => {
          if (!outcome) return
          editSession.clearAll(projectId)
          discardDraft(projectId, path)
          navigate(
            `/proj/${projectPath}/blob/${encodeURIComponent(outcome.branch)}/${encodePath(path)}`,
          )
        }}
      />
    </section>
  )
}

/** CSRF header pair for editor mutations (session-authenticated requests). */
async function csrfHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const cookie = document.cookie
    .split(';')
    .find((c) => c.trim().startsWith('lsgit_csrf='))
  if (cookie) headers['x-csrf-token'] = decodeURIComponent(cookie.split('=')[1]!.trim())
  return headers
}
