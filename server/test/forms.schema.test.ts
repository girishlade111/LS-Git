import { describe, expect, it } from 'vitest'
import { parseSafeYaml } from '../src/lib/yaml.js'
import {
  validateFormSchema,
  validateAnswers,
  renderIssueBody,
  resolveIssueTitle,
  FIELD_TYPES,
  FORM_LIMITS,
} from '../src/lib/forms.js'

/**
 * LSGit-native form schema validation: required structure, field types,
 * option constraints, validation rules, and malformed-schema rejection.
 */

function schemaOf(yaml: string) {
  return validateFormSchema(parseSafeYaml(yaml))
}

const VALID_MINIMAL = `
name: Bug report
fields:
  - type: text
    id: summary
    attributes:
      label: Summary
    validations:
      required: true
`

describe('form schema — valid documents', () => {
  it('accepts a minimal form', () => {
    const def = schemaOf(VALID_MINIMAL)
    expect(def.name).toBe('Bug report')
    expect(def.fields).toHaveLength(1)
    expect(def.fields[0]!.validations.required).toBe(true)
    expect(def.labels).toEqual([])
    expect(def.title_prefix).toBe('')
  })

  it('exposes every supported field type', () => {
    expect(FIELD_TYPES).toEqual(['text', 'textarea', 'dropdown', 'radio', 'checkbox', 'checkboxes', 'tasklist'])
  })

  it('normalizes a full-featured form (all field types + validations)', () => {
    const def = schemaOf(`
name: Full form
description: Everything enabled
title_prefix: '[triage] '
labels:
  - bug
title_field: summary
fields:
  - type: text
    id: summary
    attributes:
      label: Summary
      placeholder: Login returns 500
      default: Fallback title
    validations:
      required: true
      min_length: 5
      max_length: 80
      pattern: '^[A-Z].*'
      pattern_message: Start with a capital letter
  - type: textarea
    id: details
    attributes:
      label: Details
    validations:
      max_length: 5000
  - type: dropdown
    id: severity
    attributes:
      label: Severity
      multiple: false
      options:
        - low
        - medium
        - high
  - type: radio
    id: frequency
    attributes:
      label: Frequency
      options:
        - always
        - sometimes
  - type: checkbox
    id: consent
    attributes:
      label: Searched duplicates
      default: false
    validations:
      required: true
  - type: checkboxes
    id: environment
    attributes:
      label: Environment
      options:
        - label: On staging
          description: staging.example.com
          required: true
        - label: In production
  - type: tasklist
    id: triage
    attributes:
      label: Triage steps
      options:
        - collect logs
        - check dashboards
`)
    expect(def.title_prefix).toBe('[triage] ')
    expect(def.labels).toEqual(['bug'])
    expect(def.fields.map((f) => f.type)).toEqual([
      'text', 'textarea', 'dropdown', 'radio', 'checkbox', 'checkboxes', 'tasklist',
    ])
    expect(def.fields[5]!.options[0]!.required).toBe(true)
    expect(def.fields[6]!.options.map((o) => o.label)).toEqual(['collect logs', 'check dashboards'])
  })
})

// -- malformed schemas ---------------------------------------------------------

