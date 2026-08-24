import { useEffect, useState } from 'react'
import { Badge } from '../design-system/Badge'
import { Button } from '../design-system/Button'
import { Dialog } from '../design-system/Dialog'
import { DiffViewer } from '../design-system/DiffViewer'
import { EmptyState } from '../design-system/EmptyState'
import { Icon } from '../design-system/Icon'
import { Input } from '../design-system/Input'
import { Select } from '../design-system/Select'
import { Tooltip } from '../design-system/Tooltip'
import {
  repositoryApi,
  type BranchBrowseInfo,
  type CompareResult,
  type TagInfo,
} from './api'
import { ErrorState, type BrowserNav } from './views'
import { Skeleton } from '../design-system/Skeleton'
import { KindBadge, timeAgo } from './widgets'

function LoadingRows() {
  return (
    <div className="ls-rb__skeleton" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} shape="text" width={`${40 + ((i * 11) % 50)}%`} height={10} />
      ))}
    </div>
  )
}

interface ViewCtx {
  projectId: number
  defaultBranch: string
  nav: BrowserNav
  navigate: (hash: string) => void
}

// ---------------------------------------------------------------------------
// Branches view — dense table: name · last commit · meta · actions
// ---------------------------------------------------------------------------

export function BranchesView(ctx: ViewCtx) {
  const [branches, setBranches] = useState<BranchBrowseInfo[] | null>(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'name' | 'recent'>('name')
  const [error, setError] = useState<string | null>(null)
  // Dialog state (one at a time).
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [renameFrom, setRenameFrom] = useState<string | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<BranchBrowseInfo | null>(null)

  async function reload() {
    try {
      const res = await repositoryApi.branches(ctx.projectId, { search, sort })
      setBranches(res.branches)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load branches')
    }
  }

  useEffect(() => { void reload(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [ctx.projectId, search, sort])

  async function mutate(action: () => Promise<unknown>) {
    try {
      await action()
      await reload()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed')
      return false
    }
  }

  if (error && !branches) return <ErrorState message={error} />
  if (!branches) return <LoadingRows />

  return (
    <section aria-label="Branches" className="ls-rb">
      <header className="ls-rb__head">
        <h2 className="ls-rb__viewtitle">Branches <span className="ls-rb__muted">· {branches.length}</span></h2>
        <div className="ls-rb__actions">
          <div style={{ width: 200 }}>
            <Input label="Search branches" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter…" />
          </div>
          <div style={{ width: 150 }}>
            <Select
              label="Sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as 'name' | 'recent')}
              options={[
                { value: 'name', label: 'By name' },
                { value: 'recent', label: 'Recently updated' },
              ]}
            />
          </div>
          <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>New branch</Button>
          <Button size="sm" variant="secondary" onClick={() => ctx.navigate(`#${ctx.nav.tree(ctx.defaultBranch, '')}`)}>Compare</Button>
        </div>
      </header>

      {error && <div role="alert" className="ls-editor-error">{error}</div>}

      {branches.length === 0 ? (
        <EmptyState icon="branch" title="No branches match" description="Adjust the filter or create a branch." />
      ) : (
        <div className="ls-rb__tablewrap">
          <table className="ls-rb__table ls-rb__table--branches">
            <thead>
              <tr>
                <th scope="col">Branch</th>
                <th scope="col">Last commit</th>
                <th scope="col" className="ls-rb__colmeta">Updated</th>
                <th scope="col" className="ls-rb__colmeta"><span className="ls-visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {branches.map((b) => (
                <tr key={b.name}>
                  <td>
                    <a className="ls-rb__name" href={`#${ctx.nav.tree(b.name, '')}`}>
                      <Icon name="branch" size={13} /> {b.name}
                    </a>
                    {b.default && <Tooltip content="Default branch"><Badge variant="neutral">default</Badge></Tooltip>}
                    {b.protected && <Tooltip content="Protected"><Badge variant="neutral">protected</Badge></Tooltip>}
                  </td>
                  <td className="ls-rb__cellcommit">
                    <a className="ls-rb__tipsha" href={`#${ctx.nav.commit(b.sha)}`}>{b.sha.slice(0, 8)}</a>
                    <span className="ls-rb__muted">{b.title}</span>
                  </td>
                  <td className="ls-rb__colmeta"><span className="ls-rb__muted">{timeAgo(b.committed_at)}</span></td>
                  <td className="ls-rb__colmeta">
                    <div className="ls-rb__rowactions">
                      {!b.default && (
                        <>
                          <Tooltip content="Rename / move">
                            <button type="button" className="ls-iconbtn" aria-label={`Rename ${b.name}`}
                              onClick={() => { setRenameFrom(b.name); setRenameTo(b.name) }}>
                              <Icon name="code" size={14} />
                            </button>
                          </Tooltip>
                          {!b.protected && (
                            <Tooltip content="Delete branch">
                              <button type="button" className="ls-iconbtn" aria-label={`Delete ${b.name}`}
                                onClick={() => setDeleteTarget(b)}>
                                <Icon name="trash" size={14} />
                              </button>
                            </Tooltip>
                          )}
                        </>
                      )}
                      {b.name !== ctx.defaultBranch && (
                        <Tooltip content="Set as default branch">
                          <button type="button" className="ls-iconbtn" aria-label={`Set ${b.name} as default`}
                            onClick={() => void mutate(() => repositoryApi.setDefaultBranch(ctx.projectId, b.name))}>
                            <Icon name="check" size={14} />
                          </button>
                        </Tooltip>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create */}
      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create branch"
        description={`Branches from “${ctx.defaultBranch}” by default.`}
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" data-autofocus disabled={!newName.trim()} onClick={() => {
              void mutate(async () => {
                await repositoryApi.createBranch(ctx.projectId, newName.trim(), ctx.defaultBranch)
                setNewName('')
                setCreateOpen(false)
              })
            }}>Create</Button>
          </>
        }
      >
        <Input label="Branch name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="feature/my-work" />
      </Dialog>

      {/* Rename */}
      <Dialog
        open={renameFrom !== null}
        onClose={() => setRenameFrom(null)}
        title={`Rename ${renameFrom ?? ''}`}
        footer={
          <>
            <Button onClick={() => setRenameFrom(null)}>Cancel</Button>
            <Button variant="primary" data-autofocus disabled={!renameTo.trim() || renameTo === renameFrom} onClick={() => {
              if (!renameFrom) return
              void mutate(async () => {
                await repositoryApi.renameBranch(ctx.projectId, renameFrom, renameTo.trim())
                setRenameFrom(null)
              })
            }}>Rename</Button>
          </>
        }
      >
        <Input label="New name" value={renameTo} onChange={(e) => setRenameTo(e.target.value)} />
      </Dialog>

      {/* Delete confirm */}
      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.name ?? ''}?`}
        description="The branch ref is removed; its commits remain reachable until garbage collection."
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" data-autofocus onClick={() => {
              if (!deleteTarget) return
              void mutate(async () => {
                await repositoryApi.deleteBranch(ctx.projectId, deleteTarget.name, deleteTarget.sha)
                setDeleteTarget(null)
              })
            }}>Delete branch</Button>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 'var(--ls-fs-body)', color: 'var(--ls-text-secondary)' }}>
          Tip <code>{deleteTarget?.sha.slice(0, 10)}</code> — the optimistic guard refuses the delete if the branch moved.
        </p>
      </Dialog>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Tags view
// ---------------------------------------------------------------------------

export function TagsView(ctx: ViewCtx) {
  const [tags, setTags] = useState<TagInfo[] | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [tagName, setTagName] = useState('')
  const [tagRef, setTagRef] = useState('')
  const [tagMessage, setTagMessage] = useState('')
  const [annotated, setAnnotated] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    try {
      setTags((await repositoryApi.tagsList(ctx.projectId)).tags)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load tags')
    }
  }
  useEffect(() => { void reload() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [ctx.projectId])

  if (error && !tags) return <ErrorState message={error} />
  if (!tags) return <LoadingRows />

  return (
    <section aria-label="Tags" className="ls-rb">
      <header className="ls-rb__head">
        <h2 className="ls-rb__viewtitle">Tags <span className="ls-rb__muted">· {tags.length}</span></h2>
        <div className="ls-rb__actions">
          <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>New tag</Button>
        </div>
      </header>
      {error && <div role="alert" className="ls-editor-error">{error}</div>}

      {tags.length === 0 ? (
        <EmptyState icon="tag" title="No tags yet" description="Tag a commit to mark releases." />
      ) : (
        <div className="ls-rb__tablewrap">
          <table className="ls-rb__table">
            <thead>
              <tr>
                <th scope="col">Tag</th>
                <th scope="col">Target</th>
                <th scope="col" className="ls-rb__colmeta"><span className="ls-visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {tags.map((t) => (
                <tr key={t.name}>
                  <td>
                    <a className="ls-rb__name" href={`#${ctx.nav.tree(t.target, '')}`}>
                      <Icon name="tag" size={13} /> {t.name}
                    </a>
                    {t.annotated && <Badge variant="neutral">annotated</Badge>}
                  </td>
                  <td>
                    <a className="ls-rb__tipsha" href={`#${ctx.nav.commit(t.target)}`}>{t.target.slice(0, 8)}</a>
                  </td>
                  <td className="ls-rb__colmeta">
                    <Tooltip content="Delete tag">
                      <button
                        type="button" className="ls-iconbtn" aria-label={`Delete tag ${t.name}`}
                        onClick={() => {
                          void (async () => {
                            try {
                              await repositoryApi.deleteTag(ctx.projectId, t.name)
                              await reload()
                            } catch (e) {
                              setError(e instanceof Error ? e.message : 'Delete failed')
                            }
                          })()
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </Tooltip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create tag"
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" data-autofocus disabled={!tagName.trim() || !tagRef.trim()} onClick={() => {
              void (async () => {
                try {
                  await repositoryApi.createTag(ctx.projectId, tagName.trim(), tagRef.trim(), annotated ? tagMessage : null)
                  setCreateOpen(false)
                  setTagName(''); setTagMessage(''); setTagRef('')
                  await reload()
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Tag creation failed')
                }
              })()
            }}>Create tag</Button>
          </>
        }
      >
        <div className="ds-stack">
          <Input label="Tag name" value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder="v1.0.0" />
          <Input label="Point at (branch, tag or SHA)" value={tagRef} onChange={(e) => setTagRef(e.target.value)} placeholder={ctx.defaultBranch} />
          <label className="ls-checkbox">
            <input type="checkbox" checked={annotated} onChange={(e) => setAnnotated(e.target.checked)} />
            Annotated (with message + tagger)
          </label>
          {annotated && (
            <Input label="Message" value={tagMessage} onChange={(e) => setTagMessage(e.target.value)} placeholder="Release notes…" />
          )}
        </div>
      </Dialog>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Compare view — from…to with commits + file patches
// ---------------------------------------------------------------------------

export function CompareView(ctx: ViewCtx & { initialFrom?: string; initialTo?: string }) {
  const [refOptions, setRefOptions] = useState<string[]>([])
  const [from, setFrom] = useState(ctx.initialFrom ?? ctx.defaultBranch)
  const [to, setTo] = useState(ctx.initialTo ?? ctx.defaultBranch)
  const [result, setResult] = useState<CompareResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Load selectable refs (branches + tags) once.
  useEffect(() => {
    void (async () => {
      try {
        const [b, t] = await Promise.all([
          repositoryApi.branches(ctx.projectId, { limit: 200 }),
          repositoryApi.tagsList(ctx.projectId).catch(() => ({ tags: [] as TagInfo[] })),
        ])
        setRefOptions([
          ...b.branches.map((x) => x.name),
          ...t.tags.map((x) => x.name),
        ].sort())
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load refs')
      }
    })()
  }, [ctx.projectId])

  useEffect(() => {
    if (!from || !to || from === to) { setResult(null); return }
    let alive = true
    setError(null)
    setResult(null)
    repositoryApi.compare(ctx.projectId, from, to, true)
      .then((r) => { if (alive) setResult(r) })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Compare failed') })
    return () => { alive = false }
  }, [ctx.projectId, from, to])

  const options = refOptions.length > 0 ? refOptions : [from, to].filter(Boolean)

  useEffect(() => {
    if (!from || !to || from === to) { setResult(null); return }
    let alive = true
    repositoryApi.compare(ctx.projectId, from, to, true)
      .then((r) => { if (alive) setResult(r) })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Compare failed') })
    return () => { alive = false }
  }, [ctx.projectId, from, to])

  return (
    <section aria-label="Compare refs" className="ls-rb">
      <header className="ls-rb__head">
        <h2 className="ls-rb__viewtitle">Compare</h2>
      </header>
      <div className="ls-cmp__pickers">
        <Select label="Base (from)" value={from} onChange={(e) => setFrom(e.target.value)} options={(options.length ? options : [from]).map((o) => ({ value: o, label: o }))} />
        <Icon name="chevron-right" size={14} />
        <Select label="Compare (to)" value={to} onChange={(e) => setTo(e.target.value)} options={(options.length ? options : [to]).map((o) => ({ value: o, label: o }))} />
      </div>
      {error && <div role="alert" className="ls-editor-error">{error}</div>}

      {from === to && (
        <EmptyState icon="code" title="Pick two different refs" description="Choose a base and a comparison branch or tag." />
      )}

      {result && (
        <>
          <p className="ls-rb__muted">
            {result.commits_ahead_count} commit{result.commits_ahead_count === 1 ? '' : 's'} in <strong>{to}</strong> not in{' '}
            <strong>{from}</strong> · {result.commits_behind_count} behind · merge-base{' '}
            <a className="ls-rb__tipsha" href={`#${ctx.nav.commit(result.merge_base ?? '')}`}>
              {(result.merge_base ?? '').slice(0, 8) || '—'}
            </a>
          </p>

          {result.ahead.length > 0 && (
            <>
              <h3 className="ls-rb__viewtitle">Commits ahead</h3>
              <ol className="ls-rb__log">
                {result.ahead.map((c) => (
                  <li key={c.sha} className="ls-rb__logrow">
                    <div className="ls-rb__logmain">
                      <a className="ls-rb__logtitle" href={`#${ctx.nav.commit(c.sha)}`}>{c.title}</a>
                      <div className="ls-rb__logmeta">
                        <span>{c.author_name} · {timeAgo(c.committed_at)}</span>
                        <a className="ls-rb__tipsha" href={`#${ctx.nav.commit(c.sha)}`}>{c.short_sha}</a>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}

          {result.files.length > 0 && (
            <>
              <h3 className="ls-rb__viewtitle">Changed files <span className="ls-rb__muted">· {result.files.length}</span></h3>
              <ul className="ls-rb__changed">
                {result.files.map((f) => (
                  <li key={`${f.kind}-${f.path}`} className="ls-rb__changedrow">
                    <KindBadge kind={f.kind} />
                    <a className="ls-rb__name" href={f.kind === 'deleted' ? '#' : `#${ctx.nav.blob(to, f.path)}`}>
                      <Icon name="file" size={13} /> {f.path}
                    </a>
                    {f.stats && (
                      <span className="ls-rb__muted">+{f.stats.added} −{f.stats.removed}</span>
                    )}
                  </li>
                ))}
              </ul>
              {result.files.some((f) => f.patch) && (
                <div className="ls-cmp__patches" aria-label="Patches">
                  {result.files.filter((f) => f.patch).map((f) => (
                    <DiffViewer key={f.path} diff={f.patch!} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
