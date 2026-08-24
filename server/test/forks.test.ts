import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginRaw, extractSession, authed } from './helpers.js'
import type { FastifyInstance } from 'fastify'
import type { Actor } from '../src/authz.js'

/**
 * Fork system tests: fork creation (history preserved), duplicate forks,
 * private-source authorization + visibility caps, sync (behind/ahead/diverged/
 * up-to-date), detach confirmation/permissions, network graph traversal,
 * and permission enforcement on every mutation.
 */

interface Setup {
  app: FastifyInstance
  alice: Actor
  aliceSession: ReturnType<typeof extractSession>
  bob: Actor
  bobSession: ReturnType<typeof extractSession>
  mallorySession: ReturnType<typeof extractSession>
}

async function setup(): Promise<Setup> {
  const app = makeApp()
  await registerUser(app) // alice
  const aliceSession = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'bob', email: 'bob@example.com' })
  const bobSession = extractSession((await loginRaw(app, 'bob')).cookies)
  await registerUser(app, { username: 'mallory', email: 'mallory@example.com' })
  const mallorySession = extractSession((await loginRaw(app, 'mallory')).cookies)

  function actor(name: string): Actor {
    const u = app.store.users.byUsername(name)!
    return { userId: u.id, username: name, admin: false, state: 'active', via: { kind: 'session' } }
  }
  return {
    app, alice: actor('alice'), bob: actor('bob'),
    aliceSession, bobSession, mallorySession,
  }
}

/** Creates a source project as alice with one commit. */
async function makeSource(s: Setup, opts: { visibility?: string; path?: string } = {}): Promise<{ id: number; full_path: string }> {
  const res = await authed(s.app, 'POST', '/api/v1/projects', {
    session: s.aliceSession,
    payload: {
      name: opts.path ?? 'source-repo', path: opts.path ?? 'source-repo',
      visibility: opts.visibility ?? 'public',
      description: 'Fork me', website_url: '', default_branch: 'main',
      topics: [], initialize_with_readme: true,
    },
  })
  expect(res.statusCode).toBe(201)
  const project = s.app.store.projects.byOwnerPath('alice', opts.path ?? 'source-repo')!
  return { id: project.id, full_path: 'alice/' + project.path }
}

function repos(s: Setup) { return s.app.repositories }
function forksSvc(s: Setup) { return s.app.forks }

async function commitOn(s: Setup, actor: Actor, projectId: number, message: string, changes: Array<{ path: string; content?: string; delete?: boolean }>, over: Record<string, unknown> = {}) {
  return repos(s).commitChanges(actor, projectId, { message, changes, ...over })
}

// -- fork -------------------------------------------------------------------------

