import { z } from 'zod'

/**
 * Project path rules (GitLab-parity subset):
 * - letters/digits first, then [A-Za-z0-9_.-]
 * - reserved suffixes (.git, .atom) and a few reserved names
 * - case-insensitively unique per owner (enforced by DB collation too)
 */
const PROJECT_PATH_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

const RESERVED_PATHS = new Set(['new', 'root', 'admin', 'api', 'dashboard', 'projects', 'groups', 'explore'])
const RESERVED_SUFFIXES = ['.git', '.atom', '.json']

export const projectPathSchema = z
  .string()
  .trim()
  .min(1, 'Path is too short (minimum is 1 character)')
  .max(255, 'Path is too long (maximum is 255 characters)')
  .regex(PROJECT_PATH_RE, 'Path must start with a letter or digit and contain only letters, digits, ".", "_" or "-"')
  .refine((p) => !RESERVED_SUFFIXES.some((s) => p.toLowerCase().endsWith(s)), {
    message: 'Path ends with a reserved suffix',
  })
  .refine((p) => !RESERVED_PATHS.has(p.toLowerCase()), { message: 'Path is reserved' })
  .transform((p) => p.toLowerCase())

export const projectNameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(255, 'Name is too long (maximum is 255 characters)')

export const projectDescriptionSchema = z
  .string()
  .trim()
  .max(1000, 'Description is too long (maximum is 1000 characters)')
  .transform((d) => d ?? '')

export const websiteUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) => v === '' || /^https?:\/\/[^\s]+$/i.test(v),
    { message: 'Website URL must be an http(s) URL' },
  )

/**
 * Git ref-name validation for the default branch — a pragmatic subset of
 * git-check-ref-format(1): no leading/trailing junk, no '..', no control
 * characters, no '.lock' suffix, no consecutive slashes.
 */
export function isValidBranchRef(name: string): boolean {
  if (!name || name.length > 255) return false
  if (name.startsWith('-') || name.startsWith('.') || name.endsWith('.') || name.endsWith('/')) return false
  if (name.endsWith('.lock')) return false
  if (/[\s~^:?*[\\\u0000-\u001f\u007f]/.test(name)) return false
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false
  if (!/[a-zA-Z0-9_]/.test(name)) return false
  return true
}

export const branchRefSchema = z
  .string()
  .trim()
  .refine(isValidBranchRef, { message: 'Invalid default branch name' })

export const visibilitySchema = z.enum(['private', 'internal', 'public'])

/** Topic normalization: trim → collapse inner whitespace → lowercase canonical form. */
export function normalizeTopic(raw: string): string | null {
  const t = raw.trim().replace(/\s+/g, '-').toLowerCase()
  if (!t || t.length > 255) return null
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(t)) return null
  return t
}

export interface CreateProjectInput {
  name: string
  path: string
  visibility: 'private' | 'internal' | 'public'
  description: string
  website_url: string
  default_branch: string
  initialize_with_readme: boolean
  gitignore_template: string | null
  license_template: string | null
  topics: string[]
  template_project_id: number | null
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

export function validateCreateProject(input: unknown): Parsed<CreateProjectInput> {
  let obj: Record<string, unknown>
  try {
    obj = (input ?? {}) as Record<string, unknown>
  } catch {
    return { ok: false, error: 'Invalid input' }
  }

  const name = projectNameSchema.safeParse(obj.name)
  if (!name.success) return { ok: false, error: name.error.issues[0]!.message }
  // Path defaults to a slugified name when absent.
  const rawPath = typeof obj.path === 'string' && obj.path.trim() !== '' ? obj.path : name.data
  const path = projectPathSchema.safeParse(rawPath)
  if (!path.success) return { ok: false, error: path.error.issues[0]!.message }

  const visibility = visibilitySchema.safeParse(obj.visibility ?? 'private')
  if (!visibility.success) return { ok: false, error: 'Invalid visibility level' }

  const description = projectDescriptionSchema.safeParse(typeof obj.description === 'string' ? obj.description : '')
  if (!description.success) return { ok: false, error: description.error.issues[0]!.message }

  const websiteUrl = websiteUrlSchema.safeParse(typeof obj.website_url === 'string' ? obj.website_url : '')
  if (!websiteUrl.success) return { ok: false, error: websiteUrl.error.issues[0]!.message }

  const default_branch = branchRefSchema.safeParse(
    typeof obj.default_branch === 'string' && obj.default_branch.trim() ? obj.default_branch : 'main',
  )
  if (!default_branch.success) return { ok: false, error: default_branch.error.issues[0]!.message }

  const topicsRaw = Array.isArray(obj.topics) ? obj.topics.map(String).slice(0, 100) : []
  const topics: string[] = []
  for (const raw of topicsRaw) {
    const normalized = normalizeTopic(raw)
    if (normalized === null) {
      return { ok: false, error: `Invalid topic: ${String(raw).slice(0, 60)}` }
    }
    if (!topics.includes(normalized)) topics.push(normalized)
  }
  if (topics.length > 30) return { ok: false, error: 'A project can have at most 30 topics' }

  return {
    ok: true,
    value: {
      name: name.data,
      path: path.data,
      visibility: visibility.data as CreateProjectInput['visibility'],
      description: description.data,
      website_url: websiteUrl.data,
      default_branch: default_branch.data,
      initialize_with_readme: obj.initialize_with_readme === true,
      gitignore_template:
        typeof obj.gitignore_template === 'string' && obj.gitignore_template ? obj.gitignore_template : null,
      license_template:
        typeof obj.license_template === 'string' && obj.license_template ? obj.license_template : null,
      topics,
      template_project_id:
        typeof obj.template_project_id === 'number' ? obj.template_project_id : null,
    },
  }
}
