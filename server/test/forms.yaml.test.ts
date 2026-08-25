import { describe, expect, it } from 'vitest'
import { parseSafeYaml, YamlParseError, DEFAULT_YAML_LIMITS } from '../src/lib/yaml.js'

/**
 * Safe-YAML guarantees: nothing executes, aliasing/amplification syntax is
 * rejected outright, and resource abuse (size/depth/node bombs) fails fast.
 * The parser's only output is plain JSON-compatible data.
 */

describe('safe yaml subset — supported constructs', () => {
  it('parses mappings, sequences, nesting, comments and quoted scalars', () => {
    const doc = parseSafeYaml(`
# top comment
name: Bug report            # trailing comment
description: 'Single ''quoted'' # not-a-comment'
labels:
  - bug
  - "regression"
fields:
  - type: text
    id: summary
    attributes:
      label: Summary
      max_score: 10
      enabled: true
      owner: null
  - type: textarea
    id: details
`)
    expect(doc).toEqual({
      name: 'Bug report',
      description: "Single 'quoted' # not-a-comment",
      labels: ['bug', 'regression'],
      fields: [
        {
          type: 'text',
          id: 'summary',
          attributes: { label: 'Summary', max_score: 10, enabled: true, owner: null },
        },
        { type: 'textarea', id: 'details' },
      ],
    })
  })

  it('supports sequences written at the SAME indent as their key', () => {
    const doc = parseSafeYaml('labels:\n- bug\n- feature\nname: X\n')
    expect(doc.labels).toEqual(['bug', 'feature'])
    expect(doc.name).toBe('X')
  })

  it('handles CRLF input and preserves spaces inside quoted strings', () => {
    const doc = parseSafeYaml("a: \"  padded  \"\r\nb: 'x y'\r\n")
    expect(doc.a).toBe('  padded  ')
    expect(doc.b).toBe('x y')
  })
})

// ---------------------------------------------------------------------------
// Malicious / hostile inputs — every one must be REJECTED, never evaluated.
// ---------------------------------------------------------------------------

describe('safe yaml — hostile syntax is rejected outright', () => {
  const rejects = (source: string, messagePart?: string) => {
    let err: unknown
    try {
      parseSafeYaml(source)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(YamlParseError)
    const message = (err as Error).message
    if (messagePart) expect(message).toContain(messagePart)
    return message
  }

  it('rejects arbitrary TAGS instead of resolving them', () => {
    // The classic RCE probes — these MUST NOT be passed to any resolver.
    rejects('a: !!python/object/new:os.system ["echo pwned"]', 'tags')
    rejects('a: !!exec echo pwned', 'tags')
    rejects('a: !custom-scalar x', 'tags')
    rejects('!!map\na: b', 'tags')
  })

  it('rejects ANCHORS and ALIASES (billion-laughs amplification vector)', () => {
    rejects(
      ['a: &a ["x","x","x","x","x","x","x","x"]', 'b: &b [*a,*a,*a,*a,*a,*a,*a,*a]', 'c: &c [*b,*b,*b,*b]', 'd: [*c,*c,*c,*c]'].join('\n'),
      'anchors',
    )
    rejects('a: &anchor value', 'anchors')
    rejects('a: *alias', 'aliases')
    rejects('base: &b\n  x: 1\nuse:\n  <<: *b', 'anchors')
  })

  it('rejects merge keys', () => {
    rejects('defaults: &d\n  x: 1\nitem:\n  <<: *d\n', 'anchors') // alias caught first
    rejects('item:\n  <<: {a: 1}\n', 'Merge keys')
  })

  it('rejects FLOW collections (block style only)', () => {
    rejects('a: {b: c}', 'Flow collections')
    rejects('a: [1, 2, 3]', 'Flow collections')
    rejects('{a: b}', 'Flow collections')
  })

  it('rejects BLOCK SCALARS', () => {
    rejects('a: |\n  line one\n  line two\n', 'Block scalars')
    rejects('a: >-\n  folded\n', 'Block scalars')
  })

  it('rejects multi-document streams and document markers', () => {
    rejects('---\na: b\n', 'document-marker')
    rejects('a: b\n---\nc: d\n', 'document-marker')
    rejects('a: b\n...\n', 'document-marker')
  })

  it('never evaluates payloads even when they look like code', () => {
    // If anything executed, this would attempt side effects; we assert pure throw.
    expect(() =>
      parseSafeYaml('x: !!python/object/apply:subprocess.check_output ["rm -rf /"]'),
    ).toThrow(YamlParseError)
  })
})

describe('safe yaml — malformed input', () => {
  it('reports unclosed quotes', () => {
    expect(() => parseSafeYaml("a: 'never closed")).toThrow(YamlParseError)
    expect(() => parseSafeYaml('a: "unterminated')).toThrow(YamlParseError)
  })

  it('reports duplicate mapping keys', () => {
    expect(() => parseSafeYaml('a: 1\na: 2\n')).toThrow(/Duplicate key 'a'/)
  })

  it('reports bad indentation', () => {
    expect(() => parseSafeYaml('outer:\n    a: 1\n  b: 2\n')).toThrow(/Unexpected indentation/)
    expect(() => parseSafeYaml('a: 1\n  b: 2\n')).toThrow(YamlParseError)
  })

  it('rejects tab indentation', () => {
    expect(() => parseSafeYaml('outer:\n\ta: 1\n')).toThrow(/Tab characters/)
  })

  it('rejects non-mapping documents at the top level', () => {
    expect(() => parseSafeYaml('- just\n- a\n- list\n')).toThrow(/mapping at the top level/)
    expect(() => parseSafeYaml('just a scalar\n')).toThrow(YamlParseError)
  })

  it('returns an empty object for empty documents', () => {
    expect(parseSafeYaml('')).toEqual({})
    expect(parseSafeYaml('# only a comment\n\n')).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Resource abuse limits
// ---------------------------------------------------------------------------

describe('safe yaml — resource abuse protection', () => {
  it('caps input SIZE before doing any work', () => {
    const big = `name: ${'x'.repeat(40_000)}\n`
    expect(() => parseSafeYaml(big)).toThrow(/byte limit/)
    expect(() => parseSafeYaml('a: b', { maxBytes: 2 })).toThrow(/byte limit/)
  })

  it('caps NESTING DEPTH regardless of indentation tricks', () => {
    // Deeply indented staircase — each level one step deeper than legal.
    let src = ''
    for (let i = 0; i < DEFAULT_YAML_LIMITS.maxDepth + 5; i++) {
      src += `${' '.repeat(i * 2)}k${i}:\n`
    }
    src += `${' '.repeat((DEFAULT_YAML_LIMITS.maxDepth + 5) * 2)}leaf: 1\n`
    expect(() => parseSafeYaml(src)).toThrow(/depth limit/)
  })

  it('caps TOTAL NODES (mapping sprawl bomb)', () => {
    const manyKeys = Array.from({ length: 5000 }, (_, i) => `k${i}: v`).join('\n')
    expect(() =>
      parseSafeYaml(manyKeys, { maxNodes: 512, maxBytes: 200_000 }),
    ).toThrow(/node limit/)
  })

  it('caps node count across nested structures', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => `  - id: f${i}\n    type: text`).join('\n')
    const doc = `fields:\n${rows}\n`
    expect(() =>
      parseSafeYaml(doc, { maxBytes: 200_000 }),
    ).toThrow(/node limit/)
  })
})
