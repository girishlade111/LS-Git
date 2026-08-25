/**
 * GitLab-style code suggestions.
 *
 * A suggestion is a fenced code block with language `suggestion` inside a
 * diff-thread note. Applying it REPLACES the thread's covered line range in
 * the target file — the result is committed as a REAL git commit on the PR
 * source branch (never a database-only mutation of "code").
 */

export interface SuggestionBlock {
  lines: string[]
}

const SUGGESTION_FENCE = /```suggestion[^\S\n]*(?:-?\d+)?(?:\+\d+)?[^\S\n]*\n([\s\S]*?)\n?```/

/** Extracts the first ```suggestion block's replacement lines, or null. */
export function extractSuggestion(body: string): string[] | null {
  const m = SUGGESTION_FENCE.exec(body)
  if (!m) return null
  const raw = m[1] ?? ''
  if (raw === '') return [] // empty fence = delete the covered lines
  return raw.replace(/\r\n/g, '\n').split('\n')
}

export interface ApplyRangeInput {
  /** File content at the CURRENT source tip. */
  fileContent: string
  /** Inclusive 1-based new-side range the thread covers. */
  lineStart: number
  lineEnd: number
  /** Lines snapshot taken at thread creation — must still match exactly. */
  coveredLines: string[]
  replacement: string[]
}

export type ApplyRangeResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'out_of_bounds' | 'covered_lines_changed'; detail?: string }

/**
 * Applies one suggestion to file lines. Pure — the caller owns git I/O.
 * The covered-lines guard is what makes stale suggestions REFUSE instead of
 * silently editing the wrong region after upstream shifts.
 */
export function applySuggestionToContent(input: ApplyRangeInput): ApplyRangeResult {
  const { lineStart, lineEnd, coveredLines, replacement } = input
  const fileLines = input.fileContent === '' ? [] : input.fileContent.replace(/\n$/, '').split('\n')

  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart || lineEnd > fileLines.length) {
    return { ok: false, reason: 'out_of_bounds', detail: `range ${lineStart}-${lineEnd} outside ${fileLines.length}-line file` }
  }
  const current = fileLines.slice(lineStart - 1, lineEnd)
  if (current.join('\n') !== coveredLines.join('\n')) {
    return { ok: false, reason: 'covered_lines_changed' }
  }
  const next = [...fileLines.slice(0, lineStart - 1), ...replacement, ...fileLines.slice(lineEnd)]
  return { ok: true, content: next.length > 0 ? next.join('\n') + '\n' : '' }
}
