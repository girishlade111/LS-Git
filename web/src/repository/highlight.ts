/**
 * Dependency-free syntax highlighting for the repository browser.
 *
 * Produces token spans styled EXCLUSIVELY with LSGit design tokens
 * (--ls-accent / --ls-success / --ls-danger / --ls-text-secondary) — no new
 * hues, no theme system. Supported: JS/TS/JSX/TSX, JSON, YAML, CSS, HTML/XML,
 * Markdown fences, Python, Ruby, Go, Rust, Shell, SQL, INI/TOML/Dockerfile.
 * Unknown languages render as plain text — highlighting must never corrupt
 * content, so every rule is fail-safe by construction.
 */

export type TokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'key' | 'tag' | 'heading'

export interface Token {
  kind: TokenKind
  text: string
}

const KEYWORDS = new Set([
  // C-family / JS / TS / Go / Rust
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
  'continue', 'crate', 'debugger', 'def', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'fn', 'for', 'from', 'func',
  'function', 'go', 'if', 'impl', 'implements', 'import', 'in', 'instanceof',
  'interface', 'let', 'loop', 'match', 'mod', 'mut', 'new', 'null', 'nullptr',
  'package', 'private', 'protected', 'pub', 'public', 'raise', 'readonly',
  'require', 'return', 'self', 'Self', 'static', 'struct', 'super', 'switch',
  'this', 'throw', 'trait', 'true', 'try', 'type', 'typeof', 'union', 'unsafe',
  'use', 'var', 'void', 'while', 'with', 'yield',
  'end', 'elsif', 'unless', 'then', 'begin', 'nil', 'lambda', 'pass', 'elif',
  'None', 'True', 'False', 'and', 'or', 'not', 'is',
])

interface LangSpec {
  lineComment?: RegExp
  blockComment?: [RegExp, string]
  strings?: Array<{ start: RegExp; end: string; escape: boolean }>
}

const SPECS: Record<string, LangSpec> = {
  clike: {
    lineComment: /^\/\/.*/,
    blockComment: [/^\/\*/, '*/'],
    strings: [
      { start: /^"(?:[^"\\\n]|\\.)*"?/, end: '"', escape: true },
      { start: /^'(?:[^'\\\n]|\\.)*'?/, end: "'", escape: true },
      { start: /^`(?:[^`\\]|\\.)*`?/, end: '`', escape: true },
    ],
  },
  python: {
    lineComment: /^#.*/,
    strings: [
      { start: /^(?:[rbfu]{0,2})?"{3}[\s\S]*?(?:"{3}|$)/, end: '"""', escape: false },
      { start: /^(?:[rbfu]{0,2})?'{3}[\s\S]*?(?:'{3}|$)/, end: "'''", escape: false },
      { start: /^[rbfu]?"(?:[^"\\\n]|\\.)*"?/, end: '"', escape: true },
      { start: /^[rbfu]?'(?:[^'\\\n]|\\.)*'?/, end: "'", escape: true },
    ],
  },
  yaml: {
    lineComment: /^#.*/,
    strings: [{ start: /^"[^"\n]*"?/, end: '"', escape: false }, { start: /^'[^'\n]*'?/, end: "'", escape: false }],
  },
  shell: {
    lineComment: /^#.*/,
    strings: [{ start: /^"[^"\n]*"?/, end: '"', escape: true }, { start: /^'[^']*'/, end: "'", escape: false }],
  },
}

export function languageForFile(name: string): string {
  const lower = name.toLowerCase()
  if (/\.(jsx?|mjs|cjs|tsx?)$/.test(lower)) return 'clike'
  if (/\.json5?$/.test(lower)) return 'json'
  if (/\.(ya?ml)$/.test(lower)) return 'yaml'
  if (/\.css$/.test(lower)) return 'css'
  if (/\.(html?|xml|svg|vue)$/.test(lower)) return 'markup'
  if (/\.(md|markdown)$/.test(lower)) return 'markdown'
  if (/\.py$/.test(lower)) return 'python'
  if (/\.(rb|erb)$/.test(lower)) return 'ruby'
  if (/\.go$/.test(lower)) return 'clike'
  if (/\.rs$/.test(lower)) return 'rust'
  if (/\.(sh|bash|zsh)$/.test(lower) || lower === 'bashrc' || lower === 'profile') return 'shell'
  if (/\.sql$/.test(lower)) return 'sql'
  if (/\.(ini|toml|cfg|conf|env|properties)$/.test(lower) ||
      ['dockerfile', 'makefile', '.gitignore', '.editorconfig', '.npmrc'].some((f) => lower.endsWith(f))) {
    return 'config'
  }
  return 'plain'
}

