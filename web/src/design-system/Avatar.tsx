import { useState } from 'react'

export interface AvatarProps {
  name: string
  src?: string
  size?: 'sm' | 'md' | 'lg'
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?'
}

export function Avatar({ name, src, size = 'md' }: AvatarProps) {
  const [failed, setFailed] = useState(false)
  return (
    <span
      className={['ls-avatar', size !== 'md' && `ls-avatar--${size}`].filter(Boolean).join(' ')}
      role="img"
      aria-label={name}
      title={name}
    >
      {src && !failed ? (
        <img src={src} alt="" onError={() => setFailed(true)} />
      ) : (
        initials(name)
      )}
    </span>
  )
}
