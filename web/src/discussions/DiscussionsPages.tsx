import { useCallback, useEffect, useState } from 'react'
import { Badge } from '../design-system/Badge'
import { Button } from '../design-system/Button'
import { Dialog } from '../design-system/Dialog'
import { EmptyState } from '../design-system/EmptyState'
import { Icon } from '../design-system/Icon'
import { Input } from '../design-system/Input'
import { Pagination } from '../design-system/Pagination'
import { Select } from '../design-system/Select'
import { Textarea } from '../design-system/Textarea'
import { renderMarkdown } from '../repository/markdown'
import { timeAgo } from '../repository/widgets'

/**
 * Community discussions — dense threaded layout, hairline separators, small
 * typography. Safe markdown only (React-element renderer, no innerHTML).
 */

async function request<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (!['GET', 'HEAD'].includes(method)) {
    for (const part of document.cookie.split(';')) {
      const eq = part.indexOf('=')
      if (part.slice(0, eq).trim() === 'lsgit_csrf') {
        headers['x-csrf-token'] = decodeURIComponent(part.slice(eq + 1).trim())
        break
      }
    }
  }
  const res = await fetch(url, { method, headers, credentials: 'same-origin', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new Error(String((data as { message?: string }).message ?? 'Request failed'))
  return data as T
}

export const CATEGORIES = ['general', 'question', 'idea', 'announcement', 'showcase', 'poll'] as const
export type Category = (typeof CATEGORIES)[number]

export interface DiscussionListItem {
  id: number
  author: { id: number; username: string; name: string | null } | null
  category: Category
  title: string
  body_preview: string
  comment_count: number
  pinned?: boolean
  locked?: boolean
  last_activity_at: string
  created_at: string
}

export interface DiscussionCommentView {
  id: number
  parent_id: number | null
  author: { id: number; username: string; name: string | null } | null
  body: string
  deleted: boolean
  edited_at: string | null
  created_at: string
  reactions: Array<{ name: string; count: number; me: boolean }>
  replies: DiscussionCommentView[]
}

export interface DiscussionDetail {
  discussion: {
    id: number
    author: { id: number; username: string; name: string | null } | null
    category: Category
    title: string
    body: string
    pinned: boolean
    locked: boolean
    best_answer_comment_id: number | null
    created_at: string
    last_activity_at: string
  }
  comments: DiscussionCommentView[]
  comment_count: number
}

const CATEGORY_ICONS: Record<Category, Parameters<typeof Icon>[0]['name']> = {
  question: 'issue',
  idea: 'star',
  announcement: 'bell',
  showcase: 'eye',
  general: 'menu',
  poll: 'check',
}

// ── list ──────────────────────────────────────────────────────────────────────

export function DiscussionsListPage({ projectId }: { projectId: number }) {
  const [category, setCategory] = useState<Category | ''>('')
  const [search, setSearch] = useState('')
  const [result, setResult] = useState<{ discussions: DiscussionListItem[]; pagination: { page: number; total_pages: number; total: number; has_more: boolean } } | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // create form
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [cat, setCat] = useState<Category>('general')
  const [pollOptions, setPollOptions] = useState('')

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams()
      if (category) q.set('category', category)
      if (search) q.set('search', search)
      setResult(await request(`/api/v1/projects/${projectId}/discussions?${q.toString()}`))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load discussions')
    }
  }, [projectId, category, search])

  useEffect(() => { void load() }, [load])

  async function submitCreate() {
    await request(`/api/v1/projects/${projectId}/discussions`, 'POST', {
      title,
      body,
      category: cat,
      ...(cat === 'poll' ? { poll_options: pollOptions.split('\n').map((s) => s.trim()).filter(Boolean) } : {}),
    })
    setCreateOpen(false); setTitle(''); setBody(''); setPollOptions('')
    await load()
  }

  return (
    <section aria-label="Discussions" className="ls-rb ls-disc">
      <header className="ls-rb__head">
        <h2 className="ls-rb__viewtitle">Discussions</h2>
        <div className="ls-rb__actions">
          <Button size="sm" variant="primary" iconStart="plus" onClick={() => setCreateOpen(true)}>New discussion</Button>
        </div>
      </header>

      <div style={{ maxWidth: 300, marginBottom: 10 }}>
        <Input label="Search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search discussions…" />
      </div>

      {/* category chips — terracotta only when active */}
      <div className="ls-disc__chips" role="tablist" aria-label="Category filter">
        <button type="button" role="tab" aria-selected={category === ''} className={`ls-disc__chip${category === '' ? ' ls-disc__chip--on' : ''}`} onClick={() => setCategory('')}>All</button>
        {CATEGORIES.map((c) => (
          <button key={c} type="button" role="tab" aria-selected={category === c} className={`ls-disc__chip${category === c ? ' ls-disc__chip--on' : ''}`} onClick={() => setCategory(c)}>{c}</button>
        ))}
      </div>

      {error && <div role="alert" className="ls-editor-error">{error}</div>}

      {!result ? (
        <div role="status">Loading…</div>
      ) : result.discussions.length === 0 ? (
        <EmptyState icon="menu" title="No discussions yet" description="Start the first community thread." />
      ) : (
        <>
          <ul className="ls-disc__list">
            {result.discussions.map((d) => (
              <li key={d.id}>
                <a className="ls-disc__row" href={`#/proj/_/_/discussions/${d.id}`}>
                  <Icon name={CATEGORY_ICONS[d.category] ?? 'menu'} size={13} />
                  <span className="ls-disc__rowtitle">
                    {d.pinned && <span className="ls-disc__flag">pinned</span>}
                    {d.locked && <span className="ls-disc__flag">locked</span>}
                    {d.title}
                  </span>
                  <Badge variant="neutral">{d.category}</Badge>
                  <span className="ls-rb__muted">{d.comment_count} comment{d.comment_count === 1 ? '' : 's'}</span>
                  <time className="ls-rb__muted">{timeAgo(d.last_activity_at)}</time>
                </a>
              </li>
            ))}
          </ul>
          <footer className="ls-issues__foot">
            <Pagination page={result.pagination.page} pageCount={Math.max(1, result.pagination.total_pages)} onChange={() => void load()} key={result.pagination.page} />
          </footer>
        </>
      )}

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="New discussion"
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" data-autofocus disabled={!title.trim()} onClick={() => void submitCreate()}>Start discussion</Button>
          </>
        }>
        <div className="ds-stack">
          <Select label="Category" value={cat} onChange={(e) => setCat(e.target.value as Category)}
            options={CATEGORIES.map((c) => ({ value: c, label: c }))} />
          <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Textarea label="Body (Markdown)" value={body} onChange={(e) => setBody(e.target.value)} />
          {cat === 'poll' && (
            <Textarea label="Poll options — one per line" value={pollOptions} onChange={(e) => setPollOptions(e.target.value)} placeholder={'yes\nno'} hint="At least two options." />
          )}
        </div>
      </Dialog>
    </section>
  )
}

