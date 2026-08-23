const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function getFocusable(container: HTMLElement): HTMLElement[] {
  // Note: no visibility filtering — layout APIs (offsetParent) are unavailable in
  // jsdom and hidden overlays are managed by conditional rendering anyway.
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
}

/** Traps Tab keydown inside `container`. Attach to the container's onKeyDown. */
export function trapTabKey(e: React.KeyboardEvent, container: HTMLElement) {
  if (e.key !== 'Tab') return
  const items = getFocusable(container)
  if (items.length === 0) {
    e.preventDefault()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement as HTMLElement | null

  if (e.shiftKey && (active === first || !container.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (active === last || !container.contains(active))) {
    e.preventDefault()
    first.focus()
  }
}
