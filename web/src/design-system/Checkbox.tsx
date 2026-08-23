import { forwardRef, useId, type InputHTMLAttributes } from 'react'

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, id: idProp, className, ...rest }, ref) => {
    const autoId = useId()
    const id = idProp ?? autoId
    return (
      <span className={['ls-checkbox', className].filter(Boolean).join(' ')}>
        <input ref={ref} id={id} type="checkbox" {...rest} />
        {label && <label htmlFor={id}>{label}</label>}
      </span>
    )
  },
)
Checkbox.displayName = 'Checkbox'
