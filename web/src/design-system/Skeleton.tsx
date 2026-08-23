export interface SkeletonProps {
  /** Width in px or any CSS width. */
  width?: number | string
  height?: number
  shape?: 'rect' | 'circle' | 'text'
}

/** Decorative loading placeholder. Hidden from assistive tech; pair with an aria-busy container. */
export function Skeleton({ width, height, shape = 'rect' }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={['ls-skeleton', shape !== 'rect' && `ls-skeleton--${shape}`]
        .filter(Boolean)
        .join(' ')}
      style={{
        display: 'inline-block',
        width: typeof width === 'number' ? `${width}px` : (width ?? '100%'),
        height: height ? `${height}px` : undefined,
      }}
    />
  )
}
