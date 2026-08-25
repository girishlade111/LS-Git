import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Badge } from '../design-system/Badge'
import { Button } from '../design-system/Button'
import { Dialog } from '../design-system/Dialog'
import { EmptyState } from '../design-system/EmptyState'
import { Icon } from '../design-system/Icon'
import { IconButton } from '../design-system/IconButton'
import { Input } from '../design-system/Input'
import { Select } from '../design-system/Select'
import { Textarea } from '../design-system/Textarea'
import { Tooltip } from '../design-system/Tooltip'
import { renderMarkdown } from '../repository/markdown'
import { timeAgo } from '../repository/widgets'
import {
  issuesApi,
  type Issue,
  type LabelFull,
  type MilestoneFull,
  type Note,
  type ReactionSummary,
} from './api'
import { LabelChip } from './LabelChip'

/** Mirrors the server-side emoji allowlist. */
const EMOJI: Record<string, string> = {
  thumbsup: '👍', thumbsdown: '👎', smile: '🙂', tada: '🎉', heart: '❤️', rocket: '🚀',
}

const TASK_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s*(.*)$/

export interface IssueDetailProps {
  projectId: number
  owner: string
  projectPath: string
  iid: number
  /** Viewer may edit metadata / delete (owner or admin today). */
  canMaintain: boolean
  navigate: (hash: string) => void
}

/**
 * Issue detail: header + state actions, description with interactive Markdown
 * task lists, sidebar metadata, reaction bar, and the activity timeline
 * (human comments + system notes).
 */
