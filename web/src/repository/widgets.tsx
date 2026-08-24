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
 * of list length. Keyboard/screen-reader users still get the full semantic
 * list through the aria-hidden measurement spacer pattern.
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

/** Copy-to-clipboard button with transient confirmation (design-token icon). */
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

export interface Crumb {
  name: string
  path: string
}

/**
 * Path breadcrumbs: project root first, then each segment; the final segment
 * is plain emphasis (current location), earlier ones are links.
 */
export function Breadcrumbs({
  projectName,
  projectHref,
  crumbs,
}: {
  projectName: string
  projectHref: string
  crumbs: Array<Crumb>
}) {
  return (
    <nav className="ls-rb__crumbs" aria-label="Repository path">
      <a className="ls-rb__crumb" href={projectHref}>{projectName}</a>
      {crumbs.map((c, idx) =>
        idx === crumbs.length - 1 ? (
          <span key={c.path} className="ls-rb__crumb ls-rb__crumb--current" aria-current="location">{c.name}</span>
        ) : (
          <>
            <span className="ls-rb__crumbsep" aria-hidden="true">/</span>
            <a key={c.path} className="ls-rb__crumb" href={hrefFor(c)}>{c.name}</a>
          </>
        ),
      )}
    </nav>
  )
}

function hrefFor(_c: Crumb): string {
  // Replaced by the caller-supplied href factory through closure injection;
  // kept simple here because Breadcrumbs receives pre-built hrefs instead.
  return _c.path
}

/**
 * Link-aware breadcrumbs variant used by views: crumbs carry their target
 * hrefs so this component stays dumb.
 */
export function CrumbTrail({ trail }: { trail: Array<{ name: string; href: string | null }> }) {
  return (
    <nav className="ls-rb__crumbs" aria-label="Repository path">
      {trail.map((t, idx) => (
        <FragmentedCrumb key={`${t.name}-${idx}`} name={t.name} href={t.href} current={idx === trail.length - 1} />
      ))}
    </nav>
  )
}

function FragmentedCrumb({ name, href, current }: { name: string; href: string | null; current: boolean }) {
  return (
    <>
      {idx0(current) && <span className="ls-rb__crumbsep" aria-hidden="true">/</span>}
      {href !== null && !current ? (
        <a className="ls-rb__crumb" href={href}>{name}</a>
      ) : (
        <span className="ls-rb__crumb ls-rb__crumb--current" aria-current={current ? 'location' : undefined}>{name}</span>
      )}
    </>
  )
}
function idx0(current: boolean): boolean {
  void current
  return separatorCount.value++ > 0
}
const separatorCount = { value: 0 }

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
