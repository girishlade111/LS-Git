import { useEffect, useState } from 'react'
import { Button } from '../design-system/Button'
import { Dialog } from '../design-system/Dialog'
import { EmptyState } from '../design-system/EmptyState'
import { IconButton } from '../design-system/IconButton'
import { Input } from '../design-system/Input'
import { Tooltip } from '../design-system/Tooltip'
import { issuesApi, type LabelFull } from './api'
import { labelTint } from './labelcolor'

/**
 * Label manager. Color input accepts any hex spelling — the live preview
 * shows the CONSTRAINED rendering (tinted chip), making the presentation
 * contract visible to the author of the color.
 */
export function LabelsView({ projectId }: { projectId: number }) {
  const [labels, setLabels] = useState<LabelFull[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editTarget, setEditTarget] = useState<Partial<LabelFull> | null>(null) // {} = create
  const [deleteTarget, setDeleteTarget] = useState<LabelFull | null>(null)
  const [form, setForm] = useState({ title: '', description: '', color: '#e07856' })

  async function reload() {
    try {
      setLabels(await issuesApi.labels(projectId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load labels')
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

  if (error && !labels) return <div role="alert" className="ls-editor-error">{error}</div>
  if (!labels) return <div className="ls-rb__loading" role="status">Loading labels…</div>

  return (
    <section aria-label="Labels" className="ls-rb ls-issues">
      <header className="ls-rb__head">
        <h2 className="ls-rb__viewtitle">Labels <span className="ls-rb__muted">· {labels.length}</span></h2>
        <div className="ls-rb__actions">
          <Button size="sm" variant="primary" iconStart="plus" onClick={() => { setForm({ title: '', description: '', color: '#e07856' }); setEditTarget({}) }}>
            New label
          </Button>
        </div>
      </header>

      {error && <div role="alert" className="ls-editor-error">{error}</div>}

      {labels.length === 0 ? (
        <EmptyState icon="tag" title="No labels" description="Create labels to categorize issues." />
      ) : (
        <ul className="ls-labels__list">
          {labels.map((l) => (
            <li key={l.id} className="ls-labels__row">
              <LabelPreview title={l.title} color={l.color} />
              <span className="ls-labels__desc">{l.description}</span>
              <code className="ls-labels__hex">{l.color}</code>
              {l.open_issues_count !== undefined && (
                <span className="ls-rb__muted">{l.open_issues_count} issue{l.open_issues_count === 1 ? '' : 's'}</span>
              )}
              <span className="ls-labels__actions">
                <Tooltip content="Edit label">
                  <IconButton label={`Edit ${l.title}`} icon="code" onClick={() => {
                    setForm({ title: l.title, description: l.description, color: l.color })
                    setEditTarget(l)
                  }} />
                </Tooltip>
                <Tooltip content="Delete label">
                  <IconButton label={`Delete ${l.title}`} icon="trash" onClick={() => setDeleteTarget(l)} />
                </Tooltip>
              </span>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        title={editTarget?.id ? `Edit ${editTarget.title}` : 'New label'}
        footer={
          <>
            <Button onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button
              variant="primary"
              data-autofocus
              disabled={!form.title.trim()}
              onClick={() =>
                void mutate(async () => {
                  if (editTarget?.id) {
                    await issuesApi.updateLabel(projectId, editTarget.id, form)
                  } else {
                    await issuesApi.createLabel(projectId, form)
                  }
                  setEditTarget(null)
                })
              }
            >
              {editTarget?.id ? 'Save' : 'Create'}
            </Button>
          </>
        }
      >
        <div className="ds-stack">
          <Input label="Name" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="performance" />
          <Input label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <Input label="Color (hex)" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} hint="Any hex value; rendered as a calm tint inside the product palette." />
          <div className="ds-row" style={{ alignItems: 'center', gap: 8 }}>
            Preview:
            <LabelPreview title={form.title || 'label'} color={form.color} />
          </div>
        </div>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={`Delete label “${deleteTarget?.title ?? ''}”?`}
        description="The label is removed from every issue that uses it."
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" data-autofocus onClick={() => {
              if (!deleteTarget) return
              void mutate(async () => {
                await issuesApi.deleteLabel(projectId, deleteTarget.id)
                setDeleteTarget(null)
              })
            }}>Delete label</Button>
          </>
        }
      >
        <span />
      </Dialog>
    </section>
  )
}

function LabelPreview({ title, color }: { title: string; color: string }) {
  const tint = labelTint(color)
  return (
    <span className="ls-labelchip" style={{ background: tint.background, borderColor: tint.border, color: tint.text }}>
      {title}
    </span>
  )
}
