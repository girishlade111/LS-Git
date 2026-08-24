import { Fragment, type ReactNode } from 'react'
import { highlightLine, languageForFile } from './highlight'

/**
 * Minimal, SAFE Markdown renderer for the repository browser.
 *
 * Builds React elements only — there is no `dangerouslySetInnerHTML` anywhere
 * and no raw HTML pass-through, so stored-XSS via file content is impossible
 * by construction. Supported: headings, paragraphs, bold/italic/inline-code/
 * links, fenced code blocks (highlighted), unordered/ordered lists,
 * blockquotes, horizontal rules. Everything else degrades to plain text.
 */

export function renderMarkdown(source: string): ReactNode {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]!

    // Fenced code block.
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      const lang = fence[1] ?? ''
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!)
        i++
      }
      i++ // closing fence (or EOF)
      out.push(<CodeFence key={key++} code={body.join('\n')} lang={lang} />)
      continue
    }

    // Heading.
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1]!.length
      const content = inline(h[2]!)
      out.push(
        level <= 2
          ? <h3 key={key++} className="ls-md__heading ls-md__heading--major">{content}</h3>
          : <h4 key={key++} className="ls-md__heading">{content}</h4>,
      )
      i++
      continue
    }

    // Horizontal rule.
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push(<hr key={key++} className="ls-md__hr" />)
      i++
      continue
    }

    // Blockquote.
    if (/^>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^>\s?/, ''))
        i++
      }
      out.push(
        <blockquote key={key++} className="ls-md__quote">
          {renderMarkdown(quote.join('\n'))}
        </blockquote>,
      )
      continue
    }

    // Lists (one nesting level).
    const bullet = /^\s*[-*+]\s+/
    const ordered = /^\s*\d+[.)]\s+/
    if (bullet.test(line) || ordered.test(line)) {
      const isOrdered = ordered.test(line)
      const items: string[] = []
      while (i < lines.length && (isOrdered ? ordered : bullet).test(lines[i]!)) {
        items.push(lines[i]!.replace(isOrdered ? ordered : bullet, ''))
        i++
      }
      const children = items.map((item, idx) => <li key={idx}>{inline(item)}</li>)
      out.push(
        isOrdered
          ? <ol key={key++} className="ls-md__list">{children}</ol>
          : <ul key={key++} className="ls-md__list">{children}</ul>,
      )
      continue
    }

    // Blank line.
    if (line.trim() === '') {
      i++
      continue
    }

    // Paragraph — consecutive non-special lines.
    const para: string[] = [line]
    i++
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^(#{1,6})\s|^>|^\s*[-*+]\s|^\s*\d+[.)]\s|^```/.test(lines[i]!)
    ) {
      para.push(lines[i]!)
      i++
    }
    out.push(<p key={key++} className="ls-md__p">{inline(para.join(' '))}</p>)
  }

  return <div className="ls-md">{out}</div>
}

function CodeFence({ code, lang }: { code: string; lang: string }) {
  return (
    <pre className="ls-md__code" aria-label="Code block">
      <code>
        {code.split('\n').map((lineText, idx) => (
          <span key={idx} className="ls-md__codeline">
            {highlightLine(lineText, languageForFile(lang ? `f.${lang}` : 'f.txt')).map((tok, tIdx) => (
              <span key={tIdx} className={`ls-tok--${tok.kind}`}>{tok.text}</span>
            ))}
            {'\n'}
          </span>
        ))}
      </code>
    </pre>
  )
}

/** Inline formatting: links (safe protocols only), code spans, bold, italic. */
function inline(text: string): ReactNode {
  const nodes: ReactNode[] = []
  // Order matters: code spans first so their contents are not further parsed.
  const pattern = /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) nodes.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>)
    const tok = m[0]
    if (tok.startsWith('`')) {
      nodes.push(<code key={k++} className="ls-md__inlinecode">{tok.slice(1, -1)}</code>)
    } else if (tok.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!
      const href = safeHref(link![2]!)
      if (href) {
        nodes.push(<a key={k++} href={href} className="ls-md__link">{link![1]}</a>)
      } else {
        nodes.push(<Fragment key={k++}>{link![1]}</Fragment>)
      }
    } else {
      const inner = tok.slice(2, -2)
      nodes.push(<strong key={k++}>{inner}</strong>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) nodes.push(<Fragment key={k++}>{text.slice(last)}</Fragment>)
  return nodes
}

function safeHref(href: string): string | null {
  if (/^(https?:\/\/|\/|#|\.\/)/i.test(href)) return href
  // Bare relative links like (docs/guide.md) are allowed.
  if (!/[\s"'<>]/.test(href) && !href.includes(':')) return href
  return null
}
