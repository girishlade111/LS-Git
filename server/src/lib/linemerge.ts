import { matchLines } from './linediff.js'

/**
 * Genuine diff3-style three-way line merge.
 *
 * Built directly on the blame-foundation LCS alignment (matchLines): each
 * side is expressed as monotonic segments over the BASE coordinate space
 * (equal runs + edit regions with replacement lines), then the two sides are
 * merged segment-by-segment:
 *
 *   base vs ours vs theirs →
 *     equal/equal            → base
 *     equal/edit             → the edited side
 *     edit/edit (identical)  → once
 *     edit/edit (differing)  → CONFLICT spanning both regions
 *
 * There is no heuristic here: overlapping edits are conflicts, exactly like
 * git's merge without renames. The caller decides whether a conflict is fatal
 * (merge gate) or becomes conflict markers.
 */

export interface MergeConflict {
  /** Base line range [start, end) this conflict spans (informational). */
  start: number
  end: number
  ourLines: string[]
  theirLines: string[]
}

export interface ThreeWayResult {
  lines: string[] | null // null when conflicts exist
  conflicts: MergeConflict[]
}

interface Segment {
  baseStart: number
  baseEnd: number // exclusive
  lines: string[]
  isEdit: boolean
}

const MAX_MERGE_LINES = 50_000

/** Projects one side onto the base coordinate space as ordered segments. */
function sideSegments(baseLen: number, sideLines: string[], curToBase: Map<number, number>): Segment[] {
  const segments: Segment[] = []
  let basePos = 0 // next unconsumed base index
  let pending: string[] = [] // insertion buffer at gap `basePos`

  const flushEdit = (end: number) => {
    segments.push({ baseStart: basePos, baseEnd: end, lines: pending, isEdit: true })
    pending = []
    basePos = end
  }

  for (let i = 0; i < sideLines.length; i++) {
    const m = curToBase.get(i)
    if (m === undefined) {
      pending.push(sideLines[i]!)
      continue
    }
    if (m < basePos) {
      // Out-of-order match (possible with hash fallback) — treat defensively
      // as an edit over nothing rather than corrupting monotonicity.
      pending.push(sideLines[i]!)
      continue
    }
    if (pending.length > 0 || m > basePos) {
      flushEdit(m)
    }
    segments.push({ baseStart: m, baseEnd: m + 1, lines: [sideLines[i]!], isEdit: false })
    basePos = m + 1
  }
  if (pending.length > 0 || basePos < baseLen) {
    flushEdit(baseLen)
  }
  return segments
}

