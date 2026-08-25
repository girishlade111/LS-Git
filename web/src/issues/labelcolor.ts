/**
 * Label color presentation contract.
 *
 * Users may pick ANY valid hex color — but the UI never paints raw user
 * colors at full strength. Chips render the hue as a low-alpha tint over the
 * panel surface with a hairline border; text stays the standard token
 * (--ls-text). A neon #00ff00 input reads as a calm tinted chip, so
 * user-defined colors can never violate the product palette.
 */

export interface LabelTint {
  /** Background fill: user hue composited at fixed low alpha. */
  background: string
  /** Hairline border: same hue, slightly stronger alpha. */
  border: string
  /** Always a design token, never the raw user color. */
  text: 'var(--ls-text)'
}

const TINT_ALPHA = 0.16
const BORDER_ALPHA = 0.45

/** Parses #rgb / #rrggbb into r,g,b (0-255); null when invalid. */
export function parseHex(hex: string): { r: number; g: number; b: number } | null {
  let v = hex.trim().toLowerCase()
  if (!v.startsWith('#')) v = `#${v}`
  if (/^#[0-9a-f]{3}$/.test(v)) {
    v = `#${[1, 2, 3].map((i) => `${v[i]}${v[i]}`).join('')}`
  }
  if (!/^#[0-9a-f]{6}$/.test(v)) return null
  return {
    r: parseInt(v.slice(1, 3), 16),
    g: parseInt(v.slice(3, 5), 16),
    b: parseInt(v.slice(5, 7), 16),
  }
}

export function labelTint(color: string): LabelTint {
  const rgb = parseHex(color)
  if (!rgb) {
    // Fallback: neutral chip using border-token colors.
    return {
      background: 'var(--ls-surface-2)',
      border: 'var(--ls-border)',
      text: 'var(--ls-text)',
    }
  }
  const { r, g, b } = rgb
  return {
    background: `rgba(${r}, ${g}, ${b}, ${TINT_ALPHA})`,
    border: `rgba(${r}, ${g}, ${b}, ${BORDER_ALPHA})`,
    text: 'var(--ls-text)',
  }
}
