import { z } from 'zod'

/**
 * Reserved usernames (GitLab reserves `root` and instance paths; this set keeps
 * the API/UI namespaces unambiguous). Extend via config later.
 */
export const RESERVED_USERNAMES = new Set([
  'root', 'admin', 'administrator', 'lsgit', 'api', 'users', 'new',
  'groups', 'projects', 'explore', 'dashboard', 'profile', 'settings',
  'help', 'login', 'logout', 'register', 'search', 'public', 'assets',
])

const usernameRegex = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

export const usernameSchema = z
  .string()
  .trim()
  .min(2, 'Username is too short (minimum is 2 characters)')
  .max(255, 'Username is too long (maximum is 255 characters)')
  .regex(usernameRegex, 'Username must start with a letter or digit and contain only letters, digits, ".", "_" or "-"')
  .refine((u) => !RESERVED_USERNAMES.has(u.toLowerCase()), { message: 'Username is reserved' })
  .transform((u) => u.toLowerCase())

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(255, 'Email is too long (maximum is 255 characters)')
  .email('Enter a valid email address')
  .transform((e) => e.toLowerCase())

export function passwordIssues(password: string, minLength: number): string[] {
  const issues: string[] = []
  if (password.length < minLength) {
    issues.push(`Password is too short (minimum is ${minLength} characters)`)
  }
  if (password.length > 128) issues.push('Password is too long (maximum is 128 characters)')
  if (!/[a-z]/.test(password) && !/[A-Z]/.test(password)) {
    // GitLab requires letters; digits/symbols encouraged.
    issues.push('Password must contain at least one letter')
  }
  return issues
}

export interface RegisterInput {
  username: string
  email: string
  name?: string
  password: string
}

export function validateRegistration(
  input: unknown,
  passwordMinLength: number,
): { ok: true; value: RegisterInput } | { ok: false; error: string } {
  const schema = z.object({
    username: usernameSchema,
    email: emailSchema,
    name: z.string().trim().min(1).max(255).optional(),
    password: z.string().max(128),
  })
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  }
  const pw = passwordIssues(parsed.data.password, passwordMinLength)
  if (pw.length > 0) return { ok: false, error: pw[0]! }
  if (
    parsed.data.password.toLowerCase().includes(parsed.data.username.toLowerCase()) ||
    parsed.data.password.includes(parsed.data.email.split('@')[0]!.toLowerCase())
  ) {
    return { ok: false, error: 'Password must not contain your username or email' }
  }
  return { ok: true, value: parsed.data as RegisterInput }
}

export function validatePasswordReset(
  input: unknown,
  passwordMinLength: number,
): { ok: true; value: { password: string } } | { ok: false; error: string } {
  const schema = z.object({ password: z.string().max(128), resetToken: z.string().min(10).max(200) })
  const parsed = schema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid input' }
  const pw = passwordIssues(parsed.data.password, passwordMinLength)
  if (pw.length > 0) return { ok: false, error: pw[0]! }
  return { ok: true, value: { password: parsed.data.password } }
}
