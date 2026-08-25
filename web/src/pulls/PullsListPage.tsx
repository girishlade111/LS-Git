import { useCallback, useEffect, useState } from 'react'
import { Button } from '../design-system/Button'
import { Dialog } from '../design-system/Dialog'
import { EmptyState } from '../design-system/EmptyState'
import { Icon } from '../design-system/Icon'
import { Input } from '../design-system/Input'
import { Pagination } from '../design-system/Pagination'
import { Select } from '../design-system/Select'
import { Textarea } from '../design-system/Textarea'
import { Tooltip } from '../design-system/Tooltip'
import { LabelChip } from '../issues/LabelChip'
import { timeAgo } from '../repository/widgets'
import { pullsApi, type PullRequest, type PrState } from './api'

/**
 * Pull request list — GitLab MR semantics, LSGit density.
 * Open / Draft / Merged / Closed tabs · search · pagination. No cards.
 */

export function PullsListPage({
  projectId,
  owner,
  projectPath,
  navigate,
  refs,
}: {
  projectId: number
  owner: string
  projectPath: string
  navigate: (hash: string) => void
  refs: Array<{ name: string }>
}) {
  const [state, setState] = useState<PrState | 'all' | 'draft'>('opened')
  const [search, setSearch] = useState('')
  const [result, setResult] = useState<{ pull_requests: PullRequest[]; pagination: Pagination } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // New-PR dialog state.
  const [createOpen, setCreateOpen] = useState(false)
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('main')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [draft, setDraft] = useState(false)

  const load = useCallback(async () => {
    try {
      const f: Record<string, string> = {}
      if (state === 'draft') { f.state = 'opened'; f.draft = 'true' }
      else if (state !== 'all') f.state = state
      if (search) f.search = search
      setResult(await pullsApi.list(projectId, f))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load pull requests')
    }
  }, [projectId, state, search])

  useEffect(() => { void load() }, [load])

  async function create() {
    try {
      const pr = await pullsApi.create(projectId, {
        title: title.trim(),
        description,
        source_branch: source,
        target_branch: target,
        draft,
      })
      setCreateOpen(false); setTitle(''); setDescription(''); setSource(''); setDraft(false)
      navigate(`#${pr.web_path}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to open the pull request')
    }
  }

  const branchOptions = refs.map((r) => ({ value: r.name, label: r.name }))
  const base = `/proj/${encodeURIComponent(owner)}/${encodeURIComponent(projectPath)}`

  return (
    <section aria-label="Pull requests" className="ls-rb ls-pulls">
      <header className="ls-rb__head">
        <nav className="ls-issues__tabs" aria-label="Pull request state">
          {([['opened', 'Open'], ['draft', 'Draft'], ['merged', 'Merged'], ['closed', 'Closed']] as const).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={state === v}
              className={`ls-issues__tab${state === v ? ' ls-issues__tab--current' : ''}`}
              onClick={() => setState(v as typeof state)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="ls-rb__actions">
          <Button size="sm" variant="primary" iconStart="plus" onClick={() => setCreateOpen(true)}>
            New pull request
          </Button>
        </div>
      </header>

      <div className="ls-issues__filters">
        <div style={{ flex: 1, minWidth: 200 }}>
          <Input
            label="Search"
            placeholder="Search titles and descriptions…"
            value={search}
            onChange={(e) => setSearch(e.target.value || undefined)}
          />
        </div>
      </div>

      {error && <div role="alert" className="ls-editor-error">{error}</div>}

      {!result ? (
        <div className="ls-rb__loading" role="status">Loading pull requests…</div>
      ) : result.pull_requests.length === 0 ? (
        <EmptyState icon="merge" title="No pull requests here" description="Open one from any branch pair to start a review." />
      ) : (
        <>
          <ul className="ls-issues__list">
            {result.pull_requests.map((pr) => (
              <li key={pr.id} className="ls-issues__row">
                <span className={`ls-pulls__state ls-pulls__state--${pr.state}`} aria-label={`Pull request ${pr.state}`}>
                  {pr.state === 'merged' ? <Icon name="merge" size={13} /> : pr.state === 'closed' ? <Icon name="close" size={13} /> : <Icon name="code" size={13} />}
                </span>
                <div className="ls-issues__main">
                  <a className="ls-issues__title" href={`#${base}/pulls/${pr.iid}`}>
                    {pr.title} <span className="ls-rb__muted">!{pr.iid}</span>
                    {pr.draft && <span className="ls-pulls__drafttag">Draft</span>}
                  </a>
                  <div className="ls-issues__meta">
                    {pr.source_branch} → {pr.target_branch}
                    {' · '}opened {timeAgo(pr.created_at)} by {pr.author?.username ?? 'unknown'}
                  </div>
                  {pr.labels.length > 0 && (
                    <div className="ls-issues__labels">
                      {pr.labels.map((l) => <LabelChip key={l.id} label={l} />)}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <footer className="ls-issues__foot">
            <span className="ls-rb__muted">{result.pagination.total} pull request{result.pagination.total === 1 ? '' : 's'}</span>
            <Pagination
              page={result.pagination.page}
              pageCount={Math.max(1, result.pagination.total_pages)}
              onChange={(p) => { /* refetch via load() keyed on filters */ void pullsApi.list(projectId, { page: p }).then(setResult) }}
            />
          </footer>
        </>
      )}

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New pull request"
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              data-autofocus
              disabled={!title.trim() || !source || !target || source === target}
              onClick={() => void create()}
            >
              Open pull request
            </Button>
          </>
        }
      >
        <div className="ds-stack">
          <Select
            label="Source branch"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            options={[{ value: '', label: 'Choose…' }, ...branchOptions]}
          />
          <Select
            label="Target branch"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            options={branchOptions.length > 0 ? branchOptions : [{ value: 'main', label: 'main' }]}
          />
          <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder='Add "Fixes #3" to link an issue' />
          <Textarea
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={'Markdown · @mentions · closing keywords like "Closes #12" auto-link issues.'}
          />
          <label className="ls-checkline">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            <span>Start as draft</span>
          </label>
          {source && source === target && (
            <p className="ls-formfield__error" role="alert">Source and target must differ.</p>
          )}
        </div>
      </Dialog>
    </section>
  )
}

void Tooltip