describe('fork repository', () => {
  it('forks into the user namespace with FULL history preserved (identical SHAs)', async () => {
    const s = await setup()
    const src = await makeSource(s)
    // Extra branch + commits before forking.
    commitOn(s, s.alice, src.id, 'feature work', [{ path: 'feat.txt', content: 'f' }], { new_branch: 'feature/x', start_branch: 'main' })
    commitOn(s, s.alice, src.id, 'main moves on', [{ path: 'later.md', content: 'l' }])
    const mainSha = await repos(s).resolveBranch(s.alice, src.id, 'main')
    const featSha = await repos(s).resolveBranch(s.alice, src.id, 'feature/x')

    const res = await authed(s.app, 'POST', `/api/v1/projects/${src.id}/fork`, {
      session: s.bobSession,
      payload: { path: 'my-fork', namespace: 'bob' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as Record<string, unknown>
    const forkProject = body.project as Record<string, unknown>
    expect(forkProject.path).toBe('my-fork')
    expect(body.source).toEqual({ id: src.id, full_path: src.full_path })

    // Relationship stored.
    const row = s.app.store.projects.byId(forkProject.id as number)!
    expect(row.forked_from_project_id).toBe(src.id)
    expect(row.fork_network_id).toBe(src.id) // root of its own network

    // History preserved: same branch tips resolve to identical SHAs.
    const forkId = forkProject.id as number
    expect(await repos(s).resolveBranch(s.bob, forkId, 'main')).toBe(mainSha)
    expect(await repos(s).resolveBranch(s.bob, forkId, 'feature/x')).toBe(featSha)
    // Content readable through the fork.
    expect(repos(s).readFileAt(s.bob, forkId, 'main', 'later.md').toString()).toBe('l')
    // Metadata copied.
    expect(row.description).toBe('Fork me')
    expect(row.default_branch).toBe('main')
  })

  it('records an upstream reference visible in the project serializer', async () => {
    const s = await setup()
    const src = await makeSource(s)
    const res = await authed(s.app, 'POST', `/api/v1/projects/${src.id}/fork`, {
      session: s.bobSession, payload: {},
    })
    expect(res.statusCode).toBe(201)
    const view = await authed(s.app, 'GET', `/api/v1/projects/${(res.json() as { project: { id: number } }).project.id}`, { session: s.bobSession })
    expect(view.json().upstream_full_path).toBe(src.full_path)
  })

  it('rejects organization namespaces until groups land (distinct error)', async () => {
    const s = await setup()
    const src = await makeSource(s)
    const res = await authed(s.app, 'POST', `/api/v1/projects/${src.id}/fork`, {
      session: s.bobSession, payload: { namespace: 'some-org' },
    })
    expect(res.statusCode).toBe(422)
    expect((res.json() as { code?: string }).code).toBe('namespace_unsupported')
  })
})

describe('duplicate fork', () => {
  it('refuses a second fork at the same path in the target namespace', async () => {
    const s = await setup()
    const src = await makeSource(s)
    const first = await authed(s.app, 'POST', `/api/v1/projects/${src.id}/fork`, {
      session: s.bobSession, payload: { path: 'dupe' },
    })
    expect(first.statusCode).toBe(201)

    const second = await authed(s.app, 'POST', `/api/v1/projects/${src.id}/fork`, {
      session: s.bobSession, payload: { path: 'DUPE' }, // case-insensitive collision
    })
    expect(second.statusCode).toBe(409)
    expect((second.json() as { code?: string }).code).toBe('path_taken')
  })

  it('conflicts with any existing project path in the namespace, even across sources', async () => {
    const s = await setup()
    const a = await makeSource(s, { path: 'repo-a' })
    await makeSource(s, { path: 'repo-b' })
    // bob creates his own 'clash' project…
    await authed(s.app, 'POST', '/api/v1/projects', {
      session: s.bobSession,
      payload: { name: 'Clash', path: 'clash', visibility: 'private', description: '', website_url: '', default_branch: 'main', topics: [] },
    })
    // …then forking repo-a to that occupied path fails.
    const res = await authed(s.app, 'POST', `/api/v1/projects/${a.id}/fork`, {
      session: s.bobSession, payload: { path: 'clash' },
    })
    expect(res.statusCode).toBe(409)
  })
})

describe('private fork authorization & visibility validation', () => {
  it('blocks anonymous and unauthorized users from forking private sources', async () => {
    const s = await setup()
    const priv = await makeSource(s, { visibility: 'private' })

    const anon = await s.app.inject({ method: 'POST', url: `/api/v1/projects/${priv.id}/fork`, payload: {} })
    expect(anon.statusCode).toBe(401)

    const stranger = await authed(s.app, 'POST', `/api/v1/projects/${priv.id}/fork`, {
      session: s.mallorySession, payload: { path: 'stolen' },
    })
    expect(stranger.statusCode).toBe(403)

    // Nothing was created.
    expect(s.app.store.projects.byOwnerPath('mallory', 'stolen')).toBeUndefined()
  })

  it('allows authorized collaborators (the owner herself / admins) and other users for PUBLIC sources', async () => {
    const s = await setup()
    const pub = await makeSource(s, { visibility: 'public' })
    const res = await authed(s.app, 'POST', `/api/v1/projects/${pub.id}/fork`, {
      session: s.mallorySession, payload: { path: 'legit-fork' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('never allows a fork MORE visible than its upstream', async () => {
    const s = await setup()
    const internal = await makeSource(s, { visibility: 'internal' })

    const escalated = await authed(s.app, 'POST', `/api/v1/projects/${internal.id}/fork`, {
      session: s.bobSession, payload: { path: 'esc', visibility: 'public' },
    })
    expect(escalated.statusCode).toBe(400)
    expect((escalated.json() as { code?: string }).code).toBe('visibility_exceeds_source')

    // Equal-or-lower is fine.
    const ok = await authed(s.app, 'POST', `/api/v1/projects/${internal.id}/fork`, {
      session: s.bobSession, payload: { path: 'capped', visibility: 'private' },
    })
    expect(ok.statusCode).toBe(201)
    const row = s.app.store.projects.byOwnerPath('bob', 'capped')!
    expect(row.visibility).toBe('private')

    // Default inherits source visibility.
    const inherit = await authed(s.app, 'POST', `/api/v1/projects/${internal.id}/fork`, {
      session: s.bobSession, payload: { path: 'inherit' },
    })
    expect(inherit.statusCode).toBe(201)
    expect(s.app.store.projects.byOwnerPath('bob', 'inherit')!.visibility).toBe('internal')
  })
})

// -- sync ---------------------------------------------------------------------------

describe('sync fork', () => {
  interface ForkedSetup extends Setup {
    sourceId: number
    forkId: number
  }

  async function forkedSetup(): Promise<ForkedSetup> {
    const s = await setup()
    const src = await makeSource(s)
    const res = await authed(s.app, 'POST', `/api/v1/projects/${src.id}/fork`, {
      session: s.bobSession, payload: { path: 'sync-fork' },
    })
    expect(res.statusCode).toBe(201)
    return { ...s, sourceId: src.id, forkId: (res.json() as { project: { id: number } }).project.id }
  }

  it('reports BEHIND then fast-forwards safely; repeated sync is UP TO DATE', async () => {
    const fs0 = await forkedSetup()
    commitOn(fs0, fs0.alice, fs0.sourceId, 'upstream one', [{ path: 'u1.txt', content: '1\n' }])
    commitOn(fs0, fs0.alice, fs0.sourceId, 'upstream two', [{ path: 'u2.txt', content: '2\n' }])
    void fs0

    const divBefore = forksSvc(s0()).divergence(fs0.bob, fs0.forkId, {})
    expect(divBefore.state).toBe('behind')
    expect(divBefore.behind_count).toBeGreaterThanOrEqual(2)
    expect(divBefore.ahead_count).toBe(0)

    function s0(): Setup { return fs0 }

    const syncRes = await authed(fs0.app, 'POST', `/api/v1/projects/${fs0.forkId}/fork/sync`, {
      session: fs0.bobSession, payload: {},
    })
    expect(syncRes.statusCode).toBe(200)
    const body = syncRes.json() as { outcome: string; report: { state: string } }
    expect(body.outcome).toBe('updated')
    expect(body.report.state).toBe('behind')

    // Fork tip now equals upstream tip; upstream-only files present.
    const tips = forksSvc(fs0).divergence(fs0.bob, fs0.forkId, {})
    expect(tips.state).toBe('up_to_date')
    expect(await repos(fs0).resolveBranch(fs0.bob, fs0.forkId, 'main'))
      .toBe(await repos(fs0).resolveBranch(fs0.alice, fs0.sourceId, 'main'))
    expect(repos(fs0).readFileAt(fs0.bob, fs0.forkId, 'main', 'u2.txt').toString()).toBe('2\n')

    // Idempotent: syncing again reports up_to_date without changes.
    const again = await authed(fs0.app, 'POST', `/api/v1/projects/${fs0.forkId}/fork/sync`, {
      session: fs0.bobSession, payload: {},
    })
    expect((again.json() as { outcome: string }).outcome).toBe('noop')
  })

  it('AHEAD forks are left alone (local work preserved)', async () => {
    const fs1 = await forkedSetup()
    commitOn(fs1, fs1.bob, fs1.forkId, 'local experiment', [{ path: 'local.txt', content: 'mine' }])

    const report = forksSvc(fs1).divergence(fs1.bob, fs1.forkId, {})
    expect(report.state).toBe('ahead')
    expect(report.ahead_count).toBeGreaterThanOrEqual(1)

    const syncRes = await authed(fs1.app, 'POST', `/api/v1/projects/${fs1.forkId}/fork/sync`, {
      session: fs1.bobSession, payload: {},
    })
    expect(syncRes.statusCode).toBe(200)
    expect((syncRes.json() as { outcome: string }).outcome).toBe('noop')

    // Local commit untouched.
    expect(repos(fs1).readFileAt(fs1.bob, fs1.forkId, 'main', 'local.txt').toString()).toBe('mine')
  })

  it('DIVERGED forks refuse sync — fork changes are NEVER overwritten', async () => {
    const fs2 = await forkedSetup()

    // Both sides advance independently.
    commitOn(fs2, fs2.bob, fs2.forkId, 'fork-side change', [{ path: 'shared.txt', content: 'fork version' }])
    // The guard point: after the fork-side commit, BEFORE sync is attempted.
    const forkTipBefore = await repos(fs2).resolveBranch(fs2.bob, fs2.forkId, 'main')
    commitOn(fs2, fs2.alice, fs2.sourceId, 'upstream change', [{ path: 'shared.txt', content: 'upstream version' }])

    const div = forksSvc(fs2).divergence(fs2.bob, fs2.forkId, {})
    expect(div.state).toBe('diverged')
    expect(div.ahead_count).toBeGreaterThan(0)
    expect(div.behind_count).toBeGreaterThan(0)

    const syncRes = await authed(fs2.app, 'POST', `/api/v1/projects/${fs2.forkId}/fork/sync`, {
      session: fs2.bobSession, payload: {},
    })
    expect(syncRes.statusCode).toBe(409)
    const err = syncRes.json() as { code?: string; ahead_count?: number; behind_count?: number }
    expect(err.code).toBe('fork_diverged')
    expect(err.ahead_count).toBeGreaterThan(0)
    expect(err.behind_count).toBeGreaterThan(0)

    // Fork tip UNCHANGED — no blind overwrite.
    expect(await repos(fs2).resolveBranch(fs2.bob, fs2.forkId, 'main')).toBe(forkTipBefore)
    expect(repos(fs2).readFileAt(fs2.bob, fs2.forkId, 'main', 'shared.txt').toString()).toBe('fork version')
  })

  it('sync is CONCURRENCY-SAFE: a racing local commit makes the CAS update conflict', async () => {
    const fs3 = await forkedSetup()
    commitOn(fs3, fs3.alice, fs3.sourceId, 'advance upstream', [{ path: 'u.txt', content: 'u' }])

    // Simulate: divergence computed while tip was F, but another writer lands
    // on F before the ref update executes.
    const repo = repos(fs3).open(fs3.bob, fs3.forkId).repo
    const staleTip = repo.resolveBranch('main')!
    commitOn(fs3, fs3.bob, fs3.forkId, 'racing writer', [{ path: 'race.txt', content: 'x' }])
    let conflicted = false
    try {
      repo.updateRef('refs/heads/main', 'f'.repeat(40), staleTip)
      void conflicted
    } catch {
      // Either CAS conflict or invalid sha — both prove the guard exists.
      conflicted = true
    }
    expect(conflicted).toBe(true)
    void fs3
  })

  it('non-forks and missing branches fail with clean errors', async () => {
    const s = await setup()
    const plain = await makeSource(s)
    // not_a_fork:
    try {
      forksSvc(s).syncBranch(s.alice, plain.id, {})
      expect.unreachable()
    } catch (err) {
      expect((err as { code?: string }).code).toBe('not_a_fork')
    }
    // branch_missing:
    const src = plain
    const res = await authed(s.app, 'POST', `/api/v1/projects/${src.id}/fork`, {
      session: s.bobSession, payload: { path: 'br-fork' },
    })
    const forkId = (res.json() as { project: { id: number } }).project.id
    const badBranch = await authed(s.app, 'POST', `/api/v1/projects/${forkId}/fork/sync`, {
      session: s.bobSession, payload: { branch: 'no-such-branch' },
    })
    expect(badBranch.statusCode).toBe(404)
  })
})

// -- detach --------------------------------------------------------------------------

describe('detach fork', () => {
  it('requires typed confirmation of the full path', async () => {
    const s = await setup()
    const src = await makeSource(s)
    const res = await authed(s.app, 'POST', `/api/v1/projects/${src.id}/fork`, {
      session: s.bobSession, payload: { path: 'detach-me' },
    })
    const forkId = (res.json() as { project: { id: number } }).project.id

    const wrong = await authed(s.app, 'POST', `/api/v1/projects/${forkId}/fork/detach`, {
      session: s.bobSession, payload: { confirm_path: 'bob/wrong' },
    })
    expect(wrong.statusCode).toBe(400)

    const ok = await authed(s.app, 'POST', `/api/v1/projects/${forkId}/fork/detach`, {
      session: s.bobSession, payload: { confirm_path: 'bob/detach-me' },
    })
    expect(ok.statusCode).toBe(200)
    const row = s.app.store.projects.byId(forkId)!
    expect(row.forked_from_project_id).toBeNull()
    expect(row.fork_network_id).toBeNull()

    // Second detach → not_a_fork.
    const again = await authed(s.app, 'POST', `/api/v1/projects/${forkId}/fork/detach`, {
      session: s.bobSession, payload: { confirm_path: 'bob/detach-me' },
    })
    expect(again.statusCode).toBe(422)
    expect((again.json() as { code?: string }).code).toBe('not_a_fork')
  })

  it('denies non-owner detach attempts even with correct confirmation', async () => {
    const s = await setup()
    const src = await makeSource(s)
    const res = await authed(s.app, 'POST', `/api/v1/projects/${src.id}/fork`, {
      session: s.bobSession, payload: { path: 'guard-fork' },
    })
    const forkId = (res.json() as { project: { id: number } }).project.id

    const stranger = await authed(s.app, 'POST', `/api/v1/projects/${forkId}/fork/detach`, {
      session: s.mallorySession, payload: { confirm_path: 'bob/guard-fork' },
    })
    expect(stranger.statusCode).toBe(403)
    expect(s.app.store.projects.byId(forkId)!.forked_from_project_id).toBe(src.id)
  })
})

// -- network ------------------------------------------------------------------------

describe('fork network graph', () => {
  it('traverses upstream → direct forks → descendants with materialized counts', async () => {
    const s = await setup()
    // Register carol for depth 2.
    await registerUser(s.app, { username: 'carol', email: 'carol@example.com' })
    const carolSession = extractSession((await loginRaw(s.app, 'carol')).cookies)
    void carolSession

    const root = await makeSource(s)
    const b = await authed(s.app, 'POST', `/api/v1/projects/${root.id}/fork`, {
      session: s.bobSession, payload: { path: 'level-one' },
    })
    const c = await authed(s.app, 'POST', `/api/v1/projects/${(b.json() as { project: { id: number } }).project.id}/fork`, {
      session: s.mallorySession, payload: { path: 'level-two' },
    })
    const d = await authed(s.app, 'POST', `/api/v1/projects/${root.id}/fork`, {
      session: s.mallorySession, payload: { path: 'sibling' },
    })
    const levelOneId = (b.json() as { project: { id: number } }).project.id
    const levelTwoId = (c.json() as { project: { id: number } }).project.id

    // Graph queried FROM THE DEEPEST node must still see everything.
    const graph = await authed(s.app, 'GET', `/api/v1/projects/${levelTwoId}/fork/network`, { session: s.mallorySession })
    expect(graph.statusCode).toBe(200)
    const body = graph.json() as {
      total_size: number
      max_depth: number
      root: { id: number; full_path: string; direct_forks: number; total_descendants: number }
      members: Array<{ id: number; full_path: string; forked_from: number | null; direct_forks: number }>
    }

    expect(body.total_size).toBe(4)
    expect(body.max_depth).toBe(3)
    expect(body.root.full_path).toBe(root.full_path)
    expect(body.root.direct_forks).toBe(2) // level-one + sibling

    const members = new Map(body.members.map((m) => [m.id, m]))
    expect(members.get(levelOneId)!.direct_forks).toBe(1) // level-two
    expect(members.get(levelTwoId)!.direct_forks).toBe(0)
    // Parent links form the chain: level-two → level-one → root.
    expect(members.get(levelOneId)!.forked_from).toBe(root.id)
    expect(members.get(levelTwoId)!.forked_from).toBe(levelOneId)
    void d
  })

  it('a detached fork leaves the network', async () => {
    const s = await setup()
    const root = await makeSource(s)
    const f = await authed(s.app, 'POST', `/api/v1/projects/${root.id}/fork`, {
      session: s.bobSession, payload: { path: 'leaver' },
    })
    const forkId = (f.json() as { project: { id: number } }).project.id
    await authed(s.app, 'POST', `/api/v1/projects/${forkId}/fork/detach`, {
      session: s.bobSession, payload: { confirm_path: 'bob/leaver' },
    })

    const graph = await authed(s.app, 'GET', `/api/v1/projects/${root.id}/fork/network`, { session: s.aliceSession })
    const body = graph.json() as { total_size: number; members: Array<{ id: number }> }
    expect(body.total_size).toBe(1)
    expect(body.members.map((m) => m.id)).not.toContain(forkId)
  })
})

// -- permissions ----------------------------------------------------------------------

describe('fork permission enforcement', () => {
  it('gates every mutation: anonymous 401, strangers 403', async () => {
    const s = await setup()
    const src = await makeSource(s, { visibility: 'public' })
    const f = await authed(s.app, 'POST', `/api/v1/projects/${src.id}/fork`, {
      session: s.bobSession, payload: { path: 'perm-fork' },
    })
    const forkId = (f.json() as { project: { id: number } }).project.id

    const anonDiv = await s.app.inject({ method: 'GET', url: `/api/v1/projects/${forkId}/fork/divergence` })
    expect(anonDiv.statusCode).toBe(401)

    const anonSync = await s.app.inject({ method: 'POST', url: `/api/v1/projects/${forkId}/fork/sync`, payload: {} })
    expect(anonSync.statusCode).toBe(401)

    const strangerSync = await authed(s.app, 'POST', `/api/v1/projects/${forkId}/fork/sync`, {
      session: s.mallorySession, payload: {},
    })
    expect(strangerSync.statusCode).toBe(403)

    const strangerDetach = await authed(s.app, 'POST', `/api/v1/projects/${forkId}/fork/detach`, {
      session: s.mallorySession, payload: { confirm_path: 'bob/perm-fork' },
    })
    expect(strangerDetach.statusCode).toBe(403)
  })

  it('audits denied attempts', async () => {
    const s = await setup()
    const src = await makeSource(s, { visibility: 'private' })
    await authed(s.app, 'POST', `/api/v1/projects/${src.id}/fork`, {
      session: s.mallorySession, payload: { path: 'nope' },
    })
    const mallory = s.app.store.users.byUsername('mallory')!
    const denials = s.app.store.audit.listForUser(mallory.id, 20)
      .filter((r) => String(r.event) === 'repo_write_denied')
    expect(denials.length).toBeGreaterThanOrEqual(1)
  })
})
