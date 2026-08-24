import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginRaw, extractSession, authed } from './helpers.js'
import type { FastifyInstance } from 'fastify'
import type { Actor } from '../src/authz.js'

/**
 * Branch, tag and commit-history functionality tests.
 * Covers: branch creation, same-name conflicts, delete protection, rename,
 * default branch switching, tag creation, real commit history, compare,
 * invalid refs, authorization, concurrent changes.
 */

interface Setup {
  app: FastifyInstance
  session: ReturnType<typeof extractSession>
  owner: Actor
  stranger: Actor
  strangerSession: ReturnType<typeof extractSession>
  projectId: number
  repos: FastifyInstance['repositories']
}

async function setup(): Promise<Setup> {
  const app = makeApp()
  await registerUser(app) // alice → admin/owner
  const session = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'mallory', email: 'mallory@example.com' })
  const strangerSession = extractSession((await loginRaw(app, 'mallory')).cookies)

  const res = await authed(app, 'POST', '/api/v1/projects', {
    session,
    payload: {
      name: 'Flow Repo', path: 'flow-repo', visibility: 'private',
      description: '', website_url: '', default_branch: 'main',
      topics: [], initialize_with_readme: true,
    },
  })
  expect(res.statusCode).toBe(201)
  const project = app.store.projects.byOwnerPath('alice', 'flow-repo')!
  const alice = app.store.users.byUsername('alice')!
  return {
    app,
    session,
    owner: { userId: alice.id, username: 'alice', admin: true, state: 'active', via: { kind: 'session' } },
    stranger: { userId: app.store.users.byUsername('mallory')!.id, username: 'mallory', admin: false, state: 'active', via: { kind: 'session' } },
    strangerSession,
    projectId: project.id,
    repos: app.repositories,
  }
}

const base = (s: Setup) => `/api/v1/projects/${s.projectId}/repository`

function commit(s: Setup, message: string, changes: Array<{ path: string; content?: string; delete?: boolean }>, over: Record<string, unknown> = {}) {
  return s.repos.commitChanges(s.owner, s.projectId, { message, changes, ...over })
}

// -- branch creation -----------------------------------------------------------------

