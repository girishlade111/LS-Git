import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FileTree, type FileTreeNode } from '../design-system/FileTree'
import { DiffViewer } from '../design-system/DiffViewer'

const tree: FileTreeNode[] = [
  {
    name: 'src',
    path: 'src',
    type: 'dir',
    children: [
      { name: 'app.ts', path: 'src/app.ts', type: 'file' },
    ],
  },
  { name: 'README.md', path: 'README.md', type: 'file' },
]

function Harness({ onSelect }: { onSelect?: (n: FileTreeNode) => void }) {
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <FileTree
      nodes={tree}
      selectedPath={selected}
      ariaLabel="Project files"
      onSelect={(n) => {
        setSelected(n.path)
        onSelect?.(n)
      }}
    />
  )
}

describe('FileTree', () => {
  it('renders top-level nodes and expands a directory on click', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const src = screen.getByRole('treeitem', { name: /src/ })
    expect(src).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('treeitem', { name: /app\.ts/ })).not.toBeInTheDocument()

    await user.click(src)
    expect(screen.getByRole('treeitem', { name: /app\.ts/ })).toBeInTheDocument()
    expect(src).toHaveAttribute('aria-expanded', 'true')
  })

  it('selects a file via click and reports the node', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<Harness onSelect={onSelect} />)
    await user.click(screen.getByRole('treeitem', { name: /README/ }))
    await user.click(screen.getByRole('treeitem', { name: /README/ }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: 'README.md' }))
    const readme = screen.getByRole('treeitem', { name: /README/ })
    expect(readme).toHaveAttribute('aria-selected', 'true')
  })

  it('supports keyboard navigation: ArrowRight expands, ArrowDown moves focus', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const srcRow = screen.getByRole('treeitem', { name: /src/ })
    ;(srcRow as HTMLElement).focus()
    await user.keyboard('{ArrowRight}')
    const appRow = screen.getByRole('treeitem', { name: /app\.ts/ })
    await user.keyboard('{ArrowDown}')
    expect(appRow).toHaveFocus()

    // Enter on a file selects it
    await user.keyboard('{Enter}')
    expect(appRow).toHaveAttribute('aria-selected', 'true')

    // ArrowLeft collapses back
    const srcAgain = screen.getByRole('treeitem', { name: /src/ })
    ;(srcAgain as HTMLElement).focus()
    await user.keyboard('{ArrowLeft}')
    expect(srcAgain).toHaveAttribute('aria-expanded', 'false')
  })
})

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
    render(<DiffViewer diff={sampleDiff} />)
    expect(screen.getByText(/Added line:/)).toBeInTheDocument()
    expect(screen.getByText(/Removed line:/)).toBeInTheDocument()
  })
})
