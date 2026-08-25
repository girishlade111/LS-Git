import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../design-system/Button'
import { Dialog } from '../design-system/Dialog'
import { EmptyState } from '../design-system/EmptyState'
import { Icon } from '../design-system/Icon'
import { Input } from '../design-system/Input'
import { Pagination } from '../design-system/Pagination'
import { Select } from '../design-system/Select'
import { Textarea } from '../design-system/Textarea'
import {
  issuesApi,
  type Issue,
  type IssueFilters,
  type IssueListResult,
  type IssueForm,
  type FormListEntry,
  type LabelFull,
  type MilestoneFull,
} from './api'
import { LabelChip } from './LabelChip'
import { FormFields, validateAnswersClient, type AnswersState } from './FormFields'
import { timeAgo } from '../repository/widgets'

/** Issues list: state tabs · search · filters (label/milestone/assignee) · sort · pages. */
export function IssuesListPage({
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
  const [result, setResult] = useState<IssueListResult | null>(null)
  const [labels, setLabels] = useState<LabelFull[]>([])
  const [milestones, setMilestones] = useState<MilestoneFull[]>([])
  const [error, setError] = useState<string | null>(null)

  const [filters, setFilters] = useState<IssueFilters>({ state: 'opened', order_by: 'updated_at', sort: 'desc' })

  // New-issue dialog state — blank issue OR form-driven creation.
  const [createOpen, setCreateOpen] = useState(false)
  const [mode, setMode] = useState<'blank' | 'form'>('blank')
  const [forms, setForms] = useState<FormListEntry[]>([])
  const [selectedForm, setSelectedForm] = useState('')
  const [formDef, setFormDef] = useState<IssueForm | null>(null)
  const [answers, setAnswers] = useState<AnswersState>({ values: {}, errors: {} })
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')

  useEffect(() => {
    void issuesApi.listForms(projectId).then((r) => setForms(r.forms.filter((f) => f.valid))).catch(() => setForms([]))
  }, [projectId])

  async function pickForm(name: string) {
    setSelectedForm(name)
    setFormDef(null)
    setAnswers({ values: {}, errors: {} })
    if (!name) return
    try {
      setFormDef((await issuesApi.getForm(projectId, name)).form)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load form')
    }
  }

  function updateAnswer(id: string, value: unknown) {
    setAnswers((s) => ({ ...s, values: { ...s.values, [id]: value } }))
  }

  const load = useCallback(async () => {
    try {
      setResult(await issuesApi.list(projectId, filters))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load issues')
    }
  }, [projectId, filters])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    void issuesApi.labels(projectId).then(setLabels).catch(() => setLabels([]))
    void issuesApi.milestones(projectId).then(setMilestones).catch(() => setMilestones([]))
  }, [projectId])

  function patchFilters(p: Partial<IssueFilters>) {
    setFilters((f) => ({ ...f, page: undefined, ...p }))
  }

  async function createIssue() {
    try {
      if (mode === 'form' && formDef) {
        const errors = validateAnswersClient(formDef.fields, answers.values)
        if (Object.values(errors).some(Boolean)) {
          setAnswers((s) => ({ ...s, errors }))
          return
        }
        const { issue } = await issuesApi.submitForm(projectId, selectedForm, { answers: answers.values })
        resetCreateDialog()
        navigate(`#${issue.web_path}`)
        return
      }
      const issue = await issuesApi.create(projectId, { title: newTitle.trim(), description: newDescription })
      resetCreateDialog()
      navigate(`#${issue.web_path}`)
    } catch (e) {
      // Server-side validation errors surface per-field when possible.
      setError(e instanceof Error ? e.message : 'Failed to create issue')
    }
  }

  function resetCreateDialog() {
    setCreateOpen(false)
    setSelectedForm('')
    setFormDef(null)
    setAnswers({ values: {}, errors: {} })
    setNewTitle(''); setNewDescription('')
  }

  const canSubmitForm = useMemo(() => {
    if (!formDef) return false
    return !Object.values(validateAnswersClient(formDef.fields, answers.values)).some(Boolean)
  }, [formDef, answers])

  const base = `/proj/${encodeURIComponent(owner)}/${encodeURIComponent(projectPath)}`
  const openCount = result?.pagination.total ?? 0

  return (
    <section aria-label="Issues" className="ls-rb ls-issues">
      <header className="ls-rb__head">
        <nav className="ls-issues__tabs" aria-label="Issue state">
          {(['opened', 'closed'] as const).map((st) => (
            <button
              key={st}
              type="button"
              className={`ls-issues__tab${(filters.state ?? 'opened') === st ? ' ls-issues__tab--current' : ''}`}
              aria-current={(filters.state ?? 'opened') === st ? 'page' : undefined}
              onClick={() => patchFilters({ state: st })}
            >
              <Icon name={st === 'opened' ? 'issue' : 'check'} size={13} />
              {st === 'opened' ? 'Open' : 'Closed'}
            </button>
          ))}
        </nav>
        <div className="ls-rb__actions">
          <Button size="sm" variant="secondary" onClick={() => navigate(`#${base}/pulls`)}>Pull requests</Button>
          <Button size="sm" variant="secondary" onClick={() => navigate(`#${base}/labels`)}>Manage labels</Button>
          <Button size="sm" variant="secondary" onClick={() => navigate(`#${base}/milestones`)}>Milestones</Button>
          <Button size="sm" variant="secondary" onClick={() => navigate(`#${base}/issue_forms`)}>Manage forms</Button>
          <Button size="sm" variant="primary" iconStart="plus" onClick={() => setCreateOpen(true)}>New issue</Button>
        </div>
      </header>

      <div className="ls-issues__filters">
        <div style={{ flex: 1, minWidth: 180 }}>
          <Input
            label="Search issues"
            placeholder="Search titles and descriptions…"
            value={filters.search ?? ''}
            onChange={(e) => patchFilters({ search: e.target.value || undefined })}
          />
        </div>
        <div style={{ width: 160 }}>
          <Select
            label="Label"
            value={filters.labels ?? ''}
            onChange={(e) => patchFilters({ labels: e.target.value || undefined })}
            options={[{ value: '', label: 'Any label' }, ...labels.map((l) => ({ value: l.title, label: l.title }))]}
          />
        </div>
        <div style={{ width: 160 }}>
          <Select
            label="Milestone"
            value={filters.milestone ?? ''}
            onChange={(e) => patchFilters({ milestone: e.target.value || undefined })}
            options={[
              { value: '', label: 'Any milestone' },
              { value: 'none', label: 'No milestone' },
              { value: 'any', label: 'Has milestone' },
              ...milestones.map((m) => ({ value: m.title, label: m.title })),
            ]}
          />
        </div>
        <div style={{ width: 150 }}>
          <Select
            label="Sort"
            value={`${filters.order_by ?? 'updated_at'}-${filters.sort ?? 'desc'}`}
            onChange={(e) => {
              const [ob, dir] = e.target.value.split('-')
              patchFilters({ order_by: ob as 'created_at' | 'updated_at', sort: dir as 'asc' | 'desc' })
            }}
            options={[
              { value: 'updated_at-desc', label: 'Recently updated' },
              { value: 'updated_at-asc', label: 'Oldest updated' },
              { value: 'created_at-desc', label: 'Newest' },
              { value: 'created_at-asc', label: 'Oldest' },
            ]}
          />
        </div>
      </div>

      {error && <div role="alert" className="ls-editor-error">{error}</div>}

      {!result ? (
        <div role="status" className="ls-rb__loading">Loading issues…</div>
      ) : result.issues.length === 0 ? (
        <EmptyState
          icon="issue"
          title={filters.search || filters.labels || filters.milestone ? 'No matching issues' : 'No issues yet'}
          description={
            filters.search || filters.labels || filters.milestone
              ? 'Adjust or clear the filters.'
              : 'Track work by creating the first issue.'
          }
        />
      ) : (
        <>
          <ul className="ls-issues__list">
            {result.issues.map((issue) => (
              <IssueRow key={issue.id} issue={issue} base={base} />
            ))}
          </ul>
          <footer className="ls-issues__foot">
            <span className="ls-rb__muted">
              {openCount} issue{openCount === 1 ? '' : 's'}
            </span>
            <Pagination
              page={result.pagination.page}
              pageCount={Math.max(1, result.pagination.total_pages)}
              onChange={(p) => patchFilters({ page: p })}
            />
          </footer>
        </>
      )}

      <Dialog
        open={createOpen}
        onClose={resetCreateDialog}
        title="New issue"
        footer={
          <>
            <Button onClick={resetCreateDialog}>Cancel</Button>
            {mode === 'blank' ? (
              <Button variant="primary" data-autofocus disabled={!newTitle.trim()} onClick={() => void createIssue()}>
                Create issue
              </Button>
            ) : (
              <Button variant="primary" data-autofocus disabled={!formDef || !canSubmitForm} onClick={() => void createIssue()}>
                Submit form
              </Button>
            )}
          </>
        }
      >
        <div className="ds-stack">
          {/* Creation mode: blank markdown issue OR structured form. */}
          <div className="ls-createmode" role="radiogroup" aria-label="Creation mode">
            <button
              type="button"
              className={`ls-createmode__opt${mode === 'blank' ? ' ls-createmode__opt--current' : ''}`}
              aria-checked={mode === 'blank'}
              role="radio"
              onClick={() => setMode('blank')}
            >
              Blank issue
            </button>
            <button
              type="button"
              className={`ls-createmode__opt${mode === 'form' ? ' ls-createmode__opt--current' : ''}`}
              aria-checked={mode === 'form'}
              role="radio"
              disabled={forms.length === 0}
              onClick={() => setMode('form')}
            >
              Use a form{forms.length > 0 ? ` (${forms.length})` : ''}
            </button>
          </div>

          {mode === 'blank' && (
            <>
              <Input label="Title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Something is broken…" />
              <Textarea
                label="Description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder={'Markdown supported. Mention people with @username.\nTask lists: - [ ] step'}
              />
            </>
          )}

          {mode === 'form' && (
            <>
              <Select
                label="Form"
                value={selectedForm}
                onChange={(e) => void pickForm(e.target.value)}
                options={[
                  { value: '', label: 'Choose a form…' },
                  ...forms.map((f) => ({ value: f.name, label: f.title })),
                ]}
              />
              {selectedForm && !formDef && (
                <p className="ls-rb__muted" role="status">Loading form…</p>
              )}
              {formDef && (
                <>
                  {formDef.description && <p className="ls-formintro">{formDef.description}</p>}
                  {formDef.title_prefix && (
                    <Input
                      label={`Title (prefixed automatically with “${formDef.title_prefix}”)`}
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                    />
                  )}
                  <FormFields
                    fields={formDef.fields}
                    state={answers}
                    onChange={updateAnswer}
                  />
                </>
              )}
            </>
          )}
        </div>
      </Dialog>
    </section>
  )
}

