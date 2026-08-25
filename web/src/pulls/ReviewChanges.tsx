import { useMemo, useState } from 'react'
import { Badge } from '../design-system/Badge'
import { Button } from '../design-system/Button'
import { Icon } from '../design-system/Icon'
import { Textarea } from '../design-system/Textarea'
import type { ChangedFile } from './api'
import { pullsApi, type ReviewThread, type DraftComment, type MergeMethod } from './api'

/**
 * Review surface for a pull request: changed files rendered line-by-line with
 * inline threads (single- or multi-line), suggestion blocks with
 * apply/batch/reject, a draft composer per line, and the compact finish bar.
 *
 * Color contract: green ONLY for approved/resolved/applied; red ONLY for
 * blocking/request-changes/outdated-danger; terracotta accent marks
 * actionable things (pending suggestions, unresolved counts); everything
 * else stays neutral.
 */

interface Props {
  projectId: number
  iid: number
  files: ChangedFile[]
  threads: ReviewThread[]
  drafts: DraftComment[]
  onChanged: () => void
}

export function ReviewChanges({ projectId, iid, files, threads, drafts, onChanged }: Props) {
  const [selection, setSelection] = useState<{ path: string; start: number; end: number } | null>(null)
  const [batchIds, setBatchIds] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)

  const pendingSuggestions = useMemo(() => {
    const ids: number[] = []
    for (const t of threads) {
      for (const n of t.notes) {
        if (n.suggestion?.status === 'pending' && !t.outdated) ids.push(n.id)
      }
    }
    return ids
  }, [threads])

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn()
      setSelection(null)
      onChanged()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Review action failed')
      return false
    }
  }

  function toggleBatch(noteId: number) {
    setBatchIds((ids) => ids.includes(noteId) ? ids.filter((i) => i !== noteId) : [...ids, noteId])
  }

  return (
    <section aria-label="Code review" className="ls-review">
      {error && <div role="alert" className="ls-editor-error ls-mb8">{error}</div>}

      {/* Finish bar — appears only when there is something actionable. */}
      {(pendingSuggestions.length > 0 || drafts.length > 0) && (
        <div className="ls-finishbar" data-testid="finish-bar">
          <span className="ls-accent">
            {drafts.length > 0 && <>{drafts.length} draft{drafts.length === 1 ? '' : 's'} · </>}
            {pendingSuggestions.length > 0 && <>{pendingSuggestions.length} applicable suggestion{pendingSuggestions.length === 1 ? '' : 's'}</>}
          </span>
          {pendingSuggestions.length > 0 && (
            <Button
              size="sm"
              variant="primary"
              disabled={batchIds.length === 0 && pendingSuggestions.length === 0}
              onClick={() => void run(async () => {
                const ids = batchIds.length > 0 ? batchIds : pendingSuggestions
                await pullsApi.applySuggestions(projectId, iid, ids)
                setBatchIds([])
              })}
            >
              Apply suggestions{batchIds.length > 0 ? ` (${batchIds.length})` : ` (${pendingSuggestions.length})`}
            </Button>
          )}
        </div>
      )}

      {files.map((file) => (
        <FilePatch
          key={`${file.kind}-${file.path}`}
          file={file}
          threads={threads.filter((t) => t.path === file.path)}
          selection={selection?.path === file.path ? selection : null}
          onSelect={(start, end) => setSelection({ path: file.path, start, end })}
          onComment={async (start, end, body) => {
            const ok = await run(async () => {
              await pullsApi.createThread(projectId, iid, {
                body, path: file.path, side: 'new', line_start: start, line_end: end,
              })
            })
            return ok
          }}
          projectId={projectId}
          iid={iid}
          batchIds={batchIds}
          onToggleBatch={toggleBatch}
        />
      ))}
    </section>
  )
}

// ── one file's patch + threads ───────────────────────────────────────────────