export function IssueDetailPage({ projectId, owner, projectPath, iid, canMaintain, navigate }: IssueDetailProps) {
  const [issue, setIssue] = useState<Issue | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [labels, setLabels] = useState<LabelFull[]>([])
  const [milestones, setMilestones] = useState<MilestoneFull[]>([])
  const [reactions, setReactions] = useState<ReactionSummary>([])
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  const [commentBody, setCommentBody] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const base = `/proj/${encodeURIComponent(owner)}/${encodeURIComponent(projectPath)}`
  const listUrl = `${base}/issues`

  const reloadIssue = useCallback(async () => {
    try {
      setIssue(await issuesApi.byIid(projectId, iid))
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load issue'
      if (/not found/i.test(msg)) setNotFound(true)
      else setError(msg)
    }
  }, [projectId, iid])

  const reloadTimeline = useCallback(async () => {
    try {
      setNotes((await issuesApi.timeline(projectId, iid)).notes)
    } catch { /* surfaced by other loads */ }
  }, [projectId, iid])

  useEffect(() => {
    void reloadIssue()
    void reloadTimeline()
  }, [reloadIssue, reloadTimeline])
  useEffect(() => {
    void issuesApi.labels(projectId).then(setLabels).catch(() => setLabels([]))
    void issuesApi.milestones(projectId).then(setMilestones).catch(() => setMilestones([]))
  }, [projectId])
  useEffect(() => {
    void issuesApi.issueReactions(projectId, iid).then(setReactions).catch(() => setReactions([]))
  }, [projectId, iid])

  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn()
      await Promise.all([reloadIssue(), reloadTimeline()])
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
      return false
    }
  }

  if (notFound) {
    return (
      <EmptyState
        icon="warning"
        title="Issue not found"
        description="It may have been deleted, or you may not have access."
      />
    )
  }
  if (!issue) return <div className="ls-rb__loading" role="status">Loading issue…</div>

  return (
    <section aria-label={`Issue ${issue.iid}`} className="ls-rb ls-issues">
      <header className="ls-issues__detailhead">
        <a className="ls-rb__crumb" href={`#${listUrl}`}>Issues</a>
        <span className="ls-rb__muted"> / #{issue.iid}</span>
        <div className="ls-issues__detailactions">
          <Button size="sm" onClick={() =>
            void act(() =>
              issue.state === 'opened' ? issuesApi.close(projectId, iid) : issuesApi.reopen(projectId, iid),
            )
          }>
            {issue.state === 'opened' ? 'Close issue' : 'Reopen issue'}
          </Button>
          {canMaintain && (
            <Tooltip content="Delete issue">
              <IconButton label="Delete issue" icon="trash" onClick={() => setConfirmDelete(true)} />
            </Tooltip>
          )}
        </div>
      </header>

      <div className="ls-issues__detailtitle">
        {editingTitle ? (
          <form
            className="ds-row"
            onSubmit={(e) => {
              e.preventDefault()
              void act(() => issuesApi.update(projectId, iid, { title: titleDraft })).then((ok) => {
                if (ok) setEditingTitle(false)
              })
            }}
          >
            <Input value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} aria-label="Issue title" />
            <Button variant="primary" size="sm" type="submit">Save</Button>
            <Button size="sm" type="button" onClick={() => setEditingTitle(false)}>Cancel</Button>
          </form>
        ) : (
          <>
            <h2 className="ls-issues__h">
              {issue.title}{' '}
              <span className="ls-rb__muted">#{issue.iid}</span>
              <IconButton
                label="Edit title"
                icon="code"
                className="ls-issues__edittitle"
                onClick={() => { setTitleDraft(issue.title); setEditingTitle(true) }}
              />
            </h2>
            <div className="ls-issues__stateline">
              {issue.state === 'closed' ? <Badge variant="success">Closed</Badge> : <Badge variant="accent">Open</Badge>}
              <span className="ls-rb__muted">
                opened {timeAgo(issue.created_at)} by {issue.author?.username ?? 'unknown'}
                {issue.closed_at ? ` · closed ${timeAgo(issue.closed_at)}` : ''}
              </span>
              {issue.confidential && <Badge variant="danger">confidential</Badge>}
            </div>
          </>
        )}
      </div>

      {error && <div role="alert" className="ls-editor-error">{error}</div>}

      <div className="ls-issues__columns">
        <div className="ls-issues__thread">
          {issue.description.trim() !== '' && (
            <article className="ls-issues__body" aria-label="Description">
              <TaskAwareMarkdown text={issue.description} onToggle={(idx) => void act(() => issuesApi.toggleTask(projectId, iid, idx))} />
            </article>
          )}

          <ReactionsBar
            summary={reactions}
            names={['thumbsup', 'thumbsdown', 'tada', 'heart', 'rocket']}
            onToggle={(name) =>
              void act(async () => {
                const r = await issuesApi.toggleIssueReaction(projectId, iid, name)
                setReactions(r.summary)
              })
            }
            onChanged={setReactions}
          />

          <ol className="ls-issues__timeline" aria-label="Activity">
            {notes.map((n) =>
              n.system ? (
                <li key={n.id} className="ls-timeline__sysnote">
                  <Icon name="settings" size={12} />
                  <span><strong>{n.author?.username ?? 'system'}</strong> {n.body}</span>
                  <time>{timeAgo(n.created_at)}</time>
                </li>
              ) : (
                <li key={n.id}>
                  <CommentBlock
                    note={n}
                    onReact={(name) =>
                      void act(async () => {
                        await issuesApi.toggleNoteReaction(projectId, iid, n.id, name)
                        await reloadTimeline()
                      })
                    }
                  />
                </li>
              ),
            )}
            {notes.length === 0 && <li className="ls-timeline__empty">No activity yet.</li>}
          </ol>

          <form
            className="ls-issues__composer"
            onSubmit={(e) => {
              e.preventDefault()
              if (!commentBody.trim()) return
              void act(() => issuesApi.comment(projectId, iid, commentBody.trim())).then((ok) => {
                if (ok) setCommentBody('')
              })
            }}
          >
            <Textarea
              label="Add a comment"
              hint="Markdown · @username mentions · #iid references"
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
            />
            <Button variant="primary" size="sm" type="submit" disabled={!commentBody.trim()}>Comment</Button>
          </form>
        </div>

        <aside className="ls-issues__side" aria-label="Issue metadata">
          <MetaSection label="Assignees">
            <span className={issue.assignees.filter(Boolean).length === 0 ? 'ls-rb__muted' : undefined}>
              {issue.assignees.filter(Boolean).map((a) => a!.username).join(', ') || '—'}
            </span>
          </MetaSection>

          <MetaSection label="Milestone">
            <span className={issue.milestone ? undefined : 'ls-rb__muted'}>
              {issue.milestone?.title ?? '—'}
              {issue.milestone?.due_date ? ` · due ${issue.milestone.due_date}` : ''}
            </span>
            {canMaintain && (
              <Select
                aria-label="Set milestone"
                value={issue.milestone?.id ? String(issue.milestone.id) : ''}
                onChange={(e) => {
                  const v = e.target.value
                  void act(() =>
                    issuesApi.update(projectId, iid, { milestone_id: v === '' ? null : Number(v) }),
                  )
                }}
                options={[
                  { value: '', label: 'No milestone' },
                  ...milestones.filter((m) => m.state === 'active').map((m) => ({ value: String(m.id), label: m.title })),
                ]}
              />
            )}
          </MetaSection>

          <MetaSection label="Due date">
            <span className={issue.due_date ? undefined : 'ls-rb__muted'}>{issue.due_date ?? '—'}</span>
            {canMaintain && (
              <Input
                aria-label="Set due date"
                type="date"
                value={issue.due_date ?? ''}
                onChange={(e) => void act(() => issuesApi.update(projectId, iid, { due_date: e.target.value || null }))}
              />
            )}
          </MetaSection>

          <MetaSection label="Labels">
            {issue.labels.length > 0 ? (
              <div className="ds-row">{issue.labels.map((l) => <LabelChip key={l.id} label={l} />)}</div>
            ) : (
              <span className="ls-rb__muted">None yet</span>
            )}
            {canMaintain && labels.length > 0 && (
              <ul className="ls-issues__labelpicker" aria-label="Apply labels">
                {labels.map((l) => (
                  <li key={l.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={issue.labels.some((x) => x.id === l.id)}
                        onChange={(e) => {
                          const add = e.target.checked
                          const nextTitles = add
                            ? [...issue.labels.map((x) => x.title), l.title]
                            : issue.labels.filter((x) => x.title !== l.title).map((x) => x.title)
                          void act(() => issuesApi.update(projectId, iid, { labels: nextTitles }))
                        }}
                      />
                      <LabelChip label={l} />
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </MetaSection>
        </aside>
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete issue #${issue.iid}?`}
        description="The issue and its comments are removed permanently. This cannot be undone."
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="danger"
              data-autofocus
              onClick={() => {
                void act(() => issuesApi.remove(projectId, iid)).then((ok) => {
                  if (ok) navigate(`#${listUrl}`)
                })
              }}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, color: 'var(--ls-text-secondary)', fontSize: 'var(--ls-fs-body)' }}>
          Only project owners and administrators can delete issues.
        </p>
      </Dialog>
    </section>
  )
}

// ---------------------------------------------------------------------------

function MetaSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ls-issues__meta-block">
      <h3 className="ls-issues__metalabel">{label}</h3>
      {children}
    </div>
  )
}

