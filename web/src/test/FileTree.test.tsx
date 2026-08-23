import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FileTree, type FileTreeNode } from '../design-system/FileTree'

const tree: FileTreeNode[] = [
  {
    name: 'src',
    path: 'src',
    type: 'dir',
    children: [{ name: 'app.ts', path: 'src/app.ts', type: 'file' }],
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
    // First click expands nothing (file); it selects and calls back.
    await user.click(screen.getByRole('treeitem', { name: /README/ }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: 'README.md' }))
    expect(screen.getByRole('treeitem', { name: /README/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('supports keyboard navigation: expand, move focus, select, collapse', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const srcRow = screen.getByRole('treeitem', { name: /src/ })
    ;(srcRow as HTMLElement).focus()
    await user.keyboard('{ArrowRight}') // expand src

    const appRow = screen.getByRole('treeitem', { name: /app\.ts/ })
    await user.keyboard('{ArrowDown}')
    expect(appRow).toHaveFocus()

    await user.keyboard('{Enter}') // select file
    expect(appRow).toHaveAttribute('aria-selected', 'true')

    const srcAgain = screen.getByRole('treeitem', { name: /src/ })
    ;(srcAgain as HTMLElement).focus()
    await user.keyboard('{ArrowLeft}') // collapse
    expect(srcAgain).toHaveAttribute('aria-expanded', 'false')
  })
})
