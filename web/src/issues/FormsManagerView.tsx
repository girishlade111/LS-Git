import { useEffect, useState } from 'react'
import { Badge } from '../design-system/Badge'
import { Button } from '../design-system/Button'
import { Dialog } from '../design-system/Dialog'
import { EmptyState } from '../design-system/EmptyState'
import { IconButton } from '../design-system/IconButton'
import { Input } from '../design-system/Input'
import { Textarea } from '../design-system/Textarea'
import { Tooltip } from '../design-system/Tooltip'
import { issuesApi, type FormListEntry } from './api'

const TEMPLATE_SKELETON = `name: Bug report
description: Report a reproducible problem
title_prefix: '[bug] '
title_field: summary
labels:
  - bug
fields:
  - type: text
    id: summary
    attributes:
      label: Summary
      placeholder: Login returns 500
    validations:
      required: true
  - type: textarea
    id: details
    attributes:
      label: Details
      description: What happened, and what did you expect?
    validations:
      required: true
  - type: dropdown
    id: severity
    attributes:
      label: Severity
      options:
        - low
        - medium
        - high
    validations:
      required: true
`

/**
 * Issue-form manager (maintainer gate on the server). Templates are YAML in
 * the repository (.lsgit/issues/forms/*.yml); saving commits a versioned file
 * so forms inherit history/review. The editor is a plain YAML surface — the
 * server parses with the safe-subset parser and validates BEFORE committing.
 */
