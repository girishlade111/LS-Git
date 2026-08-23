import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DiffViewer } from '../design-system/DiffViewer'

const sampleDiff = `diff --git a/src/app.ts b/src/app.ts
index 83db48f..bf269f4 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 import { start } from './server'
+import { config } from './config'

 function main() {
-  start(3000)
+  start(config.port)
 }`

describe('DiffViewer', () => {
  it('parses files, hunks, additions, and deletions', () => {
    render(<DiffViewer diff={sampleDiff} />)

    expect(screen.getByText('src/app.ts')).toBeInTheDocument()
    expect(screen.getByText(/@@ -1,4 \+1,5 @@/)).toBeInTheDocument()

    const added = screen.getByText("import { config } from './config'")
    expect(added.closest('tr')).toHaveClass('ls-diff__row--add')

    const removed = screen.getByText('start(3000)')
    expect(removed.closest('tr')).toHaveClass('ls-diff__row--del')
  })

  it('announces line changes to screen readers', () => {
    const { container } = render(<DiffViewer diff={sampleDiff} />)
    const notes = Array.from(container.querySelectorAll('.ls-sr-only')).map((n) => n.textContent)
    expect(notes.some((t) => t?.startsWith('Added line:'))).toBe(true)
    expect(notes.some((t) => t?.startsWith('Removed line:'))).toBe(true)
  })
})
