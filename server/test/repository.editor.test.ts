import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginRaw, extractSession, authed } from './helpers.js'
import type { FastifyInstance } from 'fastify'
import type { Actor } from '../src/authz.js'

/**
 * Browser-based file editing system tests (web editor parity):
 * edit, create, delete, rename, multi-file commit, stale base commit
 * (optimistic concurrency), permission denial, protected branch, large file.
 */

interface Setup {
  app: FastifyInstance
  session: ReturnType<typeof extractSession>
  owner: Actor
  strangerSession: Awaited<ReturnType<typeof extractSession>> | null
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
      name: 'Editor Repo', path: 'editor-repo', visibility: 'private',
      description: '', website_url: '', default_branch: 'main',
      topics: [], initialize_with_readme: true,
    },
  })
  expect(res.statusCode).toBe(201)
  const project = app.store.projects.byOwnerPath('alice', 'editor-repo')!
  const user = app.store.users.byUsername('alice')!
  return {
    app,
    session,
    owner: { userId: user.id, username: 'alice', admin: true, state: 'active', via: { kind: 'session' } },
    strangerSession,
    projectId: project.id,
    repos: app.repositories,
  }
}

function commitUrl(s: Setup): string {
  return `/api/v1/projects/${s.projectId}/repository/commit`
}

/** POST one change through the web-editor endpoint. */
function postCommit(s: Setup, payload: Record<string, unknown>, session: Setup['session'] = s.session) {
  return authed(s.app, 'POST', commitUrl(s), { session, payload: { commit_message: 'web edit', ...payload } })
}

async function currentTip(s: Setup, branch = 'main'): Promise<string | null> {
  return s.repos.resolveBranch(s.owner, s.projectId, branch)
}

// -- create / edit ----------------------------------------------------------------

describe('create and edit files', () => {
  it('CREATEs a new file with implicit directory', async () => {
    const s = await setup()
    const res = await postCommit(s, {
      changes: [{ path: 'docs/new-page.md', content: '# Fresh\n' }],
      branch: 'main',
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ branch: 'main', created_branch: false })

    const blob = s.repos.blob(s.owner, s.projectId, 'main', 'docs/new-page.md')
    expect(blob.text).toBe('# Fresh\n')
  })

  it('EDITs an existing file (replace semantics) and reports the replaced path', async () => {
    const s = await setup()
    await postCommit(s, { changes: [{ path: 'notes.txt', content: 'v1' }], branch: 'main' })
    const res = await postCommit(s, { changes: [{ path: 'notes.txt', content: 'v2' }], branch: 'main' })

    expect(res.statusCode).toBe(201)
    expect((res.json() as { replaced_paths: string[] }).replaced_paths).toEqual(['notes.txt'])
    expect(s.repos.readFileAt(s.owner, s.projectId, 'main', 'notes.txt').toString()).toBe('v2')
  })

  it('supports BINARY replace through content_base64', async () => {
    const s = await setup()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x00, 0x01])
    const res = await postCommit(s, {
      changes: [{ path: 'assets/icon.png', content_base64: png.toString('base64') }],
      branch: 'main',
    })
    expect(res.statusCode).toBe(201)
    const stored = s.repos.rawBlob(s.owner, s.projectId, 'main', 'assets/icon.png')
    expect(Buffer.compare(stored, png)).toBe(0)
  })
})

// -- delete / rename -----------------------------------------------------------------

describe('delete and rename files', () => {
  it('DELETEs a file in a commit; history keeps the deletion event', async () => {
    const s = await setup()
    await postCommit(s, { changes: [{ path: 'obsolete.txt', content: 'old' }], branch: 'main' })

    const res = await postCommit(s, { changes: [{ path: 'obsolete.txt', delete: true }], branch: 'main' })
    expect(res.statusCode).toBe(201)

    // Gone from the tree…
    try {
      s.repos.blob(s.owner, s.projectId, 'main', 'obsolete.txt')
      expect.unreachable('expected 404')
    } catch (err) {
      expect((err as { status?: number }).status).toBe(404)
    }

    // …but the deletion is recorded as the last path-history event.
    const hist = s.repos.fileHistory(s.owner, s.projectId, 'main', 'obsolete.txt')
    expect(hist.commits.map((c) => c.kind)).toEqual(['deleted', 'added'])
  })

  it('RENAMEs by moving content to the new path in ONE atomic commit', async () => {
    const s = await setup()
    await postCommit(s, { changes: [{ path: 'old/name.md', content: 'content here' }], branch: 'main' })

    const res = await postCommit(s, {
      changes: [
        { path: 'new-name.md', content: 'content here' }, // copy forward
        { path: 'old/name.md', delete: true },            // …then drop original
      ],
      branch: 'main',
    })
    expect(res.statusCode).toBe(201)

    const moved = s.repos.blob(s.owner, s.projectId, 'main', 'new-name.md')
    expect(moved.text).toBe('content here')
    try {
      s.repos.blob(s.owner, s.projectId, 'main', 'old/name.md')
      expect.unreachable('expected old path gone')
    } catch (err) {
      expect((err as { status?: number }).status).toBe(404)
    }
  })

  it('rejects deleting a nonexistent path with 404', async () => {
    const s = await setup()
    const res = await postCommit(s, { changes: [{ path: 'ghost.txt', delete: true }], branch: 'main' })
    expect(res.statusCode).toBe(404)
    expect((res.json() as { code?: string }).code).toBe('file_not_found')
  })
})

