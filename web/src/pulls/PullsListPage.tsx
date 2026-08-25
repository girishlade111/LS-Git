import { useCallback, useEffect, useState } from 'react'
import { Button } from '../design-system/Button'
import { Checkbox } from '../design-system/Checkbox'
import { Dialog } from '../design-system/Dialog'
import { EmptyState } from '../design-system/EmptyState'
import { Icon } from '../design-system/Icon'
import { Input } from '../design-system/Input'
import { Pagination } from '../design-system/Pagination'
import { Select } from '../design-system/Select'
import { Textarea } from '../design-system/Textarea'
import { repositoryApi } from '../repository/api'
import { timeAgo } from '../repository/widgets'
import { pullsApi, type PullRequest } from './api'
import { LabelChip } from '../issues/LabelChip'

/** Dense PR list: state tabs · search · rows (icon · title · branches · labels). */
export function PullsListPage({
  projectId,
  owner,
  projectPath,
  navigate,
}: {
  projectId: number
  owner: string
  projectPath: string
  navigate: (hash: string) => void
}) {
  const [rows, setRows] = useState<PullRequest[] | null>(null)
  const [pagination, setPagination] = useState<{ total: number; page: number; total_pages: number; has_more: boolean } | null>(null)
  const [state, setState] = useState<'opened' | 'closed' | 'merged'>('opened')
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)

  // New-PR dialog.
  const [createOpen, setCreateOpen] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('main')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [draft, setDraft] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await pullsApi.list(projectId, { state, search: search || undefined })
      setRows(r.pull_requests)
      setPagination(r.pagination)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load pull requests')
    }
  }, [projectId, state, search])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    void repositoryApi.refs(projectId).then((r) => {
      setBranches(r.branches.map((b) => b.name))
    }).catch(() => setBranches([]))
  }, [projectId])

  async function createPr() {
    try {
      const pr = await pullsApi.create(projectId, {
        title: title.trim(),
        description,
        source_branch: source,
        target_branch: target,
        draft,
      })
      resetDialog()
      navigate(`#${pr.web_path}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create pull request')
    }
  }

  function resetDialog() {
    setCreateOpen(false); setTitle(''); setDescription(''); setDraft(false); setSource('')
  }

  return (
    <section aria-label="Pull requests" className="ls-rb ls-pulls">
      <header className="ls-rb__head">
        <nav className="ls-issues__tabs" aria-label="Pull request state">
          {(['opened', 'closed', 'merged'] as const).map((st) => (
            <button
              key={st}
              type="button"
              className={`ls-issues__tab${state === st ? ' ls-issues__tab--current' : ''}`}
              aria-current={state === st ? 'page' : undefined}
              onClick={() => setState(st)}
            >
              <Icon name={st === 'merged' ? 'merge' : st === 'closed' ? 'check' : 'issue'} size={13} />
              {st === 'opened' ? 'Open' : st === 'closed' ? 'Closed' : 'Merged'}
            </button>
          ))}
        </nav>
        <div className="ls-rb__actions">
          <Button size="sm" variant="primary" iconStart="plus" onClick={() => setCreateOpen(true)}>New pull request</Button>
        </div>
      </header>

      <div style={{ maxWidth: 320, marginBottom: 12 }}>
        <Input
          label="Search"
          placeholder="Search titles and descriptions…"
          value={search}
          onChange={(e) => setSearch(e.target.value || undefined as unknown as string)}
        />
      </div>

      {error && <div role="alert" className="ls-editor-error">{error}</div>}

      {!rows ? (
        <div role="status" className="ls-rb__loading">Loading pull requests…</div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon="merge"
          title={search ? 'No matching pull requests' : 'No pull requests yet'}
          description={search ? 'Adjust or clear the filter.' : 'Propose changes by opening one from a branch.'}
        />
      ) : (
        <>
          <ul className="ls-issues__list">
            {rows.map((pr) => (
              <li key={pr.id} className="ls-issues__row">
                <span className={`ls-pulls__state ls-pulls__state--${pr.state}`} aria-label={`Pull request ${pr.state}`}>
                  <Icon name={pr.state === 'merged' ? 'merge' : pr.state === 'closed' ? 'check' : 'issue'} size={14} />
                </span>
                <div className="ls-issues__main">
                  <a className="ls-issues__title" href={`#/proj/${encodeURIComponent(owner)}/${encodeURIComponent(projectPath)}/pulls/${pr.iid}`}>
                    {pr.draft && <span className="ls-pulls__draft">Draft:</span>}
                    {pr.title}
                  </a>
                  <div className="ls-issues__meta">
                    {pr.iid} · {pr.source_branch} → {pr.target_branch}
                    {' · '}opened {timeAgo(pr.created_at)} by {pr.author?.username ?? 'unknown'}
                    {pr.state === 'merged' && pr.merged_at ? ` · merged ${timeAgo(pr.merged_at)}` : ''}
                    {(pr.approvals.required ?? 0) > 0 && (
                      <span> · approvals {pr.approvals.count}/{pr.approvals.required}</span>
                    )}
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
          {pagination && pagination.total_pages > 1 && (
            <footer className="ls-issues__foot">
              <span className="ls-rb__muted">{pagination.total} pull request{pagination.total === 1 ? '' : 's'}</span>
              <Pagination
                page={pagination.page}
                pageCount={Math.max(1, pagination.total_pages)}
                onChange={(p) => { void pullsApi.list(projectId, { state, search, page: p }).then((r) => { setRows(r.pull_requests); setPagination(r.pagination) }) }}
              />
            </footer>
          )}
        </>
      )}

      <Dialog
        open={createOpen}
        onClose={resetDialog}
        title="New pull request"
        footer={
          <>
            <Button onClick={resetDialog}>Cancel</Button>
            <Button
              variant="primary"
              data-autofocus
              disabled={!source || !target || source === target || !title.trim()}
              onClick={() => void createPr()}
            >
              Create pull request
            </Button>
          </>
        }
      >
        <div className="ds-stack">
          <Select label="Source branch" value={source} onChange={(e) => setSource(e.target.value)} options={[{ value: '', label: 'Choose…' }, ...branches.map((b) => ({ value: b, label: b }))]} />
          <Select label="Target branch" value={target} onChange={(e) => setTarget(e.target.value)} options={branches.map((b) => ({ value: b, label: b }))} />
          <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder='Introduce the change — "closes #12" links issues' />
          <Textarea label="Description" value={description} onChange={(e) => setDescription(e.target.value)} hint={'Markdown · @mentions · closing keywords: closes/fixes/resolves #iid'} />
          <Checkbox label="Open as draft" checked={draft} onChange={(e) => setDraft((e.target as HTMLInputElement).checked)} />
        </div>
      </Dialog>
    </section>
  )
}
