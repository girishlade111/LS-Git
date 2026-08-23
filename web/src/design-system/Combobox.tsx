import {
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
} from 'react'
import { Icon } from './Icon'

export interface ComboboxOption {
  value: string
  label: string
  description?: string
}

export interface ComboboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'size'> {
  options: ComboboxOption[]
  value: string | null
  onChange: (value: string) => void
  /** Accessible name when no external label is associated. */
  label: string
  emptyMessage?: string
}

/**
 * ARIA 1.2 combobox: editable input + listbox popup with aria-activedescendant.
 * Keyboard: ArrowDown/Up navigate (wrap), Enter selects active, Escape reverts/closes,
 * Home/End jump. Clicking outside closes.
 */
export function Combobox({
  options,
  value,
  onChange,
  label,
  emptyMessage = 'No matches found',
  placeholder,
  disabled,
  ...rest
}: ComboboxProps) {
  const uid = useId()
  const listboxId = `${uid}-listbox`
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)

  const selected = options.find((o) => o.value === value) ?? null

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const filtered = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options

  function openListbox() {
    if (disabled || open) return
    setOpen(true)
    setActiveIndex(filtered.length > 0 ? Math.max(0, filtered.findIndex((o) => o.value === value)) : -1)
  }

  function select(option: ComboboxOption) {
    onChange(option.value)
    setQuery('')
    setOpen(false)
    inputRef.current?.focus()
  }

  function commitActive() {
    const opt = filtered[activeIndex]
    if (opt) select(opt)
  }

  return (
    <div className="ls-combobox" ref={rootRef}>
      <div className="ls-field__control">
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && activeIndex >= 0 ? `${uid}-opt-${activeIndex}` : undefined}
          aria-label={label}
          autoComplete="off"
          className="ls-input"
          value={open ? query : (selected?.label ?? '')}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value)
            setActiveIndex(0)
            if (!open) setOpen(true)
          }}
          onFocus={openListbox}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              open ? setActiveIndex((i) => Math.min(i + 1, filtered.length - 1)) : openListbox()
              if (open && !filtered.length) setActiveIndex(-1)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActiveIndex((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Home' && open) {
              e.preventDefault()
              setActiveIndex(0)
            } else if (e.key === 'End' && open) {
              e.preventDefault()
              setActiveIndex(filtered.length - 1)
            } else if (e.key === 'Enter' && open) {
              e.preventDefault()
              commitActive()
            } else if (e.key === 'Escape' && open) {
              e.preventDefault()
              setOpen(false)
              setQuery('')
            }
          }}
          {...rest}
        />
        <span className="ls-field__chevron">
          <Icon name="chevron-down" size={14} />
        </span>
      </div>
      {open && (
        <ul className="ls-combobox__listbox" role="listbox" id={listboxId}>
          {filtered.length === 0 && (
            <li className="ls-combobox__empty" role="option" aria-selected={false} aria-disabled="true">
              {emptyMessage}
            </li>
          )}
          {filtered.map((o, i) => (
            <li key={o.value}>
              <button
                type="button"
                role="option"
                id={`${uid}-opt-${i}`}
                aria-selected={o.value === value}
                data-active={i === activeIndex}
                className="ls-combobox__option"
                // Prevent blur before click registers.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(o)}
                onMouseEnter={() => setActiveIndex(i)}
              >
                {o.label}
                {o.description && (
                  <span className="ls-field__hint" style={{ marginLeft: 'auto' }}>
                    {o.description}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
