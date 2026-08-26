import { useEffect, useState } from 'react'
import { Badge } from '../design-system/Badge'
import { Button } from '../design-system/Button'
import { Dialog } from '../design-system/Dialog'
import { EmptyState } from '../design-system/EmptyState'
import { IconButton } from '../design-system/IconButton'
import { Input } from '../design-system/Input'
import { Textarea } from '../design-system/Textarea'
import { Toggle } from '../design-system/Toggle'
import { releasesApi, type Release, type ReleaseAsset } from './api'

/**
 * Compact release timeline/table (GitLab releases parity).
 * Columns: version · date · tag · pre-release badge · asset count · download.
 * Maintainers additionally get publish / notes / edit / delete actions and an
 * expandable asset panel with raw octet-stream uploads + checksum display.
 */

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function dayOf(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—'
}

interface CreateForm {
  tag_name: string
  ref: string
  name: string
  description: string
  prerelease: boolean
  draft: boolean
}

const EMPTY_FORM: CreateForm = { tag_name: '', ref: '', name: '', description: '', prerelease: false, draft: false }

export function ReleasesView({ projectId, isMaintainer }: { projectId: number; isMaintainer: boolean }) {
  const [releases, setReleases] = useState<Release[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [assets, setAssets] = useState<Record<string, ReleaseAsset[]>>({})

  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM)

  const [editTag, setEditTag] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ name: '', description: '', prerelease: false })

  const [notesTag, setNotesTag] = useState<string | null>(null)
  const [notesPrev, setNotesPrev] = useState('')
  const [notes, setNotes] = useState<{ markdown: string; commit_count: number; merged_prs: number } | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<Release | null>(null)

  async function reload() {
    try {
      setReleases((await releasesApi.list(projectId)).releases)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load releases')
    }
  }
  useEffect(() => { void reload() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [projectId])

  async function mutate(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn()
      await reload()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed')
      return false
    }
  }

  async function toggleAssets(tag: string) {
    if (expanded === tag) { setExpanded(null); return }
    setExpanded(tag)
    if (!assets[tag]) {
      try {
        const detail = await releasesApi.get(projectId, tag)
        setAssets((m) => ({ ...m, [tag]: detail.release.assets }))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load assets')
      }
    }
  }

  async function generateNotes() {
    if (!notesTag) return
    try {
      setNotes(await releasesApi.generateNotes(projectId, notesTag, notesPrev.trim() || undefined))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate notes')
    }
  }

  if (!releases) {
    return <div className="ls-rb__loading" role="status">Loading releases…</div>
  }

  const latestStable = releases.find((r) => r.state === 'published' && !r.is_prerelease)
    ?? releases.find((r) => r.state === 'published')

  return (
    <section aria-label="Releases" className="ls-rb ls-rel">
      <header className="ls-rb__head">
        <h2 className="ls-rb__viewtitle">Releases <span className="ls-rb__muted">· {releases.length}</span></h2>
        <div className="ls-rb__actions">
          {isMaintainer && (
            <Button size="sm" variant="primary" iconStart="tag" onClick={() => { setForm(EMPTY_FORM); setCreateOpen(true) }}>
              New release
            </Button>
          )}
        </div>
      </header>

      {error && <div role="alert" className="ls-editor-error">{error}</div>}

      {releases.length === 0 ? (
        <EmptyState icon="tag" title="No releases" description="Cut a tagged release to publish versions and binaries." />
      ) : (
        <div className="ls-table-wrap">
          <table className="ls-table ls-rel__table" aria-label="Release history">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Date</th>
                <th scope="col">Tag</th>
                <th scope="col">Assets</th>
                <th scope="col"><span className="ls-sr-only">Download</span></th>
              </tr>
            </thead>
            <tbody>
              {releases.map((r) => (
                <ReleaseRow key={r.tag_name}
                  release={r}
                  isLatest={latestStable?.id === r.id}
                  isMaintainer={isMaintainer}
                  expanded={expanded === r.tag_name}
                  rowAssets={assets[r.tag_name]}
                  onToggle={() => void toggleAssets(r.tag_name)}
                  onPublish={() => void mutate(() => releasesApi.update(projectId, r.tag_name, { state_event: 'publish' }))}
                  onEdit={() => {
                    setEditTag(r.tag_name)
                    setEditForm({ name: r.name, description: r.description, prerelease: r.is_prerelease })
                  }}
                  onNotes={() => { setNotesTag(r.tag_name); setNotesPrev(''); setNotes(null) }}
                  onDelete={() => setDeleteTarget(r)}
                  onUpload={(file) => void mutate(async () => {
                    await releasesApi.uploadAsset(projectId, r.tag_name, file)
                    setAssets((m) => { const c = { ...m }; delete c[r.tag_name]; return c })
                  })}
                  onAssetDelete={(filename) => void mutate(async () => {
                    await releasesApi.deleteAsset(projectId, r.tag_name, filename)
                    setAssets((m) => ({ ...m, [r.tag_name]: m[r.tag_name]!.filter((a) => a.filename !== filename) }))
                  })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── New release ── */}
      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New release"
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              data-autofocus
              disabled={!form.tag_name.trim()}
              onClick={() =>
                void mutate(async () => {
                  await releasesApi.create(projectId, {
                    tag_name: form.tag_name.trim(),
                    ...(form.ref.trim() ? { ref: form.ref.trim() } : {}),
                    ...(form.name.trim() ? { name: form.name.trim() } : {}),
                    description: form.description,
                    prerelease: form.prerelease,
                    draft: form.draft,
                  })
                  setCreateOpen(false)
                })
              }
            >
              Create release
            </Button>
          </>
        }
      >
        <div className="ds-stack">
          <Input label="Tag name" value={form.tag_name} onChange={(e) => setForm({ ...form, tag_name: e.target.value })} placeholder="v1.0.0" />
          <Input label="Ref (branch or existing tag)" value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} placeholder="main — defaults to the default branch when creating a new tag" />
          <Input label="Title" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder='v1.0.0 "Aurora"' />
          <Textarea label="Release notes" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <div className="ds-row">
            <Toggle checked={form.prerelease} onChange={(v) => setForm({ ...form, prerelease: v })} label="Pre-release" />
            <Toggle checked={form.draft} onChange={(v) => setForm({ ...form, draft: v })} label="Save as draft" />
          </div>
        </div>
      </Dialog>

      {/* ── Edit draft (published releases are immutable) ── */}
      <Dialog
        open={editTag !== null}
        onClose={() => setEditTag(null)}
        title={`Edit ${editTag ?? ''}`}
        footer={
          <>
            <Button onClick={() => setEditTag(null)}>Cancel</Button>
            <Button
              variant="primary"
              data-autofocus
              onClick={() =>
                void mutate(async () => {
                  await releasesApi.update(projectId, editTag!, {
                    name: editForm.name || null,
                    description: editForm.description,
                    prerelease: editForm.prerelease,
                  })
                  setEditTag(null)
                })
              }
            >
              Save
            </Button>
          </>
        }
      >
        <div className="ds-stack">
          <Input label="Title" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
          <Textarea label="Description" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
          <Toggle checked={editForm.prerelease} onChange={(v) => setEditForm({ ...editForm, prerelease: v })} label="Pre-release" />
        </div>
      </Dialog>

      {/* ── Generated release notes (review before adopting) ── */}
      <Dialog
        open={notesTag !== null}
        onClose={() => { setNotesTag(null); setNotes(null) }}
        title={`Generate notes for ${notesTag ?? ''}`}
        description="Built from commit history and merged pull requests. Nothing is saved until you adopt it."
        footer={
          <>
            <Button onClick={() => { setNotesTag(null); setNotes(null) }}>Cancel</Button>
            <Button onClick={() => void generateNotes()} disabled={!notesTag}>Generate</Button>
            <Button
              variant="primary"
              data-autofocus={!!notes}
              disabled={!notes}
              onClick={() =>
                notes &&
                void mutate(async () => {
                  await releasesApi.update(projectId, notesTag!, { description: notes.markdown })
                  setNotesTag(null)
                  setNotes(null)
                })
              }
            >
              Use as description
            </Button>
          </>
        }
      >
        <div className="ds-stack">
          {!notes ? (
            <>
              <Input label="Previous tag (optional)" value={notesPrev} onChange={(e) => setNotesPrev(e.target.value)} placeholder="auto-detected when empty" />
            </>
          ) : (
            <>
              <p className="ls-rb__muted">{notes.commit_count} commits · {notes.merged_prs} merged pull requests</p>
              <Textarea aria-label="Generated release notes" value={notes.markdown} readOnly rows={12} />
            </>
          )}
        </div>
      </Dialog>

      {/* ── Delete release ── */}
      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={`Delete “${deleteTarget?.name ?? ''}”?`}
        description="Assets are removed from storage. The git tag itself is kept."
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="danger"
              data-autofocus
              onClick={() => {
                if (!deleteTarget) return
                void mutate(async () => {
                  await releasesApi.remove(projectId, deleteTarget.tag_name)
                  setDeleteTarget(null)
                })
              }}
            >
              Delete release
            </Button>
          </>
        }
      >
        <span />
      </Dialog>
    </section>
  )
}

// ── Row ─────────────────────────────────────────────────────────────────────

function ReleaseRow({
  release: r,
  isLatest,
  isMaintainer,
  expanded,
  rowAssets,
  onToggle,
  onPublish,
  onEdit,
  onNotes,
  onDelete,
  onUpload,
  onAssetDelete,
}: {
  release: Release
  isLatest: boolean
  isMaintainer: boolean
  expanded: boolean
  rowAssets?: ReleaseAsset[]
  onToggle: () => void
  onPublish: () => void
  onEdit: () => void
  onNotes: () => void
  onDelete: () => void
  onUpload: (file: File) => void
  onAssetDelete: (filename: string) => void
}) {
  const single = rowAssets && rowAssets.length > 0
  return (
    <>
      <tr className={expanded ? 'ls-rel__row--open' : undefined}>
        <td>
          <span className="ls-rel__version">{r.name}</span>
          {isLatest && <Badge variant="accent">latest</Badge>}
          {r.state === 'draft' && <Badge variant="neutral">draft</Badge>}
          {r.is_prerelease && <Badge variant="danger">pre-release</Badge>}
        </td>
        <td className="ls-rb__muted">{dayOf(r.released_at ?? r.created_at)}</td>
        <td><code className="ls-rel__tag">{r.tag_name}</code></td>
        <td className="ls-rb__muted">{r.asset_count}</td>
        <td className="ls-labels__actions">
          <button type="button" className="ls-btn ls-btn--sm" onClick={onToggle} aria-expanded={expanded}>
            Download{single ? '' : '…'}
          </button>
          {isMaintainer && (
            <span className="ls-rel__maintools">
              {r.state === 'draft' && (
                <IconButton label={`Publish ${r.tag_name}`} icon="check" onClick={onPublish} />
              )}
              <IconButton label={`Generate notes ${r.tag_name}`} icon="code" onClick={onNotes} />
              {r.state === 'draft' && (
                <IconButton label={`Edit ${r.tag_name}`} icon="settings" onClick={onEdit} />
              )}
              <IconButton label={`Delete ${r.tag_name}`} icon="trash" onClick={onDelete} />
            </span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="ls-rel__assets-row">
          <td colSpan={5}>
            <div className="ls-rel__assets">
              {(rowAssets ?? []).length === 0 ? (
                <p className="ls-rb__muted">No binary assets.</p>
              ) : (
                <ul className="ls-rel__assetlist">
                  {(rowAssets ?? []).map((a) => (
                    <li key={a.id}>
                      <a href={a.download_url} download>{a.filename}</a>
                      <span className="ls-rb__muted">
                        {formatBytes(a.size)} · sha256 {a.sha256.slice(0, 12)}…
                      </span>
                      {isMaintainer && (
                        <IconButton label={`Delete ${a.filename}`} icon="close"
                          onClick={() => onAssetDelete(a.filename)} />
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {isMaintainer && (
                <label className="ls-btn ls-btn--sm ls-rel__upload">
                  Upload asset
                  <input
                    type="file"
                    aria-label={`Upload asset for ${r.tag_name}`}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) onUpload(f)
                      e.currentTarget.value = ''
                    }}
                  />
                </label>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