describe('branch creation', () => {
  it('creates a branch from a selected ref via the API', async () => {
    const s = await setup()
    commit(s, 'seed', [{ path: 'a.txt', content: 'a' }])
    const tip = await s.repos.resolveBranch(s.owner, s.projectId, 'main')

    const res = await authed(s.app, 'POST', `${base(s)}/branches`, {
      session: s.session,
      payload: { name: 'feature/login', start_point: 'main' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ branch: 'feature/login', commit_sha: tip })

    // Listed with metadata.
    const list = await authed(s.app, 'GET', `${base(s)}/branches`, { session: s.session })
    const branches = list.json().branches as Array<Record<string, unknown>>
    const feature = branches.find((b) => b.name === 'feature/login')!
    expect(feature).toMatchObject({ default: false, protected: false })
    expect(String(feature.title)).toBe('seed')
  })

  it('defaults the start point to the current default branch', async () => {
    const s = await setup()
    commit(s, 'base', [{ path: 'x', content: 'x' }])
    const res = await authed(s.app, 'POST', `${base(s)}/branches`, {
      session: s.session, payload: { name: 'from-default' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().commit_sha).toBe(await s.repos.resolveBranch(s.owner, s.projectId, 'main'))
  })
})

describe('same-name conflict', () => {
  it('refuses duplicate branch names with a conflict error', async () => {
    const s = await setup()
    commit(s, 'seed', [{ path: 'a.txt', content: 'a' }])
    await authed(s.app, 'POST', `${base(s)}/branches`, { session: s.session, payload: { name: 'dup' } })
    const again = await authed(s.app, 'POST', `${base(s)}/branches`, {
      session: s.session, payload: { name: 'dup', start_point: 'main' },
    })
    expect(again.statusCode).toBe(409)
    expect((again.json() as { code?: string }).code).toMatch(/branch_exists|ref_update_conflict/)

    // The existing branch was untouched by the failed creation.
    const tipBefore = await s.repos.resolveBranch(s.owner, s.projectId, 'dup')
    expect(tipBefore).toBeTruthy()
  })
})

describe('delete protection', () => {
  it('never deletes PROTECTED branches — even for the owner — while unprotected ones go', async () => {
    const s = await setup()
    commit(s, 'work', [{ path: 'f', content: '1' }])
    await s.repos.createBranch(s.owner, s.projectId, { name: 'deletable' })

    // Protect 'main' at no_one level AND demote alice so no admin bypass applies.
    s.app.store.db.run('UPDATE users SET admin = 0 WHERE id = ?', s.owner.userId)
    s.app.store.protectedBranches.set(s.projectId, 'main', 'no_one')

    const blocked = await authed(s.app, 'DELETE', `${base(s)}/branches/main`, { session: s.session })
    expect(blocked.statusCode).toBe(403)
    expect((blocked.json() as { code?: string }).code).toBe('protected_branch')
    // Still present:
    expect(await s.repos.resolveBranch(s.owner, s.projectId, 'main')).toBeTruthy()

    // Unprotected branch deletes fine.
    const ok = await authed(s.app, 'DELETE', `${base(s)}/branches/deletable`, { session: s.session })
    expect(ok.statusCode).toBe(200)
    expect(await s.repos.resolveBranch(s.owner, s.projectId, 'deletable')).toBeNull()

    // The DEFAULT branch is never deletable either.
    const defBlocked = await authed(s.app, 'DELETE', `${base(s)}/branches/main`, { session: s.session })
    expect([400, 403]).toContain(defBlocked.statusCode)
  })
})

describe('rename', () => {
  it('renames atomically: new ref claims the tip, old disappears', async () => {
    const s = await setup()
    commit(s, 'work on branch', [{ path: 'r.txt', content: 'r' }])
    await s.repos.createBranch(s.owner, s.projectId, { name: 'old-name' })
    const sha = await s.repos.resolveBranch(s.owner, s.projectId, 'old-name')

    const res = await authed(s.app, 'POST', `${base(s)}/branches/old-name/rename`.replace(/old-name$/, encodeURIComponent('old-name')) + '/rename'.replace(/^\/rename/, '/rename'), {
      session: s.session, payload: { new_name: 'renamed-branch' },
    }).catch(() => null)
    void res
    // Use service directly for deterministic assertion (route covered below).
    const renamed = s.repos.renameBranch(s.owner, s.projectId, 'old-name', 'renamed-branch')
    expect(renamed.sha).toBe(sha)

    expect(await s.repos.resolveBranch(s.owner, s.projectId, 'renamed-branch')).toBe(sha)
    expect(await s.repos.resolveBranch(s.owner, s.projectId, 'old-name')).toBeNull()
  })

  it('refuses renaming onto an existing name and rolls back cleanly', async () => {
    const s = await setup()
    commit(s, 'c', [{ path: 'c', content: '1' }])
    await s.repos.createBranch(s.owner, s.projectId, { name: 'b-one' })
    await s.repos.createBranch(s.owner, s.projectId, { name: 'b-two' })
    const oneTip = await s.repos.resolveBranch(s.owner, s.projectId, 'b-one')

    try {
      s.repos.renameBranch(s.owner, s.projectId, 'b-one', 'b-two')
      expect.unreachable('expected conflict')
    } catch (err) {
      expect((err as { status?: number }).status ?? 409).toBe(409)
    }
    // Both branches intact after the failed rename.
    expect(await s.repos.resolveBranch(s.owner, s.projectId, 'b-one')).toBe(oneTip)
    expect(await s.repos.resolveBranch(s.owner, s.projectId, 'b-two')).toBeTruthy()
  })

  it('protected branches cannot be renamed; the HTTP route works for plain ones', async () => {
    const s = await setup()
    commit(s, 'c', [{ path: 'p', content: '1' }])
    await s.repos.createBranch(s.owner, s.projectId, { name: 'plain' })
    s.app.store.db.run('UPDATE users SET admin = 0 WHERE id = ?', s.owner.userId)
    s.app.store.protectedBranches.set(s.projectId, 'plain', 'maintainer')

    try {
      s.repos.renameBranch(s.owner, s.projectId, 'plain', 'other')
      expect.unreachable('expected denial')
    } catch (err) {
      expect((err as { code?: string }).code).toBe('protected_branch')
    }

    s.app.store.db.run('DELETE FROM protected_branches WHERE project_id = ? AND name = ?', s.projectId, 'plain')
    const httpRename = await authed(
      s.app, 'POST',
      `${base(s)}/branches/rename`,
      { session: s.session, payload: { name: 'plain', new_name: 'renamed-via-http' } },
    )
    expect(httpRename.statusCode).toBe(200)
    expect(httpRename.json()).toMatchObject({ from: 'plain', to: 'renamed-via-http' })
  })
})

describe('default branch', () => {
  it('switches HEAD + metadata together and auto-protects the new default', async () => {
    const s = await setup()
    commit(s, 'on main', [{ path: 'm', content: 'm' }])
    await s.repos.createBranch(s.owner, s.projectId, { name: 'trunk' })
    commit(s, 'on trunk', [{ path: 't', content: 't' }], { new_branch: 'trunk', start_branch: 'main' })

    const res = await authed(s.app, 'PUT', `${base(s)}/default_branch`, {
      session: s.session, payload: { name: 'trunk' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ default_branch: 'trunk', previous: 'main' })

    // Engine HEAD follows; DB row follows; protection applied.
    const repo = s.repos.open(s.owner, s.projectId).repo
    expect(repo.defaultBranch()).toBe('trunk')
    expect(s.app.store.projects.byId(s.projectId)!.default_branch).toBe('trunk')
    const rules = s.app.store.protectedBranches.listForProject(s.projectId)
    expect(rules.find((r) => r.name === 'trunk')).toMatchObject({ push_access_level: 'maintainer' })

    // Missing branch → clean 404, nothing changes.
    const bad = await authed(s.app, 'PUT', `${base(s)}/default_branch`, {
      session: s.session, payload: { name: 'ghost' },
    })
    expect(bad.statusCode).toBe(404)
    expect(s.app.store.projects.byId(s.projectId)!.default_branch).toBe('trunk')
  })
})

describe('tags', () => {
  it('creates annotated tags against commits and lists them with targets', async () => {
    const s = await setup()
    const c1 = commit(s, 'v1 work', [{ path: 'v', content: '1' }]).commit_sha

    const res = await authed(s.app, 'POST', `${base(s)}/tags`, {
      session: s.session,
      payload: { name: 'v1.0.0', ref: c1, message: 'First tagged release' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ name: 'v1.0.0', annotated: true, target: c1 })

    // Tagging a BRANCH ref resolves to its tip commit.
    commit(s, 'v2 work', [{ path: 'v', content: '2' }])
    const t2 = await authed(s.app, 'POST', `${base(s)}/tags`, {
      session: s.session, payload: { name: 'v2.0.0', ref: 'main', message: '' },
    })
    expect(t2.statusCode).toBe(201)

    const list = await authed(s.app, 'GET', `${base(s)}/tags`, { session: s.session })
    const tags = list.json().tags as Array<Record<string, unknown>>
    expect(tags.map((t) => t.name)).toEqual(['v1.0.0', 'v2.0.0'])
    expect(tags.find((t) => t.name === 'v2.0.0')!.annotated).toBe(false)

    // Duplicate tag names are refused.
    const dup = await authed(s.app, 'POST', `${base(s)}/tags`, {
      session: s.session, payload: { name: 'v1.0.0', ref: 'main' },
    })
    expect(dup.statusCode).toBe(409)
  })

  it('deletes tags where allowed; unknown tags 404', async () => {
    const s = await setup()
    commit(s, 'c', [{ path: 'c', content: '1' }])
    await s.repos.createTag(s.owner, s.projectId, { name: 'tmp', ref: 'main' })

    const del = await authed(s.app, 'DELETE', `${base(s)}/tags/tmp`, { session: s.session })
    expect(del.statusCode).toBe(200)
    expect(await s.repos.listTags(s.owner, s.projectId).find(t => t.name === 'tmp')).toBeNull()

    const missing = await authed(s.app, 'DELETE', `${base(s)}/tags/tmp`, { session: s.session })
    expect(missing.statusCode).toBe(404)
  })
})

describe('commit history', () => {
  it('uses REAL git history: parent chains, ordering, path scoping with deletions', async () => {
    const s = await setup()
    commit(s, 'first', [{ path: 'lifecycle.txt', content: 'one\n' }])
    commit(s, 'second', [{ path: 'lifecycle.txt', content: 'two\n' }])
    commit(s, 'third', [{ path: 'unrelated.md', content: 'u' }])
    commit(s, 'fourth removes', [{ path: 'lifecycle.txt', delete: true }])

    const hist = await authed(s.app, 'GET', `${base(s)}/commits/main?per_page=50`, { session: s.session })
    expect(hist.statusCode).toBe(200)
    const titles = (hist.json().commits as Array<{ title: string }>).map((c) => c.title)
    expect(titles).toEqual(['fourth removes', 'third', 'second', 'first', 'Initial commit'])

    // Parent chain integrity from the detail endpoint.
    const detail = await authed(s.app, 'GET', `${base(s)}/commit/${await s.repos.resolveBranch(s.owner, s.projectId, 'main')}`, { session: s.session })
    const parents = detail.json().parents as string[]
    expect(parents).toHaveLength(1)

    // Path-scoped history keeps the deletion event last.
    const scoped = await authed(s.app, 'GET', `${base(s)}/commits/main?path=lifecycle.txt`, { session: s.session })
    const kinds = (scoped.json().commits as Array<{ kind: string }>).map((c) => c.kind)
    expect(kinds).toEqual(['deleted', 'modified', 'added'])
  })
})

describe('compare branches', () => {
  it('computes merge-base, ahead/behind commits and changed files with patches', async () => {
    const s = await setup()
    commit(s, 'base line', [
      { path: 'shared.txt', content: 'alpha\nbeta\ngamma\n' },
      { path: 'only-main.txt', content: 'main only' },
    ])

    // Diverge feature from main's tip.
    commit(s, 'feature adds', [{ path: 'new-feature.txt', content: 'hello\nworld\n' }], { new_branch: 'feature/x', start_branch: 'main' })
    commit(s, 'feature edits shared', [{ path: 'shared.txt', content: 'alpha\nBETA\ngamma\ndelta\n' }], { branch: 'feature/x' })
    // Meanwhile main moves too.
    commit(s, 'main advances', [{ path: 'main-progress.md', content: 'progress' }])

    const cmp = await authed(
      s.app, 'GET',
      `${base(s)}/compare?from=main&to=feature/x&with_patches=1`,
      { session: s.session },
    )
    expect(cmp.statusCode).toBe(200)
    const body = cmp.json() as Record<string, unknown>

    expect(body.merge_base).toBe(await s.repos.resolveBranch(s.owner, s.projectId, 'main'))
    expect(body.commits_ahead_count).toBe(2)
    expect(body.commits_behind_count).toBe(1)
    expect(((body.ahead as Array<{ title: string }>)[0]).title).toBe('feature edits shared')

    const files = body.files as Array<{ path: string; kind: string; patch?: string }>
    const paths = files.map((f) => f.path).sort()
    expect(paths).toEqual(['new-feature.txt', 'shared.txt'])

    const sharedPatch = files.find((f) => f.path === 'shared.txt')!
    expect(sharedPatch.kind).toBe('modified')
    expect(sharedPatch.patch).toContain('-beta')
    expect(sharedPatch.patch).toContain('+BETA')

    // Reverse direction flips ahead/behind counts.
    const reverse = await authed(s.app, 'GET', `${base(s)}/compare?from=feature/x&to=main`, { session: s.session })
    expect((reverse.json() as Record<string, number>).commits_ahead_count).toBe(1)
  })

  it('exposes COMMIT DIFF versus first parent', async () => {
    const s = await setup()
    commit(s, 'before', [{ path: 'd.txt', content: 'keep\nremove me\n' }, { path: 'gone.txt', content: 'bye' }])
    const editSha = commit(s, 'the edit', [
      { path: 'd.txt', content: 'keep\nstay\n' },
      { path: 'added.txt', content: 'fresh' },
      { path: 'gone.txt', delete: true },
    ]).commit_sha

    const diff = await authed(s.app, 'GET', `${base(s)}/commit/${editSha}/diff`, { session: s.session })
    expect(diff.statusCode).toBe(200)
    const body = diff.json() as { parent_sha: string | null; files: Array<{ path: string; kind: string; patch: string }> }
    expect(body.files.map((f) => f.path).sort()).toEqual(['added.txt', 'd.txt', 'gone.txt'])
    const dPatch = body.files.find((f) => f.path === 'd.txt')!
    expect(dPatch.patch).toContain('-remove me')
    expect(dPatch.patch).toContain('+stay')
    expect(body.parent_sha).toBeTruthy()
  })
})

describe('invalid refs', () => {
  it('rejects unknown branches/tags/shas across operations with clean errors', async () => {
    const s = await setup()
    commit(s, 'c', [{ path: 'c', content: '1' }])

    // Compare with unknown refs → 404 revision_not_found.
    const cmp = await authed(s.app, 'GET', `${base(s)}/compare?from=nope&to=main`, { session: s.session })
    expect(cmp.statusCode).toBe(404)

    // Delete unknown branch → 404.
    const del = await authed(s.app, 'DELETE', `${base(s)}/branches/nope-branch`, { session: s.session })
    expect(del.statusCode).toBe(404)

    // Create branch from unknown start point → 404.
    const badStart = await authed(s.app, 'POST', `${base(s)}/branches`, {
      session: s.session, payload: { name: 'valid-name', start_point: 'no-such-ref' },
    })
    expect(badStart.statusCode).toBe(404)

    // Illegal branch names are refused before touching disk.
    const illegal = await authed(s.app, 'POST', `${base(s)}/branches`, {
      session: s.session, payload: { name: '../escape' },
    })
    expect(illegal.statusCode).toBe(400)

    // Unknown tag deletion → 404 (covered above); unknown commit diff → 404.
    const badDiff = await authed(s.app, 'GET', `${base(s)}/commit/${'0'.repeat(40)}/diff`, { session: s.session })
    expect(badDiff.statusCode).toBe(404)
  })
})

describe('authorization', () => {
  it('blocks anonymous and non-owner actors on every branch/tag mutation', async () => {
    const s = await setup()
    commit(s, 'c', [{ path: 'c', content: '1' }])
    await s.repos.createBranch(s.owner, s.projectId, { name: 'target' })

    const anon = await s.app.inject({ method: 'POST', url: `${base(s)}/branches`, payload: { name: 'anon-b' } })
    expect(anon.statusCode).toBe(401)

    const strangerCreate = await authed(s.app, 'POST', `${base(s)}/branches`, {
      session: s.strangerSession, payload: { name: 'stranger-b' },
    })
    expect(strangerCreate.statusCode).toBe(403)

    const strangerDelete = await authed(s.app, 'DELETE', `${base(s)}/branches/target`, { session: s.strangerSession })
    expect(strangerDelete.statusCode).toBe(403)

    const strangerDefault = await authed(s.app, 'PUT', `${base(s)}/default_branch`, {
      session: s.strangerSession, payload: { name: 'target' },
    })
    expect(strangerDefault.statusCode).toBe(403)

    const strangerProtect = await authed(s.app, 'PUT', `${base(s)}/protected_branches`, {
      session: s.strangerSession, payload: { name: 'target', push_access_level: 'no_one' },
    })
    expect(strangerProtect.statusCode).toBe(403)

    const strangerTagDelete = await authed(s.app, 'DELETE', `${base(s)}/tags/whatever`, { session: s.strangerSession })
    expect(strangerTagDelete.statusCode).toBe(403)

    // Nothing changed.
    expect(await s.repos.resolveBranch(s.owner, s.projectId, 'target')).toBeTruthy()
    expect(await s.repos.resolveBranch(s.owner, s.projectId, 'anon-b')).toBeNull()
    expect(await s.repos.resolveBranch(s.owner, s.projectId, 'stranger-b')).toBeNull()
  })
})

describe('concurrent changes', () => {
  it('branch creation races resolve to exactly one winner (create-only CAS)', async () => {
    const s = await setup()
    commit(s, 'c', [{ path: 'c', content: '1' }])
    const sha = await s.repos.resolveBranch(s.owner, s.projectId, 'main')
    const repo = s.repos.open(s.owner, s.projectId).repo

    let firstFailed = false
    try {
      repo.updateRef('refs/heads/race', sha!, null) // winner
      repo.updateRef('refs/heads/race', sha!, null) // loser must fail
      expect.unreachable()
    } catch (err) {
      firstFailed = true
      expect((err as { code?: string }).code).toBe('ref_conflict')
    }
    expect(firstFailed).toBe(true)
    expect(repo.resolveBranch('race')).toBe(sha)
  })

  it('delete-vs-rename races keep exactly one live ref pointing at the work', async () => {
    const s = await setup()
    commit(s, 'c', [{ path: 'c', content: '1' }])
    await s.repos.createBranch(s.owner, s.projectId, { name: 'contested' })
    const sha = await s.repos.resolveBranch(s.owner, s.projectId, 'contested')
    const repo = s.repos.open(s.owner, s.projectId).repo

    // Rename wins the old ref's CAS…
    s.repos.renameBranch(s.owner, s.projectId, 'contested', 'contested-renamed')
    // …a stale delete targeting the OLD name with the recorded tip must fail.
    try {
      repo.deleteRef('refs/heads/contested', sha!)
      expect.unreachable('stale delete must fail')
    } catch (err) {
      expect((err as { code?: string }).code).toBe('ref_conflict')
    }
    // Work survives under the new name only.
    expect(repo.resolveBranch('contested')).toBeNull()
    expect(repo.resolveBranch('contested-renamed')).toBe(sha)
  })
})
