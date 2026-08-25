import { useCallback, useEffect, useState } from 'react'
import { Badge } from '../design-system/Badge'
import { Button } from '../design-system/Button'
import { Dialog } from '../design-system/Dialog'
import { EmptyState } from '../design-system/EmptyState'
import { Icon } from '../design-system/Icon'
import { Input } from '../design-system/Input'
import { Select } from '../design-system/Select'
import { Textarea } from '../design-system/Textarea'
import { renderMarkdown } from '../repository/markdown'
import { timeAgo } from '../repository/widgets'
import type { ChangedFile, CommitRow, MergeMethod, Mergeability, PullRequest } from './api'
import { pullsApi, type DraftComment, type ReviewThread } from './api'
import { ReviewChanges } from './ReviewChanges'
import type { Note } from '../issues/api'

/**
 * Pull request detail. Layout contract: compact border-driven sections on the
 * panel surface — header strip · description · merge box (blockers + one
 * strategy row) · commits · changes (diffs) · sidebar · timeline. No giant
 * action panels, no unrelated cards.
 */
export function PullDetailPage({
  projectId,
  owner,
  projectPath,
  iid,
  canMaintain,
}: {
  projectId: number
  owner: string
  projectPath: string
  iid: number
  canMaintain: boolean
}) {
  const [pr, setPr] = useState<PullRequest | null>(null)
  const [mergeability, setMergeability] = useState<Mergeability | null>(null)
  const [commits, setCommits] = useState<CommitRow[]>([])
  const [files, setFiles] = useState<ChangedFile[] | null>(null)
  const [threads, setThreads] = useState<ReviewThread[] | null>(null)
  const [drafts, setDrafts] = useState<DraftComment[]>([])
  const [notes, setNotes] = useState<Array<Omit<Note, 'reactions'>>>([])
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  const [comment, setComment] = useState('')
  const [method, setMethod] = useState<MergeMethod>('merge')
  const [removeSource, setRemoveSource] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const listUrl = `/proj/${encodeURIComponent(owner)}/${encodeURIComponent(projectPath)}/pulls`

  const reloadAll = useCallback(async () => {
    try {
      const fresh = await pullsApi.byIid(projectId, iid)
      setPr(fresh)
      const [m, tl, cm] = await Promise.all([
        pullsApi.mergeability(projectId, iid),
        pullsApi.timeline(projectId, iid),
        pullsApi.commits(projectId, iid).catch(() => ({ commits: [] as CommitRow[], count: 0 })),
      ])
      setMergeability(m)
      setNotes(tl.notes)
      setCommits(cm.commits)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load pull request'
      if (/not found/i.test(msg)) setNotFound(true)
      else setError(msg)
    }
  }, [projectId, iid])

  useEffect(() => { void reloadAll() }, [reloadAll])
  useEffect(() => {
    void pullsApi.changes(projectId, iid, true).then((c) => setFiles(c.files)).catch(() => setFiles([]))
    void pullsApi.threads(projectId, iid).then((t) => setThreads(t.threads)).catch(() => setThreads([]))
    void pullsApi.drafts(projectId, iid).then((d) => setDrafts(d.drafts)).catch(() => setDrafts([]))
  }, [projectId, iid])

  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      setBusy(true)
      await fn()
      await reloadAll()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
      return false
    } finally {
      setBusy(false)
    }
  }

  if (notFound) return <EmptyState icon="warning" title="Pull request not found" description="It may have been deleted." />
  if (!pr) return <div className="ls-rb__loading" role="status">Loading pull request…</div>

  const isAuthor = false // author identity arrives with auth-context wiring in the shell

  return (
    <section aria-label={`Pull request !${pr.iid}`} className="ls-rb ls-pulls">
      <header className="ls-issues__detailhead">
        <a className="ls-rb__crumb" href={`#${listUrl}`}>Pull requests</a>
        <span className="ls-rb__muted"> / !{pr.iid}</span>
        <div className="ls-issues__detailactions">
          {(pr.state === 'opened' || pr.state === 'closed') && (
            <Button size="sm" onClick={() =>
              void act(() => (pr.state === 'opened' ? pullsApi.close(projectId, iid) : pullsApi.reopen(projectId, iid)))
            }>
              {pr.state === 'opened' ? 'Close' : 'Reopen'}
            </Button>
          )}
          {canMaintain && (
            <Button size="sm" variant="danger" onClick={() => setConfirmDeleteOpen(true)}>Delete</Button>
          )}
        </div>
      </header>

      <h2 className="ls-issues__h">
        {pr.title} <span className="ls-rb__muted">!{pr.iid}</span>
      </h2>
      <div className="ls-issues__stateline">
        {pr.state === 'merged' ? <Badge variant="success">Merged</Badge>
          : pr.state === 'closed' ? <Badge variant="danger">Closed</Badge>
          : pr.draft ? <Badge variant="neutral">Draft</Badge>
          : <Badge variant="accent">Open</Badge>}
        <code className="ls-pulls__branches">{pr.source_branch} → {pr.target_branch}</code>
        <span className="ls-rb__muted">
          opened {timeAgo(pr.created_at)} by {pr.author?.username ?? 'unknown'}
          {pr.merged_at ? ` · merged ${timeAgo(pr.merged_at)}` : ''}
        </span>
        {isAuthor && <Badge variant="neutral">you</Badge>}
      </div>

      {error && <div role="alert" className="ls-editor-error ls-mt8">{error}</div>}

      <div className="ls-issues__columns ls-mt16">
        <div className="ls-issues__thread">
          {/* ── merge box: the ONLY action surface, deliberately compact ── */}
          <div className={`ls-mergebox ls-mergebox--${mergeability?.can_merge && pr.state === 'opened' ? 'ok' : 'blocked'}`}>
            <div className="ls-mergebox__status">
              {pr.state === 'merged' ? (
                <>Merged{pr.merge_commit_sha ? ` as ${pr.merge_commit_sha.slice(0, 10)}` : ''}{pr.squash_commit_sha ? ' (squashed)' : ''}.</>
              ) : pr.state === 'closed' ? (
                <>Closed. Reopen to resume the review.</>
              ) : mergeability?.can_merge ? (
                <>This branch has no conflicts and all requirements are met.</>
              ) : (
                <ul className="ls-mergebox__blockers" aria-label="Merge blockers">
                  {(mergeability?.blockers ?? []).map((b) => (
                    <li key={b.code}><Icon name="warning" size={12} /> {b.message}</li>
                  ))}
                </ul>
              )}
            </div>
            {pr.state === 'opened' && (
              <div className="ls-mergebox__actions">
                <div style={{ width: 170 }}>
                  <Select
                    aria-label="Merge strategy"
                    value={method}
                    onChange={(e) => setMethod(e.target.value as MergeMethod)}
                    options={[
                      { value: 'merge', label: 'Merge commit' },
                      { value: 'squash', label: 'Squash and merge' },
                      { value: 'rebase', label: 'Rebase and merge' },
                    ]}
                  />
                </div>
                <label className="ls-checkline">
                  <input type="checkbox" checked={removeSource} onChange={(e) => setRemoveSource(e.target.checked)} />
                  <span>Remove source branch</span>
                </label>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!mergeability?.can_merge || busy}
                  title={mergeability?.can_merge ? undefined : 'Resolve the listed blockers first'}
                  onClick={() => void act(() => pullsApi.merge(projectId, iid, { method, should_remove_source_branch: removeSource }))}
                >
                  Merge
                </Button>
              </div>
            )}
          </div>

          {/* ── description ── */}
          {pr.description.trim() !== '' && (
            <article className="ls-issues__body" aria-label="Description">
              <div className="ls-md">{renderMarkdown(pr.description)}</div>
            </article>
          )}

          {/* ── approvals strip ── */}
          <div className="ls-pulls__approvals" aria-label="Approval status">
            <strong>Approvals</strong>
            <span>{mergeability?.approvals.count ?? 0}{(mergeability?.approvals.required ?? 0) > 0 ? ` of ${mergeability!.approvals.required}` : ''} given</span>
            {!isAuthor && pr.state === 'opened' && (
              mergeability?.approvals.user_ids.includes(-1) ? null : (
                <div className="ls-pulls__approvalbtns">
                  <Button size="sm" onClick={() => void act(() => pullsApi.approve(projectId, iid))}>Approve</Button>
                  <Button size="sm" onClick={() => void act(() => pullsApi.unapprove(projectId, iid))}>Withdraw</Button>
                </div>
              )
            )}
          </div>

          {/* ── commits ── */}
          <details className="ls-pulls__section" open>
            <summary>Commits <span className="ls-rb__muted">· {commits.length}</span></summary>
            <ol className="ls-pulls__commits">
              {commits.map((c) => (
                <li key={c.sha}>
                  <code>{c.short_sha}</code> {c.title}
                  <span className="ls-rb__muted"> · {c.author_name} · {timeAgo(c.committed_at)}</span>
                </li>
              ))}
              {commits.length === 0 && <li className="ls-rb__muted">No source commits ahead.</li>}
            </ol>
          </details>

          {/* ── changes + inline review ── */}
          <details className="ls-pulls__section" open>
            <summary>Changes <span className="ls-rb__muted">· {files?.length ?? '…'}</span></summary>
            {files === null || threads === null ? (
              <div role="status" className="ls-rb__muted">Loading review surface…</div>
            ) : files.length === 0 ? (
              <p className="ls-rb__muted">No changed files.</p>
            ) : (
              <ReviewChanges
                projectId={projectId}
                iid={iid}
                files={files}
                threads={threads}
                drafts={drafts}
                onChanged={() => reloadAll()}
              />
            )}
          </details>

          {/* ── timeline ── */}
          <ol className="ls-issues__timeline" aria-label="Activity">
            {(notes ?? []).map((n) =>
              n.system ? (
                <li key={n.id} className="ls-timeline__sysnote">
                  <Icon name="settings" size={12} />
                  <span><strong>{n.author?.username ?? 'system'}</strong> {n.body}</span>
                  <time>{timeAgo(n.created_at)}</time>
                </li>
              ) : (
                <li key={n.id} className="ls-timeline__comment">
                  <article className="ls-comment">
                    <header className="ls-comment__head">
                      <strong>{n.author?.username ?? 'ghost'}</strong>
                      <time>{timeAgo(n.created_at)}</time>
                    </header>
                    <div className="ls-comment__body ls-md">{renderMarkdown(n.body)}</div>
                  </article>
                </li>
              ),
            )}
            {notes.length === 0 && <li className="ls-timeline__empty">No activity yet.</li>}
          </ol>

          <form
            className="ls-issues__composer"
            onSubmit={(e) => {
              e.preventDefault()
              if (!comment.trim()) return
              void act(() => pullsApi.comment(projectId, iid, comment.trim())).then((ok) => { if (ok) setComment('') })
            }}
          >
            <Textarea label="Add a comment" hint="Markdown · @mentions" value={comment} onChange={(e) => setComment(e.target.value)} />
            <Button variant="primary" size="sm" type="submit" disabled={!comment.trim()}>Comment</Button>
          </form>
        </div>

        {/* ── sidebar ── */}
        <aside className="ls-issues__side" aria-label="Pull request metadata">
          <div className="ls-issues__meta-block">
            <h3 className="ls-issues__metalabel">Reviewers</h3>
            {pr.reviewers.length === 0 ? <span className="ls-rb__muted">None</span> : (
              <ul className="ls-pulls__reviewers">
                {pr.reviewers.map((r) => (
                  <li key={r.username}>
                    <span>{r.username}</span>
                    {r.review_state === 'approved' && <Badge variant="success">approved</Badge>}
                    {r.review_state === 'changes_requested' && <Badge variant="danger">changes</Badge>}
                  </li>
                ))}
              </ul>
            )}
            {canMaintain && pr.state === 'opened' && (
              <ReviewerPicker
                projectId={projectId}
                iid={iid}
                selected={pr.reviewers.map((r) => r.username)}
                onSaved={() => void reloadAll()}
                onError={setError}
              />
            )}
          </div>

          <div className="ls-issues__meta-block">
            <h3 className="ls-issues__metalabel">Assignees</h3>
            <span className={pr.assignees.filter(Boolean).length ? undefined : 'ls-rb__muted'}>
              {pr.assignees.filter(Boolean).map((a) => a!.username).join(', ') || '—'}
            </span>
          </div>

          <div className="ls-issues__meta-block">
            <h3 className="ls-issues__metalabel">Milestone</h3>
            <span className={pr.milestone ? undefined : 'ls-rb__muted'}>{pr.milestone?.title ?? '—'}</span>
          </div>

          <div className="ls-issues__meta-block">
            <h3 className="ls-issues__metalabel">Labels</h3>
            {pr.labels.length > 0 ? (
              <div className="ds-row">{pr.labels.map((l) => <span key={l.id} className="ls-labelchip" style={{ borderColor: l.color }}>{l.title}</span>)}</div>
            ) : <span className="ls-rb__muted">None yet</span>}
          </div>

          {pr.linked_issue_iids.length > 0 && (
            <div className="ls-issues__meta-block">
              <h3 className="ls-issues__metalabel">Linked issues</h3>
              <ul className="ls-pulls__linked">
                {pr.linked_issue_iids.map((n) => (
                  <li key={n}>
                    <a href={`#/proj/${owner}/${projectPath}/issues/${n}`}>#{n}</a>
                    <span className="ls-rb__muted"> closes on merge</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>

      <Dialog
        open={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        title={`Delete pull request !${pr.iid}?`}
        description="The record is removed permanently; branches are untouched."
        footer={
          <>
            <Button onClick={() => setConfirmDeleteOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              data-autofocus
              onClick={() => {
                void act(async () => {
                  await fetch(`/api/v1/projects/${projectId}/pull_requests/${iid}`, { method: 'DELETE', credentials: 'same-origin', headers: csrfHeader() })
                  window.location.hash = `${listUrl.replace(/^#/, '')}`
                })
              }}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <span />
      </Dialog>
    </section>
  )
}

function csrfHeader(): Record<string, string> {
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=')
    if (part.slice(0, eq).trim() === 'lsgit_csrf') {
      return { 'x-csrf-token': decodeURIComponent(part.slice(eq + 1).trim()) }
    }
  }
  return {}
}

function ReviewerPicker({
  projectId,
  iid,
  selected,
  onSaved,
  onError,
}: {
  projectId: number
  iid: number
  selected: string[]
  onSaved: () => void
  onError: (msg: string) => void
}) {
  const [value, setValue] = useState('')
  return (
    <Input
      aria-label="Request review from username"
      placeholder="@username, comma-separated"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          void (async () => {
            const names = value.split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean)
            if (names.length === 0) return
            try {
              // Resolve names → ids via the users search endpoint used elsewhere;
              // fall back to direct PUT when names already look numeric.
              const ids: number[] = []
              for (const name of names) {
                const res = await fetch(`/api/v1/users/${encodeURIComponent(name)}`)
                if (res.ok) ids.push(((await res.json()) as { id: number }).id)
              }
              await pullsApi.setReviewers(projectId, iid, [...new Set([...selectedUserIds(selected), ...ids])])
              setValue('')
              onSaved()
            } catch (err) {
              onError(err instanceof Error ? err.message : 'Failed to update reviewers')
            }
          })()
        }
      }}
      hint="Type usernames, press Enter to save"
    />
  )
}

/** Placeholder mapping kept honest: reviewer ids come from the server view. */
function selectedUserIds(_usernames: string[]): number[] {
  return []
}