function FilePatch({
  file,
  threads,
  selection,
  onSelect,
  onComment,
  projectId,
  iid,
  batchIds,
  onToggleBatch,
}: {
  file: ChangedFile
  threads: ReviewThread[]
  selection: { start: number; end: number } | null
  onSelect: (start: number, end: number) => void
  onComment: (start: number, end: number, body: string) => Promise<boolean>
  projectId: number
  iid: number
  batchIds: number[]
  onToggleBatch: (noteId: number) => void
}) {
  const rows = useMemo(() => parsePatchRows(file.patch ?? ''), [file.patch])
  const newLines = rows.filter((r) => r.newLine !== null).map((r) => r.newLine!)

  function rangeFor(clicked: number): { start: number; end: number } {
    if (!selection) return { start: clicked, end: clicked }
    // Shift-click extends the range between anchor and click.
    const lo = Math.min(selection.start, clicked)
    const hi = Math.max(selection.start, clicked)
    return { start: lo, end: hi }
  }

  return (
    <div className="ls-filepatch" aria-label={`Changes in ${file.path}`}>
      <header className="ls-filepatch__head">
        <code>{file.path}</code>
        <span className="ls-pulls__kind">{file.kind}</span>
      </header>
      <table className="ls-patch">
        <tbody>
          {rows.map((row, i) => {
            if (row.newLine === null) {
              return (
                <tr key={i} className="ls-patch__row ls-patch__row--ctx">
                  <td className="ls-patch__ln" />
                  <td className="ls-patch__sign" aria-hidden="true">{row.sign}</td>
                  <td className="ls-patch__code"><code>{row.text}</code></td>
                </tr>
              )
            }
            const ln = row.newLine
            const inRange = selection ? ln >= selection.start && ln <= selection.end : false
            const thread = threads.find(
              (t) => !t.outdated && ln >= t.line_start && ln <= t.line_end,
            )
            return (
              <LineRow
                key={i}
                ln={ln}
                sign={row.sign}
                text={row.text}
                highlighted={inRange}
                hasThread={!!thread}
                onClick={() => onSelect(rangeFor(ln).start, rangeFor(ln).end)}
              />
            )
          })}
        </tbody>
      </table>

      {/* Inline composer anchored to the selected range. */}
      {selection && newLines.length > 0 && (
        <InlineComposer
          rangeText={`Lines ${selection.start}${selection.end !== selection.start ? `–${selection.end}` : ''}`}
          onCancel={() => onSelect(0, 0)}
          onSubmit={async (body) => {
            await fetchDraftOrThread(body, selection, onComment, projectId, iid)
          }}
        />
      )}

      {/* Threads render inline under their lines. */}
      {threads.map((t) => (
        <ThreadBlock
          key={t.id}
          thread={t}
          projectId={projectId}
          iid={iid}
          batchIds={batchIds}
          onToggleBatch={onToggleBatch}
          onChanged={onComment}
        />
      ))}
    </div>
  )

  function LineRow({
    ln, sign, text, highlighted, hasThread, onClick,
  }: { ln: number; sign: string; text: string; highlighted: boolean; hasThread: boolean; onClick: () => void }) {
    return (
      <>
        <tr
          className={`ls-patch__row${highlighted ? ' ls-patch__row--sel' : ''}`}
          onClick={onClick}
          title="Click to comment; shift-click for a range"
        >
          <td className="ls-patch__ln">{ln}</td>
          <td className="ls-patch__sign" aria-hidden="true">{sign}</td>
          <td className="ls-patch__code"><code>{text}</code></td>
        </tr>
        {hasThread && (
          <tr className="ls-patch__threadanchor" aria-hidden="true"><td colSpan={3} /></tr>
        )}
      </>
    )
  }

  async function fetchDraftOrThread(
    body: string,
    sel: { start: number; end: number },
    directThread: (s: number, e: number, b: string) => Promise<unknown>,
    _pid: number,
    _iid: number,
  ) {
    await directThread(sel.start, sel.end, body)
  }
}

// ── thread block with suggestion controls ─────────────────────────────────────

