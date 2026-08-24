import { describe, expect, it } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { makeApp, registerUser, loginRaw, extractSession, authed } from './helpers.js'
import type { FastifyInstance } from 'fastify'
import type { Actor } from '../src/authz.js'
import type { ProjectRow } from '../src/db/store'
import type { ChangeInput } from '../src/services/repositories'

/**
 * Repository code-browser API tests (server/src/http/routes/repository.ts).
 * Covers: root tree, nested folders, file metadata, binary detection, large
 * files + directory pagination, invalid paths, private-repo authorization,
 * SHA permalinks, branch switching, missing files and deleted-file history.
 */

interface Setup {
  app: FastifyInstance
  session: ReturnType<typeof extractSession>
  owner: Actor
  project: ProjectRow
  repos: ReturnType<typeof getRepos>
}

function getRepos(app: FastifyInstance) {
  return app.repositories
}

async function setup(): Promise<Setup> {
  const app = makeApp()
  await registerUser(app) // alice → first user → admin/owner
  const session = extractSession((await loginRaw(app, 'alice')).cookies)
  const res = await authed(app, 'POST', '/api/v1/projects', {
    session,
    payload: {
      name: 'Browser Repo', path: 'browser-repo', visibility: 'private',
      description: '', website_url: '', default_branch: 'main',
      topics: [], initialize_with_readme: true,
    },
  })
  expect(res.statusCode).toBe(201)
  const project = app.store.projects.byOwnerPath('alice', 'browser-repo')!
  const user = app.store.users.byUsername('alice')!
  return {
    app,
    session,
    owner: { userId: user.id, username: 'alice', admin: true, state: 'active', via: { kind: 'session' } },
    project,
    repos: app.repositories,
  }
}

function commit(s: Setup, message: string, changes: Array<ChangeInput | Record<string, unknown>>, over: Record<string, unknown> = {}) {
  return s.repos.commitChanges(s.owner, s.project.id, {
    message,
    changes: changes as ChangeInput[],
    ...over,
  })
}

async function getJson(s: Setup, url: string) {
  const res = await authed(s.app, 'GET', url, { session: s.session })
  return { status: res.statusCode, body: res.json() as Record<string, unknown>, headers: res.headers }
}

// -- root tree ------------------------------------------------------------------

describe('repository tree', () => {
  it('lists the ROOT tree with dirs-first ordering, breadcrumbs and tip commit', async () => {
    const s = await setup()
    commit(s, 'Add structure', [
      { path: 'README.md', content: '# Browser Repo\n', delete: false },
      { path: 'src/index.ts', content: 'export {}\n' },
      { path: 'docs/guide.md', content: '# Guide\n' },
      { path: 'z-file.txt', content: 'z' },
    ])

    const { status, body } = await getJson(s, `/api/v1/projects/${s.project.id}/repository/tree/main`)
    expect(status).toBe(200)
    expect(body.empty_repository).toBe(false)
    expect(body.path).toBe('')
    expect(body.breadcrumbs).toEqual([])
    // Dirs first (docs, src), then files alphabetically.
    expect((body.entries as Array<{ name: string; type: string }>).map((e) => e.name))
      .toEqual(['docs', 'src', 'README.md', 'z-file.txt'])
    expect((body.entries as Array<{ type: string }>)[0]!.type).toBe('tree')

    const tip = body.tip_commit as Record<string, unknown>
    expect(tip.title).toBe('Add structure')
    expect(String(tip.sha)).toMatch(/^[0-9a-f]{40}$/)
    expect(body.pagination).toMatchObject({ page: 1, total: 4, has_more: false })
  })

  it('navigates NESTED folders with breadcrumbs', async () => {
    const s = await setup()
    commit(s, 'docs', [
      { path: 'docs/api/reference.md', content: 'api' },
      { path: 'docs/guide.md', content: 'guide' },
    ])

    const { status, body } = await getJson(s, `/api/v1/projects/${s.project.id}/repository/tree/main/docs`)
    expect(status).toBe(200)
    expect(body.path).toBe('docs')
    expect(body.breadcrumbs).toEqual([{ name: 'docs', path: 'docs' }])
    expect((body.entries as Array<{ name: string }>).map((e) => e.name)).toEqual(['api', 'guide.md'])

    const deep = await getJson(s, `/api/v1/projects/${s.project.id}/repository/tree/main/docs/api`)
    expect((deep.body.entries as Array<{ name: string }>)).toEqual([expect.objectContaining({ name: 'reference.md', type: 'blob' })])
  })

  it('paginates LARGE directories efficiently', async () => {
    const s = await setup()
    const changes = Array.from({ length: 150 }, (_, i) => ({ path: `bulk/file-${String(i).padStart(3, '0')}.txt`, content: `f${i}` }))
    commit(s, 'bulk import', changes)

    const page1 = await getJson(s, `/api/v1/projects/${s.project.id}/repository/tree/main/bulk?per_page=100`)
    expect(page1.body.pagination).toMatchObject({ page: 1, per_page: 100, total: 150, has_more: true })
    expect(page1.body.entries as unknown[]).toHaveLength(100)
    expect(((page1.body.entries as Array<{ name: string }>)[0]).name).toBe('file-000.txt')

    const page2 = await getJson(s, `/api/v1/projects/${s.project.id}/repository/tree/main/bulk?per_page=100&page=2`)
    expect(page2.body.pagination).toMatchObject({ page: 2, has_more: false })
    expect(page2.body.entries as unknown[]).toHaveLength(50)
    expect(((page2.body.entries as Array<{ name: string }>)[0]).name).toBe('file-100.txt')
  })
})

