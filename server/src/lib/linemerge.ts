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

  const emitBase = (from: number, to: number) => {
    for (let i = from; i < to; i++) out.push(base[i]!)
  }

  while (oi < O.length && ti < T.length) {
    const o = O[oi]!
    const t = T[ti]!

    if (o.baseStart > pos) {
      emitBase(pos, Math.min(o.baseStart, t.baseStart))
    }
    if (o.baseStart !== t.baseStart) {
      // Only one side has an event at this coordinate; the other side keeps
      // the base here by construction of its own segmentation.
      if (o.baseStart < t.baseStart) {
        if (o.isEdit) out.push(...o.lines)
        else emitBase(o.baseStart, o.baseEnd)
        pos = o.baseEnd
        oi++
        ti = advanceThrough(T, ti, pos)
      } else {
        if (t.isEdit) out.push(...t.lines)
        else emitBase(t.baseStart, t.baseEnd)
        pos = t.baseEnd
        ti++
        oi = advanceThrough(O, oi, pos)
      }
      continue
    }

    // Both sides align at this boundary.
    if (!o.isEdit && !t.isEdit) {
      const end = Math.max(o.baseEnd, t.baseEnd)
      emitBase(pos, end)
      pos = end
      oi++
      ti++
      continue
    }
    if (!o.isEdit && t.isEdit) {
      out.push(...t.lines)
      pos = t.baseEnd
      oi++
      ti++
      continue
    }
    if (o.isEdit && !t.isEdit) {
      out.push(...o.lines)
      pos = o.baseEnd
      oi++
      ti++
      continue
    }

    // edit × edit
    const overlapEnd = Math.max(o.baseEnd, t.baseEnd)
    const identical =
      o.baseStart === t.baseStart &&
      o.baseEnd === t.baseEnd &&
      o.lines.length === t.lines.length &&
      o.lines.every((l, i2) => l === t.lines[i2])
    if (identical) {
      out.push(...o.lines)
    } else {
      conflicts.push({
        start: Math.min(o.baseStart, t.baseStart),
        end: overlapEnd,
        ourLines: o.lines,
        theirLines: t.lines,
      })
    }
    pos = overlapEnd
    oi = advanceThrough(O, oi, overlapEnd)
    ti = advanceThrough(T, ti, overlapEnd)
  }

  // A list that ended early leaves pure-base regions the other side kept.
  while (oi < O.length && conflicts.length === 0) {
    const seg = O[oi++]!
    if (seg.isEdit) out.push(...seg.lines)
    else emitBase(seg.baseStart, seg.baseEnd)
  }
  while (ti < T.length && conflicts.length === 0) {
    const seg = T[ti++]!
    if (seg.isEdit) out.push(...seg.lines)
    else emitBase(seg.baseStart, seg.baseEnd)
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
