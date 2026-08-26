import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from './IconButton'
import { trapTabKey } from './focus'

function useOverlayA11y(open: boolean, onClose: () => void, ref: React.RefObject<HTMLElement | null>) {
  const previouslyFocused = useRef<HTMLElement | null>(null)
  // Latest-ref pattern: parents pass inline closures that change identity on
  // every render; keying the effect on them would re-run focus management
  // mid-interaction (e.g. steal focus back from a controlled input).
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  useEffect(() => {
    if (!open) return
    previouslyFocused.current = document.activeElement as HTMLElement | null

    // Focus the container (tabIndex=-1) so SR announces the dialog and focus is inside.
    requestAnimationFrame(() => {
      ref.current?.focus()
      const first = ref.current?.querySelector<HTMLElement>(
        '[data-autofocus], button:not([disabled]), input:not([disabled])',
      )
      ;(first ?? ref.current)?.focus()
    })

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      previouslyFocused.current?.focus()
    }
  }, [open, ref])
}

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  footer?: ReactNode
  children: ReactNode
}

/** Modal dialog: portal-rendered, focus-trapped, Escape closes, focus restored on close. */
export function Dialog({ open, onClose, title, description, footer, children }: DialogProps) {
  const uid = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  useOverlayA11y(open, onClose, panelRef)

  if (!open) return null

  return createPortal(
    <div className="ls-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        aria-describedby={description ? `${uid}-desc` : undefined}
        tabIndex={-1}
        className="ls-dialog"
        onKeyDown={(e) => panelRef.current && trapTabKey(e, panelRef.current)}
      >
        <div className="ls-dialog__header">
          <h2 className="ls-dialog__title" id={`${uid}-title`}>
            {title}
          </h2>
          <IconButton label="Close dialog" icon="close" onClick={onClose} />
        </div>
        <div className="ls-dialog__body">
          {description && (
            <p id={`${uid}-desc`} style={{ marginTop: 0 }}>
              {description}
            </p>
          )}
          {children}
        </div>
        {footer && <div className="ls-dialog__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export interface DrawerProps {
  open: boolean
  onClose: () => void
  title?: string
  side?: 'left' | 'right'
  children: ReactNode
}

/** Side drawer: same a11y contract as Dialog. */
export function Drawer({ open, onClose, title, side = 'left', children }: DrawerProps) {
  const uid = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  useOverlayA11y(open, onClose, panelRef)

  if (!open) return null

  return createPortal(
    <>
      <div className="ls-overlay" style={{ zIndex: 94 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Drawer'}
        aria-labelledby={title ? `${uid}-title` : undefined}
        tabIndex={-1}
        className={['ls-drawer', `ls-drawer--${side}`].join(' ')}
        onKeyDown={(e) => panelRef.current && trapTabKey(e, panelRef.current)}
      >
        {title && (
          <div className="ls-drawer__header">
            <h2 className="ls-drawer__title" id={`${uid}-title`}>
              {title}
            </h2>
            <IconButton label="Close drawer" icon="close" onClick={onClose} />
          </div>
        )}
        <div className="ls-drawer__body">{children}</div>
      </div>
    </>,
    document.body,
  )
}
