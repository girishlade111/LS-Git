import { useEffect, useState } from 'react'
import { Badge } from '../design-system/Badge'
import { Button } from '../design-system/Button'
import { Dialog } from '../design-system/Dialog'
import { Input } from '../design-system/Input'
import { Select } from '../design-system/Select'
import { useToast } from '../design-system/Toast'
import { useAuth, useHashRoute } from '../auth/context'
import { projectsApi, type Project } from './api'
import { FolderUploadDialog } from './FolderUploadDialog'
import { ForkButton, ForkStatusPanel } from '../repository/forks'
import { StarButton, WatchSelector } from '../repository/social'

export function ProjectDetailView({ owner, path }: { owner: string; path: string }) {
  const toast = useToast()
  const { user } = useAuth()
  const { navigate } = useHashRoute()
  const [project, setProject] = useState<Project | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [tab, setTab] = useState<'overview' | 'settings'>('overview')
  const [uploadOpen, setUploadOpen] = useState(false)

  async function reload() {
    try {
      setProject(await projectsApi.byPath(owner, path))
    } catch {
      setNotFound(true)
    }
  }
  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, path])

  if (notFound) {
    return (
      <div className="ls-page-title"><h1>Project not found</h1></div>
    )
  }
  if (!project) return null

  const isOwner = user?.id === project.owner?.id

  return (
    <>
      <div className="ls-page-title">
        <h1 style={{ fontSize: 'var(--ls-fs-h1)' }}>{project.name}</h1>
        <Badge variant={project.visibility === 'public' ? 'success' : 'neutral'}>{project.visibility}</Badge>
        {project.archived && <Badge variant="danger">archived</Badge>}
        {project.is_template && <Badge variant="accent">template</Badge>}
      </div>
      <p className="ls-page-desc">
        {project.full_path}
        {project.description ? ` · ${project.description}` : ''}
        {project.website_url && (
          <>
            {' · '}
            <a href={project.website_url} target="_blank" rel="noreferrer noopener">{project.website_url}</a>
          </>
        )}
      </p>

      {/* Social + fork controls: star/watch on the source page; relationship panel on forks. */}
      <div className="ds-row" style={{ marginBottom: 12, alignItems: 'center' }}>
        <nav className="ls-issues__projlinks" aria-label="Project collaboration" style={{ display: 'flex', gap: 14, marginRight: 12 }}>
          <a href={`#/proj/${encodeURIComponent(owner)}/${encodeURIComponent(path)}/pulls`}>Pull requests</a>
          <a href={`#/proj/${encodeURIComponent(owner)}/${encodeURIComponent(path)}/issues`}>Issues</a>
          <a href={`#/proj/${encodeURIComponent(owner)}/${encodeURIComponent(path)}/releases`}>Releases</a>
          <a href={`#/proj/${encodeURIComponent(owner)}/${encodeURIComponent(path)}/milestones`}>Milestones</a>
          <a href={`#/proj/${encodeURIComponent(owner)}/${encodeURIComponent(path)}/labels`}>Labels</a>
        </nav>
        {!project.upstream_full_path && !project.archived && <ForkButton project={project} />}
        {project.upstream_full_path && (
          <ForkStatusPanel
            project={project}
            isOwner={!!isOwner}
            onChanged={() => void reload()}
          />
        )}
        {isOwner || project.visibility === 'public' ? (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginLeft: 8 }}>
            <StarButton projectId={project.id} />
            <WatchSelector projectId={project.id} />
          </div>
        ) : null}
      </div>

      <div className="ls-tabs__list" role="tablist" aria-label="Project sections">
        {(['overview', 'settings'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className="ls-tabs__tab" onClick={() => setTab(t)}>
            {t === 'overview' ? 'Overview' : 'Settings'}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <section className="ls-section" aria-label="Overview">
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            {isOwner && !project.archived && (
              <Button size="sm" variant="primary" iconStart="plus" onClick={() => setUploadOpen(true)}>
                Upload files
              </Button>
            )}
          </div>
          <FolderUploadDialog
            project={project}
            open={uploadOpen}
            onClose={() => setUploadOpen(false)}
            onCommitted={() => void reload()}
          />
          <h2 className="ls-section__title">Topics</h2>
          {project.topics.length === 0 ? (
            <p className="ls-page-desc">No topics yet.</p>
          ) : (
            <div className="ds-row">
              {project.topics.map((t) => (
                <TopicLink key={t} topic={t} />
              ))}
            </div>
          )}
          <h2 className="ls-section__title">Repository</h2>
          <div className="ls-card" style={{ padding: 16 }}>
            <p style={{ fontSize: 'var(--ls-fs-body)', color: 'var(--ls-text-secondary)' }}>
              Default branch: <strong style={{ color: 'var(--ls-text)' }}>{project.default_branch}</strong>
              {' · '}Clone URL: <code style={{ fontFamily: 'var(--ls-font-mono)', fontSize: 'var(--ls-fs-label)' }}>
                https://lsgit.local/{project.full_path}.git
              </code>
            </p>
            <a
              className="ls-btn ls-btn--sm ls-btn--primary"
              href={`#/proj/${owner}/${path}/tree/${encodeURIComponent(project.default_branch)}`}
            >
              Browse code
            </a>
          </div>
        </section>
      )}

      {tab === 'settings' && (
        <SettingsPanel
          project={project}
          isOwner={!!isOwner}
          onSaved={(p) => setProject(p)}
          onDeleted={() => navigate('/projects')}
          onRenamed={(p) => {
            const [o, pathSeg] = p.full_path.split('/')
            navigate(`/proj/${o}/${pathSeg}`)
          }}
          notify={(title, message, variant) => toast.show({ title, message, variant })}
        />
      )}
    </>
  )
}

