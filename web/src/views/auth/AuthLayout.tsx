import { useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '../../design-system/Button'

/** Centered dense auth card — same token system as the shell, no new styles. */
export function AuthLayout({
  title,
  description,
  children,
  footer,
  onSubmit,
  busy = false,
}: {
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  onSubmit?: () => void | Promise<void>
  busy?: boolean
}) {
  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!onSubmit || busy) return
    void onSubmit()
  }
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: 'var(--ls-bg)',
      }}
    >
      <div style={{ width: 380 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <span className="ls-sidebar__brand-mark" aria-hidden="true">
            LS
          </span>
          <span style={{ fontSize: 'var(--ls-fs-row)', fontWeight: 600 }}>LSGit</span>
        </div>
        <h1 style={{ marginBottom: 4 }}>{title}</h1>
        {description && <p className="ls-page-desc">{description}</p>}
        <div className="ls-card" style={{ padding: 20 }}>
          <form onSubmit={handleSubmit}>
            <div className="ds-stack">{children}</div>
          </form>
        </div>
        {footer && (
          <div style={{ marginTop: 12, fontSize: 'var(--ls-fs-desc)', color: 'var(--ls-text-secondary)' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

export function SubmitButton({ label }: { label: string; busy?: boolean }) {
  return (
    <Button type="submit" variant="primary" disabled={false} style={{ width: '100%', justifyContent: 'center' }}>
      {label}
    </Button>
  )
}

export function FieldError({ message }: { message?: string | null }) {
  if (!message) return null
  return (
    <p role="alert" style={{ fontSize: 'var(--ls-fs-desc)', color: 'var(--ls-danger)' }}>
      {message}
    </p>
  )
}

export function useAsyncSubmit(): {
  busy: boolean
  error: string | null
  run: (fn: () => Promise<void>) => Promise<void>
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}
