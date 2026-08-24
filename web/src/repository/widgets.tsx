import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Combobox, type ComboboxOption } from '../design-system/Combobox'
import { Icon } from '../design-system/Icon'
import { IconButton } from '../design-system/IconButton'

/** Human byte size ("3.2 KB"). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Compact relative timestamp ("3 days ago"). */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const seconds = Math.max(1, Math.floor((Date.now() - then) / 1000))
  const units: Array<[number, string]> = [
    [60, 'second'], [3600, 'minute'], [86400, 'hour'],
    [86400 * 30, 'day'], [86400 * 365, 'month'], [Number.MAX_SAFE_INTEGER, 'year'],
  ]
  let size = 1
  for (const [limit, name] of units) {
    if (seconds < limit) {
      const count = Math.floor(seconds / size)
      return `${count} ${name}${count === 1 ? '' : 's'} ago`
    }
    size = limit
  }
  return ''
}

/**
 * Fixed-row-height windowing for very long lists (large directories, blame).
 * Renders only the visible band plus overscan — the DOM stays small regardless
 * of list length.
 */
export function useVirtualWindow(
  rowCount: number,
  rowHeight: number,
  opts: { overscan?: number; enabled?: boolean } = {},
): {
  containerRef: React.RefObject<HTMLDivElement | null>
  startIndex: number
  endIndex: number
  padTop: number
  padBottom: number
  virtualized: boolean
} {
  const overscan = opts.overscan ?? 8
  const enabled = (opts.enabled ?? true) && rowCount > 200
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(600)

  useEffect(() => {
    if (!enabled || !containerRef.current) return
    const el = containerRef.current
    const onScroll = () => setScrollTop(el.scrollTop)
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(() => setViewport(el.clientHeight))
    ro.observe(el)
    setViewport(el.clientHeight)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [enabled])

  const computed = useMemo(() => {
    if (!enabled) return { startIndex: 0, endIndex: rowCount - 1, padTop: 0, padBottom: 0, virtualized: false }
    const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
    const visibleCount = Math.ceil(viewport / rowHeight) + overscan * 2
    const endIndex = Math.min(rowCount - 1, startIndex + visibleCount)
    return {
      startIndex,
      endIndex,
      padTop: startIndex * rowHeight,
      padBottom: Math.max(0, (rowCount - endIndex - 1) * rowHeight),
      virtualized: true,
    }
  }, [enabled, rowCount, rowHeight, scrollTop, viewport, overscan])

  return { containerRef, ...computed }
}

/** Copy-to-clipboard button with transient confirmation (design-token icons). */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // Clipboard API unavailable (permissions/insecure context): fallback.
      const ta = document.createElement('textarea')
      ta.value = value
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* give up quietly */ }
      ta.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }, [value])

  return (
    <IconButton
      label={copied ? 'Copied' : label}
      icon={copied ? 'check' : 'copy'}
      onClick={() => void copy()}
      aria-pressed={copied}
    />
  )
}

export interface CrumbItem {
  name: string
  href: string | null
}

/**
 * Path breadcrumbs: segments joined with '/', the FINAL segment rendered as
 * the current location (not a link).
 */
export function CrumbTrail({ trail }: { trail: CrumbItem[] }) {
  return (
    <nav className="ls-rb__crumbs" aria-label="Repository path">
      {trail.map((t, idx) => {
        const last = idx === trail.length - 1
        return (
          <span key={`${t.name}-${idx}`} className="ls-rb__crumbwrap">
            {idx > 0 && <span className="ls-rb__crumbsep" aria-hidden="true">/</span>}
            {!last && t.href !== null ? (
              <a className="ls-rb__crumb" href={t.href}>{t.name}</a>
            ) : (
              <span className="ls-rb__crumb ls-rb__crumb--current" aria-current={last ? 'location' : undefined}>
                {t.name}
              </span>
            )}
          </span>
        )
      })}
    </nav>
  )
}

/** Change-kind chip for history/commit file lists — subtle tint states only. */
export function KindBadge({ kind }: { kind: 'added' | 'modified' | 'deleted' }) {
  return (
    <span className={`ls-rb__kind ls-rb__kind--${kind}`}>
      {kind === 'added' ? 'A' : kind === 'modified' ? 'M' : 'D'}
      <span className="ls-visually-hidden"> {kind}</span>
    </span>
  )
}

/** Branch/tag selector built on the ARIA combobox primitive. */
export function RefSelector({
  branches,
  tags,
  current,
  onChange,
}: {
  branches: Array<{ name: string; sha: string; default: boolean }>
  tags: Array<{ name: string }>
  current: string
  onChange: (refName: string) => void
}) {
  const options: ComboboxOption[] = useMemo(() => [
    ...branches.map((b) => ({
      value: b.name,
      label: b.name,
      ...(b.default ? { description: 'default branch' } : {}),
    })),
    ...tags.map((t) => ({ value: t.name, label: t.name, description: 'tag' })),
  ], [branches, tags])

  return (
    <div className="ls-rb__refs">
      <Icon name="branch" size={14} />
      <Combobox
        options={options}
        value={current}
        onChange={(v) => onChange(v)}
        label="Switch branch or tag"
        placeholder={current}
      />
    </div>
  )
}
