import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

export interface EmptyStateProps {
  icon?: IconName
  title: string
  description?: string
  action?: ReactNode
}

/** Empty/zero-data state for lists, tables, and views. */
export function EmptyState({ icon = 'file', title, description, action }: EmptyStateProps) {
  return (
    <div className="ls-empty">
      <span className="ls-empty__icon">
        <Icon name={icon} size={28} />
      </span>
      <div className="ls-empty__title">{title}</div>
      {description && <div className="ls-empty__desc">{description}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  )
}