describe('form schema — malformed documents are rejected', () => {
  const invalid = (yaml: string, messagePart?: RegExp | string) => {
    let err: unknown
    try {
      schemaOf(yaml)
    } catch (e) {
      err = e
    }
    // Either a schema error or a YAML error is acceptable rejection.
    const message = (err as Error | undefined)?.message ?? ''
    if (messagePart !== undefined) expect(message).toMatch(messagePart)
    else expect(err).toBeDefined()
    return message
  }

  it('requires a mapping with a name and fields', () => {
    expect(() => schemaOf('description: only\n')).toThrow(/name/)
    expect(() =>
      validateFormSchema(parseSafeYaml('name: X\n')),
    ).toThrow(/fields/)
  })

  it('rejects unknown top-level keys (strict shape)', () => {
    invalid(
      `${VALID_MINIMAL}\nassignee_ids:\n  - 1\n`,
      "Unknown top-level key 'assignee_ids'",
    )
  })

  it('rejects unknown field types', () => {
    invalid(
      'name: X\nfields:\n  - type: color_picker\n    id: c\n    attributes:\n      label: C\n',
      'field type must be one of',
    )
  })

  it('enforces id charset and uniqueness ([a-z0-9_])', () => {
    invalid('name: X\nfields:\n  - type: text\n    id: Bad Id!\n    attributes:\n      label: A\n')
    invalid(
      `name: X
fields:
  - type: text
    id: dup
    attributes:
      label: A
  - type: text
    id: dup
    attributes:
      label: B
`,
      /duplicate field id 'dup'/,
    )
  })

  it('requires labels on every field and rejects unknown attribute keys', () => {
    invalid('name: X\nfields:\n  - type: text\n    id: a\n', 'label')
    invalid(
      'name: X\nfields:\n  - type: text\n    id: a\n    attributes:\n      label: A\n      secret_option: 1\n',
      "Unknown attribute 'secret_option'",
    )
  })

  it('bounds field count and option count (resource abuse)', () => {
    const tooManyFields = Array.from({ length: FORM_LIMITS.maxFields + 1 }, (_, i) =>
      `  - type: text\n    id: f${i}\n    attributes:\n      label: F${i}`,
    ).join('\n')
    invalid(`name: X\nfields:\n${tooManyFields}`, /at most .* fields/)

    const manyOptions = Array.from({ length: FORM_LIMITS.maxOptions + 1 }, (_, i) => `        - opt ${i}`).join('\n')
    invalid(
      `name: X
fields:
  - type: dropdown
    id: d
    attributes:
      label: D
      options:
${manyOptions}
`,
      /at most .* options/,
    )
  })

  it('option-bearing fields require options; plain fields reject them', () => {
    invalid(
      'name: X\nfields:\n  - type: dropdown\n    id: d\n    attributes:\n      label: D\n',
      'requires options',
    )
    invalid(
      'name: X\nfields:\n  - type: text\n    id: t\n    attributes:\n      label: T\n      options: [x]\n'.replace('[x]', '\n        - x'),
      'does not accept options',
    )
  })

  it('per-option required is exclusive to checkboxes fields', () => {
    invalid(
      `name: X
fields:
  - type: tasklist
    id: t
    attributes:
      label: T
      options:
        - label: a
          required: true
`,
      "per-option 'required'",
    )
  })

  it('validates pattern compilability, bounds, and min<=max', () => {
    invalid(
      `name: X
fields:
  - type: text
    id: a
    attributes:
      label: A
    validations:
      pattern: '([unclosed'
`,
      'not a valid regular expression',
    )
    invalid(
      `name: X
fields:
  - type: text
    id: b
    attributes:
      label: B
    validations:
      min_length: 10
      max_length: 5
`,
      /min_length exceeds max_length/,
    )
    invalid(
      `name: X
fields:
  - type: checkbox
    id: c
    attributes:
      label: C
    validations:
      min_length: 3
`,
      'only valid on',
    )
  })

  it('title_field must reference an existing text-like field', () => {
    invalid('name: X\ntitle_field: ghost\nfields:\n  - type: text\n    id: a\n    attributes:\n      label: A\n', 'does not match any field id')
    invalid(
      `name: X
title_field: env
fields:
  - type: text
    id: a
    attributes:
      label: A
  - type: checkboxes
    id: env
    attributes:
      label: Env
      options:
        - x
`,
      'text-like field',
    )
  })
})

// -- answer validation & rendering ---------------------------------------------

