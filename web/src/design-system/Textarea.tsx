import { forwardRef, useId, type TextareaHTMLAttributes } from 'react'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  hint?: string
  error?: string
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, hint, error, id: idProp, className, ...rest }, ref) => {
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
        <textarea
          ref={ref}
          id={id}
          className={['ls-textarea', className].filter(Boolean).join(' ')}
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
Textarea.displayName = 'Textarea'
