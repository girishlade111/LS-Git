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
 * Empty `oldText` with `newPath` produces GitLab-style "new file" output;
 * the reverse yields "deleted file".
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  path: string,
): { text: string; stats: DiffStats } {
  const oldLines = oldText === '' ? [] : oldText.replace(/\n$/, '').split('\n')
  const newLines = newText === '' ? [] : newText.replace(/\n$/, '').split('\n')
  const ops = lcsOps(oldLines, newLines)
  const header =
    `diff --git a/${path} b/${path}\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n`

  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.type === 'insert') added++
    else if (op.type === 'delete') removed++
  }
  if (added === 0 && removed === 0) return { text: '', stats: { added: 0, removed: 0 } }

  // Group ops into hunks with context windows.
  const hunks: Array<Array<{ prefix: string; text: string }>> = []
  let current: Array<{ prefix: string; text: string }> = []
  let sinceChange = Number.MAX_SAFE_INTEGER
  let oldNo = 1
  let newNo = 1
  const starts: Array<{ oldStart: number; newStart: number; lines: Array<{ prefix: string; text: string }> }> = []

  interface HunkBuilder {
    lines: Array<{ prefix: string; text: string }>
    oldStart: number
    newStart: number
    open: boolean
    lastOld: number
    lastNew: number
  }
  const hunk: HunkBuilder = { lines: [], oldStart: 0, newStart: 0, open: false, lastOld: 0, lastNew: 0 }

  const pendingCtx: Array<{ prefix: string; text: string; oldNo: number; newNo: number }> = []

  function flushContext(into: boolean): void {
    if (!into) {
      pendingCtx.length = 0
      return
    }
    for (const c of pendingCtx) {
      if (!hunk.open) {
        hunk.open = true
        hunk.oldStart = c.oldNo
        hunk.newStart = c.newNo
      }
      hunk.lines.push({ prefix: ' ', text: c.text })
      hunk.lastOld = c.oldNo
      hunk.lastNew = c.newNo
    }
    pendingCtx.length = 0
  }

  for (const op of ops) {
    switch (op.type) {
      case 'equal':
        pendingCtx.push({ prefix: ' ', text: op.newLine ?? '', oldNo, newNo })
        oldNo++
        newNo++
        break
      case 'delete':
        flushContext(pendingCtx.length > 0 || hunk.open ? true : false)
        if (!hunk.open) { hunk.open = true; hunk.oldStart = oldNo; hunk.newStart = newNo }
        hunk.lines.push({ prefix: '-', text: op.oldLine ?? '' })
        hunk.lastOld = oldNo
        oldNo++
        break
      case 'insert':
        flushContext(hunk.open || pendingCtx.length > 0)
        if (!hunk.open) { hunk.open = true; hunk.oldStart = oldNo; hunk.newStart = newNo }
        hunk.lines.push({ prefix: '+', text: op.newLine ?? '' })
        hunk.lastNew = newNo
        newNo++
        break
    }
    // Trim long context runs between changes.
    if (op.type === 'equal' && pendingCtx.length > CONTEXT_LINES && !hunk.open) {
      pendingCtx.splice(0, pendingCtx.length - CONTEXT_LINES)
    } else if (op.type === 'equal' && hunk.open && pendingCtx.length > CONTEXT_LINES * 2) {
      flushContext(true)
      if (hunk.lines.length > 0) starts.push({ oldStart: hunk.oldStart, newStart: hunk.newStart, lines: [...hunk.lines] })
      hunk.lines = []
      hunk.open = false
    }
  }
  flushContext(hunk.open)
  if (hunk.lines.length > 0) starts.push({ oldStart: hunk.oldStart, newStart: hunk.newStart, lines: hunk.lines })

  void current
  void hunks

  let out = header
  for (const hk of starts) {
    const oldCount = hk.lines.filter((l) => l.prefix !== '+').length
    const newCount = hk.lines.filter((l) => l.prefix !== '-').length
    out += `@@ -${hk.oldStart},${oldCount} +${hk.newStart},${newCount} @@\n`
    out += hk.lines.map((l) => `${l.prefix}${l.text}`).join('\n') + '\n'
  }
  return { text: out, stats: { added, removed } }
}
