import { useMemo, useState } from 'react'
import { Icon } from './Icon'

export interface FileTreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: FileTreeNode[]
}

interface FlatRow {
  node: FileTreeNode
  depth: number
}

/** WAI-ARIA tree: roving tabindex, Arrow keys expand/collapse/navigate, Enter selects. */
export function FileTree({
  nodes,
  selectedPath,
  onSelect,
  ariaLabel = 'Files',
}: {
  nodes: FileTreeNode[]
  selectedPath?: string | null
  onSelect?: (node: FileTreeNode) => void
  ariaLabel?: string
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [focusedPath, setFocusedPath] = useState<string | null>(null)

  const rows = useMemo(() => {
    const out: FlatRow[] = []
    function walk(list: FileTreeNode[], depth: number) {
      for (const node of list) {
        out.push({ node, depth })
        if (node.type === 'dir' && expanded.has(node.path)) walk(node.children ?? [], depth + 1)
      }
    }
    walk(nodes, 0)
    return out
  }, [nodes, expanded])

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }

  function currentIndex(): number {
    const key = focusedPath ?? selectedPath ?? null
    return rows.findIndex((r) => r.node.path === key)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const idx = currentIndex()
    const focusIndex = (target: number) => {
      if (rows.length === 0) return
      const clamped = Math.max(0, Math.min(target, rows.length - 1))
      const el = document.querySelector<HTMLElement>(`[data-tree-path="${cssEscape(rows[clamped].node.path)}"]`)
      el?.focus()
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusIndex(currentIndex + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        focusIndex(currentIndex - 1)
        break
      case 'ArrowRight': {
        e.preventDefault()
        const row = rows[currentIndex]
        if (row?.node.type !== 'dir') return
        if (!expanded.has(row.node.path)) toggle(row.node.path)
        else focusIndex(currentIndex + 1)
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        const row = rows[currentIndex]
        if (row?.node.type === 'dir' && expanded.has(row.node.path)) toggle(row.node.path)
        else {
          // Move to parent directory if one exists.
          const parentPath = row?.node.path.split('/').slice(0, -1).join('/')
          if (parentPath) {
            const parentIndex = rows.findIndex((r) => r.node.path === parentPath)
            focusIndex(parentIndex)
          }
        }
        break
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        const row = rows[currentIndex]
        if (!row) return
        row.node.type === 'dir' ? toggle(row.node.path) : onSelect?.(row.node)
        break
      }
    }
  }

  function renderRows(): React.ReactNode {
    return rows.map(({ node, depth }) => (
      <li key={node.path} role="none">
        <div
          role="treeitem"
          data-tree-path={node.path}
          tabIndex={0}
          aria-level={depth + 1}
          aria-selected={node.type === 'file' ? node.path === selectedPath : undefined}
          aria-expanded={node.type === 'dir' ? expanded.has(node.path) : undefined}
          className="ls-treeitem"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={() => (node.type === 'dir' ? toggle(node.path) : onSelect?.(node))}
          onKeyDown={(e) => e.currentTarget.closest('[role="tree"]')?.dispatchEvent(new KeyboardEvent(e.type, { key: e.key }))}
        >
          <span className="ls-treeitem__chev" data-has-children={node.type === 'dir'}>
            <Icon name="chevron-right" size={12} />
          </span>
          <span className="ls-treeitem__icon">
            <Icon name={node.type === 'dir' ? 'folder' : 'file'} size={14} />
          </span>
          <span className="ls-treeitem__name">{node.name}</span>
        </div>
        {node.type === 'dir' && expanded.has(node.path) && (
          <ul role="group" className="ls-treegroup" />
        )}
      </li>
    ))
  }

  return (
    <nav aria-label={ariaLabel}>
      <ul role="tree" className="ls-filetree ls-treegroup" onKeyDown={onKeyDown} aria-activedescendant={undefined}>
        {renderRows()}
      </ul>
    </nav>
  )
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}
