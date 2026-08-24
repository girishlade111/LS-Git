import { useCallback, useEffect, useState } from 'react'
import { Button } from '../design-system/Button'
import { EmptyState } from '../design-system/EmptyState'
import { Icon } from '../design-system/Icon'
import { Input } from '../design-system/Input'
import { Select } from '../design-system/Select'

/**
 * Social discovery UI: star control, watch-level selector, and the persisted
 * in-app notification inbox. Visual contract: quiet, dense rows with hairline
 * dividers; accent marks unread/relevance; success green only for active
 * states. No notification-card explosion.
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
  const res = await fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new Error(String(data.message ?? 'Request failed'))
  return data as T
}

export interface StarState {
  count: number
  starred: boolean
}

/** Dense star toggle: icon + count inline; filled/starred state uses accent. */
export function StarButton({ projectId }: { projectId: number }) {
  const [state, setState] = useState<StarState | null>(null)

  useEffect(() => {
    request<StarState>(`/api/v1/projects/${projectId}/star`)
      .then(setState)
      .catch(() => setState({ count: 0, starred: false }))
  }, [projectId])

  const toggle = useCallback(async () => {
    try {
      const next = state?.starred
        ? await request<StarState>(`/api/v1/projects/${projectId}/star`, 'DELETE')
        : await request<StarState>(`/api/v1/projects/${projectId}/star`, 'POST')
      setState(next)
    } catch { /* transient — leave prior state visible */ }
  }, [projectId, state?.starred])

  return (
    <button
      type="button"
      className={`ls-star${state?.starred ? ' ls-star--active' : ''}`}
      aria-pressed={state?.starred ?? false}
      aria-label={state?.starred ? `Unstar repository (${state.count} stars)` : `Star repository (${state?.count ?? 0} stars)`}
      onClick={() => void toggle()}
    >
      <Icon name="star" size={14} />
      <span>{state?.count ?? '…'}</span>
    </button>
  )
}

const WATCH_LEVELS = [
  { value: 'watch', label: 'Watch — all activity' },
  { value: 'participating', label: 'Participating — mentions & your threads' },
  { value: 'mention', label: 'Mentions only' },
  { value: 'disabled', label: 'Disabled — never notify' },
] as const

/** Per-user watch level selector (user-specific by server session identity). */
export function WatchSelector({ projectId }: { projectId: number }) {
  const [level, setLevel] = useState<string>('participating')
  const [explicit, setExplicit] = useState<string | null>(null)

  useEffect(() => {
    request<{ level: string | null; effective_level: string }>(`/api/v1/projects/${projectId}/watch`)
      .then((r) => { setExplicit(r.level); setLevel(r.effective_level) })
      .catch(() => undefined)
  }, [projectId])

  async function change(next: string) {
    setLevel(next)
    try {
      if (next === (explicit ?? '')) return
      await request(`/api/v1/projects/${projectId}/watch`, 'PUT', { level: next })
      setExplicit(next)
    } catch { /* revert on failure via refetch */ }
  }

  return (
    <div style={{ width: 260 }}>
      <Select
        label="Notifications"
        value={level}
        onChange={(e) => void change(e.target.value)}
        options={[...WATCH_LEVELS]}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Notification inbox
// ---------------------------------------------------------------------------

export interface InboxItem {
  id: number
  project_path: string | null
  type: string
  title: string
  body: string | null
  url: string | null
  actor_username: string | null
  read_at: string | null
  created_at: string
}

interface InboxResponse {
  unread_count: number
  notifications: InboxItem[]
}

function timeAgoShort(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/**
 * The quiet inbox: one hairline-divided row per notification, a small unread
 * dot in accent, filter controls inline. Rows navigate and auto-mark read.
 */
export function InboxView({ navigate }: { navigate?: (hash: string) => void }) {
  const [data, setData] = useState<InboxResponse | null>(null)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [type, setType] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams()
      if (unreadOnly) q.set('unread', '1')
      if (type) q.set('type', type)
      setData(await request<InboxResponse>(`/api/v1/user/notifications?${q.toString()}`))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load notifications')
    }
  }, [unreadOnly, type])

  useEffect(() => { void load() }, [load])

  async function open(item: InboxItem) {
    if (!item.read_at) {
      try { await request(`/api/v1/user/notifications/${item.id}/read`, 'POST') } catch { /* keep row */ }
    }
    if (item.url && navigate) navigate(`#${item.url}`)
  }

  async function markAll() {
    try {
      await request('/api/v1/user/notifications/read_all', 'POST', {})
      await load()
    } catch { /* surfaced on next load */ }
  }

  async function markRead(item: InboxItem, e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    try {
      await request(`/api/v1/user/notifications/${item.id}/${item.read_at ? 'unread' : 'read'}`, 'POST')
      await load()
    } catch { /* ignore */ }
  }

  return (
    <section aria-label="Notification inbox" className="ls-rb ls-inbox">
      <header className="ls-rb__head">
        <h2 className="ls-rb__viewtitle">
          Notifications{' '}
          {data && data.unread_count > 0 && (
            <span className="ls-inbox__count" aria-label={`${data.unread_count} unread`}>{data.unread_count}</span>
          )}
        </h2>
        <div className="ls-rb__actions">
          <div style={{ width: 170 }}>
            <Select
              label="Filter type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              options={[
                { value: '', label: 'All types' },
                ...['push', 'issue', 'merge_request', 'discussion', 'mention', 'review_request', 'release', 'deployment', 'workflow', 'security_alert', 'fork']
                  .map((t) => ({ value: t, label: t.replace(/_/g, ' ') })),
              ]}
            />
          </div>
          <label className="ls-checkbox">
            <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
            Unread only
          </label>
          <Button size="sm" variant="ghost" onClick={() => void markAll()} disabled={!data || data.unread_count === 0}>
            Mark all read
          </Button>
        </div>
      </header>

      {error && <div role="alert" className="ls-editor-error">{error}</div>}

      {data && data.notifications.length === 0 ? (
        <EmptyState
          icon="bell"
          title="Nothing here"
          description={unreadOnly ? 'No unread notifications.' : 'You are all caught up.'}
        />
      ) : !data ? (
        <div className="ls-inbox__list" aria-busy="true" />
      ) : (
        <ul className="ls-inbox__list">
          {data.notifications.map((n) => {
            const row = (
              <>
                <span className={`ls-inbox__dot${n.read_at ? ' ls-inbox__dot--read' : ''}`} aria-hidden="true" />
                {!n.read_at && <span className="ls-visually-hidden">unread </span>}
                <span className="ls-inbox__title">{n.title}</span>
                {n.project_path && <span className="ls-inbox__proj">{n.project_path}</span>}
                <span className="ls-inbox__meta">{timeAgoShort(n.created_at)}</span>
                <IconButtonSmall
                  label={n.read_at ? 'Mark unread' : 'Mark read'}
                  onClick={(e) => void markRead(n, e)}
                />
              </>
            )
            const href = n.url ? `#${n.url}` : undefined
            return (
              <li key={n.id}>
                {href ? (
                  <a className={`ls-inbox__row${n.read_at ? ' ls-inbox__row--read' : ''}`} href={href} onClick={() => void open(n)}>
                    {row}
                  </a>
                ) : (
                  <div className={`ls-inbox__row${n.read_at ? ' ls-inbox__row--read' : ''}`}>{row}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function IconButtonSmall({ label, onClick }: { label: string; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button type="button" className="ls-iconbtn ls-iconbtn--sm" aria-label={label} onClick={onClick}>
      <Icon name="check" size={12} />
    </button>
  )
}

void Input