export function FormsManagerView({ projectId }: { projectId: number }) {
  const [forms, setForms] = useState<FormListEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editName, setEditName] = useState('') // '' = create new
  const [yamlText, setYamlText] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<FormListEntry | null>(null)

  async function reload() {
    try {
      setForms((await issuesApi.listForms(projectId)).forms)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load forms')
    }
  }
  useEffect(() => { void reload() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [projectId])

  async function mutate(fn: () => Promise<unknown>) {
    try {
      await fn()
      await reload()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed')
      return false
    }
  }

  if (!forms) return <div className="ls-rb__loading" role="status">Loading issue forms…</div>

  return (
    <section aria-label="Issue forms" className="ls-rb ls-issues">
      <header className="ls-rb__head">
        <h2 className="ls-rb__viewtitle">
          Issue forms <span className="ls-rb__muted">· {forms.length}</span>
        </h2>
        <div className="ls-rb__actions">
          <Button size="sm" variant="primary" iconStart="plus" onClick={() => {
            setEditName('')
            setYamlText(TEMPLATE_SKELETON)
            setEditOpen(true)
          }}>
            New form
          </Button>
        </div>
      </header>

      <p className="ls-page-desc">
        Templates are stored as YAML at <code>.lsgit/issues/forms/&lt;name&gt;.yml</code> in the default branch —
        every save creates a normal commit, so forms are versioned and reviewable like code.
      </p>

      {error && <div role="alert" className="ls-editor-error">{error}</div>}

      {forms.length === 0 ? (
        <EmptyState icon="issue" title="No issue forms yet" description="Structured templates guide reporters through fielded submissions." />
      ) : (
        <ul className="ls-labels__list">
          {forms.map((f) => (
            <li key={f.name} className="ls-labels__row">
              <strong>{f.title}</strong>
              <code className="ls-labels__hex">{f.name}.yml</code>
              {f.valid ? (
                <Badge variant="success">valid</Badge>
              ) : (
                <Tooltip content={f.error ?? 'invalid'}>
                  <Badge variant="danger">invalid</Badge>
                </Tooltip>
              )}
              <span className="ls-rb__muted">
                {f.valid ? `${f.field_count} field${f.field_count === 1 ? '' : 's'}` : f.error}
              </span>
              <span className="ls-rb__muted">{f.description}</span>
              <span className="ls-labels__actions">
                <Tooltip content="Edit YAML source">
                  <IconButton label={`Edit ${f.title}`} icon="code" onClick={() => void openForEdit(f)} />
                </Tooltip>
                <Tooltip content="Delete form">
                  <IconButton label={`Delete ${f.title}`} icon="trash" onClick={() => setDeleteTarget(f)} />
                </Tooltip>
              </span>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={editName ? `Edit ${editName}.yml` : 'New issue form'}
        description="LSGit-native schema. Tags, anchors/aliases, flow collections and block scalars are rejected; the template is validated before it is committed."
        footer={
          <>
            <Button onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button variant="primary" data-autofocus disabled={!yamlText.trim() || (!editName && !nameFromYaml(yamlText))} onClick={() => void submitSave()}>
              Save to repository
            </Button>
          </>
        }
      >
        <div className="ds-stack">
          {!editName && (
            <Input
              label="File name (becomes .lsgit/issues/forms/<name>.yml)"
              value={editName}
              onChange={(e) => setEditName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))}
              placeholder="bug_report"
            />
          )}
          <Textarea
            label="Template YAML"
            value={yamlText}
            onChange={(e) => setYamlText(e.target.value)}
            hint="Field types: text · textarea · dropdown · radio · checkbox · checkboxes · tasklist"
          />
        </div>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={`Delete “${deleteTarget?.title ?? ''}”?`}
        description="The template file is removed from the repository via a deletion commit."
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" data-autofocus onClick={() => {
              const name = deleteTarget?.name
              setDeleteTarget(null)
              if (name) void mutate(() => issuesApi.deleteForm(projectId, name))
            }}>Delete form</Button>
          </>
        }
      >
        <span />
      </Dialog>
    </section>
  )

  async function openForEdit(f: FormListEntry) {
    try {
      const { form } = await issuesApi.getForm(projectId, f.name)
      // Round-trip the DEFINITION back to canonical-ish YAML for editing.
      setYamlText(renderFormAsYaml(form))
      setEditName(f.name)
      setEditOpen(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load form')
    }
  }

  async function submitSave() {
    const name = editName || nameFromYaml(yamlText) || ''
    await mutate(() => issuesApi.saveForm(projectId, name, yamlText))
    setEditOpen(false)
  }
}

function nameFromYaml(text: string): string | null {
  const m = /^\s*name:\s*(.+)\s*$/.exec(text)
  const raw = m?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? ''
  return raw ? slugify(raw) : null
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || ''
}

/** Serializes a parsed definition back into the safe-YAML subset for editing. */
function renderFormAsYaml(form: import('./api').IssueForm): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`
  const lines: string[] = []
  lines.push(`name: ${q(form.name)}`)
  if (form.description) lines.push(`description: ${q(form.description)}`)
  if (form.title_prefix) lines.push(`title_prefix: ${q(form.title_prefix)}`)
  if (form.labels.length > 0) lines.push('labels:', ...form.labels.map((l) => `  - ${q(l)}`))
  lines.push('fields:')
  for (const f of form.fields) {
    lines.push(`  - type: ${f.type}`, `    id: ${f.id}`, '    attributes:', `      label: ${q(f.label)}`)
    if (f.description) lines.push(`      description: ${q(f.description)}`)
    if (f.placeholder) lines.push(`      placeholder: ${q(f.placeholder)}`)
    if (f.type === 'dropdown') lines.push(`      multiple: ${f.multiple}`)
    if (f.options.length > 0) {
      lines.push('      options:')
      for (const o of f.options) {
        if (o.required || o.description) {
          lines.push(`        - label: ${q(o.label)}`)
          if (o.description) lines.push(`          description: ${q(o.description)}`)
          if (o.required) lines.push('          required: true')
        } else {
          lines.push(`        - ${q(o.label)}`)
        }
      }
    }
    const v = f.validations
    if (v.required || v.min_length !== null || v.max_length !== null || v.pattern_message !== null) {
      lines.push('    validations:')
      if (v.required) lines.push('      required: true')
      if (v.min_length !== null) lines.push(`      min_length: ${v.min_length}`)
      if (v.max_length !== null) lines.push(`      max_length: ${v.max_length}`)
      if (v.pattern_message !== null) lines.push(`      pattern_message: ${q(v.pattern_message)}`)
    }
  }
  return lines.join('\n')
}