// -- blob / file views -----------------------------------------------------------

describe('blob view', () => {
  it('returns FILE metadata with renderable text content and line counts', async () => {
    const s = await setup()
    commit(s, 'add guide', [{ path: 'docs/guide.md', content: '# Guide\n\nline two\n' }])

    const { status, body } = await getJson(s, `/api/v1/projects/${s.project.id}/repository/blob/main/docs/guide.md`)
    expect(status).toBe(200)
    expect(body).toMatchObject({
      path: 'docs/guide.md',
      name: 'guide.md',
      dir: 'docs',
      mode: 'regular',
      is_binary: false,
      too_large: false,
      line_count: 3,
      size: '# Guide\n\nline two\n'.length,
    })
    expect(body.text).toBe('# Guide\n\nline two\n')
    expect((body.breadcrumbs as unknown[]).map((b) => (b as { name: string }).name)).toEqual(['docs'])
    expect(String(body.resolved_sha)).toMatch(/^[0-9a-f]{40}$/)
  })

  it('detects BINARY files and withholds inline text', async () => {
    const s = await setup()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x00, 0xff, 0xfe])
    commit(s, 'add logo', [{ path: 'assets/logo.png', content: png }])

    const { status, body } = await getJson(s, `/api/v1/projects/${s.project.id}/repository/blob/main/assets/logo.png`)
    expect(status).toBe(200)
    expect(body.is_binary).toBe(true)
    expect(body.text).toBeNull()
    expect(body.size).toBe(png.length)

    // Raw transfer still serves the exact bytes.
    const raw = await authed(
      s.app, 'GET',
      `/api/v1/projects/${s.project.id}/repository/raw/main/assets/logo.png`,
      { session: s.session },
    )
    expect(raw.statusCode).toBe(200)
    const pngBytes = (raw as unknown as { rawPayload: Buffer }).rawPayload
    expect(pngBytes.length).toBe(png.length)
    expect(pngBytes[0]).toBe(0x89)
  })

  it('flags LARGE text files instead of inlining them; raw download still works', async () => {
    const s = await setup()
    const big = `${'line one\n'.repeat(60_000)}` // ~540 KB > 512 KB render cap
    commit(s, 'big file', [{ path: 'data/big.log', content: big }])

    const { status, body } = await getJson(s, `/api/v1/projects/${s.project.id}/repository/blob/main/data/big.log`)
    expect(status).toBe(200)
    expect(body.too_large).toBe(true)
    expect(body.text).toBeNull()

    const rawRes = await authed(
      s.app, 'GET',
      `/api/v1/projects/${s.project.id}/repository/raw/main/data/big.log`,
      { session: s.session },
    )
    expect(rawRes.statusCode).toBe(200)
    const bytes = (rawRes as unknown as { rawPayload: Buffer }).rawPayload ?? Buffer.alloc(0)
    expect(bytes.length).toBe(big.length)
    void rawRes
  })

  it('MISSING files produce a clean 404', async () => {
    const s = await setup()
    const { status, body } = await getJson(s, `/api/v1/projects/${s.project.id}/repository/blob/main/nope/ghost.txt`)
    expect(status).toBe(404)
    expect(String(body.message)).toContain('not found')

    const missingDir = await getJson(s, `/api/v1/projects/${s.project.id}/repository/tree/main/nope-dir`)
    expect(missingDir.status).toBe(404)
  })

  it('rejects INVALID paths before touching the repository', async () => {
    const s = await setup()

    // Service-level: traversal and control characters never reach the engine.
    for (const bad of ['../secret', 'a/../b', 'has space']) {
      try {
        s.repos.tree(s.owner, s.project.id, 'main', bad)
        expect.unreachable(`expected rejection for '${bad}'`)
      } catch (err) {
        expect((err as { code?: string }).code ?? (err as Error).message).toMatch(/invalid_path|not allowed/i)
        expect((err as { status?: number }).status ?? 400).toBe(400)
      }
    }

    // Route-level: encoded characters survive transport and are rejected.
    const res = await authed(
      s.app, 'GET',
      `/api/v1/projects/${s.project.id}/repository/tree/main/has%20space`,
      { session: s.session },
    )
    expect(res.statusCode).toBe(400)
    expect((res.json() as { code?: string }).code).toBe('invalid_path')
  })
})

