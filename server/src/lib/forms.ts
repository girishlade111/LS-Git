import { AppError } from '../services/identity.js'

/**
 * LSGit-native Issue Form schema (independent design, documented GitLab
 * compatibility mapping below).
 *
 * SCHEMA DECISION (see API.md §3.9): LSGit-native schema with a documented
 * mapping from GitLab-style templates. Alternatives considered:
 *   1. GitLab-schema-compatible subset — rejected: couples our storage format
 *      to an external product contract that we only partially implement.
 *   2. JSON Schema + arbitrary YAML — rejected: over-general for issue forms,
 *      larger attack/validation surface for zero product gain.
 *
 * GitLab → LSGit mapping:
 *   .gitlab/issue_templates/*.md        → .lsgit/issues/forms/<name>.yml
 *   `body:` list of widgets             → `fields:` list
 *   widget type `input`                 → type `text`
 *   widget type `textarea`              → type `textarea`
 *   widget type `dropdown`              → type `dropdown` (+ attributes.multiple)
 *   widget type `checkboxes`            → type `checkboxes` or `tasklist`
 *   widget validations.required         → validations.required
 *   (GitLab has no radio/checkbox/tasklist primitives; those are LSGit-native.)
 *
 * SECURITY MODEL
 * --------------
 * Templates are DATA. The YAML layer never evaluates anything (lib/yaml.ts);
 * this layer additionally bounds structure (field/option counts), sizes and
 * regex complexity so a hostile template cannot exhaust server resources.
 */

// -- limits -----------------------------------------------------------------

export const FORM_LIMITS = {
  maxTemplateBytes: 32 * 1024,
  maxFields: 25,
  maxOptions: 30,
  maxLabelLength: 100,
  maxDescriptionLength: 500,
  maxPlaceholderLength: 200,
  maxValueLength: 10_000,
  maxTitlePrefixLength: 60,
  maxPatternLength: 200,
  maxNameLength: 40,
} as const

export const FIELD_TYPES = [
  'text', 'textarea', 'dropdown', 'radio',
  'checkbox', 'checkboxes', 'tasklist',
] as const
export type FieldType = (typeof FIELD_TYPES)[number]

const OPTION_TYPES: FieldType[] = ['dropdown', 'radio', 'checkboxes', 'tasklist']
const VALUE_TYPES: FieldType[] = ['text', 'textarea', 'dropdown', 'radio']

export interface FormValidations {
  required: boolean
  min_length: number | null
  max_length: number | null
  pattern: RegExp | null
  pattern_message: string | null
}

export interface FormOption {
  label: string
  description: string
  required: boolean // checkboxes options only (GitLab parity)
}

export interface FormFieldDef {
  type: FieldType
  id: string
  label: string
  description: string
  placeholder: string
  multiple: boolean // dropdown only
  default_value: string | boolean | null
  options: FormOption[]
  validations: FormValidations
}

export interface IssueFormDef {
  name: string
  description: string
  title_prefix: string
  title_field: string | null
  labels: string[]
  fields: FormFieldDef[]
}

export class FormSchemaError extends AppError {
  constructor(message: string) {
    super(400, message, 'form_schema_invalid')
  }
}

function fail(message: string): never {
  throw new FormSchemaError(message)
}

const ID_PATTERN = /^[a-z0-9_]+$/

// -- schema validation --------------------------------------------------------

/** Validates and normalizes a parsed YAML document into an IssueFormDef. */
export function validateFormSchema(doc: unknown): IssueFormDef {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    fail('Form template must be a YAML mapping')
  }
  const root = doc as Record<string, unknown>
  assertOnlyKeys(root, ['name', 'description', 'title_prefix', 'title_field', 'labels', 'fields'])

  const name = requireString(root.name, 'name', 1, 80)

  const description = optionalString(root.description, 'description', FORM_LIMITS.maxDescriptionLength)
  const title_prefix = optionalString(root.title_prefix, 'title_prefix', FORM_LIMITS.maxTitlePrefixLength)
  const labels = parseLabels(root.labels)
  const fields = parseFields(root.fields)

  let title_field: string | null = null
  if (root.title_field !== undefined && root.title_field !== null) {
    if (typeof root.title_field !== 'string' || !ID_PATTERN.test(root.title_field)) {
      fail('title_field must reference a field id ([a-z0-9_])')
    }
    const target = fields.find((f) => f.id === root.title_field)
    if (!target) fail(`title_field '${root.title_field}' does not match any field id`)
    if (!VALUE_TYPES.includes(target.type)) fail('title_field must point at a text-like field')
    title_field = root.title_field
  }

  return { name, description, title_prefix, title_field, labels, fields }
}

