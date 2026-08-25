import { useEffect, useState } from 'react'
import { Button } from '../design-system/Button'
import { Dialog } from '../design-system/Dialog'
import { EmptyState } from '../design-system/EmptyState'
import { IconButton } from '../design-system/IconButton'
import { Input } from '../design-system/Input'
import { Textarea } from '../design-system/Textarea'
import { issuesApi, type MilestoneFull } from './api'

/**
 * Milestone manager: create/edit with due dates, close/activate lifecycle,
 * and completion percentage computed from linked issues (closed / total).
 * Merge-request counts appear once the MR phase lands.
 */
export function MilestonesView({ projectId }: { projectId: number }) {
  const [milestones, setMilestones] = useState<MilestoneFull[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<MilestoneFull | null>(null)
  const [form, setForm] = useState({ title: '', description: '', due_date: '' })
  const [deleteTarget, setDeleteTarget] = useState<MilestoneFull | null>(null)

  async function reload() {
    try {
      setMilestones(await issuesApi.milestones(projectId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load milestones')
    }
  }
  useEffect(() => { void reload() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [projectId])

  async function mutate(fn: () => Promise<unknown>) {
    try {
      await fn()
      await reload()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed')
      return false
    }
  }

  if (!milestones) return <div className="ls-rb__loading" role="status">Loading milestones…</div>

  return (
    <section aria-label="Milestones" className="ls-rb ls-issues">
      <header className="ls-rb__head">
        <h2 className="ls-rb__viewtitle">Milestones <span className="ls-rb__muted">· {milestones.length}</span></h2>
        <div className="ls-rb__actions">
          <Button size="sm" variant="primary" iconStart="plus" onClick={() => {
            setEditing(null)
            setForm({ title: '', description: '', due_date: '' })
            setEditOpen(true)
          }}>
            New milestone
          </Button>
        </div>
      </header>

      {error && <div role="alert" className="ls-editor-error">{error}</div>}

      {milestones.length === 0 ? (
        <EmptyState icon="clock" title="No milestones" description="Group issues under a due date to track a release." />
      ) : (
        <ul className="ls-ms__list">
          {milestones.map((m) => (
            <li key={m.id} className="ls-ms__row">
              <div className="ls-ms__main">
                <strong>{m.title}</strong>
                {m.state === 'closed' && <span className="ls-ms__closed">closed</span>}
                <p className="ls-labels__desc">{m.description}</p>
                <span className="ls-rb__muted">
                  {m.due_date ? `Due ${m.due_date} · ` : ''}
                  {m.total_issues ?? 0} issue{(m.total_issues ?? 0) === 1 ? '' : 's'}
                  {' · '}
                  {(m.opened_issues ?? 0)} open · {(m.closed_issues ?? 0)} closed
                </span>
                <div
                  className="ls-ms__bar"
                  role="progressbar"
                  aria-valuenow={m.completion_percent ?? 0}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${m.title} completion`}
                >
                  <span style={{ width: `${m.completion_percent ?? 0}%` }} />
                </div>
                <span className="ls-rb__muted">{m.completion_percent ?? 0}% complete</span>
              </div>
              <span className="ls-labels__actions">
                <IconButton label={`Edit ${m.title}`} icon="code" onClick={() => {
                  setEditing(m)
                  setForm({ title: m.title, description: m.description, due_date: m.due_date ?? '' })
                  setEditOpen(true)
                }} />
                <IconButton
                  label={m.state === 'active' ? `Close ${m.title}` : `Reopen ${m.title}`}
                  icon="check"
                  onClick={() =>
                    void mutate(() =>
                      issuesApi.updateMilestone(projectId, m.id, {
                        state_event: m.state === 'active' ? 'close' : 'activate',
                      }),
                    )
                  }
                />
                <IconButton label={`Delete ${m.title}`} icon="trash" onClick={() => setDeleteTarget(m)} />
              </span>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={editing ? `Edit ${editing.title}` : 'New milestone'}
        footer={
          <>
            <Button onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              data-autofocus
              disabled={!form.title.trim()}
              onClick={() =>
                void mutate(async () => {
                  const payload = { ...form, due_date: form.due_date || null }
                  if (editing) await issuesApi.updateMilestone(projectId, editing.id, payload)
                  else await issuesApi.createMilestone(projectId, payload)
                  setEditOpen(false)
                })
              }
            >
              {editing ? 'Save' : 'Create'}
            </Button>
          </>
        }
      >
        <div className="ds-stack">
          <Input label="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="v1.0" />
          <Textarea label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <Input label="Due date" type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
        </div>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={`Delete “${deleteTarget?.title ?? ''}”?`}
        description="Linked issues are kept but lose their milestone."
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" data-autofocus onClick={() => {
              if (!deleteTarget) return
              void mutate(async () => {
                await issuesApi.deleteMilestone(projectId, deleteTarget.id)
                setDeleteTarget(null)
              })
            }}>Delete milestone</Button>
          </>
        }
      >
        <span />
      </Dialog>
    </section>
  )
}
