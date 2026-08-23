import { useState } from 'react'
import { IconButton } from './IconButton'

export interface CodeBlockProps {
  code: string
  filename?: string
  /** Start line number shown in the gutter. */
  startLine?: number
}

export function CodeBlock({ code, filename, startLine = 1 }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const lines = code.replace(/\n$/, '').split('\n')

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — no-op */
    }
  }

  return (
    <figure className="ls-codeblock" style={{ margin: 0 }}>
      {filename && (
        <figcaption className="ls-codeblock__header">
          <span className="ls-codeblock__file">{filename}</span>
          <IconButton
            label={copied ? 'Copied' : 'Copy contents'}
            icon="copy"
            onClick={copy}
          />
        </figcaption>
      )}
      <pre>
        <code>
          {lines.map((line, i) => (
            <span key={i} style={{ display: 'block', minHeight: '1em' }}>
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-block',
                  width: '2.5em',
                  marginRight: '1em',
                  textAlign: 'right',
                  color: 'var(--ls-text-disabled)',
                  userSelect: 'none',
                }}
              >
                {startLine + i}
              </span>
              {line || ' '}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  )
}
