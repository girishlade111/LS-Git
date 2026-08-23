import type { ReactNode } from 'react'

export interface ActivityItemProps {
  /** Leading visual: Avatar, Icon wrapper, or any node. */
  leading?: ReactNode
  title: ReactNode
  description?: ReactNode
  /** Right-aligned timestamp or metadata. */
  meta?: ReactNode
}

export function ActivityItem({ leading, title, description, meta }: ActivityItemProps) {
  return (
    <article className="ls-activity">
      {leading && <span style={{ flex: 'none', display: 'inline-flex' }}>{leading}</span>}
      <div className="ls-activity__body">
        <div className="ls-activity__title">{title}</div>
        {description && <div className="ls-activity__desc">{description}</div>}
      </div>
      {meta && <div className="ls-activity__time">{meta}</div>}
    </article>
  )
}
