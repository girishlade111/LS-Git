import { forwardRef, useId, type SelectHTMLAttributes } from 'react'
import { Icon } from './Icon'

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'size'> {
  label?: string
  hint?: string
  options: Array<{ value: string; label: string }>
  placeholder?: string
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, hint, options, placeholder, id: idProp, className, ...rest }, ref) => {
    const autoId = useId()
    const id = idProp ?? autoId
    const hintId = `${id}-hint`
    return (
      <div className="ls-field">
        {label && (
          <label className="ls-field__label" htmlFor={id}>
            {label}
          </label>
        )}
        <div className="ls-field__control">
          <select
            ref={ref}
            id={id}
            className={['ls-select', className].filter(Boolean).join(' ')}
            aria-describedby={hint ? hintId : undefined}
            {...rest}
          >
            {placeholder && (
              <option value="" disabled={rest.required}>
                {placeholder}
              </option>
            )}
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="ls-field__chevron">
            <Icon name="chevron-down" size={14} />
          </span>
        </div>
        {hint && (
          <span className="ls-field__hint" id={hintId}>
            {hint}
          </span>
        )}
      </div>
    )
  },
)
Select.displayName = 'Select'
