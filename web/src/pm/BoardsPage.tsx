import { useCallback, useEffect, useState } from 'react'
import { Badge } from '../design-system/Badge'
import { Button } from '../design-system/Button'
import { Dialog } from '../design-system/Dialog'
import { EmptyState } from '../design-system/EmptyState'
import { Input } from '../design-system/Input'
import { Select } from '../design-system/Select'

/**
 * Project-management boards: table + board (kanban) views over typed items.
 * Dense LSGit visual language — hairline separators, no cards, no shadows;
 * insights are a quiet strip of numbers, not a colorful dashboard.
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

interface Board { id: number; name: string; description: string }
interface Field { id: number; key: string; label: string; type: string; options: string[]; position: number }
interface ItemView {
  id: number
  kind: 'issue' | 'pull_request' | 'draft'
  issue_iid: number | null
  pr_iid: number | null
  title: string
  field_values: Record<string, string | null>
  updated_at: string
}
interface SavedView { id: number; name: string; filters: Record<string, unknown>; group_by: string | null }
interface Insights {
  total_items: number
  by_kind: Record<string, number>
  status_distribution: Array<{ status: string; count: number }>
  progress: { done_status: string; done_count: number; percent: number }
  throughput_last_30_days: number
}

export function BoardsPage({ projectId, isMaintainer }: { projectId: number; isMaintainer: boolean }) {
  const [boards, setBoards] = useState<Board[]>([])
  const [boardId, setBoardId] = useState<number | null>(null)
  const [fields, setFields] = useState<Field[]>([])
  const [items, setItems] = useState<ItemView[] | null>(null)
  const [views, setViews] = useState<SavedView[]>([])
  const [activeView, setActiveView] = useState('')
  const [mode, setMode] = useState<'table' | 'board'>('table')
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')

  const loadBoard = useCallback(async () => {
    if (boardId === null) return
    try {
      const q = activeView ? `?view=${encodeURIComponent(activeView)}` : ''
      const [detail, items, vs, ins] = await Promise.all([
        request<{ board: Board; fields: Field[]; workflows: unknown[] }>(`/api/v1/projects/${projectId}/pm/boards/${boardId}`),
        request<{ items: ItemView[] }>(`/api/v1/projects/${projectId}/pm/boards/${boardId}/items${q}`),
        request<{ views: SavedView[] }>(`/api/v1/projects/${projectId}/pm/boards/${boardId}/views`),
        request<Insights>(`/api/v1/projects/${projectId}/pm/boards/${boardId}/insights`).catch(() => null),
      ])
      void ins
      setFields(detail.fields)
      setItems(items.items)
      setViews(vs.views)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load board')
    }
  }, [projectId, boardId, activeView])

  useEffect(() => {
    void (async () => {
      try {
        const r = await request<{ boards: Board[] }>(`/api/v1/projects/${projectId}/pm/boards`)
        setBoards(r.boards)
        if (r.boards.length > 0 && boardId === null) setBoardId(r.boards[0]!.id)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load boards')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  useEffect(() => { void loadBoard() }, [loadBoard])

  async function setField(itemId: number, key: string, value: string) {
    try {
      await request(`/api/v1/projects/${projectId}/pm/boards/${boardId}/items/${itemId}`, 'PATCH', { field_key: key, value })
      await loadBoard()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed')
    }
  }

  async function createDraft() {
    try {
      await request(`/api/v1/projects/${projectId}/pm/boards/${boardId}/items`, 'POST', { kind: 'draft', title: newTitle.trim() })
      setCreateOpen(false); setNewTitle('')
      await loadBoard()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create item')
    }
  }

  const statusField = fields.find((f) => f.key === 'status')
  const statusOptions = statusField?.options ?? []
  const boardColumns = statusOptions.map((s) => ({
    status: s,
    items: (items ?? []).filter((i) => (i.field_values.status ?? '(none)') === s),
  }))
  const backlogItems = (items ?? []).filter((i) => !statusOptions.includes(i.field_values.status ?? ''))

  return (
    <section aria-label="Project management" className="ls-rb ls-pm">
      <header className="ls-rb__head">
        <div style={{ width: 200 }}>
          <Select
            label="Board"
            value={String(boardId ?? '')}
            onChange={(e) => setBoardId(Number(e.target.value))}
            options={boards.map((b) => ({ value: String(b.id), label: b.name }))}
          />
        </div>
        <div className="ls-pm__viewtoggle" role="radiogroup" aria-label="View mode">
          <button type="button" role="radio" aria-checked={mode === 'table'} className={`ls-pm__toggle${mode === 'table' ? ' ls-pm__toggle--on' : ''}`} onClick={() => setMode('table')}>Table</button>
          <button type="button" role="radio" aria-checked={mode === 'board'} className={`ls-pm__toggle${mode === 'board' ? ' ls-pm__toggle--on' : ''}`} onClick={() => setMode('board')}>Board</button>
        </div>
        <div style={{ width: 170 }}>
          <Select
            label="Saved view"
            value={activeView}
            onChange={(e) => setActiveView(e.target.value)}
            options={[{ value: '', label: 'All items' }, ...views.map((v) => ({ value: v.name, label: v.name }))]}
          />
        </div>
        <div className="ls-rb__actions">
          {isMaintainer && (
            <Button size="sm" variant="primary" iconStart="plus" onClick={() => setCreateOpen(true)}>New item</Button>
          )}
        </div>
      </header>

      {error && <div role="alert" className="ls-editor-error">{error}</div>}

      {/* New draft item */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="New draft item"
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" data-autofocus disabled={!newTitle.trim()} onClick={() => void createDraft()}>Add</Button>
          </>
        }>
        <Input label="Title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
      </Dialog>

      {boardId === null ? (
        <EmptyState icon="folder" title="No boards yet" description="Create a planning board to organize issues and pull requests." />
      ) : mode === 'table' ? (
        <table className="ls-pm__table" aria-label="Items table">
          <thead>
            <tr>
              <th scope="col">Item</th>
              {fields.map((f) => <th key={f.key} scope="col">{f.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {(items ?? []).map((item) => (
              <tr key={item.id}>
                <td>
                  <span className={`ls-pm__kind ls-pm__kind--${item.kind}`}>
                    {item.kind === 'issue' ? `#${item.issue_iid}` : item.kind === 'pull_request' ? `!${item.pr_iid}` : 'draft'}
                  </span>{' '}
                  {item.title}
                </td>
                {fields.map((f) => {
                  const v = item.field_values[f.key] ?? ''
                  return (
                    <td key={f.key}>
                      {f.type === 'status' || f.type === 'single_select' ? (
                        <select
                          className="ls-pm__inline"
                          aria-label={`${f.label} for ${item.title}`}
                          value={v}
                          onChange={(e) => void setField(item.id, f.key, e.target.value)}
                        >
                          {(f.options.length > 0 ? f.options : ['(none)']).map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : (
                        <span className="ls-pm__val">{f.key === 'multi_placeholder' ? v : v || '—'}</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="ls-kanban" aria-label="Board view">
          {[...boardColumns, { status: '(none)', items: backlogItems }].map((col) => (
            <div key={col.status} className="ls-kanban__col" aria-label={`${col.status} column`}>
              <header className="ls-kanban__colhead">
                {col.status} <span className="ls-rb__muted">{col.items.length}</span>
              </header>
              <ul className="ls-kanban__cards">
                {col.items.map((item) => (
                  <li key={item.id} className="ls-kanban__card">
                    <span className={`ls-pm__kind ls-pm__kind--${item.kind}`}>
                      {item.kind === 'issue' ? `#${item.issue_iid}` : item.kind === 'pull_request' ? `!${item.pr_iid}` : 'draft'}
                    </span>
                    <span className="ls-kanban__cardtitle">{item.title}</span>
                  </li>
                ))}
                {col.items.length === 0 && <li className="ls-rb__muted">—</li>}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function EmptyStateShim() { return null }
void EmptyStateShim
void Badge

// Re-exported for route wiring convenience.
export function NewItemDialog(props: { open: boolean; onClose: () => void; onSubmit: (t: string) => void }) {
  const [t, setT] = useState('')
  return (
    <Dialog open={props.open} onClose={props.onClose} title="New draft item"
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={!t.trim()} onClick={() => { props.onSubmit(t.trim()); setT('') }}>Add</Button>
        </>
      }>
      <Input label="Title" value={t} onChange={(e) => setT(e.target.value)} autoFocus />
    </Dialog>
  )
}