// -- multi-file commit + branch workflow -----------------------------------------------

describe('multi-file editing and branch commits', () => {
  it('commits MULTIPLE file changes as ONE commit', async () => {
    const s = await setup()
    const before = await currentTip(s)

    const res = await postCommit(s, {
      changes: [
        { path: 'multi/a.txt', content: 'a' },
        { path: 'multi/b.txt', content: 'b' },
        { path: 'README.md', content: '# rewritten\n' },
      ],
      branch: 'main',
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { commit_sha: string }
    expect(await currentTip(s)).toBe(body.commit_sha)
    expect(body.commit_sha).not.toBe(before)

    // Exactly one new commit on main containing all three paths.
    const detail = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/repository/commit/${body.commit_sha}`, { session: s.session })
    const stats = detail.json().stats as Record<string, number>
    expect(stats.added).toBe(2)
    expect(stats.modified).toBe(1)
  })

  it('commits to a NEW BRANCH off a start branch without touching the source', async () => {
    const s = await setup()
    const mainBefore = await currentTip(s)

    const res = await postCommit(s, {
      changes: [{ path: 'wip.md', content: 'work in progress' }],
      new_branch: 'patch/web-edit',
      start_branch: 'main',
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as { branch: string; created_branch: boolean; merge_request: { created: boolean } }
    expect(body.branch).toBe('patch/web-edit')
    expect(body.created_branch).toBe(true)
    // Architectural hook for future PR/MR creation from this result:
    expect(body.merge_request.created).toBe(false)

    expect(mainBefore).toBe(await currentTip(s)) // source untouched
    expect(s.repos.resolveBranch(s.owner, s.projectId, 'patch/web-edit')).toBeTruthy()
  })
})

// -- optimistic concurrency -----------------------------------------------------------

describe('stale base commit detection (optimistic concurrency)', () => {
  it('REFUSES the commit when expected_base_tip no longer matches — never overwrites', async () => {
    const s = await setup()
    await postCommit(s, { changes: [{ path: 'c.txt', content: 'based on this' }], branch: 'main' })
    const baseTip = await currentTip(s)

    // The branch advances while the user is "editing"…
    await postCommit(s, { changes: [{ path: 'other.txt', content: 'someone else' }], branch: 'main' })
    const afterMove = await currentTip(s)
    expect(afterMove).not.toBe(baseTip)

    // …the stale editor commit must fail with conflict details.
    const stale = await postCommit(s, {
      changes: [{ path: 'c.txt', content: 'my stale edit' }],
      branch: 'main',
      expected_base_tip: baseTip,
    })
    expect(stale.statusCode).toBe(409)
    const errBody = stale.json() as { code?: string; current?: string }
    expect(errBody.code).toBe('ref_update_conflict')
    expect(errBody.current).toBe(afterMove)

    // The newer change survived untouched.
    expect(s.repos.readFileAt(s.owner, s.projectId, 'main', 'other.txt').toString()).toBe('someone else')
    expect(s.repos.readFileAt(s.owner, s.projectId, 'main', 'c.txt').toString()).toBe('based on this')
  })

  it('ACCEPTS the commit when the base tip still matches', async () => {
    const s = await setup()
    const tip = await currentTip(s)
    const res = await postCommit(s, {
      changes: [{ path: 'README.md', content: '# fresh edit' }],
      branch: 'main',
      expected_base_tip: tip,
    })
    expect(res.statusCode).toBe(201)
  })

  it('engine CAS backstop: racing writers cannot lose updates even without client hints', async () => {
    const s = await setup()
    const repo = s.repos.open(s.owner, s.projectId).repo
    const tip = repo.resolveBranch('main')!
    const tree = repo.readCommit(tip).tree
    const cA = repo.writeCommit({ tree, parents: [tip], message: 'A', author: { name: 'A', email: 'a@x' } })
    const cB = repo.writeCommit({ tree, parents: [tip], message: 'B', author: { name: 'B', email: 'b@x' } })
    repo.updateRef('refs/heads/main', cA, tip)
    let conflicted = false
    try {
      repo.updateRef('refs/heads/main', cB, tip)
    } catch (err) {
      conflicted = true
      expect((err as { code?: string }).code).toBe('ref_conflict')
    }
    expect(conflicted).toBe(true)
    expect(repo.resolveBranch('main')).toBe(cA)
  })
})

// -- security ------------------------------------------------------------------------------

describe('permission denial and protected branches', () => {
  it('denies PERMISSION-less writers: anonymous and non-owner users', async () => {
    const s = await setup()

    const anon = await s.app.inject({
      method: 'POST', url: commitUrl(s),
      payload: { changes: [{ path: 'x', content: 'y' }], commit_message: 'anon', branch: 'main' },
    })
    expect(anon.statusCode).toBe(401)

    const stranger = await postCommit(
      s,
      { changes: [{ path: 'evil.md', content: 'pwn' }], branch: 'main' },
      s.strangerSession!,
    )
    expect(stranger.statusCode).toBe(403)

    // Nothing landed.
    try {
      s.repos.blob(s.owner, s.projectId, 'main', 'evil.md')
      expect.unreachable()
    } catch (err) {
      expect((err as { status?: number }).status).toBe(404)
    }
  })

  it('enforces PROTECTED BRANCH rules on web edits while side branches stay open', async () => {
    const s = await setup()
    // Demote alice to a plain owner (no instance-admin bypass) so the
    // no_one rule applies to her too.
    s.app.store.db.run('UPDATE users SET admin = 0 WHERE id = ?', s.owner.userId)
    s.app.store.protectedBranches.set(s.projectId, 'main', 'no_one')

    const blocked = await postCommit(s, { changes: [{ path: 'blocked.md', content: 'x' }], branch: 'main' })
    expect(blocked.statusCode).toBe(403)
    expect((blocked.json() as { code?: string }).code).toBe('protected_branch')

    // The same edit succeeds on an unprotected new branch.
    const ok = await postCommit(s, {
      changes: [{ path: 'blocked.md', content: 'x' }],
      new_branch: 'safe-side',
      start_branch: 'main',
    })
    expect(ok.statusCode).toBe(201)
    expect((ok.json() as { branch: string }).branch).toBe('safe-side')
  })
})

// -- limits -----------------------------------------------------------------------------------

describe('large file guard', () => {
  // The HTTP body limit (1.5 MB) is a separate transport guard; these exercise
  // the SERVICE-level cap (cfg.maxUploadBytes) that protects git storage.
  it('rejects oversized content with 413 BEFORE any git mutation', async () => {
    const s = await setup()
    const bigText = 'x'.repeat(s.app.cfg.maxUploadBytes + 1)

    const before = await currentTip(s)
    try {
      s.repos.commitChanges(s.owner, s.projectId, {
        message: 'big', branch: 'main', changes: [{ path: 'big.bin', content: bigText }],
      })
      expect.unreachable('expected 413')
    } catch (err) {
      expect((err as { status?: number }).status).toBe(413)
      expect((err as { code?: string }).code).toBe('too_large')
    }
    expect(await currentTip(s)).toBe(before) // nothing committed
  })

  it('accepts content just under the limit', async () => {
    const s = await setup()
    const okSize = 'x'.repeat(Math.min(1024 * 1024, s.app.cfg.maxUploadBytes - 10))
    const res = await postCommit(s, { changes: [{ path: 'big-ok.txt', content: okSize }], branch: 'main' })
    expect(res.statusCode).toBe(201)
  })

  it('rejects base64 payloads that decode past the limit at the service layer', async () => {
    const s = await setup()
    const bytes = Buffer.alloc(s.app.cfg.maxUploadBytes + 16, 7)
    try {
      s.repos.commitChanges(s.owner, s.projectId, {
        message: 'binary big', branch: 'main',
        changes: [{ path: 'blob.bin', content: bytes }],
      })
      expect.unreachable('expected 413')
    } catch (err) {
      expect((err as { status?: number }).status).toBe(413)
    }
  })
})

// -- validation ----------------------------------------------------------------------------------

describe('payload validation', () => {
  it('requires a commit message and rejects empty change sets', async () => {
    const s = await setup()
    const noMessage = await authed(s.app, 'POST', commitUrl(s), {
      session: s.session,
      payload: { changes: [{ path: 'a', content: 'b' }] },
    })
    expect(noMessage.statusCode).toBe(400)

    const noChanges = await postCommit(s, { changes: [], branch: 'main' })
    expect(noChanges.statusCode).toBe(400)

    const badPath = await postCommit(s, { changes: [{ path: '../escape', content: 'x' }], branch: 'main' })
    expect(badPath.statusCode).toBe(400)
    expect((badPath.json() as { code?: string }).code).toBe('invalid_path')
  })
})