/** Tokenizes one source line. Never throws; unknown input → single plain token. */
export function highlightLine(line: string, lang: string): Token[] {
  try {
    switch (lang) {
      case 'json': return tokenizeJson(line)
      case 'yaml': return tokenizeYaml(line)
      case 'css': return tokenizeCss(line)
      case 'markup': return tokenizeMarkup(line)
      case 'markdown': return tokenizeMarkdown(line)
      case 'config': return tokenizeConfig(line)
      case 'sql': return tokenizeSql(line)
      case 'rust': return tokenizeGeneric(line, { ...SPECS.clike!, lineComment: /^\/\/.*/ }, [...KEYWORDS])
      case 'ruby': return tokenizeGeneric(line, SPECS.python!, [...KEYWORDS])
      default: return tokenizeGeneric(line, SPECS[lang] ?? SPECS.python!, [...KEYWORDS])
    }
  } catch {
    return [{ kind: 'plain', text: line }]
  }
}

// -- per-language tokenizers ---------------------------------------------------

const IDENT = /^[A-Za-z_$][\w$]*/
const NUMBER = /^\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/

function pushToken(out: Token[], kind: TokenKind, text: string): void {
  if (!text) return
  const last = out[out.length - 1]
  if (last && last.kind === kind) last.text += text
  else out.push({ kind, text })
}

function tokenizeGeneric(line: string, spec: LangSpec, keywords: string[]): Token[] {
  const out: Token[] = []
  let rest = line
  while (rest.length > 0) {
    const ws = /^\s+/.exec(rest)
    if (ws) { pushToken(out, 'plain', ws[0]); rest = rest.slice(ws[0].length); continue }
    if (spec.lineComment && spec.lineComment.test(rest)) { pushToken(out, 'comment', rest); break }
    if (spec.blockComment && rest.startsWith(spec.blockComment[1]) === false && /^\/\*/.test(rest)) {
      const close = rest.indexOf('*/')
      const comment = close === -1 ? rest : rest.slice(0, close + 2)
      pushToken(out, 'comment', comment)
      rest = rest.slice(comment.length)
      continue
    }
    let matched = false
    for (const s of spec.strings ?? []) {
      const m = s.start.exec(rest)
      if (m && m[0].length > 0) { pushToken(out, 'string', m[0]); rest = rest.slice(m[0].length); matched = true; break }
    }
    if (matched) continue
    const kw = IDENT.exec(rest)
    if (kw && keywords.includes(kw[0])) { pushToken(out, 'keyword', kw[0]); rest = rest.slice(kw[0].length); continue }
    const num = NUMBER.exec(rest)
    if (num) { pushToken(out, 'number', num[0]); rest = rest.slice(num[0].length); continue }
    const ident = IDENT.exec(rest)
    if (ident) { pushToken(out, 'plain', ident[0]); rest = rest.slice(ident[0].length); continue }
    pushToken(out, 'plain', rest[0]!)
    rest = rest.slice(1)
  }
  return out
}

function tokenizeJson(line: string): Token[] {
  const out: Token[] = []
  let rest = line
  while (rest.length > 0) {
    const ws = /^\s+/.exec(rest)
    if (ws) { pushToken(out, 'plain', ws[0]); rest = rest.slice(ws[0].length); continue }
    const keyM = /^"(?:[^"\\]|\\.)*"(?=\s*:)/.exec(rest)
    if (keyM) { pushToken(out, 'key', keyM[0]); rest = rest.slice(keyM[0].length); continue }
    const strM = /^"(?:[^"\\]|\\.)*"/.exec(rest)
    if (strM) { pushToken(out, 'string', strM[0]); rest = rest.slice(strM[0].length); continue }
    const num = /^-?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest)
    if (num) { pushToken(out, 'number', num[0]); rest = rest.slice(num[0].length); continue }
    const lit = /^(?:true|false|null)\b/.exec(rest)
    if (lit) { pushToken(out, 'keyword', lit[0]); rest = rest.slice(lit[0].length); continue }
    pushToken(out, 'plain', rest[0]!)
    rest = rest.slice(1)
  }
  return out
}