function assertOnlyKeys(obj: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`Unknown top-level key '${key}'`)
  }
}

function requireString(v: unknown, what: string, min: number, max: number): string {
  if (typeof v !== 'string') fail(`'${what}' must be a string`)
  const s = v.trim()
  if (s.length < min) fail(`'${what}' must be at least ${min} character(s)`)
  if (s.length > max) fail(`'${what}' exceeds ${max} characters`)
  return s
}

function optionalString(v: unknown, what: string, max: number): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') fail(`'${what}' must be a string`)
  if (v.length > max) fail(`'${what}' exceeds ${max} characters`)
  return v.trim()
}

function parseLabels(v: unknown): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) fail('labels must be a list of existing label titles')
  if (v.length > FORM_LIMITS.maxOptions) fail(`labels may contain at most ${FORM_LIMITS.maxOptions} entries`)
  return v.map((l) => {
    if (typeof l !== 'string' || l.trim() === '' || l.length > 64) {
      fail('each label must be a non-empty string of at most 64 characters')
    }
    return l.trim()
  })
}

function parseFields(v: unknown): FormFieldDef[] {
  if (v === undefined || v === null) fail('fields is required')
  if (!Array.isArray(v)) fail('fields must be a list')
  if (v.length === 0) fail('at least one field is required')
  if (v.length > FORM_LIMITS.maxFields) {
    fail(`a form may declare at most ${FORM_LIMITS.maxFields} fields`)
  }
  const ids = new Set<string>()
  return v.map((raw) => parseField(raw, ids))
}

function parseField(raw: unknown, ids: Set<string>): FormFieldDef {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('every field must be a mapping')
  }
  const field = raw as Record<string, unknown>
  assertOnlyKeys(field, ['type', 'id', 'attributes', 'validations'])

  const type = field.type
  if (typeof type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(type)) {
    fail(`field type must be one of ${FIELD_TYPES.join(', ')}`)
  }
  const fieldType = type as FieldType

  if (typeof field.id !== 'string' || !ID_PATTERN.test(field.id)) {
    fail('field id must match [a-z0-9_] and cannot be empty')
  }
  if (ids.has(field.id)) fail(`duplicate field id '${field.id}'`)
  ids.add(field.id)

  const attrs = field.attributes ?? {}
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) {
    fail('attributes must be a mapping')
  }
  const a = attrs as Record<string, unknown>

  const optionAllowed = ['label', 'description', 'placeholder', 'options', 'multiple', 'default'] as const
  for (const key of Object.keys(a)) {
    if (!(optionAllowed as readonly string[]).includes(key)) fail(`Unknown attribute '${key}' in field '${field.id}'`)
  }

  const label = requireString(a.label, `label of field '${field.id}'`, 1, FORM_LIMITS.maxLabelLength)
  const description = optionalString(a.description, `description of field '${field.id}'`, FORM_LIMITS.maxDescriptionLength)
  const placeholder = optionalString(a.placeholder, `placeholder of field '${field.id}'`, FORM_LIMITS.maxPlaceholderLength)

  const options: FormOption[] = []
  if (a.options !== undefined && a.options !== null) {
    if (!OPTION_TYPES.includes(fieldType)) {
      fail(`field '${field.id}' (${fieldType}) does not accept options`)
    }
    if (!Array.isArray(a.options)) fail(`options of field '${field.id}' must be a list`)
    if (a.options.length === 0) fail(`options of field '${field.id}' cannot be empty`)
    if (a.options.length > FORM_LIMITS.maxOptions) {
      fail(`field '${field.id}' may declare at most ${FORM_LIMITS.maxOptions} options`)
    }
    const seen = new Set<string>()
    for (const rawOpt of a.options) {
      let opt: FormOption
      if (typeof rawOpt === 'string') {
        opt = { label: rawOpt.trim(), description: '', required: false }
      } else if (rawOpt !== null && typeof rawOpt === 'object' && !Array.isArray(rawOpt)) {
        const o = rawOpt as Record<string, unknown>
        const keys = Object.keys(o)
        for (const k of keys) {
          if (!['label', 'description', 'required'].includes(k)) {
            fail(`Unknown option key '${k}' in field '${field.id}'`)
          }
        }
        opt = {
          label: requireString(o.label, `option label in field '${field.id}'`, 1, FORM_LIMITS.maxLabelLength),
          description: optionalString(o.description, `option description in field '${field.id}'`, FORM_LIMITS.maxDescriptionLength),
          required: o.required === true,
        }
      } else {
        fail(`options of field '${field.id}' must be strings or mappings`)
      }
      if (opt.label === '') fail(`empty option label in field '${field.id}'`)
      if (opt.required && fieldType !== 'checkboxes') {
        fail(`per-option 'required' is only valid on checkboxes fields ('${field.id}')`)
      }
      if (seen.has(opt.label.toLowerCase())) fail(`duplicate option '${opt.label}' in field '${field.id}'`)
      seen.add(opt.label.toLowerCase())
      options.push(opt)
    }
  } else if (OPTION_TYPES.includes(fieldType)) {
    fail(`field '${field.id}' (${fieldType}) requires options`)
  }

  let multiple = false
  if (a.multiple !== undefined && a.multiple !== null) {
    if (fieldType !== 'dropdown') fail(`'multiple' is only valid on dropdown fields ('${field.id}')`)
    if (typeof a.multiple !== 'boolean') fail(`'multiple' must be a boolean`)
    multiple = a.multiple
  }

  let default_value: string | boolean | null = null
  if (a.default !== undefined && a.default !== null) {
    if (!VALUE_TYPES.includes(fieldType) && fieldType !== 'checkbox') {
      fail(`'default' is not supported on field '${field.id}' (${fieldType})`)
    }
    if (fieldType === 'checkbox') {
      if (typeof a.default !== 'boolean') fail(`'default' of checkbox '${field.id}' must be a boolean`)
      default_value = a.default
    } else {
      const d = String(a.default)
      if (d.length > FORM_LIMITS.maxValueLength) fail(`'default' of field '${field.id}' is too long`)
      if ((fieldType === 'dropdown' || fieldType === 'radio')) {
        if (!options.some((o) => o.label === d)) {
          fail(`'default' of field '${field.id}' must be one of its options`)
        }
      }
      default_value = d
    }
  }

  const validations = parseValidations(field.validations, field.id, fieldType)

  return {
    type: fieldType, id: field.id, label, description, placeholder,
    multiple, default_value, options, validations,
  }
}

