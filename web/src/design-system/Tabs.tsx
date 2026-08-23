import { useId, useRef, type ReactNode } from 'react'

export interface TabItem {
  id: string
  label: ReactNode
  content?: ReactNode
}

export interface TabsProps {
  items: TabItem[]
  value: string
  onChange: (id: string) => void
  'aria-label': string
}

/**
 * ARIA tabs pattern with roving tabindex.
 * Keyboard: ArrowLeft/Right move selection (automatic activation), Home/End jump.
 */
export function Tabs({ items, value, onChange, 'aria-label': ariaLabel }: TabsProps) {
  const uid = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  function onKeyDown(e: React.KeyboardEvent) {
    const index = items.findIndex((t) => t.id === value)
    let next: number | null = null
    if (e.key === 'ArrowRight') next = (index + 1) % items.length
    else if (e.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    if (next !== null) {
      e.preventDefault()
      onChange(items[next].id)
      tabRefs.current[next]?.focus()
    }
  }

  return (
    <div className="ls-tabs">
      <div role="tablist" aria-label={ariaLabel} className="ls-tabs__list" onKeyDown={onKeyDown}>
        {items.map((item) => (
          <button
            key={item.id}
            ref={(el) => {
              tabRefs.current[items.indexOf(item)] = el
            }}
            type="button"
            role="tab"
            id={`${uid}-tab-${item.id}`}
            aria-selected={item.id === value}
            aria-controls={`${uid}-panel-${item.id}`}
            tabIndex={item.id === value ? 0 : -1}
            className="ls-tabs__tab"
            onClick={() => onChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          role="tabpanel"
          id={`${uid}-panel-${item.id}`}
          aria-labelledby={`${uid}-tab-${item.id}`}
          hidden={item.id !== value}
          tabIndex={0}
        >
          {item.id === value && item.content}
        </div>
      ))}
    </div>
  )
}
