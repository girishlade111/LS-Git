/**
 * CODEOWNERS foundation (GitLab parity, deliberately minimal).
 *
 * Supports the core syntax now: comments (#), path patterns (exact paths and
 * trailing-slash directory globs), last-matching-line-wins precedence, and
 * @username owners. Group owners (@group/sub) and email owners parse but are
 * reported as non-resolvable so policies can treat them conservatively.
 * Required-approval enforcement for owned paths lands with the membership
 * phase; this module is the eligibility hook those policies will call.
 */

export interface CodeOwnerRule {
  pattern: string
  owners: string[]
}

export interface ParsedCodeOwners {
  rules: CodeOwnerRule[]
  errors: Array<{ line: number; reason: string }>
}

export function parseCodeOwners(source: string): ParsedCodeOwners {
  const rules: CodeOwnerRule[] = []
  const errors: ParsedCodeOwners['errors'] = []
  const lines = source.replace(/\r\n/g, '\n').split('\n')

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) return
    // Strip inline comment (first unquoted '#').
    const hash = line.indexOf(' #')
    const effective = (hash === -1 ? line : line.slice(0, hash)).trim()
    const parts = effective.split(/\s+/).filter(Boolean)
    if (parts.length < 2) {
      errors.push({ line: idx + 1, reason: 'a rule needs a path and at least one owner' })
      return
    }
    const pattern = parts[0]!
    const owners = parts.slice(1)
    for (const o of owners) {
      if (!/^(@[a-zA-Z0-9_./-]+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/.test(o)) {
        errors.push({ line: idx + 1, reason: `invalid owner '${o}'` })
        return
      }
    }
    rules.push({ pattern, owners })
  })

  return { rules, errors }
}

/**
 * Last-match-wins ownership query over parsed rules.
 * Matches: exact path · directory prefix (`dir/`) · extension (`*.ts`).
 * Returns resolvable usernames plus any non-resolvable owners encountered.
 */
export function ownersForPath(rules: CodeOwnerRule[], path: string): { users: string[]; unresolved: string[] } {
  let matched: CodeOwnerRule | null = null
  for (const rule of rules) {
    if (pathMatches(rule.pattern, path)) matched = rule
  }
  if (!matched) return { users: [], unresolved: [] }
  const users: string[] = []
  const unresolved: string[] = []
  for (const o of matched.owners) {
    if (o.startsWith('@')) {
      const name = o.slice(1)
      // Contains a '/' → group reference; groups are deferred.
      if (name.includes('/')) unresolved.push(o)
      else users.push(name.toLowerCase())
    } else {
      unresolved.push(o) // email owners deferred
    }
  }
  return { users, unresolved }
}

function pathMatches(pattern: string, path: string): boolean {
  const p = pattern.replace(/^\//, '').replace(/\/$/, '')
  if (p === path) return true
  if (pattern.endsWith('/') && path.startsWith(p ? `${p}/` : '')) return true
  if (p.startsWith('*.')) return path.endsWith(p.slice(1))
  return false
}