// -- authorization -----------------------------------------------------------------

describe('private repository authorization', () => {
  it('blocks anonymous readers entirely and strangers on every route', async () => {
    const s = await setup()
    await registerUser(s.app, { username: 'mallory', email: 'mallory@example.com' })
    const mallorySession = extractSession((await loginRaw(s.app, 'mallory')).cookies)
    const base = `/api/v1/projects/${s.project.id}/repository`

    // Anonymous → 401 (existence not leaked).
    for (const url of [
      `${base}/refs`,
      `${base}/tree/main`,
      `${base}/blob/main/README.md`,
      `${base}/raw/main/README.md`,
      `${base}/commits/main`,
      `${base}/search/main?q=read`,
      `${base}/download/main`,
    ]) {
      const anon = await s.app.inject({ method: 'GET', url })
      expect(anon.statusCode, `anon ${url}`).toBe(401)
    }

    // Authenticated stranger → 403.
    for (const url of [`${base}/refs`, `${base}/tree/main`, `${base}/blob/main/README.md`, `${base}/commits/main`]) {
      const stranger = await authed(s.app, 'GET', url, { session: mallorySession })
      expect(stranger.statusCode, `stranger ${url}`).toBe(403)
    }
  })
})

// -- permalinks & refs ----------------------------------------------------------------

describe('permalinks and ref selectors', () => {
  it('SHA-based URLs are immutable PERMALINKS while branch URLs follow the tip', async () => {
    const s = await setup()
    commit(s, 'v1 content', [{ path: 'doc.md', content: 'version one\n' }])
    const pinned = await getJson(s, `/api/v1/projects/${s.project.id}/repository/blob/main/doc.md`)
    const fixedSha = String(pinned.body.resolved_sha)

    // Branch moves forward…
    commit(s, 'v2 content', [{ path: 'doc.md', content: 'version two\n' }])

    // …but the SHA permalink still serves version one.
    const old = await getJson(s, `/api/v1/projects/${s.project.id}/repository/blob/${fixedSha}/doc.md`)
    expect(old.status).toBe(200)
    expect(old.body.text).toBe('version one\n')
    expect(old.body.resolved_via).toBe('sha')

    // The branch URL reflects the new tip.
    const fresh = await getJson(s, `/api/v1/projects/${s.project.id}/repository/blob/main/doc.md`)
    expect(fresh.body.text).toBe('version two\n')

    // Tree permalink under the same SHA keeps its historical listing.
    const treePin = await getJson(s, `/api/v1/projects/${s.project.id}/repository/tree/${fixedSha}`)
    expect(treePin.status).toBe(200)
    const pinnedNames = (treePin.body.entries as Array<{ name: string }>).map((e) => e.name)
    expect(pinnedNames).toContain('doc.md')
    expect(pinnedNames).not.toContain('later-only.txt')
  })

  it('exposes BRANCH and TAG selectors through /refs', async () => {
    const s = await setup()
    commit(s, 'seed', [{ path: 'a.txt', content: 'a' }])
    const tip = s.repos.resolveBranch(s.owner, s.project.id, 'main')!
    s.repos.createBranch(s.owner, s.project.id, { name: 'feature/x' })
    s.repos.createTag(s.owner, s.project.id, { name: 'v0.1.0', ref: 'main', message: 'first' })

    const { status, body } = await getJson(s, `/api/v1/projects/${s.project.id}/repository/refs`)
    expect(status).toBe(200)
    const branches = body.branches as Array<Record<string, unknown>>
    const tags = body.tags as Array<Record<string, unknown>>
    expect(branches.map((b) => b.name).sort()).toEqual(['feature/x', 'main'])
    expect(branches.find((b) => b.default === true)?.name).toBe('main')
    expect(tags[0]).toMatchObject({ name: 'v0.1.0', annotated: true, target: tip })
  })

  it('switching BRANCH changes the visible tree', async () => {
    const s = await setup()
    commit(s, 'main work', [{ path: 'on-main.txt', content: 'm' }])
    commit(s, 'branch work', [{ path: 'feature-only.txt', content: 'f' }], { new_branch: 'feature', start_branch: 'main' })

    const mainTree = await getJson(s, `/api/v1/projects/${s.project.id}/repository/tree/main`)
    expect((mainTree.body.entries as Array<{ name: string }>).some((e) => e.name === 'feature-only.txt')).toBe(false)

    const featureTree = await getJson(s, `/api/v1/projects/${s.project.id}/repository/tree/feature`)
    expect((featureTree.body.entries as Array<{ name: string }>).map((e) => e.name))
      .toEqual(expect.arrayContaining(['on-main.txt', 'feature-only.txt']))
  })
})

