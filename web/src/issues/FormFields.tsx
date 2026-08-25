import { useId } from 'react'
import type { FormField, FormOption } from './api'

/**
 * Dynamic renderer for LSGit issue-form fields.
 *
 * Client-side validation MIRRORS the server (required / choices / lengths) for
 * fast feedback; the server re-validates authoritatively on submission.
 * Styling contract: dense token-driven rows (#161616 panels, #2a2a2a borders,
 * #e07856 accent focus), border-driven sections, no shadows or gradients.
 */

export interface AnswersState {
  values: Record<string, unknown>
  errors: Record<string, string | null>
}

/** Mirrors the server's validation rules for instant feedback. */
export function validateAnswersClient(
  fields: FormField[],
  values: Record<string, unknown>,
): Record<string, string | null> {
  const errors: Record<string, string | null> = {}
  for (const f of fields) {
    const v = values[f.id] ?? f.default_value ?? undefined
    switch (f.type) {
      case 'text':
      case 'textarea': {
        const s = typeof v === 'string' ? v.trim() : ''
        if (!s && f.validations.required) errors[f.id] = `${f.label} is required`
        break
      }
      case 'dropdown':
      case 'radio': {
        if (f.multiple && f.type === 'dropdown') {
          const list = Array.isArray(v) ? v : []
          if (f.validations.required && list.length === 0) errors[f.id] = `${f.label} is required`
        } else if ((v === undefined || v === null || v === '') && f.validations.required) {
          errors[f.id] = `${f.label} is required`
        }
        break
      }
      case 'checkbox': {
        if (v !== true && f.validations.required) errors[f.id] = `${f.label} must be accepted`
        break
      }
      case 'checkboxes':
      case 'tasklist': {
        const chosen = Array.isArray(v) ? v : []
        const missingRequired = f.options.filter((o) => o.required && !chosen.includes(o.label))
        if (missingRequired.length > 0) {
          errors[f.id] = `'${missingRequired[0]!.label}' must be confirmed`
        } else if (f.validations.required && chosen.length === 0 && f.type === 'checkboxes') {
          errors[f.id] = `${f.label} is required`
        }
        break
      }
    }
    if (typeof v === 'string' && f.validations.max_length !== null && v.length > f.validations.max_length) {
      errors[f.id] = `${f.label} must be at most ${f.validations.max_length} characters`
    }
    if (errors[f.id] === undefined) errors[f.id] = null
  }
  return errors
}

export function FormFields({
  fields,
  state,
  onChange,
}: {
  fields: FormField[]
  state: AnswersState
  onChange: (id: string, value: unknown) => void
}) {
  return (
    <div className="ls-formfields">
      {fields.map((field) => (
        <FieldRow key={field.id} field={field} state={state} onChange={onChange} />
      ))}
    </div>
  )
}

function FieldRow({
  field,
  state,
  onChange,
}: {
  field: FormField
  state: AnswersState
  onChange: (id: string, value: unknown) => void
}) {
  const uid = useId()
  const value = state.values[field.id]
  const error = state.errors[field.id]

  return (
    <section className={`ls-formfield${error ? ' ls-formfield--invalid' : ''}`} aria-labelledby={`${uid}-label`}>
      <header className="ls-formfield__head">
        <span id={`${uid}-label`} className="ls-formfield__label">
          {field.label}
          {field.validations.required && (
            <span className="ls-formfield__req" aria-label="required">*</span>
          )}
        </span>
        {field.description && <p className="ls-formfield__desc">{field.description}</p>}
      </header>

      <div className="ls-formfield__control">
        {field.type === 'text' && (
          <input
            id={uid}
            className="ls-input"
            type="text"
            aria-label={field.label}
            placeholder={field.placeholder || undefined}
            value={typeof value === 'string' ? value : ''}
            aria-invalid={!!error || undefined}
            onChange={(e) => onChange(field.id, e.target.value)}
          />
        )}
        {field.type === 'textarea' && (
          <textarea
            id={uid}
            className="ls-input ls-textarea-dense"
            rows={5}
            aria-label={field.label}
            placeholder={field.placeholder || undefined}
            value={typeof value === 'string' ? value : ''}
            aria-invalid={!!error || undefined}
            onChange={(e) => onChange(field.id, e.target.value)}
          />
        )}

        {field.type === 'dropdown' && !field.multiple && (
          <select
            id={uid}
            className="ls-select"
            aria-label={field.label}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(field.id, e.target.value || undefined)}
          >
            <option value="">Select…</option>
            {field.options.map((o) => <option key={o.label} value={o.label}>{o.label}</option>)}
          </select>
        )}
        {field.type === 'dropdown' && field.multiple && (
          <ChoiceGroup
            id={uid}
            options={field.options}
            selected={Array.isArray(value) ? value : []}
            multi
            onToggle={(label) => {
              const cur = Array.isArray(value) ? value : []
              onChange(field.id, toggleIn(cur, label))
            }}
          />
        )}

        {field.type === 'radio' && (
          <ChoiceGroup
            id={uid}
            name={`${uid}-radio`}
            options={field.options}
            selected={typeof value === 'string' ? [value] : []}
            onToggle={(label) => onChange(field.id, label)}
          />
        )}

        {field.type === 'checkbox' && (
          <label className="ls-checkline">
            <input
              id={uid}
              type="checkbox"
              checked={value === true}
              onChange={(e) => onChange(field.id, e.target.checked)}
            />
            <span>{field.label}</span>
          </label>
        )}

        {(field.type === 'checkboxes' || field.type === 'tasklist') && (
          <ChoiceGroup
            id={uid}
            options={field.options}
            selected={Array.isArray(value) ? value : []}
            multi={field.type === 'checkboxes'}
            taskStyle={field.type === 'tasklist'}
            onToggle={(label) => {
              const cur = Array.isArray(value) ? value : []
              onChange(field.id, toggleIn(cur, label))
            }}
          />
        )}
      </div>

      {error && <p className="ls-formfield__error" role="alert">{error}</p>}
    </section>
  )
}

function toggleIn(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item]
}

function ChoiceGroup({
  id,
  name,
  options,
  selected,
  multi = false,
  taskStyle = false,
  onToggle,
}: {
  id: string
  name?: string
  options: FormOption[]
  selected: string[]
  multi?: boolean
  taskStyle?: boolean
  onToggle: (label: string) => void
}) {
  return (
    <ul className={`ls-choices${taskStyle ? ' ls-choices--tasks' : ''}`}>
      {options.map((o, idx) => {
        const inputId = `${id}-${idx}`
        const checked = selected.includes(o.label)
        return (
          <li key={o.label}>
            <label className="ls-checkline" title={o.description || undefined}>
              <input
                id={inputId}
                type="checkbox"
                name={name}
                checked={checked}
                onChange={() => onToggle(o.label)}
                aria-required={multi && o.required ? true : undefined}
              />
              {/* Task-style options read like markdown checklist rows. */}
              <span>{taskStyle && checked ? '✓ ' : ''}{o.label}</span>
              {o.required && <em className="ls-formfield__req" aria-label="must be confirmed">*</em>}
            </label>
          </li>
        )
      })}
    </ul>
  )
}
