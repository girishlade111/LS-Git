import { useMemo } from 'react'

type LineType = 'add' | 'del' | 'context' | 'hunk'

interface ParsedLine {
  type: LineType
  oldNo: number | null
  newNo: number | null
  content: string
}

export interface DiffFile {
  path: string
  lines: ParsedLine[]
}

/**
 * Minimal unified-diff parser. Understands `diff --git`, `---/+++`,
 * and `@@ -a,b +c,d @@` hunks. Lines outside these markers are treated as context.
 */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let oldNo = 0
  let newNo = 0

  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git')) {
      const m = raw.match(/^diff --git a\/(.+?) b\/(.+)$/)
      current = { path: m ? m[2] : raw.slice(11), lines: [] }
      files.push(current)
      continue
    }
    if (!current) continue
    if (raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('index ')) continue
    if (raw.startsWith('new file mode') || raw.startsWith('deleted file mode')) continue

    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
    if (hunk) {
      oldNo = parseInt(hunk[1], 10)
      newNo = parseInt(hunk[2], 10)
      current.lines.push({ type: 'hunk', oldNo: null, newNo: null, content: raw })
      continue
    }

    if (raw.startsWith('+')) {
      current.lines.push({ type: 'add', oldNo: null, newNo, content: raw.slice(1) })
      newNo++
    } else if (raw.startsWith('-')) {
      current.lines.push({ type: 'del', oldNo, newNo: null, content: raw.slice(1) })
      oldNo++
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — render as annotation row without numbers
      current.lines.push({ type: 'context', oldNo: null, newNo: null, content: raw })
    } else {
      current.lines.push({ type: 'context', oldNo, newNo, content: raw.replace(/^ /, '') })
      oldNo++
      newNo++
    }
  }
  return files.filter((f) => f.lines.some((l) => l.type !== 'context') || files.length === 1)
}

export interface DiffViewerProps {
  /** Raw unified diff text. */
  diff: string
}

export function DiffViewer({ diff }: DiffViewerProps) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff])

  return (
    <div className="ls-diff">
      {files.map((file) => (
        <section key={file.path} className="ls-diff__file" aria-label={`Diff for ${file.path}`}>
          <div className="ls-diff__fileheader">{file.path}</div>
          <table>
            <tbody>
              {file.lines.map((line, i) => (
                <tr
                  key={i}
                  className={
                    line.type === 'add'
                      ? 'ls-diff__row--add'
                      : line.type === 'del'
                        ? 'ls-diff__row--del'
                        : undefined
                  }
                >
                  {line.type === 'hunk' ? (
                    <td className="ls-diff__hunk" colSpan={4}>
                      {line.content}
                    </td>
                  ) : (
                    <>
                      <td className="ls-diff__lineno" aria-hidden="true">
                        {line.oldNo ?? ''}
                      </td>
                      <td className="ls-diff__lineno" aria-hidden="true">
                        {line.newNo ?? ''}
                      </td>
                      <td
                        className="ls-diff__sign"
                        aria-hidden="true"
                      >
                        {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ''}
                      </td>
                      <td>
                        <span className="ls-sr-only">
                          {line.type === 'add' ? 'Added line: ' : line.type === 'del' ? 'Removed line: ' : ''}
                        </span>
                        {line.content || ' '}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
}