// -- history, blame, search --------------------------------------------------------------

describe('history, blame and search', () => {
  it('keeps DELETED FILE HISTORY: adds, edits and the deletion all remain listed', async () => {
    const s = await setup()
    commit(s, 'add temp', [{ path: 'temp.txt', content: 'one\n' }])
    commit(s, 'edit temp', [{ path: 'temp.txt', content: 'two\n' }])
    commit(s, 'remove temp', [{ path: 'temp.txt', delete: true }])
    commit(s, 'unrelated', [{ path: 'other.txt', content: 'o' }])

    // The blob is gone from the current tree…
    const gone = await getJson(s, `/api/v1/projects/${s.project.id}/repository/blob/main/temp.txt`)
    expect(gone.status).toBe(404)

    // …but its full history survives, ending with the deletion event.
    const hist = await getJson(s, `/api/v1/projects/${s.project.id}/repository/commits/main?path=temp.txt`)
    expect(hist.status).toBe(200)
    const commits = hist.body.commits as Array<{ title: string; kind: string }>
    expect(commits.map((c) => c.kind)).toEqual(['deleted', 'modified', 'added'])
    expect(commits.map((c) => c.title)).toEqual(['remove temp', 'edit temp', 'add temp'])
  })

  it('attributes BLAME lines to introducing commits via ranges', async () => {
    const s = await setup()
    const v1 = commit(s, 'blame v1', [{ path: 'code.ts', content: 'alpha\nbeta\ngamma\n' }]).commit_sha
    const v2 = commit(s, 'blame v2', [{ path: 'code.ts', content: 'alpha\nBETA\ngamma\n' }]).commit_sha

    const { status, body } = await getJson(s, `/api/v1/projects/${s.project.id}/repository/blame/main/code.ts`)
    expect(status).toBe(200)
    expect(body.ranges).toEqual([
      { start_line: 1, end_line: 1, commit_sha: v1 },
      { start_line: 2, end_line: 2, commit_sha: v2 },
      { start_line: 3, end_line: 3, commit_sha: v1 },
    ])
    const lines = body.lines as Array<{ number: number; content: string }>
    expect(lines).toHaveLength(3)
    expect(lines[1]).toMatchObject({ number: 2, content: 'BETA' })
  })

  it('SEARCHES filenames (default) and optionally contents (bounded)', async () => {
    const s = await setup()
    commit(s, 'search corpus', [
      { path: 'docs/guide.md', content: 'the quick brown fox\n' },
      { path: 'src/router.ts', content: 'export function guide() {}\n' },
      { path: 'notes.txt', content: 'nothing relevant\n' },
    ])

    const byName = await getJson(s, `/api/v1/projects/${s.project.id}/repository/search/main?q=gui`)
    expect(byName.status).toBe(200)
    expect((byName.body.matches as Array<{ path: string }>).map((m) => m.path)).toEqual(['docs/guide.md'])

    const byContent = await getJson(s, `/api/v1/projects/${s.project.id}/repository/search/main?q=guide&content=1`)
    const matches = byContent.body.matches as Array<{ path: string; line_matches?: Array<{ line: number }> }>
    expect(matches.map((m) => m.path).sort()).toEqual(['docs/guide.md', 'src/router.ts'])
    expect(matches.find((m) => m.path === 'src/router.ts')!.line_matches![0]!.line).toBe(1)

    const empty = await getJson(s, `/api/v1/projects/${s.project.id}/repository/search/main?q=`)
    expect(empty.status).toBe(400)
  })
})

