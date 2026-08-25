import { useEffect, useState } from 'react'
import { EmptyState } from '../design-system/EmptyState'
import { useAuth } from '../auth/context'
import { projectsApi, type Project } from '../projects/api'
import { IssuesListPage } from './IssuesListPage'
import { IssueDetailPage } from './IssueDetailPage'

/**
 * Route adapters: resolve the owner/path prefix to a project id once, then
 * delegate to the issues views. `action` is the URL segment after /proj/:owner/:path/.
 */
export function IssuesRoute({
  owner,
  projectPath,
  navigate,
}: {
  owner: string
  projectPath: string
  navigate: (hash: string) => void
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

  return <IssuesListPage projectId={project.id} owner={owner} projectPath={projectPath} navigate={navigate} />
}

export function IssueDetailRoute({
  owner,
  projectPath,
  iid,
  navigate,
}: {
  owner: string
  projectPath: string
  iid: number
  navigate: (hash: string) => void
}) {
  const { user } = useAuth()
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
  if (!project || !user) return <div className="ls-rb__loading" role="status">Loading…</div>

  const canMaintain = project.owner?.id === user.id || user.admin === true

  return (
    <IssueDetailPage
      projectId={project.id}
      owner={owner}
      projectPath={projectPath}
      iid={iid}
      canMaintain={canMaintain}
      navigate={navigate}
    />
  )
}