// ── detail ────────────────────────────────────────────────────────────────────

export function DiscussionsDetailPage({
  projectId,
  did,
  isMaintainer,
  viewerId,
}: {
  projectId: number
  did: number
  isMaintainer: boolean
  viewerId: number | null
}) {
  const [data, setData] = useState<DiscussionDetail & { poll: DetailPoll | null } | null>(null)
  const [replyTo, setReplyTo] = useState<number | null>(null)
  const [commentBody, setCommentBody] = useState('')
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setData(await request(`/api/v1/projects/${projectId}/discussions/${did}`))
  }, [projectId, did])

  useEffect(() => { void reload().catch(() => setError('Failed to load discussion')) }, [reload])

  async function act(fn: () => Promise<unknown>) {
    try { await fn(); await reload(); return true } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
      return false
    }
  }

  if (!data) return <div role="status">{error ?? 'Loading…'}</div>
  const d = data.discussion
  const canBestAnswer = d.category === 'question' && (viewerId === d.author?.id || isMaintainer)
  const locked = d.locked

  return (
    <section aria-label="Discussion" className="ls-rb ls-disc">
      {error && <div role="alert" className="ls-editor-error">{error}</div>}
      <header className="ls-issues__detailhead">
        <h2 className="ls-issues__h">
          {d.pinned && <span className="ls-disc__flag">pinned</span>}
          {d.title}
        </h2>
        <Badge variant="neutral">{d.category}</Badge>
        {locked && <Badge variant="neutral"><Icon name="key" size={11} /> locked</Badge>}
        <span className="ls-rb__muted">
          started {timeAgo(d.created_at)} by {d.author?.username ?? 'ghost'}
        </span>
        <div className="ls-issues__detailactions">
          {isMaintainer && (
            <>
              <Button size="sm" onClick={() =>
                void act(() =>
                  request(`/api/v1/projects/${projectId}/discussions/${did}`, 'PATCH', { pinned: !d.pinned }),
                )
              }>{d.pinned ? 'Unpin' : 'Pin'}</Button>
              <Button size="sm" onClick={() =>
                void act(() =>
                  request(`/api/v1/projects/${projectId}/discussions/${did}`, 'PATCH', { locked: !locked }),
                )
              }>{locked ? 'Unlock' : 'Lock'}</Button>
            </>
          )}
        </div>
      </header>

      <article className="ls-disc__op">
        <strong>{d.author?.username ?? 'ghost'}</strong>
        <time>{timeAgo(d.created_at)}</time>
        <div className="ls-md ls-comment__body">{renderMarkdown(d.body)}</div>
      </article>

      {/* threaded comments with hairline separators */}
      <ol className="ls-disc__comments">
        {data.comments.map((root) => (
          <CommentNode
            key={root.id}
            node={root}
            depth={0}
            bestId={d.best_answer_comment_id}
            canMark={canBestAnswer}
            onBest={() => void act(() => request(`/api/v1/projects/${projectId}/discussions/${did}/best_answer`, 'POST', { comment_id: root.id }))}
            onReply={() => setReplyTo(root.id)}
            onReact={(name) =>
              void act(() => request(`/api/v1/projects/${projectId}/discussions/${did}/comments/${root.id}/reactions`, 'POST', { name }))
            }
          />
        ))}
      </ol>

      {/* composer */}
      {(!locked || isMaintainer) ? (
        <form
          className="ls-issues__composer"
          onSubmit={(e) => {
            e.preventDefault()
            if (!commentBody.trim()) return
            void act(async () => {
              await request(`/api/v1/projects/${projectId}/discussions/${did}/comments`, 'POST', {
                body: commentBody.trim(),
                parent_id: replyTo ?? undefined,
              })
            }).then((ok) => { if (ok) { setCommentBody(''); setReplyTo(null) } })
          }}
        >
          {replyTo !== null && <span className="ls-accent">Replying to comment #{replyTo}</span>}
          <Textarea label="Write a comment" hint="Markdown · @mentions · task lists: - [ ] item"
            value={commentBody} onChange={(e) => setCommentBody(e.target.value)} />
          <Button variant="primary" size="sm" type="submit" disabled={!commentBody.trim()}>
            {replyTo !== null ? 'Post reply' : 'Post comment'}
          </Button>
        </form>
      ) : (
        <EmptyState icon="key" title="Discussion locked" description="New comments are disabled by a moderator." />
      )}
    </section>
  )

  function CommentNode({
    node, depth, bestId, canMark, onBest, onReply, onReact,
  }: {
    node: DiscussionCommentView
    depth: number
    bestId: number | null
    canMark: boolean
    onBest: () => void
    onReply: () => void
    onReact: (name: string) => void
  }) {
    const isBest = bestId === node.id
    return (
      <li className={`ls-disc__comment${depth > 0 ? ' ls-disc__comment--nested' : ''}`}>
        {isBest && (
          <div className="ls-disc__bestmark" aria-label="Best answer">
            <Icon name="check" size={12} /> Best answer
          </div>
        )}
        <header className="ls-comment__head">
          <strong>{node.deleted ? 'removed' : node.author?.username ?? 'ghost'}</strong>
          <time>{timeAgo(node.created_at)}</time>
          {node.edited_at && <span className="ls-rb__muted">(edited)</span>}
        </header>
        {node.deleted
          ? <p className="ls-rb__muted ls-thread__body">This comment was removed.</p>
          : <div className="ls-comment__body ls-md">{renderMarkdown(node.body)}</div>}
        {!node.deleted && (
          <div className="ls-reactions ls-reactions--inline">
            {(['thumbsup', 'heart'] as const).map((name) => {
              const cur = node.reactions.find((r) => r.name === name)
              return (
                <button
                  key={name}
                  type="button"
                  className={`ls-reactions__pill${cur?.me ? ' ls-reactions__pill--me' : ''}`}
                  aria-pressed={cur?.me ?? false}
                  aria-label={`React ${name}`}
                  onClick={() => onReact(name)}
                >
                  <span aria-hidden="true">{name === 'thumbsup' ? '👍' : '❤️'}</span>
                  {cur && cur.count > 0 && <span>{cur.count}</span>}
                </button>
              )
            })}
            <button type="button" className="ls-thread__action" onClick={onReply}>Reply</button>
            {canMark && (
              <button type="button" className="ls-thread__action" onClick={onBest}>
                {isBest ? 'Unmark' : 'Mark best answer'}
              </button>
            )}
          </div>
        )}
        <ul className="ls-disc__replies">
          {node.replies.map((r) => (
            <CommentNode key={r.id} {...{ node: r, depth: depth + 1, bestId, canMark, onBest, onReply, onReact }} />
          ))}
        </ul>
      </li>
    )
  }
}

interface DetailPoll {
  options: string[]
  tally: Array<{ option_index: number; votes: number }>
  your_vote: number | null
}
