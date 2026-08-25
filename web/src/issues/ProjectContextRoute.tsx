import { useEffect, useState, type ReactNode } from 'react'
import { EmptyState } from '../design-system/EmptyState'
import { projectsApi, type Project } from '../projects/api'

/** Resolves owner/path → project and hands it to a render prop. */
export function ProjectContextRoute({
  owner,
  projectPath,
  children,
}: {
  owner: string
  projectPath: string
  children: (project: Project) => ReactNode
}) {
  const [project, setProject] = useState<Project | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    projectsApi.byPath(owner, projectPath)
      .then((p) => { if (alive) setProject(p) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [owner, projectPath])

  if (failed) return <EmptyState icon="warning" title="Project not found" description="Check the address or your access rights." />
  if (!project) return <div className="ls-rb__loading" role="status">Loading…</div>
  return <>{children(project)}</>
}
