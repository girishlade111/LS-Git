import { describe, expect, it, vi } from 'vitest'
import {
  buildManifest,
  collectFromFileList,
  formatBytes,
  normalizeRelativePath,
  type BatchLimits,
} from '../projects/folderUpload'

const LIMITS: BatchLimits = {
  max_file_bytes: 1024 * 1024,
  max_batch_files: 100,
  max_batch_total_bytes: 5 * 1024 * 1024,
}

function fileOf(name: string, size = 10): File {
  return new File([new Uint8Array(size)], name, { type: 'text/plain' })
}

function fakeList(entries: Array<{ name: string; rel?: string; size?: number }>): FileList {
  return entries.map((e) => {
    const f = fileOf(e.name, e.size)
    if (e.rel !== undefined) Object.defineProperty(f, 'webkitRelativePath', { value: e.rel })
    return f
  }) as unknown as FileList
}

describe('normalizeRelativePath — cross-platform browser paths', () => {
  it('accepts plain relative paths and nested folders', () => {
    expect(normalizeRelativePath('README.md')).toBe('README.md')
    expect(normalizeRelativePath('src/app/main.ts')).toBe('src/app/main.ts')
    expect(normalizeRelativePath('docs/café/naïve résumé.md')).toBe('docs/café/naïve résumé.md')
  })

  it('strips windows drive letters and converts backslashes', () => {
    expect(normalizeRelativePath('C:\\Users\\bob\\proj\\a.txt')).toBe('Users/bob/proj/a.txt')
    expect(normalizeRelativePath('D:\\x\\y.txt')).toBe('x/y.txt')
    expect(normalizeRelativePath('dir\\sub\\file.js')).toBe('dir/sub/file.js')
  })

  it('strips absolute prefixes (mac/linux)', () => {
    expect(normalizeRelativePath('/home/bob/file.txt')).toBe('home/bob/file.txt')
    expect(normalizeRelativePath('\\Users\\shared\\b.bin')).toBe('Users/shared/b.bin')
  })

  it('collapses no-op segments and duplicate slashes', () => {
    expect(normalizeRelativePath('./src/./a.ts')).toBe('src/a.ts')
    expect(normalizeRelativePath('a//b///c.txt')).toBe('a/b/c.txt')
    expect(normalizeRelativePath('folder/')).toBe('folder')
  })

  it('rejects traversal, .git, reserved suffixes, and control characters', () => {
    expect(normalizeRelativePath('../secret.txt')).toBeNull()
    expect(normalizeRelativePath('a/../../b.txt')).toBeNull()
    expect(normalizeRelativePath('.git/config')).toBeNull()
    expect(normalizeRelativePath('pkg/index.lock')).toBeNull()
    expect(normalizeRelativePath('bad\u0001name.txt')).toBeNull()
    expect(normalizeRelativePath('..')).toBeNull()
    expect(normalizeRelativePath('')).toBeNull()
  })
})

describe('collectFromFileList — webkitdirectory input parity', () => {
  it('uses webkitRelativePath when present and falls back to the file name', () => {
    const { files, emptyDirs } = collectFromFileList(
      fakeList([
        { name: 'main.ts', rel: 'proj/src/main.ts' },
        { name: 'loose.txt' },
      ]),
    )
    expect(emptyDirs).toEqual([])
    expect(files.map((f) => f.relativePath)).toEqual(['proj/src/main.ts', 'loose.txt'])
  })

  it('drops entries whose relative path cannot be normalized safely', () => {
    const { files } = collectFromFileList(fakeList([
      { name: 'ok.txt', rel: 'ok.txt' },
      { name: 'evil', rel: '../evil.txt' },
      { name: 'gitmeta', rel: '.git/config' },
    ]))
    expect(files.map((f) => f.relativePath)).toEqual(['ok.txt'])
  })
})

describe('buildManifest — detection pass', () => {
  function collect(pairs: Array<[string, number]>) {
    return {
      files: pairs.map(([p, size]) => ({ file: fileOf(p.split('/').pop()!, size), relativePath: p })),
      emptyDirs: [] as string[],
    }
  }

  it('keeps the first occurrence of duplicate paths and skips later ones', () => {
    const manifest = buildManifest(collect([['a.txt', 1], ['sub/b.txt', 2], ['a.txt', 3]]), LIMITS)
    const dupes = manifest.items.filter((i) => i.status === 'skipped')
    expect(dupes).toHaveLength(1)
    expect(dupes[0]!.note).toBe('Duplicate path in this upload')
    expect(manifest.eligibleFiles).toBe(2)
  })

  it('marks per-file oversize as skipped without poisoning the batch totals', () => {
    const manifest = buildManifest(collect([['big.bin', 2 * 1024 * 1024], ['small.txt', 12]]), LIMITS)
    expect(manifest.items.find((i) => i.relativePath === 'big.bin')?.status).toBe('skipped')
    expect(manifest.eligibleFiles).toBe(1)
    expect(manifest.eligibleBytes).toBe(12)
    expect(manifest.withinLimits).toBe(true)
  })

  it('flags total-byte overflow for user action before any upload starts', () => {
    const limits = { ...LIMITS, max_batch_total_bytes: 100 }
    const manifest = buildManifest(collect([['a', 60], ['b', 60]]), limits)
    expect(manifest.withinLimits).toBe(false)
    expect(manifest.limitErrors[0]).toMatch(/above the/)
  })

  it('caps accepted files at max_batch_files and reports the overflow as skipped', () => {
    const limits = { ...LIMITS, max_batch_files: 3 }
    const manifest = buildManifest(collect([['1'], ['2'], ['3'], ['4'], ['5']]), limits)
    expect(manifest.eligibleFiles).toBe(3)
    expect(manifest.items.filter((i) => i.note?.startsWith('Batch limit'))).toHaveLength(2)
  })

  it('reports empty folders so the UI can explain their omission', () => {
    const manifest = buildManifest(
      {
        files: [{ file: fileOf('x', 4), relativePath: 'keep.txt' }],
        emptyDirs: ['empty-one', 'nested/empty-two'],
      },
      LIMITS,
    )
    expect(manifest.emptyDirs).toHaveLength(2)
    expect(manifest.eligibleFiles).toBe(1)
  })
})

describe('formatBytes', () => {
  it('renders human-readable sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