function tokenizeYaml(line: string): Token[] {
  const out: Token[] = []
  let rest = line
  const commentIdx = /(^|\s)#(?![^{[]*\})/.exec(rest)
  const keyM = /^(\s*[-]?\s*)([\w.$-]+)(\s*:(?:\s|$))/.exec(rest)
  if (keyM && !(commentIdx && keyM.index !== undefined && commentIdx.index < keyM.index + keyM[1].length)) {
    pushToken(out, 'plain', keyM[1]!)
    pushToken(out, 'key', keyM[2]!)
    pushToken(out, 'plain', keyM[3]!)
    rest = rest.slice(keyM[0].length)
  }
  if (rest.length > 0) {
    const generic = tokenizeGeneric(rest, SPECS.yaml!, [])
    return out.concat(generic.map((t) => (t.kind === 'keyword' ? { kind: 'plain' as const, text: t.text } : t)))
  }
  return out
}

function tokenizeCss(line: string): Token[] {
  const out: Token[] = []
  let rest = line
  while (rest.length > 0) {
    const ws = /^\s+/.exec(rest)
    if (ws) { pushToken(out, 'plain', ws[0]); rest = rest.slice(ws[0].length); continue }
    const com = /^\/\*[\s\S]*?(\*\/|$)/.exec(rest)
    if (com) { pushToken(out, 'comment', com[0]); rest = rest.slice(com[0].length); continue }
    const str = /^"[^"\n]*"?|^'[^'\n]*'?/.exec(rest)
    if (str) { pushToken(out, 'string', str[0]); rest = rest.slice(str[0].length); continue }
    const prop = /^[-a-zA-Z]+(?=\s*:)/.exec(rest)
    if (prop) { pushToken(out, 'key', prop[0]); rest = rest.slice(prop[0].length); continue }
    const num = /^-?\d[\d.]*(?:px|em|rem|%|vh|vw|s|ms)?/.exec(rest)
    if (num) { pushToken(out, 'number', num[0]); rest = rest.slice(num[0].length); continue }
    const sel = /^[.#]?[\w-]+/.exec(rest)
    if (sel) { pushToken(out, 'plain', sel[0]); rest = rest.slice(sel[0].length); continue }
    pushToken(out, 'plain', rest[0]!)
    rest = rest.slice(1)
  }
  return out
}

function tokenizeMarkup(line: string): Token[] {
  const out: Token[] = []
  let rest = line
  while (rest.length > 0) {
    const tag = /^<\/?[A-Za-z][\w:-]*/.exec(rest)
    if (tag) { pushToken(out, 'tag', tag[0]); rest = rest.slice(tag[0].length); continue }
    const attr = /^[\w-]+(?==)/.exec(rest)
    if (attr) { pushToken(out, 'key', attr[0]); rest = rest.slice(attr[0].length); continue }
    const str = /^"[^"]*"?|^'[^']*'?/.exec(rest)
    if (str) { pushToken(out, 'string', str[0]); rest = rest.slice(str[0].length); continue }
    const gt = /^\/?>?/.exec(rest)
    if (gt && /^[/<]/.test(gt[0])) { pushToken(out, 'tag', gt[0]); rest = rest.slice(gt[0].length); continue }
    const until = rest.search(/[<]/)
    if (until === -1) { pushToken(out, 'plain', rest); break }
    pushToken(out, 'plain', rest.slice(0, Math.max(until, 1)))
    rest = rest.slice(Math.max(until, 1))
  }
  return out
}

function tokenizeMarkdown(line: string): Token[] {
  const heading = /^(#{1,6}\s.*)$/.exec(line)
  if (heading) return [{ kind: 'heading', text: heading[1]! }]
  if (/^\s*([-*_])\s*\1\s*\1[-*_\s]*$/.test(line)) return [{ kind: 'comment', text: line }]
  return [{ kind: 'plain', text: line }]
}

function tokenizeConfig(line: string): Token[] {
  const section = /^\[[^\]]*\]\s*$/.exec(line.trim())
  if (section) return [{ kind: 'tag', text: line }]
  const kv = /^(\s*[#;].*)$/.exec(line)
  if (kv) return [{ kind: 'comment', text: line }]
  const pair = /^(\s*)([\w.$-]+)(\s*[=:])/.exec(line)
  if (pair) {
    return [
      { kind: 'plain', text: pair[1]! },
      { kind: 'key', text: pair[2]! },
      { kind: 'plain', text: pair[3]! },
      { kind: 'string', text: line.slice(pair[0].length) },
    ]
  }
  return [{ kind: 'plain', text: line }]
}

function tokenizeSql(line: string): Token[] {
  const sqlKeywords = ['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete',
    'create', 'table', 'index', 'view', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by',
    'order', 'having', 'limit', 'offset', 'and', 'or', 'not', 'null', 'primary', 'key', 'foreign', 'references']
  return tokenizeGeneric(line, SPECS.shell!, sqlKeywords)
}
