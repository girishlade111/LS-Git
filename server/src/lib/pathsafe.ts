/**
 * Repository file path validation — the server NEVER trusts client paths.
 *
 * Rejects: absolute paths, drive letters, backslashes, traversal segments
 * ('..', '.'), empty segments ('//'), control characters, Windows-reserved
 * names, oversized components. Dotfiles like '.gitignore' remain allowed;
 * a bare '.git' component is not.
 */

const MAX_COMPONENT = 255
const MAX_TOTAL = 1024
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

export type PathCheck = { ok: true; path: string } | { ok: false; error: string }

export function validateRepoFilePath(raw: unknown): PathCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'file_path must be a string' }
  const input = raw.trim()

  if (input.length === 0) return { ok: false, error: 'file_path must not be empty' }
  if (input.length > MAX_TOTAL) return { ok: false, error: `file_path exceeds ${MAX_TOTAL} characters` }

  // Absolute / platform-specific injections.
  if (input.startsWith('/') || input.startsWith('\\')) {
    return { ok: false, error: 'file_path must be relative to the repository root' }
  }
  if (/^[A-Za-z]:/.test(input)) {
    return { ok: false, error: 'Drive letters are not allowed in file_path' }
  }
  if (input.includes('\\')) {
    return { ok: false, error: 'Backslashes are not allowed in file_path' }
  }
  // Control characters & shell-unsafe metacharacters.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(input)) {
    return { ok: false, error: 'file_path contains control characters' }
  }
  if (/[~^:?*[\]|<>"']/.test(input)) {
    return { ok: false, error: 'file_path contains invalid characters' }
  }

  const segments = input.split('/')
  const cleaned: string[] = []
  for (const seg of segments) {
    if (seg.length === 0) return { ok: false, error: "file_path contains an empty segment ('//')" }
    if (seg === '.' || seg === '..') {
      return { ok: false, error: 'Path traversal is not allowed in file_path' }
    }
    if (seg.length > MAX_COMPONENT) {
      return { ok: false, error: `A path component exceeds ${MAX_COMPONENT} characters` }
    }
    if (seg.startsWith('.') && (seg === '.git' || seg.toLowerCase() === '.git')) {
      return { ok: false, error: "'.git' is a reserved path component" }
    }
    if (seg.endsWith('.lock')) return { ok: false, error: "Components ending in '.lock' are reserved" }
    if (WINDOWS_RESERVED.has(seg.toLowerCase())) {
      return { ok: false, error: `'${seg}' is a reserved name on some filesystems` }
    }
    cleaned.push(seg)
  }
  return { ok: true, path: cleaned.join('/') }
}

/** Commit message hygiene: strip control chars, cap length. */
export function sanitizeCommitMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
  if (!stripped) return null
  return stripped.slice(0, 5000)
}
