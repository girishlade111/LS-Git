import { useEffect, useState } from 'react'
import { Badge } from '../design-system/Badge'
import { Button } from '../design-system/Button'
import { EmptyState } from '../design-system/EmptyState'
import { Input } from '../design-system/Input'
import { useHashRoute } from '../auth/context'
import { projectsApi, type Project } from './api'

/** Topic chip — normalized, clickable, navigates to the topic-filtered explorer. */
export function TopicChip({ topic, onNavigate }: { topic: string; onNavigate?: (t: string) => void }) {
  return (
    <button
      type="button"
      className="ls-topic"
      onClick={() => onNavigate?.(topic)}
      aria-label={`Explore projects tagged ${topic}`}
    >
      {topic}
    </button>
  )
}

function ProjectRow({ p, onOpen }: { p: Project; onOpen: (p: Project) => void }) {
  return (
    <article className="ls-activity" style={{ cursor: 'pointer' }} onClick={() => onOpen(p)}>
      <div className="ls-activity__body">
        <div className="ls-activity__title">
          {p.full_path}
          {p.visibility === 'public' && <Badge variant="success">public</Badge>}
          {p.visibility === 'private' && <Badge>private</Badge>}
          {p.archived && <Badge variant="danger">archived</Badge>}
        </div>
        {p.description && <div className="ls-activity__desc">{p.description}</div>}
        {p.topics.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {p.topics.map((t) => (
              <span key={t} onClick={(e) => e.stopPropagation()}>
                <TopicChip topic={t} />
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="ls-activity__time">{new Date(p.last_activity_at).toLocaleDateString()}</div>
    </article>
  )
}

export function ProjectsView() {
  const { navigate } = useHashRoute()
  const [mine, setMine] = useState<Project[] | null>(null)
  const [explore, setExplore] = useState<Project[] | null>(null)
  const [search, setSearch] = useState('')
  const [topicFilter, setTopicFilter] = useState<string | null>(null)

  async function load() {
    setMine(await projectsApi.listMine().catch(() => []))
    setExplore(await projectsApi.explore({ search: search || undefined, topic: topicFilter ?? undefined }).catch(() => []))
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, topicFilter])

  function open(p: Project) {
    const [owner, path] = p.full_path.split('/')
    navigate(`/proj/${owner}/${path}`)
  }

  return (
    <>
      <div className="ls-page-title">
        <h1>Projects</h1>
        <Button variant="primary" size="sm" iconStart="plus" onClick={() => navigate('/projects/new')}>
          New project
        </Button>
      </div>
      <p className="ls-page-desc">Repositories you own, and public projects across the instance.</p>

      <section className="ls-section" style={{ marginTop: 0 }} aria-label="Your projects">
        <h2 className="ls-section__title">Your projects</h2>
        {mine === null ? null : mine.length === 0 ? (
          <EmptyState
            icon="folder"
            title="No projects yet"
            description="Create your first repository to get started."
            action={<Button variant="primary" size="sm" onClick={() => navigate('/projects/new')}>New project</Button>}
          />
        ) : (
          <div className="ls-card" style={{ padding: '4px 14px' }}>
            {mine.map((p) => <ProjectRow key={p.id} p={p} onOpen={open} />)}
          </div>
        )}
      </section>

      <section className="ls-section" aria-label="Explore public projects">
        <h2 className="ls-section__title">
          Explore{topicFilter ? ` · topic “${topicFilter}”` : ''}
          {topicFilter && (
            <Button size="sm" variant="ghost" onClick={() => setTopicFilter(null)}>Clear filter</Button>
          )}
        </h2>
        <div style={{ maxWidth: 320, marginBottom: 10 }}>
          <Input
            label=""
            placeholder="Search public projects…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {explore === null ? null : explore.length === 0 ? (
          <EmptyState icon="eye" title="No public projects found" description="Try a different search or topic." />
        ) : (
          <div className="ls-card" style={{ padding: '4px 14px' }}>
            {explore.map((p) => <ProjectRow key={p.id} p={p} onOpen={open} />)}
          </div>
        )}
      </section>
    </>
  )
}

void TopicChip
