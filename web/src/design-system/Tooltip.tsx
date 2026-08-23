import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export interface TooltipProps {
  content: ReactNode
  children: ReactNode
  /** Delay before showing, ms. */
  delay?: number
}

/**
 * Shows on hover and keyboard focus; hides on Escape. The bubble is wired to
 * the trigger via aria-describedby. Content should be short — it is also
 * announced by screen readers from the described-by link.
 */
export function Tooltip({ content, children, delay = 300 }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = useId()

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  function show() {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setVisible(true), delay)
  }
  function hide() {
    if (timer.current) clearTimeout(timer.current)
    setVisible(false)
  }

  return (
    <span
      className="ls-tooltip"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
      onKeyDown={(e) => e.key === 'Escape' && hide()}
    >
      <span aria-describedby={visible ? id : undefined} style={{ display: 'inline-flex' }}>
        {children}
      </span>
      {visible && (
        <span role="tooltip" id={id} className="ls-tooltip__bubble">
          {content}
        </span>
      )}
    </span>
  )
}