function TopicLink({ topic }: { topic: string }) {
  const { navigate } = useHashRoute()
  return (
    <button
      type="button"
      className="ls-topic"
      onClick={() => navigate(`/explore?topic=${encodeURIComponent(topic)}`)}
      aria-label={`Explore projects tagged ${topic}`}
    >
      {topic}
    </button>
  )
}

function SettingsPanel({
  project,
  isOwner,
  onSaved,
  onDeleted,
  onRenamed,
  notify,
}: {
  project: Project
  isOwner: boolean
  onSaved: (p: Project) => void
  onDeleted: () => void
  onRenamed: (p: Project) => void
  notify: (title: string, message?: string, variant?: 'info' | 'success' | 'danger') => void
}) {
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const [website, setWebsite] = useState(project.website_url)
  const [visibility, setVisibility] = useState(project.visibility)
  const [defaultBranch, setDefaultBranch] = useState(project.default_branch)
  const [topicsText, setTopicsText] = useState(project.topics.join(', '))
  const [newPath, setNewPath] = useState('')
  const [transferTo, setTransferTo] = useState('')
  const [confirmDelete, setConfirmDelete] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)

  async function saveMetadata() {
    try {
      const updated = await projectsApi.update(project.id, {
        name,
        description,
        website_url: website,
        visibility,
        default_branch: defaultBranch,
        topics: topicsText.split(',').map((t) => t.trim()).filter(Boolean),
      })
      onSaved(updated)
      notify('Saved', 'Project settings updated.', 'success')
    } catch (err) {
      notify('Failed', err instanceof Error ? err.message : undefined, 'danger')
    }
  }

  async function toggleArchive() {
    try {
      const p = project.archived ? await projectsApi.unarchive(project.id) : await projectsApi.archive(project.id)
      onSaved(p)
      notify(p.archived ? 'Archived' : 'Restored', undefined, 'info')
    } catch (err) {
      notify('Failed', err instanceof Error ? err.message : undefined, 'danger')
    }
  }

  async function toggleTemplate() {
    try {
      const p = await projectsApi.setTemplate(project.id, !project.is_template)
      onSaved(p)
      notify('Template setting updated', undefined, 'success')
    } catch (err) {
      notify('Failed', err instanceof Error ? err.message : undefined, 'danger')
    }
  }

  async function doRename() {
    try {
      const p = await projectsApi.rename(project.id, newPath)
      onRenamed(p)
      setNewPath('')
      notify('Project renamed', p.redirect_created ? 'Old links now redirect.' : undefined, 'success')
    } catch (err) {
      notify('Failed', err instanceof Error ? err.message : undefined, 'danger')
    }
  }

  async function doTransfer() {
    try {
      const p = await projectsApi.transfer(project.id, transferTo)
      onRenamed(p)
      setTransferTo('')
      notify('Ownership transferred', `New owner: ${p.owner?.username}`, 'success')
    } catch (err) {
      notify('Failed', err instanceof Error ? err.message : undefined, 'danger')
    }
  }

  async function doDelete() {
    try {
      await projectsApi.remove(project.id, confirmDelete)
      notify('Project deleted', undefined, 'info')
      onDeleted()
    } catch (err) {
      notify('Failed', err instanceof Error ? err.message : undefined, 'danger')
      setDeleteOpen(false)
    }
  }

  return (
    <section className="ls-section" aria-label="Project settings">
      <h2 className="ls-section__title">General</h2>
      <section className="ls-card" style={{ padding: 20 }} aria-label="Metadata">
        <div className="ds-stack" style={{ maxWidth: 480 }}>
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
          <Input label="Website URL" value={website} onChange={(e) => setWebsite(e.target.value)} />
          <Select
            label="Visibility"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as Project['visibility'])}
            options={[
              { value: 'private', label: 'Private — members only' },
              { value: 'internal', label: 'Internal — any signed-in user' },
              { value: 'public', label: 'Public — everyone' },
            ]}
          />
          <Input label="Default branch" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} />
          <Input
            label="Topics"
            hint="Comma-separated. Normalized and deduplicated; max 30."
            value={topicsText}
            onChange={(e) => setTopicsText(e.target.value)}
          />
          <Button variant="primary" size="sm" onClick={() => void saveMetadata()}>Save changes</Button>
        </div>
      </section>

      {isOwner && (
        <>
          <h2 className="ls-section__title">Advanced</h2>
          <section className="ls-card" style={{ padding: 20 }} aria-label="Advanced settings">
            <div className="ds-row">
              <Input label="Rename to new path" placeholder={project.path} value={newPath} onChange={(e) => setNewPath(e.target.value.toLowerCase())} />
              <Button size="sm" disabled={!newPath || newPath === project.path} onClick={() => void doRename()}>Rename</Button>
            </div>
            <div className="ds-row">
              <Input label="Transfer to user" placeholder="username" value={transferTo} onChange={(e) => setTransferTo(e.target.value)} />
              <Button size="sm" disabled={!transferTo} onClick={() => void doTransfer()}>Transfer ownership</Button>
            </div>
            <div className="ds-row">
              <Button size="sm" onClick={() => void toggleArchive()}>
                {project.archived ? 'Restore project' : 'Archive project'}
              </Button>
              <Button size="sm" onClick={() => void toggleTemplate()}>
                {project.is_template ? 'Unset as template' : 'Set as template'}
              </Button>
            </div>
            <div className="ls-settings__row">
              <span>
                <h2 style={{ fontSize: 'var(--ls-fs-row)', fontWeight: 600, color: 'var(--ls-danger)' }}>Delete project</h2>
                <p style={{ fontSize: 'var(--ls-fs-desc)', color: 'var(--ls-text-secondary)' }}>
                  Permanently removes the repository and all metadata. Type the full path to confirm.
                </p>
              </span>
              <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>Delete…</Button>
            </div>
          </section>
        </>
      )}

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete project permanently?"
        description={`Type “${project.full_path}” to confirm. This cannot be undone.`}
        footer={
          <>
            <Button onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              data-autofocus
              disabled={confirmDelete.toLowerCase() !== project.full_path.toLowerCase()}
              onClick={() => void doDelete()}
            >
              Delete project
            </Button>
          </>
        }
      >
        <input
          className="ls-input"
          aria-label="Confirmation path"
          placeholder={project.full_path}
          value={confirmDelete}
          onChange={(e) => setConfirmDelete(e.target.value)}
        />
      </Dialog>
    </section>
  )
}