export function threeWayMerge(baseText: string, oursText: string, theirsText: string): ThreeWayResult {
  const split = (t: string): string[] => (t === '' ? [] : t.replace(/\n$/, '').split('\n'))
  const base = split(baseText)
  const ours = split(oursText)
  const theirs = split(theirsText)

  if (base.length + ours.length + theirs.length > MAX_MERGE_LINES * 3) {
    // Oversized content never merges silently — reported as a hard conflict
    // so the caller surfaces a real error instead of pretending success.
    return { lines: null, conflicts: [{ start: 0, end: base.length, ourLines: [], theirLines: [] }] }
  }

  // matchLines(cur, prev)? Signature is (prev, cur) returning cur→prev map.
  const oursToBase = matchLines(base, ours)
  const theirsToBase = matchLines(base, theirs)

  const O = sideSegments(base.length, ours, oursToBase)
  const T = sideSegments(base.length, theirs, theirsToBase)

  const out: string[] = []
  const conflicts: MergeConflict[] = []
  let oi = 0
  let ti = 0
  let pos = 0 // consumed base coordinate

  while (oi < O.length || ti < T.length) {
    const o = O[oi]
    const t = T[ti]

    // Advance pure-equal segments cheaply when only one side has them here.
    if (o && t && o.baseStart === t.baseStart && !o.isEdit && !t.isEdit && o.baseEnd === t.baseEnd) {
      for (let i = o.baseStart; i < o.baseEnd; i++) out.push(base[i]!)
      pos = o.baseEnd
      oi++
      ti++
      continue
    }

    // Determine the next event boundary across both lists.
    const nextStart = Math.min(
      o ? o.baseStart : Number.MAX_SAFE_INTEGER,
      t ? t.baseStart : Number.MAX_SAFE_INTEGER,
    )

    // Emit untouched base region up to the boundary from whichever segment covers it.
    if (nextStart > pos) {
      // Copy base[pos..nextStart) — guaranteed equal on both sides.
      for (let i = pos; i < nextStart; i++) out.push(base[i]!)
      pos = nextStart
      // Skip/trim leading equal segments that cover this copied region.
      if (o && o.baseStart < nextStart && !o.isEdit) {
        oi++ // fully inside copied region by construction of boundaries below
      } else if (t && t.baseStart < nextStart && !t.isEdit) {
        ti++
      }
      continue
    }

    if (!o || !t) break // defensive; lists are padded by construction

    // Both pointers sit at the same boundary — compare the pair.
    const end = Math.min(o.baseEnd, t.baseEnd === o.baseStart ? t.baseEnd : Math.max(o.baseEnd, t.baseEnd))
    void end

    const overlapEnd = Math.max(o.baseEnd, t.baseEnd)
    if (!o.isEdit && !t.isEdit) {
      for (let i = o.baseStart; i < Math.max(o.baseEnd, t.baseEnd); i++) out.push(base[i]!)
      pos = Math.max(o.baseEnd, t.baseEnd)
      oi++
      ti++
      continue
    }
    if (!o.isEdit && t.isEdit) {
      out.push(...t.lines)
      pos = t.baseEnd
      oi = advanceThrough(O, oi, t.baseEnd)
      ti++
      continue
    }
    if (o.isEdit && !t.isEdit) {
      out.push(...o.lines)
      pos = o.baseEnd
      oi++
      ti = advanceThrough(T, ti, o.baseEnd)
      continue
    }
    // edit × edit
    const identical =
      o.baseStart === t.baseStart &&
      o.baseEnd === t.baseEnd &&
      o.lines.length === t.lines.length &&
      o.lines.every((l, i2) => l === t.lines[i2])
    if (identical) {
      out.push(...o.lines)
    } else {
      conflicts.push({ start: o.baseStart, end: overlapEnd, ourLines: o.lines, theirLines: t.lines })
    }
    pos = overlapEnd
    oi = advanceThrough(O, oi, overlapEnd)
    ti = advanceThrough(T, ti, overlapEnd)
  }

  // Trailing base tail beyond the last aligned segment (both sides kept it).
  if (conflicts.length === 0) {
    while (pos < base.length) out.push(base[pos++]!)
  }

  return { lines: conflicts.length === 0 ? out : null, conflicts }
}

/** Advances the segment list until segments beyond `through` begin. */
function advanceThrough(list: Segment[], index: number, through: number): number {
  let i = index
  while (i < list.length && list[i]!.baseEnd <= through) i++
  return i
}

/**
 * Convenience wrapper producing text with git-style conflict markers, or the
 * clean result. Conflict markers make manual inspection possible but merges
 * are NEVER auto-completed with them present.
 */
export function renderConflicted(
  base: string,
  ours: string,
  theirs: string,
  ourLabel = 'ours',
  theirLabel = 'theirs',
): { text: string; conflictCount: number } {
  const r = threeWayMerge(base, ours, theirs)
  if (r.lines !== null) return { text: r.lines.join('\n') + '\n', conflictCount: 0 }

  // Deterministic marker rendering for inspection/debugging paths.
  const split = (t: string): string[] => (t === '' ? [] : t.replace(/\n$/, '').split('\n'))
  const baseLines = split(base)
  const parts: string[] = []
  let last = 0
  const sorted = [...r.conflicts].sort((a, b) => a.start - b.start)
  for (const c of sorted) {
    parts.push(...baseLines.slice(last, c.start))
    parts.push(`<<<<<<< ${ourLabel}`, ...c.ourLines, '=======', ...c.theirLines, `>>>>>>> ${theirLabel}`)
    last = Math.max(last, c.end)
  }
  parts.push(...baseLines.slice(last))
  return { text: parts.join('\n') + '\n', conflictCount: sorted.length }
}