// -- commits & downloads --------------------------------------------------------------------

describe('commit information and downloads', () => {
  it('shows COMMIT INFORMATION with changed-file kinds and exact stats', async () => {
    const s = await setup()
    commit(s, 'mixed change', [
      { path: 'added.txt', content: 'a' },
      { path: 'README.md', content: '# edited\n' },
      { path: 'gone.txt', content: 'x' },
    ])
    const removal = commit(s, 'cleanup', [
      { path: 'gone.txt', delete: true },
      { path: 'moved-in.txt', content: 'm' },
    ])

    const detail = await getJson(s, `/api/v1/projects/${s.project.id}/repository/commit/${removal.commit_sha}`)
    expect(detail.status).toBe(200)
    expect(detail.body.stats).toEqual({ added: 1, modified: 0, deleted: 1 })
    const changed = detail.body.changed_files as Array<{ path: string; kind: string }>
    expect(changed.some((c) => c.kind === 'deleted' && c.path === 'gone.txt')).toBe(true)
    expect(changed.some((c) => c.kind === 'added' && c.path === 'moved-in.txt')).toBe(true)

    // History endpoint paginates.
    const list = await getJson(s, `/api/v1/projects/${s.project.id}/repository/commits/main?per_page=2`)
    expect(list.body.pagination).toMatchObject({ page: 1, per_page: 2, has_more: true })
    expect(list.body.commits as unknown[]).toHaveLength(2)
  })

  it('downloads the repository AND subdirectories as valid tar.gz archives', async () => {
    const s = await setup()
    commit(s, 'archive seed', [
      { path: 'docs/deep/file.md', content: 'archived!' },
      { path: 'top.txt', content: 'top' },
    ])

    const whole = await authed(
      s.app, 'GET',
      `/api/v1/projects/${s.project.id}/repository/download/main`,
      { session: s.session },
    )
    expect(whole.statusCode).toBe(200)
    expect(whole.headers['content-type']).toBe('application/gzip')
    const wholeBytes = (whole as unknown as { rawPayload: Buffer }).rawPayload
    const untarred = gunzipSync(wholeBytes).toString('latin1')
    expect(untarred).toContain('browser-repo-main/docs/deep/file.md')
    expect(untarred).toContain('archived!')

    const subdir = await authed(
      s.app, 'GET',
      `/api/v1/projects/${s.project.id}/repository/download/main/docs/*`,
      { session: s.session },
    )
    expect(subdir.statusCode).toBe(200)
    const subBytes = gunzipSync((subdir as unknown as { rawPayload: Buffer }).rawPayload).toString('latin1')
    expect(subBytes).toContain('docs-main/deep/file.md')
    expect(subBytes).not.toContain('top.txt')

    // Missing directory → 404.
    const bad = await authed(
      s.app, 'GET',
      `/api/v1/projects/${s.project.id}/repository/download/main/no-such-dir/*`,
      { session: s.session },
    )
    expect(bad.statusCode).toBe(404)
  })

  it('supports EMPTY repositories gracefully', async () => {
    const app = makeApp()
    await registerUser(app)
    const session = extractSession((await loginRaw(app, 'alice')).cookies)
    await authed(app, 'POST', '/api/v1/projects', {
      session,
      payload: { name: 'Empty', path: 'empty', visibility: 'private', description: '', website_url: '', default_branch: 'main', topics: [] },
    })
    const id = app.store.projects.byOwnerPath('alice', 'empty')!.id
    const res = await authed(app, 'GET', `/api/v1/projects/${id}/repository/tree/main`, { session })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ empty_repository: true, entries: [], tip_commit: null })
  })
})
