import { forwardRef, type ButtonHTMLAttributes } from 'react'

export interface ToggleProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'children'> {
  checked: boolean
  onChange?: (checked: boolean) => void
  /** Visible label text rendered next to the switch. */
  label?: string
}

export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(
  ({ checked, onChange, label, className, ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      className={['ls-toggle', className].filter(Boolean).join(' ')}
      onClick={(e) => {
        rest.onClick?.(e)
        if (!e.defaultPrevented) onChange?.(!checked)
      }}
      {...rest}
    >
      <span className="ls-toggle__track" aria-hidden="true">
        <span className="ls-toggle__thumb" />
      </span>
      {label}
    </button>
  ),
)
Toggle.displayName = 'Toggle'
