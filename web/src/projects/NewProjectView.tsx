import { useEffect, useState } from 'react'
import { Button } from '../design-system/Button'
import { Input } from '../design-system/Input'
import { Select } from '../design-system/Select'
import { useToast } from '../design-system/Toast'
import { useHashRoute } from '../auth/context'
import { projectsApi, type Catalog, type Project } from './api'
import { TopicChip } from './ProjectsView'

/** Dense creation form: metadata + initialization options (GitLab-parity subset). */
export function NewProjectView() {
  const toast = useToast()
  const { navigate } = useHashRoute()
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [templates, setTemplates] = useState<Project[] | null>(null)

  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [pathTouched, setPathTouched] = useState(false)
  const [visibility, setVisibility] = useState<'private' | 'internal' | 'public'>('private')
  const [description, setDescription] = useState('')
  const [website, setWebsite] = useState('')
  const [defaultBranch, setDefaultBranch] = useState('main')
  const [withReadme, setWithReadme] = useState(true)
  const [gitignore, setGitignore] = useState('')
  const [license, setLicense] = useState('')
  const [topicInput, setTopicInput] = useState('')
  const [topics, setTopics] = useState<string[]>([])
  const [templateId, setTemplateId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    projectsApi.catalog().then(setCatalog).catch(() => setCatalog({ gitignore: [], licenses: [] }))
    projectsApi.templates().then(setTemplates).catch(() => setTemplates([]))
  }, [])

  function slugify(v: string): string {
    return v.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+/, '')
  }

  function addTopic() {
    const t = topicInput.trim().toLowerCase().replace(/\s+/g, '-')
    if (!t || topics.includes(t) || topics.length >= 30) return
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(t)) return
    setTopics([...topics, t])
    setTopicInput('')
  }

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const project = await projectsApi.create({
        name,
        path: path || slugify(name),
        visibility,
        description,
        website_url: website,
        default_branch: defaultBranch || 'main',
        initialize_with_readme: withReadme,
        gitignore_template: templateId === null && gitignore ? gitignore : null,
        license_template: templateId === null && license ? license : null,
        topics,
        template_project_id: templateId,
      })
      toast.show({ title: 'Project created', message: project.full_path, variant: 'success' })
      const [owner, pathSeg] = project.full_path.split('/')
      navigate(`/proj/${owner}/${pathSeg}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="ls-page-title"><h1>New project</h1></div>
      <p className="ls-page-desc">Repository metadata and initialization options.</p>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <section className="ls-card" style={{ padding: 20 }} aria-label="Project details">
          <h2 style={{ fontSize: 'var(--ls-fs-row)', fontWeight: 600 }}>Details</h2>
          <div className="ds-stack" style={{ maxWidth: 480 }}>
            <Input
              label="Project name"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (!pathTouched) setPath(slugify(e.target.value))
              }}
            />
            <Input
              label="Project path"
              required
              hint={`Will live at /${'{your-username}'}/${path || '{path}'}`}
              value={path}
              onChange={(e) => {
                setPathTouched(true)
                setPath(e.target.value.toLowerCase())
              }}
            />
            <Select
              label="Visibility"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as typeof visibility)}
              options={[
                { value: 'private', label: 'Private — members only' },
                { value: 'internal', label: 'Internal — any signed-in user' },
                { value: 'public', label: 'Public — everyone' },
              ]}
            />
            <Input label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
            <Input label="Website URL (optional)" placeholder="https://example.com" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </div>
        </section>

        <section className="ls-card" style={{ padding: 20, marginTop: 16 }} aria-label="Initialization">
          <h2 style={{ fontSize: 'var(--ls-fs-row)', fontWeight: 600 }}>Initialization</h2>
          <div className="ds-stack" style={{ maxWidth: 480 }}>
            <Input
              label="Default branch"
              required
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              hint="Created on first push or with the files below."
            />
            {templateId === null && (
              <>
                <label className="ls-checkbox">
                  <input type="checkbox" checked={withReadme} onChange={(e) => setWithReadme(e.target.checked)} />
                  Initialize repository with a README
                </label>
                <Select
                  label=".gitignore template"
                  placeholder="None"
                  value={gitignore}
                  onChange={(e) => setGitignore(e.target.value)}
                  options={(catalog?.gitignore ?? []).map((k) => ({ value: k, label: k }))}
                />
                <Select
                  label="License"
                  placeholder="None"
                  value={license}
                  onChange={(e) => setLicense(e.target.value)}
                  options={(catalog?.licenses ?? []).map((l) => ({ value: l.key, label: l.name }))}
                />
                <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
                  <legend style={{ fontSize: 'var(--ls-fs-label)', color: 'var(--ls-text-secondary)', fontWeight: 500 }}>Topics</legend>
                  <div className="ds-row" style={{ marginTop: 4 }}>
                    <input
                      className="ls-input"
                      style={{ maxWidth: 220 }}
                      placeholder="Add a topic…"
                      value={topicInput}
                      onChange={(e) => setTopicInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault()
                          addTopic()
                        }
                      }}
                      aria-label="Add a topic"
                    />
                    <Button type="button" size="sm" onClick={addTopic}>Add</Button>
                    {topics.map((t) => (
                      <span key={t}>
                        <TopicChip
                          topic={`${t} ✕`}
                          onNavigate={() => setTopics(topics.filter((x) => x !== t))}
                        />
                      </span>
                    ))}
                  </div>
                </fieldset>
              </>
            )}
            {(templates?.length ?? 0) > 0 && (
              <Select
                label="Create from template"
                placeholder="Blank project"
                value={templateId === null ? '' : String(templateId)}
                onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : null)}
                options={(templates ?? []).map((t) => ({
                  value: String(t.id),
                  label: `${t.full_path}${t.description ? ` — ${t.description}` : ''}`,
                }))}
                hint="Copies the template's files and topics into your new repository."
              />
            )}
          </div>
        </section>

        {error && (
          <p role="alert" style={{ marginTop: 12, fontSize: 'var(--ls-fs-desc)', color: 'var(--ls-danger)' }}>
            {error}
          </p>
        )}
        <div className="ds-row">
          <Button type="submit" variant="primary" disabled={!name || busy}>
            {busy ? 'Creating…' : 'Create project'}
          </Button>
          <Button type="button" onClick={() => navigate('/projects')}>Cancel</Button>
        </div>
      </form>
    </>
  )
}
