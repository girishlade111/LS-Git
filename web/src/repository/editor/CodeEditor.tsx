import { useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { HighlightStyle, bracketMatching, foldGutter, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { closeBrackets } from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'
import { markdown as mdLang } from '@codemirror/lang-markdown'
import { json as jsonLang } from '@codemirror/lang-json'
import { yaml as yamlLang } from '@codemirror/lang-yaml'
import { languageForFile } from '../highlight'

/**
 * CodeMirror 6 editor surface for the LSGit web editor.
 *
 * The visual contract is strict: the editor chrome is QUIET — backgrounds,
 * borders and text reference LSGit design tokens through CSS variables so the
 * mapping stays live with tokens.css. Syntax colors reuse the SAME palette
 * roles (accent / success-muted / danger-muted / secondary); no bright
 * IDE-theme colors are introduced.
 */

const languageCompartment = new Compartment()

const lsHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.moduleKeyword], color: 'var(--ls-accent)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.meta], color: 'var(--ls-text-disabled)' },
  { tag: [t.string, t.special(t.string), t.character], color: 'var(--ls-success-muted)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--ls-success-muted)' },
  { tag: [t.definition(t.variableName)], color: 'var(--ls-text)' },
  { tag: [t.tagName], color: 'var(--ls-danger-muted)' },
  { tag: [t.attributeName], color: 'var(--ls-text)' },
  { tag: [t.heading], color: 'var(--ls-accent)', fontWeight: '600' },
  { tag: [t.link, t.url], color: 'var(--ls-accent)' },
])

function lsThemeExtensions(): Array<ReturnType<typeof EditorView.theme>> {
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
      // Horizontal scrolling preserved — code surfaces never wrap.
      '.cm-content': { whiteSpace: 'pre' },
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
    syntaxHighlighting(lsHighlightStyle),
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
  /** Read-only review surface (diff preview). */
  readOnly?: boolean
}

export function CodeEditor({ value, onChange, fileName, readOnly = false }: CodeEditorProps) {
  const extensions = useMemo(
    () => [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      foldGutter(),
      highlightSelectionMatches(),
      EditorState.allowMultipleSelections.of(true),
      languageCompartment.of(languageExtensionFor(fileName)),
      ...lsThemeExtensions(),
      ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    ],
    [fileName, readOnly],
  )

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
