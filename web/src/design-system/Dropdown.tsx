import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export type MenuItem =
  | { kind: 'item'; id: string; label: ReactNode; icon?: IconName; disabled?: boolean; checked?: boolean }
  | { kind: 'separator' }

export interface DropdownProps {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean }) => ReactNode
  items: MenuItem[]
  onSelect?: (id: string) => void
  align?: 'left' | 'right'
  /** Accessible name for the menu. */
  menuLabel: string
}

/**
 * Menu-button pattern: Enter/Space/ArrowDown opens and focuses first item,
 * ArrowUp focuses last. Arrow keys cycle, Home/End jump, Escape closes and
 * returns focus to the trigger. Click outside closes.
 */
export function Dropdown({ trigger, items, onSelect, align = 'left', menuLabel }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const uid = useId()

  const actionable = items.filter((i) => i.kind === 'item') as Array<
    Extract<MenuItem, { kind: 'item' }>
  >

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function openMenu(focus: 'first' | 'last') {
    setOpen(true)
    requestAnimationFrame(() => {
      const els = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])')
      if (!els || els.length === 0) return
      ;(focus === 'first' ? els[0] : els[els.length - 1]).focus()
    })
  }

  function close(returnFocus = true) {
    setOpen(false)
    if (returnFocus) rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }

  function moveFocus(dir: 1 | -1) {
    const els = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [],
    )
    if (els.length === 0) return
    const idx = els.indexOf(document.activeElement as HTMLButtonElement)
    const next = (idx + dir + els.length) % els.length
    els[next].focus()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        open ? moveFocus(1) : openMenu('first')
        break
      case 'ArrowUp':
        e.preventDefault()
        open ? moveFocus(-1) : openMenu('last')
        break
      case 'Home':
        if (open) {
          e.preventDefault()
          listRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
        }
        break
      case 'End': {
        if (open) {
          e.preventDefault()
          const els = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
          els?.[els.length - 1]?.focus()
        }
        break
      }
      case 'Escape':
        if (open) {
          e.preventDefault()
          e.stopPropagation()
          close()
        }
        break
      case 'Tab':
        if (open) setOpen(false)
        break
    }
  }

  return (
    <div className="ls-dropdown" ref={rootRef} onKeyDown={onKeyDown}>
      {trigger({ onClick: () => (open ? close(false) : openMenu('first')), 'aria-expanded': open })}
      {open && (
        <ul
          ref={listRef}
          role="menu"
          aria-label={menuLabel}
          id={`${uid}-menu`}
          className={['ls-menu', align === 'right' && 'ls-menu--right'].filter(Boolean).join(' ')}
        >
          {items.map((item, i) => {
            if (item.kind === 'separator') return <li key={`sep-${i}`} role="none"><hr className="ls-menu__sep" /></li>
            return (
              <li key={item.id} role="none">
                <button
                  type="button"
                  role={item.checked !== undefined ? 'menuitemradio' : 'menuitem'}
                  aria-checked={item.checked}
                  aria-disabled={item.disabled || undefined}
                  tabIndex={-1}
                  className="ls-menu__item"
                  onClick={() => {
                    if (item.disabled) return
                    onSelect?.(item.id)
                    close()
                  }}
                >
                  {item.icon && <Icon name={item.icon} size={14} />}
                  {item.label}
                  {item.checked !== undefined && (
                    <span className="ls-menu__check">
                      <Icon name="check" size={14} />
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {/* Keep actionable list referenced for keyboard cycling when closed state changes */}
      <span hidden>{actionable.length}</span>
    </div>
  )
}
