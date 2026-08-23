import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeApp, registerUser, authed, extractSession, loginRaw, type Session } from './helpers.js'
import { LocalHashedStorage } from '../src/storage/local.js'
import { verifyLooseObject, readObject } from '../src/storage/gitobjects.js'

interface Setup {
  app: ReturnType<typeof makeApp>
  aliceSession: Session
  aliceToken?: never
  bobSession: Session
}

async function setup(): Promise<Setup> {
  const app = makeApp()
  await registerUser(app) // alice (first user → admin)
  const aliceSession = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'bob', email: 'bob@example.com' })
  const bobSession = extractSession((await loginRaw(app, 'bob')).cookies)
  return { app, aliceSession, bobSession }
}

function createPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'My Project',
    path: 'my-project',
    visibility: 'private',
    description: 'A test project',
    website_url: '',
    default_branch: 'main',
    topics: [],
    ...over,
  }
}

async function createProject(
  app: ReturnType<typeof makeApp>,
  session: Session,
  over: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await authed(app, 'POST', '/api/v1/projects', { session, payload: createPayload(over) })
  return { status: res.statusCode, body: res.json() }
}

// ---------------------------------------------------------------------------

describe('repository creation', () => {
  it('creates metadata + a physical hashed bare repo with an initial commit', async () => {
    const { app, bobSession } = await setup()
    const { status, body } = await createProject(app, bobSession, {
      initialize_with_readme: true,
      gitignore_template: 'Node',
      license_template: 'mit',
      topics: ['Web', 'web', 'FrontEnd'],
    })
    expect(status).toBe(201)

    const project = app.store.projects.byOwnerPath('bob', 'my-project')!
    expect(project).toBeTruthy()
    expect(body).toMatchObject({
      full_path: 'bob/my-project',
      visibility: 'private',
      default_branch: 'main',
      repository_empty: false,
    })

    // Hashed storage layout per STORAGE.md.
    expect(project.disk_path).toMatch(/^@hashed\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.git$/)
    const abs = join((app.cfg.repositoriesRoot), project.disk_path)
    expect(existsSync(abs)).toBe(true)

    // HEAD points at the requested default branch; branch ref exists.
    expect(readFileSync(join(abs, 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')
    const refSha = readFileSync(join(abs, 'refs', 'heads', 'main'), 'utf8').trim()

    // Loose objects are well-formed: recompute their SHA-1s.
    const objectsDir = join(abs, 'objects')
    expect(verifyLooseObject(objectsDir, refSha)).toBe(true)
    const commit = readObject(objectsDir, refSha)
    expect(commit.body.toString('utf8')).toContain('Initial commit')
    const treeLine = /^tree ([0-9a-f]{40})/m.exec(commit.body.toString('utf8'))![1]!
    expect(verifyLooseObject(objectsDir, treeLine)).toBe(true)

    // Ownership recorded correctly.
    expect(project.owner_id).toBe(app.store.users.byUsername('bob')!.id)
  })

  it('supports a custom default branch and empty (uninitialized) repositories', async () => {
    const { app, bobSession } = await setup()
    const { status } = await createProject(app, bobSession, {
      path: 'custom-branch-repo',
      default_branch: 'trunk',
      initialize_with_readme: false,
    })
    expect(status).toBe(201)
    const project = app.store.projects.byOwnerPath('bob', 'custom-branch-repo')!
    const abs = join(app.cfg.repositoriesRoot, project.disk_path)
    expect(readFileSync(join(abs, 'HEAD'), 'utf8')).toBe('ref: refs/heads/trunk\n')
    expect(existsSync(join(abs, 'refs', 'heads', 'trunk'))).toBe(false) // empty repo: no commits yet
    expect(project.initialized).toBe(0)
  })

  it('rejects duplicate paths per owner but allows them across owners', async () => {
    const { app, aliceSession, bobSession } = await setup()
    const first = await createProject(app, aliceSession, { path: 'shared-name' })
    expect(first.status).toBe(201)

    const dup = await createProject(app, aliceSession, { path: 'SHARED-NAME' }) // case-insensitive
    expect(dup.status).toBe(409)
    expect(dup.body.message).toBe('Path has already been taken')

    // Different owner may use the same path.
    const otherOwner = await createProject(app, bobSession, { path: 'shared-name' })
    expect(otherOwner.status).toBe(201)
  })

  it('validates names, paths, branches, topics and templates', async () => {
    const { app, bobSession } = await setup()
    for (const payload of [
      createPayload({ name: '' }),
      createPayload({ path: '-bad' }),
      createPayload({ path: 'has space' }),
      createPayload({ path: 'repo.git' }),
      createPayload({ path: 'new' }),
      createPayload({ default_branch: '..evil' }),
      createPayload({ default_branch: 'main.lock' }),
      createPayload({ website_url: 'notaurl' }),
      createPayload({ topics: ['ok-topic', 'BAD TOPIC!'] }),
      createPayload({ gitignore_template: 'Nope' }),
      createPayload({ license_template: 'wtfpl' }),
    ]) {
      const res = await authed(app, 'POST', '/api/v1/projects', { session: bobSession, payload })
      expect([400].includes(res.statusCode), `expected 400 for ${JSON.stringify(payload)}`).toBe(true)
    }
  })
})

describe('visibility', () => {
  it('keeps private projects hidden from anonymous users and the public explorer', async () => {
    const { app, aliceSession, bobSession } = await setup()
    const created = await createProject(app, aliceSession, { visibility: 'private' })
    void created
    const id = app.store.projects.byOwnerPath('alice', 'my-project')!.id

    // Anonymous: existence is not leaked.
    const anon = await app.inject({ method: 'GET', url: `/api/v1/projects/${id}` })
    expect(anon.statusCode).toBe(401)
    const byPath = await app.inject({ method: 'GET', url: '/api/v1/alice/my-project' })
    expect(byPath.statusCode).toBe(401)

    // Another authenticated non-owner cannot see it either.
    const asBob = await authed(app, 'GET', '/api/v1/projects/' + id, { session: bobSession })
    expect(asBob.statusCode).toBe(403)

    // Not in the public explorer.
    const explore = (await app.inject({ method: 'GET', url: '/api/v1/projects/explore' })).json() as unknown[]
    expect(explore).toHaveLength(0)
  })

  it('exposes public projects to everyone and lists them in explore', async () => {
    const { app, aliceSession } = await setup()
    const created = await createProject(app, aliceSession, {
      visibility: 'public',
      description: 'findable',
      topics: ['rust'],
    })
    expect(created.statusCode).toBe(201)

    expect((await app.inject({ method: 'GET', url: '/api/v1/alice/my-project' })).statusCode).toBe(200)
    const explore = (await app.inject({ method: 'GET', url: '/api/v1/projects/explore' })).json() as Array<Record<string, unknown>>
    expect(explore).toHaveLength(1)
    expect(explore[0]!.topics).toEqual(['rust'])

    const byTopic = (await app.inject({ method: 'GET', url: '/api/v1/projects/explore?topic=RUST' })).json() as unknown[]
    expect(byTopic).toHaveLength(1)
    const bySearch = (await app.inject({ method: 'GET', url: '/api/v1/projects/explore?search=findable' })).json() as unknown[]
    expect(bySearch).toHaveLength(1)
  })
})

describe('rename', () => {
  it('renames metadata only; old URLs redirect via headers; disk untouched', async () => {
    const { app, bobSession } = await setup()
    await createProject(app, bobSession, {})
    const before = app.store.projects.byOwnerPath('bob', 'my-project')!

    const res = await authed(app, 'POST', `/api/v1/projects/${before.id}/rename`, {
      session: bobSession,
      payload: { path: 'renamed-project' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ path: 'renamed-project', redirect_created: true })

    // Disk location unchanged (hashed storage).
    const after = app.store.projects.byId(before.id)!
    expect(after.disk_path).toBe(before.disk_path)
    expect(app.projects.storage.exists(after.disk_path)).toBe(true)

    // Old path redirects; new path resolves directly.
    const oldUrl = await app.inject({ method: 'GET', url: '/api/v1/bob/my-project' })
    expect(oldUrl.statusCode).toBe(200)
    expect(oldUrl.headers['x-lsgit-redirected-from']).toBe('bob/my-project')
    expect((await app.inject({ method: 'GET', url: '/api/v1/bob/renamed-project' })).statusCode).toBe(200)

    // Conflicts with existing projects are refused.
    await createProject(app, bobSession, { path: 'second' })
    const conflict = await authed(app, 'POST', `/api/v1/projects/${before.id}/rename`, {
      session: bobSession,
      payload: { path: 'second' },
    })
    expect(conflict.statusCode).toBe(409)
  })
})

describe('deletion', () => {
  it('requires typed confirmation and owner/admin rights', async () => {
    const { app, aliceSession, bobSession } = await setup()
    await createProject(app, bobSession, {})
    const project = app.store.projects.byOwnerPath('bob', 'my-project')!

    // Wrong confirmation text → rejected.
    const wrong = await authed(app, 'DELETE', `/api/v1/projects/${project.id}?confirm_path=bob/wrong`, { session: bobSession })
    expect(wrong.statusCode).toBe(400)

    // Non-owner cannot delete even with correct confirmation (charlie is not admin).
    await registerUser(app, { username: 'charlie', email: 'charlie@example.com' })
    const charlie = extractSession((await loginRaw(app, 'charlie')).cookies)
    const forbidden = await authed(
      app, 'DELETE',
      `/api/v1/projects/${project.id}?confirm_path=${encodeURIComponent('bob/my-project')}`,
      { session: charlie! },
    )
    expect(forbidden.statusCode).toBe(403)

    // Owner with exact confirmation succeeds.
    const ok = await authed(
      app, 'DELETE',
      `/api/v1/projects/${project.id}?confirm_path=${encodeURIComponent('bob/my-project')}`,
      { session: bobSession },
    )
    expect(ok.statusCode).toBe(200)

    expect(app.store.projects.byId(project.id)).toBeUndefined()
    expect(app.projects.storage.exists(project.disk_path)).toBe(false)
  })
})

describe('transfer', () => {
  it('moves ownership, keeps history on disk, and leaves a working redirect', async () => {
    const { app, aliceSession, bobSession } = await setup()
    await createProject(app, bobSession, { initialize_with_readme: true })
    const before = app.store.projects.byOwnerPath('bob', 'my-project')!
    const diskBefore = before.disk_path

    const res = await authed(app, 'POST', `/api/v1/projects/${before.id}/transfer`, {
      session: bobSession,
      payload: { new_owner: 'alice' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ full_path: 'alice/my-project' })

    // History intact: same physical repository.
    const after = app.store.projects.byId(before.id)!
    expect(after.owner_id).toBe(app.store.users.byUsername('alice')!.id)
    expect(after.disk_path).toBe(diskBefore)
    expect(app.projects.storage.exists(diskBefore)).toBe(true)

    // Old URL still resolves via redirect.
    const redirected = await app.inject({ method: 'GET', url: '/api/v1/bob/my-project' })
    expect(redirected.statusCode).toBe(200)
    expect(redirected.headers['x-lsgit-redirected-from']).toBe('bob/my-project')

    // Former owner no longer manages it; new owner does.
    const exOwnerTry = await authed(app, 'PATCH', `/api/v1/projects/${after.id}`, {
      session: bobSession,
      payload: { description: 'sneaky' },
    })
    expect(exOwnerTry.statusCode).toBe(403)
    const newOwnerOk = await authed(app, 'PATCH', `/api/v1/projects/${after.id}`, {
      session: aliceSession,
      payload: { description: 'now mine' },
    })
    expect(newOwnerOk.statusCode).toBe(200)

    // Guard rails: missing target, self-transfer, occupied path at target.
    expect(
      (await authed(app, 'POST', `/api/v1/projects/${after.id}/transfer`, { session: aliceSession, payload: { new_owner: 'ghost' } })).statusCode,
    ).toBe(404)
    expect(
      (await authed(app, 'POST', `/api/v1/projects/${after.id}/transfer`, { session: aliceSession, payload: { new_owner: 'alice' } })).statusCode,
    ).toBe(409)
    await createProject(app, bobSession, { path: 'collision' })
    expect(
      (await authed(app, 'POST', `/api/v1/projects/${after.id}/transfer`, { session: aliceSession, payload: { new_owner: 'bob' } })).statusCode,
    ).toBe(409)

    void aliceSession
  })
})

describe('templates', () => {
  it('marks a project as template and seeds new projects from its files', async () => {
    const { app, aliceSession, bobSession } = await setup()
    await createProject(app, aliceSession, {
      visibility: 'public',
      initialize_with_readme: true,
      description: 'Template base',
      topics: ['starter'],
    })
    const template = app.store.projects.byOwnerPath('alice', 'my-project')!

    // Only the owner can flag it as a template.
    const notAllowed = await authed(app, 'PUT', `/api/v1/projects/${template.id}/template`, {
      session: bobSession,
      payload: { enabled: true },
    })
    expect(notAllowed.statusCode).toBe(403)

    const flagged = await authed(app, 'PUT', `/api/v1/projects/${template.id}/template`, {
      session: aliceSession,
      payload: { enabled: true },
    })
    expect(flagged.json().is_template).toBe(true)

    const templates = (await app.inject({ method: 'GET', url: '/api/v1/projects/templates' })).json() as unknown[]
    expect(templates).toHaveLength(1)

    // Create from template as bob: files copied from template tip.
    const created = await createProject(app, bobSession, {
      name: 'From Template',
      path: 'from-template',
      template_project_id: template.id,
    })
    expect(created.statusCode).toBe(201)

    const copy = app.store.projects.byOwnerPath('bob', 'from-template')!
    expect(copy.initialized).toBe(1)
    const files = app.projects.storage.readBranchFiles(copy.disk_path, copy.default_branch)
    expect([...files.keys()]).toContain('README.md')
    expect(files.get('README.md')!.toString('utf8')).toContain('# My Project')

    // Creating "from" a non-template fails cleanly.
    await createProject(app, bobSession, { path: 'plain', initialize_with_readme: true })
    const plain = app.store.projects.byOwnerPath('bob', 'plain')!
    const bad = await authed(app, 'POST', '/api/v1/projects', {
      session: bobSession,
      payload: createPayload({ path: 'nope', template_project_id: plain.id }),
    })
    expect(bad.statusCode).toBe(400)
  })
})

describe('topics & metadata editing', () => {
  it('normalizes, dedupes case-insensitively, replaces sets, prunes orphans, stays searchable', async () => {
    const { app, bobSession } = await setup()
    await createProject(app, bobSession, { topics: ['WebDev', 'webdev ', 'Rust'] })
    const project = app.store.projects.byOwnerPath('bob', 'my-project')!

    // Deduplicated + normalized (case-insensitive uniqueness, canonical lowercase).
    expect(app.store.topics.listForProject(project.id).sort()).toEqual(['rust', 'webdev'])
    // Canonical casing stored once:
    expect(app.store.topics.search('WEB')).toEqual([{ id: expect.any(Number), title: 'webdev' }])

    // Replace-set edit: swap topics entirely.
    const patched = await authed(app, 'PATCH', `/api/v1/projects/${project.id}`, {
      session: bobSession,
      payload: { topics: ['cli'], description: 'updated' },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().topics).toEqual(['cli'])
    expect(patched.json().description).toBe('updated')
    // Orphans from the replaced set are gone.
    expect(app.store.topics.search('rust')).toHaveLength(0)

    // Cap enforcement (>30 distinct topics).
    const tooMany = Array.from({ length: 31 }, (_, i) => `topic-${i}`)
    const capped = await authed(app, 'PATCH', `/api/v1/projects/${project.id}`, {
      session: bobSession,
      payload: { topics: tooMany },
    })
    expect(capped.statusCode).toBe(400)
  })

  it('archives and restores projects; archived ones leave the public explorer', async () => {
    const { app, bobSession } = await setup()
    await createProject(app, bobSession, { visibility: 'public' })
    const project = app.store.projects.byOwnerPath('bob', 'my-project')!

    const archived = await authed(app, 'POST', `/api/v1/projects/${project.id}/archive`, { session: bobSession })
    expect(archived.json().archived).toBe(true)
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/explore' })).json() as unknown[]).toHaveLength(0)
    // Direct read still works while archived.
    expect((await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}` })).statusCode).toBe(200)

    const restored = await authed(app, 'POST', `/api/v1/projects/${project.id}/unarchive`, { session: bobSession })
    expect(restored.json().archived).toBe(false)
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects/explore' })).json() as unknown[]).toHaveLength(1)
  })
})

describe('default branch + storage abstraction unit checks', () => {
  it('diskPathFor follows the hashed layout contract', () => {
    const storage = new LocalHashedStorage('irrelevant')
    const p = storage.diskPathFor(1)
    expect(p).toMatch(/^@hashed\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.git$/)
    expect(storage.diskPathFor(2)).not.toBe(p)
  })

  it('(optional) produced repos pass real `git fsck` when git is installed', async () => {
    const { app, bobSession } = await setup()
    await createProject(app, bobSession, { initialize_with_readme: true })
    const project = app.store.projects.byOwnerPath('bob', 'my-project')!
    const abs = join(app.cfg.repositoriesRoot, project.disk_path)

    const probe = spawnSync('git', ['--version'])
    if (probe.error || probe.status !== 0) {
      rmSync(abs, { recursive: true, force: true })
      return // git unavailable — structural assertions above already ran
    }
    const fsck = spawnSync('git', ['-C', abs, 'fsck', '--strict'], { encoding: 'utf8' })
    expect(fsck.stderr).toBe('')
    expect(fsck.status).toBe(0)
    const log = spawnSync('git', ['-C', abs, 'log', '--oneline', '-1'], { encoding: 'utf8' })
    expect(log.stdout).toMatch(/Initial commit/)
    rmSync(abs, { recursive: true, force: true })
  })
})