describe('form answers — server-side validation', () => {
  const form = schemaOf(`
name: Bug report
title_prefix: '[bug] '
labels:
  - bug
title_field: summary
fields:
  - type: text
    id: summary
    attributes:
      label: Summary
    validations:
      required: true
      pattern: '^[A-Z].*'
  - type: textarea
    id: details
    attributes:
      label: Details
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
  - type: checkbox
    id: consent
    attributes:
      label: Searched duplicates
    validations:
      required: true
  - type: checkboxes
    id: environment
    attributes:
      label: Environment
      options:
        - label: On staging
          required: true
        - label: In production
  - type: tasklist
    id: triage
    attributes:
      label: Triage steps
      options:
        - collect logs
        - check dashboards
`)

  function expectFieldError(answers: Record<string, unknown>, field: string, part?: string): void {
    let err: unknown
    try {
      validateAnswers(form, answers)
    } catch (e) {
      err = e
    }
    expect((err as { extras?: { field?: string } }).extras?.field).toBe(field)
    if (part) expect((err as Error).message).toContain(part)
  }

  it('accepts a complete valid submission', () => {
    const normalized = validateAnswers(form, {
      summary: 'Login crashes',
      details: 'Steps to reproduce…',
      severity: 'high',
      consent: true,
      environment: ['On staging'],
      triage: ['collect logs'],
    })
    expect(normalized.severity).toBe('high')
    expect(normalized.triage).toEqual(['collect logs'])
  })

  it('rejects missing required answers with the field attached', () => {
    expectFieldError({ details: 'x' }, 'summary', 'required')
    expectFieldError({ summary: 'Ok title' }, 'details', 'required')
    expectFieldError({ summary: 'Ok title', details: 'x' }, 'severity', 'required')
  })

  it('rejects UNKNOWN answer ids and wrong value TYPES strictly', () => {
    expectFieldError({ summary: 'Aaa', details: 'd', severity: 'low', consent: true, hacker: 'x' }, 'hacker')
    expectFieldError({ summary: 42, details: 'd' }, 'summary')
    expectFieldError({ summary: 'Aaa', details: 'd', severity: ['low'], consent: true }, 'severity')
    expectFieldError({ summary: 'Aaa', details: 'd', severity: 'low', consent: 'yes' }, 'consent')
  })

  it('enforces option membership for choices', () => {
    expectFieldError({ summary: 'Aaa', details: 'd', severity: 'CATASTROPHIC' }, 'severity', 'not a valid option')
    expectFieldError(
      { summary: 'Aaa', details: 'd', severity: 'low', consent: true, environment: ['Invented'] },
      'environment',
      'not a valid option',
    )
  })

  it('enforces individually-required checkbox options', () => {
    expectFieldError(
      { summary: 'Aaa', details: 'd', severity: 'low', consent: true, environment: ['In production'] },
      'environment',
      "'On staging' must be confirmed",
    )
  })

  it('applies pattern validation with the custom message', () => {
    let err: unknown
    try {
      validateAnswers(form, { summary: 'lowercase start', details: 'd' })
    } catch (e) {
      err = e
    }
    expect((err as Error).message).toBe('Summary has an invalid format')
  })

  it('renders the STRUCTURED body: sections, task markers, provenance footer', () => {
    const answers = validateAnswers(form, {
      summary: 'Login crashes on Safari',
      details: 'Console shows a stack overflow.',
      severity: 'medium',
      consent: true,
      environment: ['On staging', 'In production'],
      triage: ['collect logs'],
    })
    const body = renderIssueBody(form, answers)
    expect(body).toContain('### Summary\n\nLogin crashes on Safari')
    expect(body).toContain('### Severity\n\nmedium')
    expect(body).toContain('- [x] On staging')
    expect(body).toContain('- [x] In production') // chosen
    expect(body).toContain('- [ ] check dashboards') // unchosen tasks stay OPEN
    expect(body).toContain('- [x] collect logs')
    expect(body).toMatch(/_Submitted via form `Bug report`\._/)
  })

  it('resolves titles through prefix → explicit → title_field chain', () => {
    const answers = validateAnswers(form, {
      summary: 'Named by field',
      details: 'x',
      severity: 'low',
      consent: true,
    })
    expect(resolveIssueTitle(form, answers)).toBe('[bug] Named by field')
    expect(resolveIssueTitle(form, answers, 'Explicit wins')).toBe('[bug] Explicit wins')
  })
})
