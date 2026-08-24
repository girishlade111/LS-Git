import { useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  bracketMatching, foldGutter, indentOnInput, syntaxHighlighting,
} from '@codemirror/language'
import { closeBrackets } from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import { lintGutter } from '@codemirror/lint'
import { markdown as mdLang } from '@codemirror/lang-markdown'
import { json as jsonLang } from '@codemirror/lang-json'
import { yaml as yamlLang } from '@codemirror/lang-yaml'
import { languageForFile } from '../highlight'

/**
 * CodeMirror 6 editor surface for the LSGit web IDE.
 *
 * The visual contract is strict: the editor chrome is QUIET — backgrounds,
 * borders and text use only LSGit token values (via CSS variables so the
 * mapping stays live). Syntax colors come from a small one-of-each-role
 * selection highlighter that maps to the same palette roles; no bright
 * IDE-theme colors are introduced.
 */

const languageCompartment = new Compartment()

// Token-role → palette-role mapping (values live in tokens.css).
const lsHighlight = syntaxHighlighting(
  EditorView.theme({
    '&': { color: 'var(--ls-text)' },
    '.ͼb': { color: 'var(--ls-accent)' },   // keywords/operators emphasis
    '.ͼc': { color: 'var(--ls-text-secondary)' }, // comments/meta
    '.ͼd': { color: 'var(--ls-success-muted)' }, // strings/atoms
    '.ͼe': { color: 'var(--ls-danger-muted)' },  // invalid/tags
    '.ͼf': { color: 'var(--ls-accent)' },
    '.ͼg': { color: 'var(--ls-text)' },
  }),
)

function lsThemeExtensions(): ReturnType<typeof EditorView.theme>[] {
  return [
    EditorView.theme({
      '&': {
        backgroundColor: 'var(--ls-panel)',
        color: 'var(--ls-text)',
        height: '100%',
        fontSize: '13px',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': {
        fontFamily: 'var(--ls-font-mono)',
        lineHeight: '21px',
        overflow: 'auto',
      },
      '.cm-gutters': {
        backgroundColor: 'var(--ls-panel)',
        color: 'var(--ls-text-disabled)',
        border: 'none',
        borderRight: '1px solid var(--ls-border)',
      },
      '.cm-activeLineGutter': { backgroundColor: 'var(--ls-surface-1)', color: 'var(--ls-text-secondary)' },
      '.cm-activeLine': { backgroundColor: 'rgba(232, 232, 232, 0.04)' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'var(--ls-tint-accent) !important',
      },
      '.cm-cursor': { borderLeftColor: 'var(--ls-accent)', borderLeftWidth: '2px' },
      '.cm-matchingBracket': { backgroundColor: 'var(--ls-hover-strong)', outline: 'none' },
      '.cm-foldGutter span': { color: 'var(--ls-text-disabled)' },
      '.cm-tooltip': {
        backgroundColor: 'var(--ls-panel)',
        border: '1px solid var(--ls-border)',
        borderRadius: '5px',
      },
    }, { dark: true }),
    lsHighlight,
  ]
}

function languageExtensionFor(fileName: string) {
  switch (languageForFile(fileName)) {
    case 'markdown': return mdLang()
    case 'json': return jsonLang()
    case 'yaml': return yamlLang()
    default: return []
  }
}

export interface CodeEditorProps {
  value: string
  onChange: (next: string) => void
  fileName: string
  /** Read-only preview mode (diff review). */
  readOnly?: boolean
}

export function CodeEditor({ value, onChange, fileName, readOnly = false }: CodeEditorProps) {
  const extensions = useMemo(() => [
    lineWrappingOff(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    foldGutter(),
    highlightSelectionMatches(),
    ...(typeof lintGutter === 'function' ? [] : []),
    EditorState.allowMultipleSelections.of(true),
    languageCompartment.of(languageExtensionFor(fileName)),
    ...lsThemeExtensions(),
    ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [fileName, readOnly])

  return (
    <div className="ls-editor" data-testid="code-editor">
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        editable={!readOnly}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          autocompletion: false,
        }}
      />
    </div>
  )
}

function lineWrappingOff() {
  // Horizontal scrolling preserved: no line wrapping in code surfaces.
  return EditorView.theme({ '.cm-content': { whiteSpace: 'pre' } })
}
