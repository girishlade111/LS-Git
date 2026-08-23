import { forwardRef, useId, type InputHTMLAttributes } from 'react'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Visible label rendered above the field. Required unless an external label/aria-label is provided. */
  label?: string
  hint?: string
  error?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, hint, error, id: idProp, ...rest }, ref) => {
    const autoId = useId()
    const id = idProp ?? autoId
    const hintId = `${id}-hint`
    const errorId = `${id}-error`
    return (
      <div className="ls-field">
        {label && (
          <label className="ls-field__label" htmlFor={id}>
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={id}
          className="ls-input"
          aria-invalid={error ? true : undefined}
          aria-describedby={[hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined}
          {...rest}
        />
        {hint && (
          <span className="ls-field__hint" id={hintId}>
            {hint}
          </span>
        )}
        {error && (
          <span className="ls-field__error" id={errorId} role="alert">
            {error}
          </span>
        )}
      </div>
    )
  },
)
Input.displayName = 'Input'
