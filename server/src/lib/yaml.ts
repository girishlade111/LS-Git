/**
 * Safe YAML subset parser for LSGit configuration files (issue forms).
 *
 * DESIGN CONTRACT
 * ---------------
 * 1. Never executes anything. The parser's ONLY output is null | boolean |
 *    number | string | arrays | plain objects. There are no extension points,
 *    no tag handlers, no revivers.
 * 2. Every YAML construct with code-execution / aliasing / resource-amplification
 *    semantics is an EXPLICIT PARSE ERROR, not a silent fallback:
 *      - tags            (!!python/object/new:os.system  etc.)   → rejected
 *      - anchors/aliases (&a / *a — billion-laughs amplification) → rejected
 *      - merge keys      (<<:)                                    → rejected
 *      - flow collections ({…} / […])                             → rejected
 *      - block scalars   (| and >)                                → rejected
 *      - multiple documents (--- … --- / ...)                     → rejected
 * 3. Resource abuse is bounded BEFORE and DURING parsing:
 *      - maxBytes   hard cap on input size (checked before any work)
 *      - maxDepth   indentation-nesting cap
 *      - maxNodes   total scalar/collection budget
 * 4. Strictness: duplicate mapping keys are errors; tab indentation is an
 *    error; unclosed quotes are errors.
 *
 * SUPPORTED SUBSET (documented deviation from full YAML)
 * ------------------------------------------------------
 * block mappings · block sequences (including `- key: value` map items) ·
 * comments · single/double-quoted scalars · plain scalars typed as
 * null|true|false|integer|string (no floats, no dates, no sexagesimal).
 */

export class YamlParseError extends Error {
  constructor(
    message: string,
    public line?: number,
  ) {
    super(message)
  }
}

export interface SafeYamlLimits {
  /** Hard byte cap on the raw source. Checked before parsing begins. */
  maxBytes?: number
  /** Maximum collection nesting depth. */
  maxDepth?: number
  /** Maximum total nodes (keys + items + scalars) produced. */
  maxNodes?: number
}

export const DEFAULT_YAML_LIMITS: Required<SafeYamlLimits> = {
  maxBytes: 32 * 1024,
  maxDepth: 10,
  maxNodes: 1024,
}

interface Line {
  indent: number
  text: string // content without indentation, comments stripped when safe
  number: number // 1-based source line
}

type YamlValue = null | boolean | number | string | YamlValue[] | { [k: string]: YamlValue }

export function parseSafeYaml(source: string | Buffer, limits: SafeYamlLimits = {}): Record<string, unknown> {
  const lim = { ...DEFAULT_YAML_LIMITS, ...limits }

  const bytes = typeof source === 'string' ? Buffer.byteLength(source, 'utf8') : source.length
  if (bytes > lim.maxBytes) {
    throw new YamlParseError(`YAML document exceeds the ${lim.maxBytes}-byte limit`)
  }

  const text = typeof source === 'string' ? source : source.toString('utf8')
  const lines = toLogicalLines(text)
  if (lines.length === 0) return {}

  const state = { nodes: 0 }
  const [value, next] = parseBlock(lines, 0, lines[0]!.indent, 1, lim, state)
  if (next !== lines.length) {
    throw new YamlParseError(`Unexpected content at line ${lines[next]!.number}`, lines[next]!.number)
  }
  if (value === null || value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new YamlParseError('A form template must be a YAML mapping at the top level')
  }
  return value as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// line preparation
// ---------------------------------------------------------------------------

function toLogicalLines(text: string): Line[] {
  const out: Line[] = []
  const raw = text.replace(/\r\n?/g, '\n').split('\n')

  for (let i = 0; i < raw.length; i++) {
    const original = raw[i]!
    const number = i + 1

    // Document markers never appear inside our single-document subset.
    const bare = original.trim()
    if (bare === '---' || bare === '...') {
      throw new YamlParseError(
        'Multi-document and document-marker YAML is not supported', number,
      )
    }

    // Tabs may appear inside values but NEVER as indentation.
    const indentMatch = /^[ ]*/.exec(original)!
    if (/^\t/.test(original.slice(indentMatch[0].length))) {
      throw new YamlParseError('Tab characters are not allowed in indentation', number)
    }
    const indent = indentMatch[0].length

    let content = original.slice(indent)
    if (content === '' || content.startsWith('#')) continue

    content = stripComment(content)
    if (content.trim() === '') continue

    // Structural rejection happens here so it covers keys AND values.
    assertNoForbiddenSyntax(content, number)

    out.push({ indent, text: content.trimEnd(), number })
  }
  return out
}

/**
 * Removes a trailing comment (" # …") outside of quotes. A '#' starts a
 * comment only at the beginning of the token stream or after whitespace.
 */
function stripComment(line: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === "'" && !inDouble) inSingle = !inSingle
    else if (c === '"' && !inSingle && (i === 0 || line[i - 1] !== '\\')) inDouble = !inDouble
    else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i).trimEnd()
    }
  }
  return line
}