function ThreadBlock({
  thread,
  projectId,
  iid,
  batchIds,
  onToggleBatch,
}: {
  thread: ReviewThread
  projectId: number
  iid: number
  batchIds: number[]
  onToggleBatch: (noteId: number) => void
  onChanged?: (s: number, e: number, b: string) => Promise<boolean>
}) {
  const [replyOpen, setReplyOpen] = useState(false)
  const [replyBody, setReplyBody] = useState('')

  return (
    <div className={`ls-thread${thread.outdated ? ' ls-thread--outdated' : ''}${thread.resolved ? ' ls-thread--resolved' : ''}`}>
      <header className="ls-thread__meta">
        <strong>{thread.notes[0]?.author?.username ?? 'ghost'}</strong>
        <span className="ls-thread__loc">lines {thread.line_start}{thread.line_end !== thread.line_start ? `–${thread.line_end}` : ''}</span>
        {thread.outdated && <Badge variant="neutral">outdated</Badge>}
        {thread.resolved && <span className="ls-thread__resolvedmark" aria-label="Resolved"><Icon name="check" size={11} /> resolved</span>}
        {thread.code_owner_users.length > 0 && (
          <span className="ls-thread__owners">owner: {thread.code_owner_users.join(', ')}</span>
        )}
        <span className="ls-thread__spacer" />
        <button
          type="button"
          className="ls-thread__action"
          onClick={() => {
            void pullsApi.resolveThread(projectId, iid, thread.id, thread.resolved).then(() => window.location.reload())
          }}
        >
          {thread.resolved ? 'Reopen' : 'Resolve'}
        </button>
      </header>

      {thread.notes.map((n) => (
        <div key={n.id} className="ls-thread__note">
          <p className="ls-thread__body">{n.body}</p>
          {n.suggestion && (
            <div className={`ls-suggestion ls-suggestion--${n.suggestion.status}`}>
              <div className="ls-suggestion__head">
                Suggestion · {n.suggestion.status}
                {n.suggestion.applied_commit_sha && (
                  <code> {n.suggestion.applied_commit_sha.slice(0, 10)}</code>
                )}
              </div>
              {n.suggestion.status === 'pending' && !thread.outdated && (
                <label className="ls-checkline">
                  <input
                    type="checkbox"
                    checked={batchIds.includes(n.id)}
                    onChange={() => onToggleBatch(n.id)}
                    aria-label={`Select suggestion ${n.id} for batch apply`}
                  />
                  <span>Add to batch</span>
                </label>
              )}
            </div>
          )}
        </div>
      ))}

      {replyOpen ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!replyBody.trim()) return
            void pullsApi.replyThread(projectId, iid, thread.id, replyBody.trim()).then(() => window.location.reload())
          }}
        >
          <Textarea label="" value={replyBody} onChange={(e) => setReplyBody(e.target.value)} placeholder={'Reply… ```suggestion fences allowed'} />
          <div className="ls-thread__actions">
            <Button size="sm" variant="primary" type="submit" disabled={!replyBody.trim()}>Reply</Button>
            <Button size="sm" type="button" onClick={() => { setReplyOpen(false); setReplyBody('') }}>Cancel</Button>
          </div>
        </form>
      ) : (
        <button type="button" className="ls-thread__action" onClick={() => setReplyOpen(true)}>Reply</button>
      )}
    </div>
  )
}

function InlineComposer({
  rangeText,
  onCancel,
  onSubmit,
}: {
  rangeText: string
  onCancel: () => void
  onSubmit: (body: string) => Promise<unknown>
}) {
  const [body, setBody] = useState('')
  return (
    <form
      className="ls-inlinecomposer"
      onSubmit={(e) => {
        e.preventDefault()
        if (!body.trim()) return
        void onSubmit(body.trim()).then((ok) => { if (ok) setBody('') })
      }}
    >
      <span className="ls-formfield__label">{rangeText}</span>
      <Textarea label="" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Leave an inline comment…" />
      <div className="ls-thread__actions">
        <Button size="sm" variant="primary" type="submit" disabled={!body.trim()}>Comment</Button>
        <Button size="sm" type="button" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

// ── unified-patch parser → rows ───────────────────────────────────────────────

export interface PatchRow { sign: '+' | '-' | ' '; text: string; newLine: number | null }

/** Parses a unified diff body into display rows with new-side numbering. */
export function parsePatchRows(patch: string): PatchRow[] {
  const out: PatchRow[] = []
  let newLine = 0
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) { newLine = Number(hunk[1]); continue }
    if (raw.startsWith('diff ') || raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('index ')) continue
    if (raw.startsWith('+')) { out.push({ sign: '+', text: raw.slice(1), newLine }); newLine++; continue }
    if (raw.startsWith('-')) { out.push({ sign: '-', text: raw.slice(1), newLine: null }); continue }
    if (raw.startsWith('\\')) continue // "\ No newline at end of file"
    if (raw.startsWith(' ')) { out.push({ sign: ' ', text: raw.slice(1), newLine }); newLine++; continue }
    if (raw === '') continue
    out.push({ sign: ' ', text: raw, newLine }); newLine++
  }
  return out
}

export type { MergeMethod }