function parseValidations(raw: unknown, fieldId: string, fieldType: FieldType): FormValidations {
  const out: FormValidations = {
    required: false, min_length: null, max_length: null,
    pattern: null, pattern_message: null,
  }
  if (raw === undefined || raw === null) return out
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(`validations of field '${fieldId}' must be a mapping`)
  const v = raw as Record<string, unknown>
  for (const key of Object.keys(v)) {
    if (!['required', 'min_length', 'max_length', 'pattern', 'pattern_message'].includes(key)) {
      fail(`Unknown validation '${key}' on field '${fieldId}'`)
    }
  }

  out.required = v.required === true
  if (v.required !== undefined && v.required !== null && typeof v.required !== 'boolean') {
    fail(`'required' of field '${fieldId}' must be a boolean`)
  }

  const lengthTypes: FieldType[] = ['text', 'textarea', 'dropdown']
  if (v.min_length !== undefined && v.min_length !== null) {
    if (!lengthTypes.includes(fieldType)) fail(`min_length is only valid on text/textarea/dropdown fields`)
    out.min_length = boundedInt(v.min_length, `min_length of '${fieldId}'`, 0, FORM_LIMITS.maxValueLength)
  }
  if (v.max_length !== undefined && v.max_length !== null) {
    if (!lengthTypes.includes(fieldType)) fail(`max_length is only valid on text/textarea/dropdown fields`)
    out.max_length = boundedInt(v.max_length, `max_length of '${fieldId}'`, 1, FORM_LIMITS.maxValueLength)
  }
  if (
    out.min_length !== null && out.max_length !== null &&
    out.min_length > out.max_length
  ) {
    fail(`min_length exceeds max_length on field '${fieldId}'`)
  }

  if (v.pattern !== undefined && v.pattern !== null) {
    if (!lengthTypes.includes(fieldType)) fail(`pattern is only valid on text/textarea/dropdown fields`)
    if (typeof v.pattern !== 'string') fail(`'pattern' of field '${fieldId}' must be a string`)
    if (v.pattern.length > FORM_LIMITS.maxPatternLength) {
      fail(`'pattern' of field '${fieldId}' is too long (max ${FORM_LIMITS.maxPatternLength})`)
    }
    try {
      out.pattern = new RegExp(v.pattern)
    } catch {
      fail(`'pattern' of field '${fieldId}' is not a valid regular expression`)
    }
  }
  if (v.pattern_message !== undefined && v.pattern_message !== null) {
    if (out.pattern === null) fail(`pattern_message without a pattern on field '${fieldId}'`)
    out.pattern_message = optionalString(
      v.pattern_message, `pattern_message of '${fieldId}'`, FORM_LIMITS.maxDescriptionLength,
    )
  }
  return out
}