/** Rejects every syntax family this parser deliberately does not implement. */
function assertNoForbiddenSyntax(content: string, line: number): void {
  // Tags: !!str, !custom, %TAG directives…
  if (/^!|^%|\s!\S/.test(content)) {
    throw new YamlParseError('YAML tags are not supported and are rejected outright', line)
  }
  // Anchors & aliases (also blocks billion-laughs style amplification).
  if (/^&\S|\s&\S/.test(content)) {
    throw new YamlParseError('YAML anchors are not supported', line)
  }
  if (/^\*\S|\s\*\S/.test(content)) {
    throw new YamlParseError('YAML aliases are not supported', line)
  }
  // Merge keys.
  if (/^<<\s*:/.test(content) || /\s<<\s*:/.test(content)) {
    throw new YamlParseError('Merge keys (<<) are not supported', line)
  }
  // Flow collections — find one OUTSIDE quotes.
  if (hasFlowOpenerOutsideQuotes(content)) {
    throw new YamlParseError('Flow collections ({…} / […]) are not supported; use block style', line)
  }
  // Block scalars.
  if (/\s[|>][+-]?\s*$/.test(` ${content}`) || /^[|>][+-]?$/.test(content.trim())) {
    throw new YamlParseError('Block scalars (| >) are not supported; quote multi-line strings instead', line)
  }
}

