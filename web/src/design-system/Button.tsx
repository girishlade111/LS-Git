import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  iconStart?: IconName
  iconEnd?: IconName
  children?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = 'secondary', size = 'md', iconStart, iconEnd, className, children, ...rest },
    ref,
  ) => (
    <button
      ref={ref}
      className={
        ['ls-btn', `ls-btn--${variant}`, size !== 'md' && `ls-btn--${size}`, className]
          .filter(Boolean)
          .join(' ')
      }
      {...rest}
    >
      {iconStart && <Icon name={iconStart} size={size === 'sm' ? 14 : 16} />}
      {children}
      {iconEnd && <Icon name={iconEnd} size={size === 'sm' ? 14 : 16} />}
    </button>
  ),
)
Button.displayName = 'Button'