function boundedInt(v: unknown, what: string, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) {
    fail(`'${what}' must be an integer between ${min} and ${max}`)
  }
  return n
}

// -- answer validation ----------------------------------------------------------

/**
 * Validated answers keyed by field id:
 *   text/textarea → string · dropdown(single)/radio → string ∈ options ·
 *   dropdown(multiple)/checkboxes/tasklist → string[] ⊆ options ·
 *   checkbox → boolean.
 */
export type NormalizedAnswers = Record<string, string | string[] | boolean>

export function validateAnswers(form: IssueFormDef, raw: unknown): NormalizedAnswers {
  if (raw === undefined || raw === null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError(400, 'answers must be an object keyed by field id', 'validation_failed')
  }
  const answers = raw as Record<string, unknown>
  const known = new Set(form.fields.map((f) => f.id))
  for (const id of Object.keys(answers)) {
    if (!known.has(id)) {
      throw new AppError(422, `'${id}' is not a field of form '${form.name}'`, 'validation_failed')
    }
  }

  const out: NormalizedAnswers = {}
  for (const field of form.fields) {
    const provided = answers[field.id]
    const value = provided === undefined ? field.default_value : provided

    switch (field.type) {
      case 'text':
      case 'textarea': {
        if (value === undefined || value === null || value === '') {
          if (field.validations.required) {
            throw answerError(field.id, `${field.label} is required`)
          }
          continue
        }
        if (typeof value !== 'string') throw answerError(field.id, `${field.label} must be text`)
        const s = field.type === 'text' ? value.trim() : value.replace(/\r\n/g, '\n')
        if (field.validations.required && s.trim() === '') {
          throw answerError(field.id, `${field.label} is required`)
        }
        if (s.length === 0) continue
        if (s.length > FORM_LIMITS.maxValueLength) {
          throw answerError(field.id, `${field.label} is too long`)
        }
        if (field.validations.min_length !== null && s.length < field.validations.min_length) {
          throw answerError(field.id, `${field.label} must be at least ${field.validations.min_length} characters`)
        }
        if (field.validations.max_length !== null && s.length > field.validations.max_length) {
          throw answerError(field.id, `${field.label} must be at most ${field.validations.max_length} characters`)
        }
        if (field.validations.pattern && !field.validations.pattern.test(s)) {
          throw answerError(
            field.id,
            field.validations.pattern_message ?? `${field.label} has an invalid format`,
          )
        }
        out[field.id] = s
        break
      }
      case 'dropdown': {
        const labels = field.options.map((o) => o.label)
        if (field.multiple) {
          const list = normalizeChoiceList(value, field, labels)
          if (list === null) continue
          out[field.id] = list
        } else {
          if (value === undefined || value === null || value === '') {
            if (field.validations.required) throw answerError(field.id, `${field.label} is required`)
            continue
          }
          if (typeof value !== 'string') throw answerError(field.id, `${field.label} must be a single choice`)
          if (!labels.includes(value)) {
            throw answerError(field.id, `'${value}' is not a valid option for ${field.label}`)
          }
          out[field.id] = value
        }
        break
      }
      case 'radio': {
        if (value === undefined || value === null || value === '') {
          if (field.validations.required) throw answerError(field.id, `${field.label} is required`)
          continue
        }
        if (typeof value !== 'string') throw answerError(field.id, `${field.label} must be a single choice`)
        const labels = field.options.map((o) => o.label)
        if (!labels.includes(value)) {
          throw answerError(field.id, `'${value}' is not a valid option for ${field.label}`)
        }
        out[field.id] = value
        break
      }
      case 'checkbox': {
        if (value === undefined || value === null) {
          if (field.validations.required) throw answerError(field.id, `${field.label} is required`)
          continue
        }
        if (typeof value !== 'boolean') throw answerError(field.id, `${field.label} must be checked or unchecked`)
        if (field.validations.required && value !== true) {
          throw answerError(field.id, `${field.label} must be accepted`)
        }
        out[field.id] = value
        break
      }
      case 'checkboxes': {
        const chosen = normalizeChoiceList(value, field, field.options.map((o) => o.label))
        if (chosen === null) continue
        for (const opt of field.options) {
          if (opt.required && !chosen.includes(opt.label)) {
            throw answerError(field.id, `'${opt.label}' must be confirmed`)
          }
        }
        out[field.id] = chosen
        break
      }
      case 'tasklist': {
        const chosen = normalizeChoiceList(value, field, field.options.map((o) => o.label))
        if (chosen === null) {
          // Task lists render ALL options; empty selection still emits open items.
          out[field.id] = []
          break
        }
        out[field.id] = chosen
        break
      }
    }
  }
  return out
}