/**
 * Renders description markdown while turning `- [ ]` lines into live toggles.
 * Completion state lives IN the markdown (server contract); each toggle calls
 * the server's task endpoint which rewrites the description and returns fresh
 * progress.
 */
function TaskAwareMarkdown({ text, onToggle }: { text: string; onToggle: (index: number) => void }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let buffer: string[] = []
  let taskIndex = 0
  let key = 0

  const flush = () => {
    if (buffer.length > 0) {
      blocks.push(<div key={`md${key++}`}>{renderMarkdown(buffer.join('\n'))}</div>)
      buffer = []
    }
  }

  for (const line of lines) {
    const m = TASK_LINE.exec(line)
    if (m) {
      flush()
      const idx = taskIndex++
      const checked = m[1]?.toLowerCase() === 'x'
      const taskText = (m[2] ?? '').trim()
      blocks.push(
        <TaskRow
          key={`t${key++}`}
          index={idx}
          checked={checked}
          text={taskText}
          onToggle={() => onToggle(idx)}
        />,
      )
    } else {
      buffer.push(line)
    }
  }
  flush()

  return <div className="ls-md">{blocks}</div>
}

function TaskRow({ index, checked, text, onToggle }: { index: number; checked: boolean; text: string; onToggle: () => void }) {
  return (
    <div className="ls-taskrow">
      <input
        type="checkbox"
        id={`task-${index}`}
        checked={checked}
        onChange={onToggle}
        aria-label={`Mark '${text}' ${checked ? 'incomplete' : 'complete'}`}
      />
      <label htmlFor={`task-${index}`} className={checked ? 'ls-taskrow__done' : undefined}>{text}</label>
    </div>
  )
}

function ReactionsBar({
  summary,
  names,
  onToggle,
  onChanged,
}: {
  summary: ReactionSummary
  names: Array<string>
  onToggle: (name: string) => void
  onChanged?: (summary: ReactionSummary) => void
}) {
  // Optimistic local mirror; server response replaces it when it arrives.
  const [local, setLocal] = useState<ReactionSummary | null>(null)
  useEffect(() => { setLocal(null) /* reset when server state changes */ }, [summary])

  const current = local ?? summary

  function toggle(name: string) {
    const existing = current.find((r) => r.name === name)
    const next: ReactionSummary = existing
      ? current
          .map((r) => (r.name === name ? { ...r, count: r.count + (r.me ? -1 : 1), me: !r.me } : r))
          .filter((r) => r.count > 0)
      : [...current, { name, count: 1, me: true }]
    setLocal(next)
    onChanged?.(next)
    onToggle(name)
  }

  return (
    <div className="ls-reactions" aria-label="Add reaction">
      {names.map((name) => {
        const cur = current.find((r) => r.name === name)
        return (
          <button
            key={name}
            type="button"
            className={`ls-reactions__pill${cur?.me ? ' ls-reactions__pill--me' : ''}`}
            aria-pressed={cur?.me ?? false}
            aria-label={`React ${name}${cur && cur.count > 0 ? ` (${cur.count})` : ''}`}
            onClick={() => toggle(name)}
          >
            <span aria-hidden="true">{EMOJI[name]}</span>
            {cur && cur.count > 0 && <span>{cur.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

function CommentBlock({ note, onReact }: { note: Note; onReact: (name: string) => void }) {
  return (
    <article className="ls-comment">
      <header className="ls-comment__head">
        <strong>{note.author?.username ?? 'ghost'}</strong>
        <time>{timeAgo(note.created_at)}</time>
      </header>
      <div className="ls-comment__body ls-md">{renderMarkdown(note.body)}</div>
      <div className="ls-reactions ls-reactions--inline" aria-label="Comment reactions">
        {['thumbsup', 'tada'].map((name) => {
          const cur = note.reactions.find((r) => r.name === name)
          return (
            <button
              key={name}
              type="button"
              className={`ls-reactions__pill${cur?.me ? ' ls-reactions__pill--me' : ''}`}
              aria-pressed={cur?.me ?? false}
              aria-label={`React ${name} to comment`}
              onClick={() => onReact(name)}
            >
              <span aria-hidden="true">{EMOJI[name]}</span>
              {cur && cur.count > 0 && <span>{cur.count}</span>}
            </button>
          )
        })}
      </div>
    </article>
  )
}
