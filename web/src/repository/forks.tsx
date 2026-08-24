import { useCallback, useEffect, useState } from 'react'
import { Badge } from '../design-system/Badge'
import { Button } from '../design-system/Button'
import { Dialog } from '../design-system/Dialog'
import { EmptyState } from '../design-system/EmptyState'
import { Icon } from '../design-system/Icon'
import { Input } from '../design-system/Input'
import { Select } from '../design-system/Select'
import { Tooltip } from '../design-system/Tooltip'
import type { Project } from '../projects/api'
import { repositoryApi, type ForkDivergenceReport, type ForkNetworkGraph } from './api'
import { Skeleton } from '../design-system/Skeleton'

function LoadingRows() {
  return (
    <div className="ls-rb__skeleton" aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} shape="text" width={`${45 + ((i * 10) % 45)}%`} height={10} />
      ))}
    </div>
  )
}

const VISIBILITY_RANK: Record<string, number> = { private: 0, internal: 1, public: 2 }

/**
 * Fork entry point: opens the create-fork dialog with the target path
 * prefilled and visibility options capped at the SOURCE visibility (a fork
 * may never start more visible than its upstream).
 */
export function ForkButton({ project }: { project: Project }) {
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState(project.path)
  const [visibility, setVisibility] = useState<string>(project.visibility)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const maxRank = VISIBILITY_RANK[project.visibility] ?? 0
  const visibilityOptions = (['private', 'internal', 'public'] as const)
    .filter((v) => VISIBILITY_RANK[v] <= maxRank)
    .map((v) => ({ value: v, label: v }))

  async function doFork() {
    setBusy(true)
    setError(null)
    try {
      const res = await repositoryApi.createFork(project.id, { path: path.trim(), visibility })
      setOpen(false)
      // The API returns the fork's owner-qualified path.
      window.location.hash = `/proj/${res.project.full_path}`
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fork failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button size="sm" variant="secondary" iconStart="branch" onClick={() => setOpen(true)}>
        Fork
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Fork ${project.full_path}`}
        description="Creates a copy of the repository under your namespace. All history and branches are preserved."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" data-autofocus disabled={busy || !path.trim()} onClick={() => void doFork()}>
              {busy ? 'Forking…' : 'Fork repository'}
            </Button>
          </>
        }
      >
        <div className="ds-stack">
          <Input label="Fork path" value={path} onChange={(e) => setPath(e.target.value.toLowerCase())} hint="In your own namespace." />
          <Select
            label="Visibility"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value)}
            options={visibilityOptions}
            hint={`A fork of a ${project.visibility} project cannot be more visible.`}
          />
          {error && <div role="alert" className="ls-editor-error">{error}</div>}
        </div>
      </Dialog>
    </>
  )
}

/**
 * Upstream reference + Sync Fork control surface shown on a project that IS a
 * fork: "Forked from …" link, live divergence badge (behind / ahead /
 * diverged / up to date), fast-forward-only sync, and strong-confirmed detach.
 */
export function ForkStatusPanel({
  project,
  isOwner,
  onChanged,
}: {
  project: Project
  isOwner: boolean
  onChanged?: () => void
}) {
  const [report, setReport] = useState<ForkDivergenceReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detachOpen, setDetachOpen] = useState(false)
  const [confirmPath, setConfirmPath] = useState('')

  const refreshReport = useCallback(() => {
    repositoryApi.forkDivergence(project.id, null)
      .then(setReport)
      .catch(() => setReport(null))
  }, [project.id])

  useEffect(() => { refreshReport() }, [refreshReport])

  async function doSync() {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const res = await repositoryApi.forkSync(project.id, null)
      if (res.outcome === 'updated') {
        setMessage(`Fast-forwarded ${res.report.branch} to upstream (${res.report.upstream_tip?.slice(0, 8)}).`)
        onChanged?.()
      } else if (res.report.state === 'ahead') {
        setMessage(`Your branch is ahead of upstream by ${res.report.ahead_count} commit(s) — nothing to pull.`)
      } else {
        setMessage('Already up to date with the upstream repository.')
      }
      setReport(res.report)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed')
      refreshReport()
    } finally {
      setBusy(false)
    }
  }

  async function doDetach() {
    setBusy(true)
    setError(null)
    try {
      await repositoryApi.forkDetach(project.id, confirmPath.trim())
      setDetachOpen(false)
      setConfirmPath('')
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Detach failed')
    } finally {
      setBusy(false)
    }
  }

  if (!project.upstream_full_path) return null

  const stateBadge = report?.state ? (
    <Tooltip content={
      report.state === 'diverged'
        ? `${report.ahead_count} local and ${report.behind_count} upstream commits have diverged`
        : report.state === 'behind'
          ? `${report.behind_count} commits behind upstream`
          : report.state === 'ahead'
            ? `${report.ahead_count} commits ahead of upstream`
            : 'Identical to upstream'
    }>
      <span>
        <Badge variant={report.state === 'up_to_date' ? 'success' : report.state === 'diverged' ? 'danger' : 'neutral'}>
          {report.state.replace('_', ' ')}
        </Badge>
      </span>
    </Tooltip>
  ) : null

  return (
    <section className="ls-card ls-fk" aria-label="Fork relationship" style={{ padding: 14 }}>
      <div className="ls-fk__row">
        <Icon name="branch" size={14} />
        <span>
          Forked from{' '}
          <a href={`#/proj/${project.upstream_full_path}`}>
            <strong>{project.upstream_full_path}</strong>
          </a>
        </span>
        {stateBadge}
        <a
          className="ls-btn ls-btn--sm ls-btn--ghost"
          href={`#/proj/${project.upstream_full_path}/network`}
        >
          View network
        </a>
      </div>

      <div className="ls-fk__row">
        {isOwner && (
          <>
            <Button size="sm" variant="primary" disabled={busy || report?.state === 'up_to_date' || report?.state === 'ahead'} onClick={() => void doSync()}>
              {busy ? 'Syncing…' : 'Sync fork'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDetachOpen(true)}>
              Detach fork…
            </Button>
          </>
        )}
        {!isOwner && (
          <span className="ls-rb__muted">Sign in as the fork owner to sync or detach.</span>
        )}
      </div>

      {message && <p className="ls-rb__muted" role="status">{message}</p>}
      {error && <div role="alert" className="ls-editor-error">{error}</div>}

      <Dialog
        open={detachOpen}
        onClose={() => setDetachOpen(false)}
        title="Detach this fork?"
        description="Detaching removes the upstream relationship and leaves the fork network. History stays intact; this cannot be undone from the UI."
        footer={
          <>
            <Button onClick={() => setDetachOpen(false)}>Cancel</Button>
            <Button variant="danger" data-autofocus disabled={busy || confirmPath.trim().toLowerCase() !== project.full_path.toLowerCase()} onClick={() => void doDetach()}>
              Detach permanently
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 'var(--ls-fs-desc)', color: 'var(--ls-text-secondary)' }}>
          Type <strong>{project.full_path}</strong> to confirm.
        </p>
        <input className="ls-input" aria-label="Confirmation path" value={confirmPath} onChange={(e) => setConfirmPath(e.target.value)} />
      </Dialog>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Fork network graph — dense token table, root first, depth-indented rows.
// ---------------------------------------------------------------------------

export function NetworkView({ projectId, currentFullPath }: { projectId: number; currentFullPath: string }) {
  const [graph, setGraph] = useState<ForkNetworkGraph | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    repositoryApi.forkNetwork(projectId)
      .then(setGraph)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load network'))
  }, [projectId])

  if (error) return <EmptyState icon="warning" title="Could not load network" description={error} />
  if (!graph) return <LoadingRows />

  // Depth-indented flattened rows via BFS from the root.
  const rows: Array<{ node: ForkNetworkGraph['root']; depth: number }> = []
  const queue: Array<{ node: ForkNetworkGraph['root']; depth: number }> = [{ node: graph.root, depth: 0 }]
  while (queue.length > 0) {
    const { node, depth } = queue.shift()!
    rows.push({ node, depth })
    for (const child of node.children) queue.push({ node: child, depth: depth + 1 })
  }

  return (
    <section aria-label="Fork network" className="ls-rb">
      <header className="ls-rb__head">
        <h2 className="ls-rb__viewtitle">
          Fork network <span className="ls-rb__muted">· {graph.total_size} repositor{graph.total_size === 1 ? 'y' : 'ies'} · depth {graph.max_depth}</span>
        </h2>
      </header>
      <div className="ls-rb__tablewrap">
        <table className="ls-rb__table">
          <thead>
            <tr>
              <th scope="col">Repository</th>
              <th scope="col">Upstream</th>
              <th scope="col" className="ls-rb__colmeta">Direct forks</th>
              <th scope="col" className="ls-rb__colmeta">Descendants</th>
              <th scope="col" className="ls-rb__colmeta">Visibility</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node, depth }) => (
              <tr key={node.id} data-current={node.full_path === currentFullPath || undefined}>
                <td>
                  <span style={{ display: 'inline-block', width: `${depth * 16}px` }} aria-hidden="true" />
                  <a className="ls-rb__name" href={`#/proj/${node.full_path}`}>
                    <Icon name={depth === 0 ? 'code' : 'branch'} size={13} /> {node.name}
                  </a>
                  {node.is_root && <Badge variant="neutral">root</Badge>}
                </td>
                <td>
                  {node.forked_from != null
                    ? (() => {
                        const parent = graph.members.find((m) => m.id === node.forked_from)
                        return parent ? <a className="ls-rb__crumb" href={`#/proj/${parent.full_path}`}>{parent.full_path}</a> : <span className="ls-rb__muted">—</span>
                      })()
                    : <span className="ls-rb__muted">—</span>}
                </td>
                <td className="ls-rb__colmeta"><span className="ls-rb__muted">{node.direct_forks}</span></td>
                <td className="ls-rb__colmeta"><span className="ls-rb__muted">{node.total_descendants}</span></td>
                <td className="ls-rb__colmeta"><Badge variant="neutral">{node.visibility}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