function IssueRow({ issue, base }: { issue: Issue; base: string }) {
  return (
    <li className="ls-issues__row">
      <span
        className={`ls-issues__state ls-issues__state--${issue.state}`}
        aria-label={`Issue ${issue.state}`}
      >
        {issue.state === 'opened' ? <Icon name="issue" size={14} /> : <Icon name="check" size={14} />}
      </span>
      <div className="ls-issues__main">
        <a
          className="ls-issues__title"
          href={`#${base}/issues/${issue.iid}`}
          data-testid="issue-title-link"
        >
          {issue.confidential && <span className="ls-issues__conf" title="Confidential">⚠</span>}
          {issue.title}
          {issue.has_tasks && (
            <span className="ls-rb__muted ls-issues__tasks" aria-label={`Tasks ${issue.task_progress.completed} of ${issue.task_progress.total} complete`}>
              {issue.task_progress.completed}/{issue.task_progress.total}
            </span>
          )}
        </a>
        <div className="ls-issues__meta">
          {issue.iid} opened {timeAgo(issue.created_at)} by {issue.author?.username ?? 'unknown'}
          {issue.milestone && <span className="ls-issues__ms">· {issue.milestone.title}</span>}
          {issue.assignees.filter(Boolean).length > 0 && (
            <span className="ls-issues__assignees">
              {issue.assignees.map((a) => a?.username[0]?.toUpperCase()).join('')}
            </span>
          )}
        </div>
        {issue.labels.length > 0 && (
          <div className="ls-issues__labels">
            {issue.labels.map((l) => <LabelChip key={l.id} label={l} />)}
          </div>
        )}
      </div>
    </li>
  )
}
