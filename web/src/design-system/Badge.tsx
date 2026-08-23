import type { ReactNode } from 'react'

export type BadgeVariant = 'neutral' | 'success' | 'danger' | 'accent'

export function Badge({
  variant = 'neutral',
  children,
}: {
  variant?: BadgeVariant
  children: ReactNode
}) {
  return (
    <span className={['ls-badge', variant !== 'neutral' && `ls-badge--${variant}`].filter(Boolean).join(' ')}>
      {children}
    </span>
  )
}
