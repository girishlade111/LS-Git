import { labelTint } from './labelcolor'
import type { LabelRef } from './api'

/**
 * Label chip — the ONLY sanctioned way to render a user-defined color.
 * The hue appears as a fixed-alpha tint + hairline border; text and radius
 * come from design tokens, so arbitrary/neon colors stay inside the palette.
 */
export function LabelChip({ label }: { label: LabelRef | string }) {
  const title = typeof label === 'string' ? label : label.title
  const color = typeof label === 'string' ? label : label.color
  const tint = labelTint(color)
  return (
    <span
      className="ls-labelchip"
      style={{ background: tint.background, borderColor: tint.border, color: tint.text }}
    >
      {title}
    </span>
  )
}