function hasFlowOpenerOutsideQuotes(content: string): boolean {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < content.length; i++) {
    const c = content[i]!
    if (c === "'" && !inDouble) inSingle = !inSingle
    else if (c === '"' && !inSingle && (i === 0 || content[i - 1] !== '\\')) inDouble = !inDouble
    else if (!inSingle && !inDouble && (c === '{' || c === '[')) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// block parsing (recursive descent over logical lines)
// ---------------------------------------------------------------------------

function parseBlock(
  lines: Line[],
  start: number,
  indent: number,
  depth: number,
  lim: Required<SafeYamlLimits>,
  state: { nodes: number },
): [YamlValue, number] {
  if (depth > lim.maxDepth) {
    throw new YamlParseError(
      `YAML nesting exceeds the depth limit of ${lim.maxDepth}`, lines[start]!.number,
    )
  }
  if (start >= lines.length || lines[start]!.indent < indent) {
    return [null, start] // empty block value
  }
  const first = lines[start]!
  if (first.text.startsWith('- ') || first.text === '-') {
    return parseSequence(lines, start, indent, depth, lim, state)
  }
  return parseMapping(lines, start, indent, depth, lim, state)
}

function parseSequence(
  lines: Line[],
  start: number,
  indent: number,
  depth: number,
  lim: Required<SafeYamlLimits>,
  state: { nodes: number },
): [YamlValue[], number] {
  const items: YamlValue[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]!
    if (line.indent < indent) break
    if (line.indent > indent) {
      throw new YamlParseError(`Unexpected indentation on line ${line.number}`, line.number)
    }
    if (!(line.text.startsWith('- ') || line.text === '-')) break

    chargeNode(state, lim, line.number)

    if (line.text === '-') {
      // Value lives on following, more-indented lines.
      const [value, next] = parseBlock(lines, i + 1, indent + 1, depth + 1, lim, state)
      items.push(value)
      i = next
      continue
    }

    const rest = line.text.slice(2).trimStart()
    // Absolute column where the item content starts (virtual indent for
    // `- key: value` mappings).
    const itemInlineIndent = line.indent + (line.text.length - rest.length)
    // `- key: value` starts a mapping whose virtual indent is where rest begins.
    if (/^[^:'"]+:(\s|$)/.test(rest) || /^(['"]).*?\1\s*:/.test(rest)) {
      const virtual: Line = { indent: itemInlineIndent, text: rest, number: line.number }
      const subLines = [virtual]
      let j = i + 1
      while (j < lines.length && lines[j]!.indent > line.indent) {
        subLines.push(lines[j]!)
        j++
      }
      const [value, consumed] = parseMapping(subLines, 0, virtual.indent, depth + 1, lim, state)
      if (consumed !== subLines.length) {
        throw new YamlParseError('Malformed sequence item', line.number)
      }
      items.push(value)
      i = j
      continue
    }

    items.push(parseScalar(rest, line.number))
    i++
  }
  return [items, i]
}

function parseMapping(
  lines: Line[],
  start: number,
  indent: number,
  depth: number,
  lim: Required<SafeYamlLimits>,
  state: { nodes: number },
): [{ [k: string]: YamlValue }, number] {
  const map: { [k: string]: YamlValue } = {}
  let i = start
  while (i < lines.length) {
    const line = lines[i]!
    if (line.indent < indent) break
    if (line.indent > indent) {
      throw new YamlParseError(`Unexpected indentation on line ${line.number}`, line.number)
    }

    const sep = findKeySeparator(line.text)
    if (!sep) {
      throw new YamlParseError(`Expected 'key: value' on line ${line.number}`, line.number)
    }
    chargeNode(state, lim, line.number)

    const rawKey = line.text.slice(0, sep).trim()
    const key = parseScalar(rawKey, line.number)
    if (typeof key !== 'string') {
      throw new YamlParseError(`Mapping keys must be strings on line ${line.number}`, line.number)
    }
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      throw new YamlParseError(`Duplicate key '${key}' on line ${line.number}`, line.number)
    }

    const rest = line.text.slice(sep + 1).trim()
    if (rest === '') {
      // Nested block OR a sequence at the SAME indent as its key (both legal).
      const next = lines[i + 1]
      if (
        next &&
        next.indent === indent &&
        (next.text.startsWith('- ') || next.text === '-')
      ) {
        const [value, consumed] = parseSequence(lines, i + 1, indent, depth + 1, lim, state)
        map[key] = value
        i = consumed
        continue
      }
      const [value, consumed2] = parseBlock(lines, i + 1, indent + 1, depth + 1, lim, state)
      map[key] = value
      i = consumed2
      continue
    }
    chargeNode(state, lim, line.number)
    map[key] = parseScalar(rest, line.number)
    i++
  }
  return [map, i]
}

/** Index of the ':' separating key from value, respecting quotes. */
function findKeySeparator(text: string): number | null {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === "'" && !inDouble) inSingle = !inSingle
    else if (c === '"' && !inSingle && (i === 0 || text[i - 1] !== '\\')) inDouble = !inDouble
    else if (c === ':' && !inSingle && !inDouble) {
      if (text.length === i + 1 || text[i + 1] === ' ') return i
    }
  }
  return null
}

function parseScalar(raw: string, line: number): YamlValue {
  const v = raw.trim()
  if (v === '') return null
  if (v === '~' || /^(null|Null|NULL)$/.test(v)) return null
  if (/^(true|True|TRUE)$/.test(v)) return true
  if (/^(false|False|FALSE)$/.test(v)) return false
  if (/^-?(0|[1-9][0-9]*)$/.test(v)) return Number(v)
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    const inner = v.slice(1, -1)
    if (inner.includes("''")) return inner.replace(/''/g, "'")
    if (inner.includes("'")) throw new YamlParseError('Malformed single-quoted string', line)
    return inner
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    const inner = v.slice(1, -1)
    if (/\\[^"\\nrt]/.test(inner)) {
      throw new YamlParseError(`Unsupported escape sequence in double-quoted string`, line)
    }
    try {
      return JSON.parse(`"${inner}"`) as string
    } catch {
      throw new YamlParseError('Malformed double-quoted string', line)
    }
  }
  if ((v.startsWith('"') && !v.endsWith('"')) || (v.startsWith("'") && !v.endsWith("'"))) {
    throw new YamlParseError('Unclosed quoted string', line)
  }
  return v
}

function chargeNode(state: { nodes: number }, lim: Required<SafeYamlLimits>, line: number): void {
  state.nodes++
  if (state.nodes > lim.maxNodes) {
    throw new YamlParseError(`YAML document exceeds the ${lim.maxNodes}-node limit`, line)
  }
}
