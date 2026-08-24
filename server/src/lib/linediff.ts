/**
 * Line-level diff matching for the blame foundation.
 *
 * Computes, for each line of the NEWER version, the index of the matching
 * line in the OLDER version (LCS alignment). Unmatched newer lines are
 * "introduced" by the commit being attributed. A pure LCS DP is used when the
 * input is small enough; larger inputs fall back to content-hash matching
 * (correct for typical edits, conservative on heavy duplication).
 */

const MAX_DP_CELLS = 4_000_000

/** curIdx → prevIdx for matched lines. */
export function matchLines(prev: string[], cur: string[]): Map<number, number> {
  if (prev.length === 0 || cur.length === 0) return new Map()
  if (prev.length * cur.length <= MAX_DP_CELLS) return lcsMatch(prev, cur)
  return hashMatch(prev, cur)
}

// ---------------------------------------------------------------------------
// Unified diff generation (server-side patch text for commit/compare views).
// Mirrors the browser-side generator so both produce git-compatible hunks.
// ---------------------------------------------------------------------------

export interface PatchStats {
  added: number
  removed: number
}

const PATCH_CONTEXT = 3

/**
 * Builds a unified-diff body (hunks only — file headers are the caller's)
 * between two versions of a file. Returns '' when identical.
 */
export function unifiedPatch(oldText: string, newText: string): { text: string; stats: PatchStats } {
  const oldLines = oldText === '' ? [] : oldText.replace(/\n$/, '').split('\n')
  const newLines = newText === '' ? [] : newText.replace(/\n$/, '').split('\n')

  // Alignment ops via LCS (hash fallback for huge inputs).
  const ops: Array<{ t: 'eq' | '-' | '+'; old?: string; new?: string }> = []
  {
    const matched = matchLines(oldLines, newLines) // curIdx → prevIdx
    const consumedOld = new Set<number>()
    let ai = 0
    for (let j = 0; j < newLines.length; j++) {
      const from = matched.get(j)
      if (from === undefined || consumedOld.has(from)) {
        ops.push({ t: '+', new: newLines[j] })
        continue
      }
      while (ai < from) {
        if (!consumedOld.has(ai)) ops.push({ t: '-', old: oldLines[ai] })
        ai++
      }
      // Equal pair.
      if (!consumedOld.has(from)) {
        ops.push({ t: 'eq', old: oldLines[from], new: newLines[j] })
        consumedOld.add(from)
      }
      ai = from + 1
    }
    while (ai < oldLines.length) {
      if (!consumedOld.has(ai)) ops.push({ t: '-', old: oldLines[ai] })
      ai++
    }
  }

  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.t === '+') added++
    else if (op.t === '-') removed++
  }
  if (added === 0 && removed === 0) return { text: '', stats: { added: 0, removed: 0 } }

  // Line numbers per op.
  const nums = new Array<{ o: number | null; n: number | null }>(ops.length)
  let oNo = 1
  let nNo = 1
  for (let i = 0; i < ops.length; i++) {
    nums[i] = {
      o: ops[i]!.t === '+' ? null : oNo++,
      n: ops[i]!.t === '-' ? null : nNo++,
    }
  }

  // Include-window around changes; group into hunks.
  const include = new Array<boolean>(ops.length).fill(false)
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.t !== 'eq') {
      for (let j = Math.max(0, i - PATCH_CONTEXT); j <= Math.min(ops.length - 1, i + PATCH_CONTEXT); j++) {
        include[j] = true
      }
    }
  }
  const groups: Array<Array<number>> = []
  let cur: Array<number> | null = null
  for (let i = 0; i < ops.length; i++) {
    if (!include[i]) {
      if (cur) { groups.push(cur); cur = null }
      continue
    }
    if (!cur) cur = []
    cur.push(i)
  }
  if (cur) groups.push(cur)

  let out = ''
  for (const g of groups) {
    const first = nums[g[0]!]!
    const last = nums[g[g.length - 1]!]!
    const oldCount = g.filter((i) => ops[i]!.t !== '+').length
    const newCount = g.filter((i) => ops[i]!.t !== '-').length
    const oldStart = oldCount === 0 ? 0 : (first.o ?? last.o ?? 1)
    const newStart = newCount === 0 ? 0 : (first.n ?? last.n ?? 1)
    out += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`
    for (const i of g) {
      const op = ops[i]!
      out += op.t === 'eq' ? ` ${op.new ?? ''}\n` : `${op.t}${(op.t === '-' ? op.old : op.new) ?? ''}\n`
    }
  }
  return { text: out, stats: { added, removed } }
}

function lcsMatch(a: string[], b: string[]): Map<number, number> {
  const n = a.length
  const m = b.length
  // dp[i][j] = LCS length of a[i..], b[j..]
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const out = new Map<number, number>()
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.set(j, i)
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++
    } else {
      j++
    }
  }
  return out
}

function hashMatch(prev: string[], cur: string[]): Map<number, number> {
  const byContent = new Map<string, number[]>()
  prev.forEach((line, idx) => {
    const list = byContent.get(line) ?? []
    list.push(idx)
    byContent.set(line, list)
  })
  const out = new Map<number, number>()
  const consumed = new Set<number>()
  for (let j = 0; j < cur.length; j++) {
    const candidates = byContent.get(cur[j]!)
    if (!candidates) continue
    const idx = candidates.find((i) => !consumed.has(i))
    if (idx !== undefined) {
      consumed.add(idx)
      out.set(j, idx)
    }
  }
  return out
}
