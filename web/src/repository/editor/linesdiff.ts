/**
 * Client-side line diff → unified diff text.
 *
 * Produces standard `@@ -a,b +c,d @@` hunks that feed the existing
 * DiffViewer primitive (parseUnifiedDiff), so diff preview reuses the locked
 * design-system rendering with zero new visual patterns.
 */

interface Op {
  type: 'equal' | 'insert' | 'delete'
  oldLine?: string
  newLine?: string
}

const MAX_CELLS = 4_000_000

function lcsOps(a: string[], b: string[]): Array<Op> {
  const n = a.length
  const m = b.length
  if (n * m > MAX_CELLS) return hashOps(a, b)

  // dp[i][j] = LCS length of a[i..], b[j..]
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  const idx = (i: number, j: number) => i * width + j
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[idx(i, j)] = a[i] === b[j]
        ? dp[idx(i + 1, j + 1)] + 1
        : Math.max(dp[idx(i + 1, j)], dp[idx(i, j + 1)])
    }
  }

  const ops: Array<Op> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', oldLine: a[i], newLine: b[j] })
      i++
      j++
    } else if (dp[idx(i + 1, j)] >= dp[idx(i, j + 1)]) {
      ops.push({ type: 'delete', oldLine: a[i] })
      i++
    } else {
      ops.push({ type: 'insert', newLine: b[j] })
      j++
    }
  }
  while (i < n) { ops.push({ type: 'delete', oldLine: a[i++] }) }
  while (j < m) { ops.push({ type: 'insert', newLine: b[j++] }) }
  return ops
}

/** Content-hash fallback for very large inputs (conservative on duplicates). */
function hashOps(a: string[], b: string[]): Array<Op> {
  const positions = new Map<string, number[]>()
  a.forEach((line, idx) => {
    const list = positions.get(line) ?? []
    list.push(idx)
    positions.set(line, list)
  })
  const consumed = new Set<number>()
  const matchedOld = new Map<number, number>() // newIdx → oldIdx
  for (let j = 0; j < b.length; j++) {
    const candidates = positions.get(b[j])
    const found = candidates?.find((i) => !consumed.has(i))
    if (found !== undefined) {
      consumed.add(found)
      matchedOld.set(j, found)
    }
  }
  const ops: Array<Op> = []
  let ai = 0
  for (let j = 0; j < b.length; j++) {
    const from = matchedOld.get(j)
    if (from === undefined) {
      ops.push({ type: 'insert', newLine: b[j] })
    } else {
      while (ai < from) { ops.push({ type: 'delete', oldLine: a[ai++] }) }
      ops.push({ type: 'equal', oldLine: a[from], newLine: b[j] })
      ai = from + 1
    }
  }
  while (ai < a.length) { ops.push({ type: 'delete', oldLine: a[ai++] }) }
  return ops
}

const CONTEXT_LINES = 3

export interface DiffStats {
  added: number
  removed: number
}

/**
 * Builds a unified-diff text between two file versions.
 * Empty `oldText` produces new-file output; empty `newText` a deletion.
 * Returns '' when the contents are identical.
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  path: string,
): { text: string; stats: DiffStats } {
  const oldLines = oldText === '' ? [] : oldText.replace(/\n$/, '').split('\n')
  const newLines = newText === '' ? [] : newText.replace(/\n$/, '').split('\n')
  const ops = lcsOps(oldLines, newLines)

  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.type === 'insert') added++
    else if (op.type === 'delete') removed++
  }
  if (added === 0 && removed === 0) return { text: '', stats: { added: 0, removed: 0 } }

  // Line numbers per op index.
  const nums = new Array<{ oldNo: number | null; newNo: number | null }>(ops.length)
  let o = 1
  let nn = 1
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    nums[i] = {
      oldNo: op.type === 'insert' ? null : o++,
      newNo: op.type === 'delete' ? null : nn++,
    }
  }

  // Include-window around every change.
  const include = new Array<boolean>(ops.length).fill(false)
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.type === 'equal') continue
    for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(ops.length - 1, i + CONTEXT_LINES); j++) {
      include[j] = true
    }
  }

  // Group included runs into hunks.
  const groups: Array<Array<number>> = []
  let current: Array<number> | null = null
  for (let i = 0; i < ops.length; i++) {
    if (!include[i]) {
      if (current) { groups.push(current); current = null }
      continue
    }
    if (!current) current = []
    current.push(i)
  }
  if (current) groups.push(current)

  let out =
    `diff --git a/${path} b/${path}\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n`
  for (const group of groups) {
    const first = nums[group[0]!]!
    const last = nums[group[group.length - 1]!]!
    const oldCount = group.filter((i) => ops[i]!.type !== 'insert').length
    const newCount = group.filter((i) => ops[i]!.type !== 'delete').length
    // Unified-diff convention: an empty side starts at 0 (e.g. @@ -0,0 +1,5 @@).
    const oldStart = oldCount === 0 ? 0 : (first.oldNo ?? last.oldNo ?? 1)
    const newStart = newCount === 0 ? 0 : (first.newNo ?? last.newNo ?? 1)
    out += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`
    for (const i of group) {
      const op = ops[i]!
      if (op.type === 'equal') out += ` ${op.newLine ?? ''}\n`
      else if (op.type === 'delete') out += `-${op.oldLine ?? ''}\n`
      else out += `+${op.newLine ?? ''}\n`
    }
  }
  return { text: out, stats: { added, removed } }
}
