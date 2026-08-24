import { useMemo, useState } from 'react'
import { Button } from '../../design-system/Button'
import { Dialog } from '../../design-system/Dialog'
import { EmptyState } from '../../design-system/EmptyState'
import { Input } from '../../design-system/Input'
import { DiffViewer } from '../../design-system/DiffViewer'
import { unifiedDiff } from './linesdiff'
import type { EditBuffer } from './session'

export interface CommitOutcomeView {
  commit_sha: string
  branch: string
  created_branch: boolean
}

export interface ConflictInfo {
  expected: string | null
  current: string | null
  message: string
}

/**
 * The commit workflow dialog: message, target branch (current or NEW), and a
 * per-file diff preview. Concurrency failures surface as an explicit conflict
 * panel — newer changes are never silently overwritten.
 */
export function CommitDialog({
  open,
  onClose,
  buffers,
  defaultBranch,
  onCommitted,
}: {
  open: boolean
  onClose: () => void
  buffers: EditBuffer[]
  defaultBranch: string
  /** Called after ANY terminal outcome so the view can refresh/reload bases. */
  onCommitted: (outcome: CommitOutcomeView | null) => void
}) {
  const [message, setMessage] = useState('')
  const [mode, setMode] = useState<'current' | 'new'>('current')
  const [newBranch, setNewBranch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ConflictInfo | null>(null)
  const [result, setResult] = useState<CommitOutcomeView | null>(null)

  const diffs = useMemo(
    () =>
      buffers.map((b) => ({
        buffer: b,
        ...unifiedDiff(b.baseContent, b.content, b.path),
      })),
    // Recomputed on demand via key remount; buffers array identity is stable enough here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buffers],
  )

  async function commit() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/v1/projects/${buffers[0]!.projectId}/repository/commit`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          ...(document.cookie.split(';').some((c) => c.trim().startsWith('lsgit_csrf='))
            ? {
                'x-csrf-token': decodeURIComponent(
                  document.cookie
                    .split(';')
                    .find((c) => c.trim().startsWith('lsgit_csrf='))!
                    .split('=')[1]!
                      .trim(),
                ),
              }
            : {}),
        },
        body: JSON.stringify({
          commit_message: message,
          changes: buffers.map((b) => ({ path: b.path, content: b.content })),
          ...(mode === 'current'
            ? {
                branch: buffers[0]!.ref,
                // Optimistic concurrency: refuse when the base moved under us.
                expected_base_tip: buffers[0]!.baseTip ?? null,
              }
            : {
                new_branch: newBranch.trim(),
                start_branch: buffers[0]!.ref,
                // Creating from the CURRENT tip: stale check applies to it too.
                expected_base_tip: null,
              }),
        }),
      })
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (res.ok) {
        const outcome: CommitOutcomeView = {
          commit_sha: String(body.commit_sha),
          branch: String(body.branch),
          created_branch: body.created_branch === true,
        }
        setResult(outcome)
        onCommitted(outcome)
        return
      }
      if (res.status === 409 && body.code === 'ref_update_conflict') {
        setConflict({
          expected: (body.expected as string | null) ?? null,
          current: (body.current as string | null) ?? null,
          message: String(body.message),
        })
      } else {
        setError(String(body.message ?? `Commit failed (${res.status})`))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }

  function reset() {
    setMessage('')
    setMode('current')
    setNewBranch('')
    setError(null)
    setConflict(null)
    setResult(null)
    setBusy(false)
  }

  function close() {
    reset()
    onClose()
  }

  const totalStats = diffs.reduce(
    (acc, d) => ({ added: acc.added + d.stats.added, removed: acc.removed + d.stats.removed }),
    { added: 0, removed: 0 },
  )

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Commit changes"
      description={
        result
          ? undefined
          : `${buffers.length} file${buffers.length === 1 ? '' : 's'} · +${totalStats.added} −${totalStats.removed}`
      }
      footer={
        result ? (
          <Button variant="primary" data-autofocus onClick={close}>Done</Button>
        ) : (
          <>
            <Button onClick={close} disabled={busy}>Cancel</Button>
            <Button variant="primary" disabled={busy || !message.trim()} onClick={() => void commit()}>
              {busy ? 'Committing…' : 'Commit'}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <EmptyState
          icon="check"
          title="Changes committed"
          description={
            result.created_branch
              ? `Branch “${result.branch}” created at ${result.commit_sha.slice(0, 10)}. Merge requests arrive with the collaboration phase.`
              : `Committed to ${result.branch} as ${result.commit_sha.slice(0, 10)}.`
          }
        />
      ) : (
        <div className="ls-editor-commit">
          {/* Target branch */}
          <fieldset className="ls-editor-commit__target">
            <legend className="ls-field__label">Commit to</legend>
            <label className="ls-checkbox">
              <input
                type="radio"
                name="commit-target"
                checked={mode === 'current'}
                onChange={() => setMode('current')}
              />
              <span>
                Current branch <strong>{buffers[0]?.ref ?? defaultBranch}</strong>
              </span>
            </label>
            <label className="ls-checkbox">
              <input
                type="radio"
                name="commit-target"
                checked={mode === 'new'}
                onChange={() => setMode('new')}
              />
              <span>Create new branch</span>
            </label>
            {mode === 'new' && (
              <Input
                label="New branch name"
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                placeholder={`${defaultBranch}-patch-1`}
                aria-invalid={mode === 'new' && !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(newBranch)}
                hint="Letters, digits, dots, dashes and slashes."
              />
            )}
          </fieldset>

          <Input
            label="Commit message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={`Update ${buffers[0]?.path ?? 'files'}`}
          />

          {/* Per-file diff preview (existing design-system renderer). */}
          <div className="ls-editor-commit__diffs" aria-label="Diff preview">
            {diffs.map(({ text, buffer: buf }) =>
              text ? <DiffViewer key={buf.path} diff={text} /> : (
                <p key={buf.path} className="ls-rb__muted">No textual change in {buf.path}.</p>
              ),
            )}
          </div>

          {conflict && (
            <div role="alert" className="ls-editor-conflict">
              <p className="ls-editor-conflict__title">
                The branch changed while you were editing
              </p>
              <p>
                Your edit is based on{' '}
                <code>{(conflict.expected ?? '—').slice(0, 10)}</code> but the branch now points at{' '}
                <code>{(conflict.current ?? '—').slice(0, 10)}</code>. Nothing was overwritten.
              </p>
              <p className="ls-rb__muted">
                Reload the file to reapply your change onto the latest version, or commit to a new branch instead.
              </p>
              <Button size="sm" onClick={() => { setConflict(null); setMode('new') }}>
                Commit to a new branch…
              </Button>
            </div>
          )}

          {error && (
            <div role="alert" className="ls-editor-error">{error}</div>
          )}
        </div>
      )}
    </Dialog>
  )
}
