/**
 * LSGit brand mark — commit-graph glyph on the panel tile.
 * Colors come from design tokens so it adapts with the theme.
 */
export function BrandLogo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      aria-hidden="true"
      focusable="false"
      style={{ flex: 'none', borderRadius: 'var(--ls-radius-sm)' }}
    >
      <rect
        x="4"
        y="4"
        width="504"
        height="504"
        rx="112"
        fill="var(--ls-panel)"
        stroke="var(--ls-border)"
        strokeWidth="8"
      />
      <g fill="none" stroke="var(--ls-accent)" strokeWidth="52">
        <line x1="120" y1="72" x2="120" y2="300" />
        <path d="M360 180 A180 180 0 0 1 180 360" />
      </g>
      <circle cx="360" cy="120" r="70" fill="var(--ls-accent)" />
      <circle cx="120" cy="360" r="70" fill="var(--ls-accent)" />
    </svg>
  )
}
