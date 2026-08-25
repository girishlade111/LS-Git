import { useEffect, useState } from 'react'
import { EmptyState } from '../design-system/EmptyState'
import { useAuth } from '../auth/context'
import { projectsApi, type Project } from '../projects/api'
import { repositoryApi, type RefsResult } from '../repository/api'
import { PullsListPage } from './PullsListPage'
import { PullDetailPage } from './PullDetailPage'

/** Resolves owner/path → project (+refs for the branch pickers). */
function useProjectContext(owner: string, projectPath: string) {
  const [project, setProject] = useState<Project | null>(null)
  const [refs, setRefs] = useState<RefsResult | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    projectsApi.byPath(owner, projectPath)
      .then((p) => {
        if (!alive) return
        setProject(p)
        repositoryApi.refs(p.id).then((r) => { if (alive) setRefs(r) }).catch(() => undefined)
      })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [owner, projectPath])

  return { project, refs, failed }
}

export function PullsListRouteBridge({
  owner,
  projectPath,
  navigate,
}: {
  owner: string
  projectPath: string
  navigate: (hash: string) => void
}) {
  const { project, failed } = useProjectContext(owner, projectPath)
  if (failed) return <EmptyState icon="warning" title="Project not found" description="Check the address or your access rights." />
  if (!project) return <div className="ls-rb__loading" role="status">Loading…</div>
  return (
    <PullsListPage
      projectId={project.id}
      owner={owner}
      projectPath={projectPath}
      navigate={navigate}
    />
  )
}

export function PullDetailRouteBridge({
  owner,
  projectPath,
  iid,
}: {
  owner: string
  projectPath: string
  iid: number
}) {
  const { user } = useAuth()
  const { project, failed } = useProjectContext(owner, projectPath)
  if (failed) return <EmptyState icon="warning" title="Project not found" description="Check the address or your access rights." />
  if (!project || !user) return <div className="ls-rb__loading" role="status">Loading…</div>
  const canMaintain = project.owner?.id === user.id || user.admin === true
  return (
    <PullDetailPage
      projectId={project.id}
      owner={owner}
      projectPath={projectPath}
      iid={iid}
      canMaintain={canMaintain}
    />
  )
}