function normalizeChoiceList(
  value: unknown,
  field: FormFieldDef,
  allowed: string[],
): string[] | null {
  if (value === undefined || value === null) {
    if (field.validations.required) throw answerError(field.id, `${field.label} is required`)
    return null
  }
  const list = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') throw answerError(field.id, `${field.label} choices must be strings`)
    if (!allowed.includes(item)) {
      throw answerError(field.id, `'${item}' is not a valid option for ${field.label}`)
    }
    if (!out.includes(item)) out.push(item)
  }
  if (list.length === 0) {
    if (field.validations.required) throw answerError(field.id, `${field.label} is required`)
    return null
  }
  if (field.validations.required && out.length === 0) {
    throw answerError(field.id, `${field.label} is required`)
  }
  return out
}

function answerError(fieldId: string, message: string): AppError {
  return new AppError(422, message, 'validation_failed', { field: fieldId })
}

// -- body rendering ---------------------------------------------------------------

/**
 * Transforms validated answers into the structured Markdown issue body:
 * one border-free section per answered field (`### <label>`), task lists
 * emitted as real `- [ ]`/`- [x]` markers so they integrate with issue
 * progress tracking, and a provenance footer.
 */
export function renderIssueBody(form: IssueFormDef, answers: NormalizedAnswers): string {
  const sections: string[] = []
  for (const field of form.fields) {
    const value = answers[field.id]
    if (value === undefined) continue

    switch (field.type) {
      case 'text':
      case 'textarea': {
        if (typeof value !== 'string' || value === '') continue
        sections.push(sectionOf(field, field.type === 'textarea' ? value : value))
        break
      }
      case 'dropdown': {
        if (Array.isArray(value)) {
          if (value.length === 0) continue
          sections.push(sectionOf(field, value.map((v) => `- ${v}`).join('\n')))
        } else if (typeof value === 'string' && value !== '') {
          sections.push(sectionOf(field, value))
        }
        break
      }
      case 'radio': {
        if (typeof value === 'string' && value !== '') sections.push(sectionOf(field, value))
        break
      }
      case 'checkbox': {
        if (typeof value !== 'boolean') continue
        sections.push(sectionOf(field, value ? '- [x]' : '- [ ]'))
        break
      }
      case 'checkboxes': {
        const chosen = Array.isArray(value) ? value : []
        if (chosen.length === 0) continue
        const lines = field.options.map((o) =>
          chosen.includes(o.label) ? `- [x] ${o.label}` : `- [ ] ${o.label}`,
        )
        sections.push(sectionOf(field, lines.join('\n')))
        break
      }
      case 'tasklist': {
        const chosen = Array.isArray(value) ? value : []
        // ALL options render as tasks; submitted ones are already complete.
        const lines = field.options.map((o) =>
          chosen.includes(o.label) ? `- [x] ${o.label}` : `- [ ] ${o.label}`,
        )
        sections.push(sectionOf(field, lines.join('\n')))
        break
      }
    }
  }

  sections.push(`---\n_Submitted via form \`${form.name}\`._`)
  return sections.join('\n\n')
}

function sectionOf(field: FormFieldDef, content: string): string {
  return `### ${field.label}\n\n${content}`
}

/**
 * Resolves the issue title: explicit submission title wins, then the
 * configured title_field answer, then the first short-text answer, then the
 * form name. The form's title_prefix always prepends.
 */
export function resolveIssueTitle(
  form: IssueFormDef,
  answers: NormalizedAnswers,
  explicit?: unknown,
): string {
  let base: string | null = null
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    base = explicit.trim().slice(0, 255)
  } else if (form.title_field && typeof answers[form.title_field] === 'string') {
    base = (answers[form.title_field] as string).trim() || null
  } else {
    const first = form.fields.find(
      (f) => (f.type === 'text') && typeof answers[f.id] === 'string' && (answers[f.id] as string).trim() !== '',
    )
    base = first ? (answers[first.id] as string).trim() : null
  }
  if (base === null) base = form.name
  const prefixed = form.title_prefix ? `${form.title_prefix}${base}` : base
  return prefixed.slice(0, 255)
}
