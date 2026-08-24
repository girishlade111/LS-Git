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
