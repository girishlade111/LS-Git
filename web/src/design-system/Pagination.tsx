import { useMemo } from 'react'
import { Icon } from './Icon'

export interface PaginationProps {
  /** 1-based current page. */
  page: number
  pageCount: number
  onChange: (page: number) => void
}

function pageItems(page: number, count: number): Array<number | 'ellipsis'> {
  return useMemo(() => {
    if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1)
    const items: Array<number | 'ellipsis'> = [1]
    const start = Math.max(2, page - 1)
    const end = Math.min(count - 1, page + 1)
    if (start > 2) items.push('ellipsis')
    for (let p = start; p <= end; p++) items.push(p)
    if (end < count - 1) items.push('ellipsis')
    items.push(count)
    return items
  }, [page, count])
}

/** Accessible pagination: landmark nav, aria-current on the active page. */
export function Pagination({ page, pageCount, onChange }: PaginationProps) {
  const items = pageItems(page, pageCount)

  function go(target: number) {
    if (target >= 1 && target <= pageCount && target !== page) onChange(target)
  }

  return (
    <nav className="ls-pagination" aria-label="Pagination">
      <button
        type="button"
        className="ls-pagination__page"
        disabled={page === 1}
        aria-label="Previous page"
        onClick={() => go(page - 1)}
      >
        <Icon name="chevron-left" size={14} />
      </button>
      {items.map((item, i) =>
        item === 'ellipsis' ? (
          <span key={`e${i}`} className="ls-pagination__ellipsis" aria-hidden="true">
            …
          </span>
        ) : (
          <button
            key={item}
            type="button"
            className="ls-pagination__page"
            aria-current={item === page ? 'page' : undefined}
            aria-label={`Page ${item}`}
            onClick={() => go(item)}
          >
            {item}
          </button>
        ),
      )}
      <button
        type="button"
        className="ls-pagination__page"
        disabled={page === pageCount}
        aria-label="Next page"
        onClick={() => go(page + 1)}
      >
        <Icon name="chevron-right" size={14} />
      </button>
    </nav>
  )
}
