import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeApp, registerUser, authed, extractSession, loginRaw, type Session } from './helpers.js'
import type { FastifyInstance } from 'fastify'

/**
 * Releases (GitLab release/tag behavior on LSGit naming).
 *
 * Coverage map (per requirement):
 *   - tag release .............. existing tag + new tag at ref + conflicts
 *   - asset upload ............. validation, checksums, content types
 *   - asset replacement policy . same-filename re-upload replaces object+metadata
 *   - draft -> published ....... lifecycle, visibility gating, immutability
 *   - pre-release .............. flag persistence + latest-release interaction
 *   - permissions .............. maintainer-only writes; visibility-gated reads
 *   - release deletion ......... metadata cascade + stored-object cleanup; git
 *                                tags are NEVER deleted by releasing
 *   - latest-release determination .. stable-over-prerelease, newest released_at,
 *                                prerelease-only fallback flag
 *   - notes generation ......... explicit-only endpoint; never auto-saved
 */

interface Setup {
  app: FastifyInstance
  ownerSession: Session
  strangerSession: Session
  projectId: number
  reposRoot: string
}

async function setup(): Promise<Setup> {
  const app = makeApp()
  await registerUser(app) // alice → project owner
  const ownerSession = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'mallory', email: 'mallory@example.com' })
  const strangerSession = extractSession((await loginRaw(app, 'mallory')).cookies)

  const res = await authed(app, 'POST', '/api/v1/projects', {
    session: ownerSession,
    payload: {
      name: 'Rel Engine', path: 'rel-engine', visibility: 'private',
      initialize_with_readme: true,
    },
  })
  expect(res.statusCode).toBe(201)
  const project = app.store.projects.byOwnerPath('alice', 'rel-engine')!
  return { app, ownerSession, strangerSession, projectId: project.id, reposRoot: app.cfg.repositoriesRoot }
}

const releasesBase = (projectId: number) => `/api/v1/projects/${projectId}/releases`

function commit(setup: Setup, message: string, path: string, content: string): void {
  const alice = setup.app.store.users.byUsername('alice')!
  const res = setup.app.repositories.commitChanges(
    { userId: alice.id, username: 'alice', admin: true, state: 'active', via: { kind: 'session' } },
    setup.projectId,
    { message, changes: [{ path, content }] },
  )
  expect(res).toBeTruthy()
}

/** PUT a binary asset body (octet-stream) and return status + json. */
async function putAsset(
  s: Setup,
  session: Session,
  tag: string,
  filename: string,
  content: Buffer | string,
  contentType = 'application/octet-stream',
): Promise<{ statusCode: number; json(): Record<string, unknown> }> {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  const res = await s.app.inject({
    method: 'PUT',
    url: `${releasesBase(s.projectId)}/${encodeURIComponent(tag)}/assets?filename=${encodeURIComponent(filename)}`,
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      'content-type': contentType,
    },
    payload: buf,
  })
  return { statusCode: res.statusCode, json: () => res.json() as Record<string, unknown> }
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(Buffer.isBuffer(b) ? b : Buffer.from(b)).digest('hex')

// ---------------------------------------------------------------------------
// Tag release
// ---------------------------------------------------------------------------

describe('tag release', () => {
  it('binds to an EXISTING git tag without creating a new one', async () => {
    const s = await setup()
    commit(s, 'work', 'f.txt', '1')
    // Pre-existing tag created through the repository surface.
    const engine = s.app.releases['engineFor'](s.app.store.projects.byId(s.projectId)!)
    engine.createTag({ name: 'v0.9.0', target: engine.resolveBranch('main')!, message: 'existing' })

    const res = await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession,
      payload: { tag_name: 'v0.9.0', name: 'v0.9.0 "Aurora"', description: 'First cut' },
    })
    expect(res.statusCode).toBe(201)
    const release = res.json().release as Record<string, unknown>
    expect(release.tag_name).toBe('v0.9.0')
    expect(release.name).toBe('v0.9.0 "Aurora"')
    // Published immediately when not requested as draft (GitLab parity).
    expect(release.state).toBe('published')
    expect(release.is_prerelease).toBe(false)
  })

  it('creates a NEW annotated tag at `ref` when the tag does not exist yet', async () => {
    const s = await setup()
    commit(s, 'base', 'a.txt', 'a')
    const res = await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession,
      payload: { tag_name: 'v1.0.0', ref: 'main', tag_message: 'release point', draft: false },
    })
    expect(res.statusCode).toBe(201)

    // The tag now resolves in the repository itself.
    const project = s.app.store.projects.byId(s.projectId)!
    const engine = s.app.releases['engineFor'](project)
    const sha = engine.resolveTag('v1.0.0')
    expect(sha).toBeTruthy()
    expect(engine.listTags().some((t) => t.name === 'v1.0.0')).toBe(true)
  })

  it('rejects duplicate releases for the same tag with 409', async () => {
    const s = await setup()
    const first = await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.0.0', draft: true },
    })
    expect(first.statusCode).toBe(201)
    const again = await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.0.0', draft: true },
    })
    expect(again.statusCode).toBe(409)
    expect((again.json() as { code?: string }).code).toBe('taken')
  })

  it('refuses to create a new tag from an unknown ref with 422', async () => {
    const s = await setup()
    const res = await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'vX', ref: 'no/such/branch', draft: true },
    })
    expect(res.statusCode).toBe(422)
    expect((res.json() as { code?: string }).code).toBe('ref_not_found')
  })

  it('requires tag_name', async () => {
    const s = await setup()
    const res = await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { name: 'no tag' },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Asset upload
// ---------------------------------------------------------------------------

describe('asset upload', () => {
  it('uploads a binary asset and persists server-computed metadata incl. sha256', async () => {
    const s = await setup()
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.0.0', draft: true },
    })
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    const up = await putAsset(s, s.ownerSession, 'v1.0.0', 'app-1.0.tar.gz', bytes)
    expect(up.statusCode).toBe(201)
    const asset = up.json().asset as Record<string, unknown>
    expect(asset.filename).toBe('app-1.0.tar.gz')
    expect(asset.size).toBe(bytes.length)
    expect(asset.sha256).toBe(sha256(bytes))
    expect(asset.content_type).toBe('application/octet-stream')

    // Object is really on disk under the release-assets area.
    const dir = join(s.reposRoot, '@release-assets', String(s.projectId))
    expect(existsSync(dir)).toBe(true)
    expect(readdirSync(dir).length).toBe(1)
  })

  it('validates filename (path traversal, dotfiles, length)', async () => {
    const s = await setup()
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.0.0', draft: true },
    })
    expect((await putAsset(s, s.ownerSession, 'v1.0.0', '../escape.bin', Buffer.from('x'))).statusCode).toBe(400)
    expect((await putAsset(s, s.ownerSession, 'v1.0.0', '.hidden', Buffer.from('x'))).statusCode).toBe(400)
    expect((await putAsset(s, s.ownerSession, 'v1.0.0', '', Buffer.from('x'))).statusCode).toBe(400)
    expect((await putAsset(s, s.ownerSession, 'v1.0.0', 'd'.repeat(121), Buffer.from('x'))).statusCode).toBe(400)
  })

  it('rejects empty bodies and non-octet-stream uploads', async () => {
    const s = await setup()
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.0.0', draft: true },
    })
    expect((await putAsset(s, s.ownerSession, 'v1.0.0', 'empty.bin', '')).statusCode).toBe(400)
    const wrongType = await s.app.inject({
      method: 'PUT',
      url: `${releasesBase(s.projectId)}/v1.0.0/assets?filename=x.bin`,
      headers: { cookie: s.ownerSession.cookie, 'x-csrf-token': s.ownerSession.csrf, 'content-type': 'application/json' },
      payload: {},
    })
    expect(wrongType.statusCode).toBe(415)
  })

  it('enforces the configured upload size limit with 413', async () => {
    const smallApp = makeApp({ maxUploadBytes: 64 })
    await registerUser(smallApp)
    const sess = extractSession((await loginRaw(smallApp, 'alice')).cookies)
    const created = await authed(smallApp, 'POST', '/api/v1/projects', {
      session: sess, payload: { name: 'Tiny', path: 'tiny', initialize_with_readme: true },
    })
    expect(created.statusCode).toBe(201)
    const pid = smallApp.store.projects.byOwnerPath('alice', 'tiny')!.id
    await authed(smallApp, 'POST', releasesBase(pid), {
      session: sess, payload: { tag_name: 'v1.0.0', draft: true },
    })
    const big = Buffer.alloc(65, 7)
    const res = await smallApp.inject({
      method: 'PUT',
      url: `${releasesBase(pid)}/v1.0.0/assets?filename=big.bin`,
      headers: { cookie: sess.cookie, 'x-csrf-token': sess.csrf, 'content-type': 'application/octet-stream' },
      payload: big,
    })
    expect(res.statusCode).toBe(413)
  })

  it('downloads the exact uploaded bytes with checksum headers via the gated URL', async () => {
    const s = await setup()
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.0.0', draft: false },
    })
    const bytes = Buffer.from('downloadable-payload-1234567890')
    await putAsset(s, s.ownerSession, 'v1.0.0', 'payload.zip', bytes, 'application/zip')

    const dl = await s.app.inject({
      method: 'GET',
      url: `${releasesBase(s.projectId)}/v1.0.0/assets/payload.zip/download`,
    })
    expect(dl.statusCode).toBe(200)
    expect(Buffer.compare(dl.rawPayload, bytes)).toBe(0)
    expect(dl.headers['x-checksum-sha256']).toBe(sha256(bytes))
    expect(dl.headers['content-disposition']).toContain('payload.zip')
    expect(dl.headers['x-content-type-options']).toBe('nosniff')
  })

  it('404s downloads of unknown assets or missing files', async () => {
    const s = await setup()
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.0.0', draft: false },
    })
    const miss = await s.app.inject({
      method: 'GET',
      url: `${releasesBase(s.projectId)}/v1.0.0/assets/nope.bin/download`,
    })
    expect(miss.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Asset replacement policy
// ---------------------------------------------------------------------------

describe('asset replacement policy', () => {
  it('re-uploading the same filename REPLACES object and refreshes checksum/size', async () => {
    const s = await setup()
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v2.0.0', draft: true },
    })
    const v1 = Buffer.from('original build artifact')
    const v2 = Buffer.from('rebuilt artifact with fixes, longer than v1')

    const first = await putAsset(s, s.ownerSession, 'v2.0.0', 'build.zip', v1)
    expect(first.statusCode).toBe(201)
    expect((first.json() as Record<string, unknown>).replaced).toBe(false)

    const second = await putAsset(s, s.ownerSession, 'v2.0.0', 'build.zip', v2)
    expect(second.statusCode).toBe(200) // replacement, not creation
    expect((second.json() as Record<string, unknown>).replaced).toBe(true)
    const asset = second.json().asset as Record<string, unknown>
    expect(asset.size).toBe(v2.length)
    expect(asset.sha256).toBe(sha256(v2))

    // Exactly ONE metadata row and ONE stored object remain.
    const detail = await authed(s.app, 'GET', `${releasesBase(s.projectId)}/v2.0.0`, { session: s.ownerSession })
    const assets = ((detail.json().release as Record<string, unknown>).assets as Array<Record<string, unknown>>)
    expect(assets.length).toBe(1)
    expect(assets[0]!.size).toBe(v2.length)
    const dir = join(s.reposRoot, '@release-assets', String(s.projectId))
    expect(readdirSync(dir).length).toBe(1)
  })

  it('deleting an asset removes both metadata and the stored object', async () => {
    const s = await setup()
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v3.0.0', draft: false },
    })
    await putAsset(s, s.ownerSession, 'v3.0.0', 'gone.bin', Buffer.from('bye'))
    const del = await authed(s.app, 'DELETE', `${releasesBase(s.projectId)}/v3.0.0/assets/gone.bin`, { session: s.ownerSession })
    expect(del.statusCode).toBe(200)
    const dir = join(s.reposRoot, '@release-assets', String(s.projectId))
    expect(readdirSync(dir).length).toBe(0)
    const after = await s.app.inject({ method: 'GET', url: `${releasesBase(s.projectId)}/v3.0.0/assets/gone.bin/download` })
    expect(after.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Draft -> published
// ---------------------------------------------------------------------------

describe('draft to published lifecycle', () => {
  it('drafts are invisible to non-maintainers until published', async () => {
    const s = await setup()
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.0.0-rc1', prerelease: true, draft: true },
    })

    // Owner sees the draft marker.
    const ownerList = await authed(s.app, 'GET', releasesBase(s.projectId), { session: s.ownerSession })
    const ownerRows = ownerList.json().releases as Array<Record<string, unknown>>
    expect(ownerRows.length).toBe(1)
    expect(ownerRows[0]!.draft).toBe(true)
    expect(ownerRows[0]!.state).toBe('draft')

    // Strangers see nothing (existence not leaked).
    const strangerList = await authed(s.app, 'GET', releasesBase(s.projectId), { session: s.strangerSession })
    expect(strangerList.statusCode).toBe(200)
    expect(((strangerList.json().releases ?? []) as unknown[]).length).toBe(0)
    const strangerGet = await authed(s.app, 'GET', `${releasesBase(s.projectId)}/v1.0.0-rc1`, { session: s.strangerSession })
    expect(strangerGet.statusCode).toBe(404)
  })

  it('publishing stamps released_at exactly once and makes it publicly visible', async () => {
    const s = await setup()
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.0.0', draft: true },
    })
    const before = await authed(s.app, 'GET', `${releasesBase(s.projectId)}/v1.0.0`, { session: s.ownerSession })
    expect(((before.json().release as Record<string, unknown>).released_at) === null).toBe(true)

    const pub = await authed(s.app, 'PATCH', `${releasesBase(s.projectId)}/v1.0.0`, {
      session: s.ownerSession, payload: { state_event: 'publish' },
    })
    expect(pub.statusCode).toBe(200)
    const releasedAt = (pub.json().release as Record<string, unknown>).released_at
    expect(typeof releasedAt).toBe('string')

    const again = await authed(s.app, 'PATCH', `${releasesBase(s.projectId)}/v1.0.0`, {
      session: s.ownerSession, payload: { state_event: 'publish' },
    })
    expect(again.statusCode).toBe(422) // already immutable

    // Visible to strangers now.
    const list = await authed(s.app, 'GET', releasesBase(s.projectId), { session: s.strangerSession })
    const rows = list.json().releases as Array<Record<string, unknown>>
    expect(rows.length).toBe(1)
    expect(rows[0]!.released_at).toBe(releasedAt)
  })

  it('published releases are immutable — edits require delete-and-recreate', async () => {
    const s = await setup()
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.1.0', description: 'final', draft: false },
    })
    const edit = await authed(s.app, 'PATCH', `${releasesBase(s.projectId)}/v1.1.0`, {
      session: s.ownerSession, payload: { description: 'tampered' },
    })
    expect(edit.statusCode).toBe(422)
    expect((edit.json() as { code?: string }).code).toBe('published_immutable')

    // Drafts remain editable.
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.2.0-draft', draft: true },
    })
    const okEdit = await authed(s.app, 'PATCH', `${releasesBase(s.projectId)}/v1.2.0-draft`, {
      session: s.ownerSession, payload: { description: 'wip notes', name: 'v1.2.0 preview' },
    })
    expect(okEdit.statusCode).toBe(200)
    expect(((okEdit.json().release as Record<string, unknown>).description) === 'wip notes').toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Pre-releases
// ---------------------------------------------------------------------------

describe('pre-releases', () => {
  it('persists the pre-release flag through create and update', async () => {
    const s = await setup()
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v2.0.0-beta1', prerelease: true, draft: true },
    })
    let row = ((await authed(s.app, 'GET', releasesBase(s.projectId), { session: s.ownerSession })).json().releases as Array<Record<string, unknown>>)[0]!
    expect(row.is_prerelease).toBe(true)

    // Flip back off while still a draft.
    await authed(s.app, 'PATCH', `${releasesBase(s.projectId)}/v2.0.0-beta1`, {
      session: s.ownerSession, payload: { prerelease: false },
    })
    row = ((await authed(s.app, 'GET', releasesBase(s.projectId), { session: s.ownerSession })).json().releases as Array<Record<string, unknown>>)[0]!
    expect(row.is_prerelease).toBe(false)
  })

  it('pre-releases never displace a newer stable as latest', async () => {
    const s = await setup()
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.0.0', draft: false },
    })
    // A LATER-in-time beta must NOT become latest over the older stable.
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v2.0.0-rc1', prerelease: true, draft: false },
    })

    const latest = await authed(s.app, 'GET', `${releasesBase(s.projectId)}/latest`)
    expect(latest.statusCode).toBe(200)
    const rel = latest.json().release as Record<string, unknown>
    expect(rel.tag_name).toBe('v1.0.0')
    expect(latest.json().is_prerelease_fallback).toBe(false)
  })

  it('falls back to the newest pre-release when only pre-releases exist, flagged', async () => {
    const s = await setup()
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v0.1.0-alpha', prerelease: true, draft: false },
    })
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v0.2.0-beta', prerelease: true, draft: false },
    })
    const latest = await authed(s.app, 'GET', `${releasesBase(s.projectId)}/latest`)
    const rel = latest.json().release as Record<string, unknown>
    expect(rel.tag_name).toBe('v0.2.0-beta')
    expect(latest.json().is_prerelease_fallback).toBe(true)
  })

  it('404s latest when no published releases exist (drafts do not count)', async () => {
    const s = await setup()
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v0.0.1', draft: true },
    })
    const latest = await authed(s.app, 'GET', `${releasesBase(s.projectId)}/latest`)
    expect(latest.statusCode).toBe(404)
    expect((latest.json() as { code?: string }).code).toBe('no_releases')
  })
})

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe('release permissions', () => {
  it('non-maintainers cannot create, publish, upload, replace or delete releases', async () => {
    const s = await setup()
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.0.0', draft: true },
    })

    const deniedCreate = await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.strangerSession, payload: { tag_name: 'vEvil', draft: true },
    })
    expect(deniedCreate.statusCode).toBe(403)

    const deniedPatch = await authed(s.app, 'PATCH', `${releasesBase(s.projectId)}/v1.0.0`, {
      session: s.strangerSession, payload: { state_event: 'publish' },
    })
    expect(deniedPatch.statusCode).toBe(403)

    const deniedUpload = await putAsset(s, s.strangerSession, 'v1.0.0', 'evil.exe', Buffer.from('nope'))
    expect(deniedUpload.statusCode).toBe(403)

    const deniedDelete = await authed(s.app, 'DELETE', `${releasesBase(s.projectId)}/v1.0.0`, { session: s.strangerSession })
    expect(deniedDelete.statusCode).toBe(403)

    const deniedNotes = await authed(s.app, 'POST', `${releasesBase(s.projectId)}/v1.0.0/notes/generate`, {
      session: s.strangerSession, payload: {},
    })
    expect(deniedNotes.statusCode).toBe(403)

    // Nothing was mutated by any denied request.
    const rows = ((await authed(s.app, 'GET', releasesBase(s.projectId), { session: s.ownerSession })).json().releases as Array<Record<string, unknown>>)
    expect(rows.map((r) => r.tag_name)).toEqual(['v1.0.0'])
  })

  it('unauthenticated users can read published releases only if the project is public', async () => {
    const s = await setup()

    // Private project: anonymous gets nothing (not even existence).
    const privateList = await s.app.inject({ method: 'GET', url: releasesBase(s.projectId) })
    expect(privateList.statusCode).toBe(401)

    // Publish something, then flip the project public: anonymous reads work.
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.0.0', draft: false },
    })
    await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}`, {
      session: s.ownerSession, payload: { visibility: 'public' },
    })

    const anon = await s.app.inject({ method: 'GET', url: releasesBase(s.projectId) })
    expect(anon.statusCode).toBe(200)
    const rows = anon.json().releases as Array<Record<string, unknown>>
    expect(rows.length).toBe(1)

    // Anonymous download of the released asset works on a public project...
    await putAsset(s, s.ownerSession, 'v1.0.0', 'open.bin', Buffer.from('free'))
    const dl = await s.app.inject({
      method: 'GET',
      url: `${releasesBase(s.projectId)}/v1.0.0/assets/open.bin/download`,
    })
    expect(dl.statusCode).toBe(200)

    // ...but anonymous WRITE stays impossible everywhere.
    const anonWrite = await authed(s.app, 'POST', releasesBase(s.projectId), {
      payload: { tag_name: 'anon-tag', draft: true },
    })
    expect(anonWrite.statusCode).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Release deletion
// ---------------------------------------------------------------------------

describe('release deletion', () => {
  it('deletes metadata + assets but NEVER touches the underlying git tag', async () => {
    const s = await setup()
    commit(s, 'history keeper', 'k.txt', 'k')
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.0.0', draft: false },
    })
    await putAsset(s, s.ownerSession, 'v1.0.0', 'bin.tar.gz', Buffer.from('artifact'))
    const dir = join(s.reposRoot, '@release-assets', String(s.projectId))
    expect(readdirSync(dir).length).toBe(1)

    const del = await authed(s.app, 'DELETE', `${releasesBase(s.projectId)}/v1.0.0`, { session: s.ownerSession })
    expect(del.statusCode).toBe(200)

    // Metadata gone, asset files gone.
    expect((await authed(s.app, 'GET', `${releasesBase(s.projectId)}/v1.0.0`, { session: s.ownerSession })).statusCode).toBe(404)
    expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0)

    // The GIT TAG survives — deleting a release never rewrites history.
    const project = s.app.store.projects.byId(s.projectId)!
    const engine = s.app.releases['engineFor'](project)
    expect(engine.resolveTag('v1.0.0')).toBeTruthy()

    // Second deletion 404s.
    expect((await authed(s.app, 'DELETE', `${releasesBase(s.projectId)}/v1.0.0`, { session: s.ownerSession })).statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Latest-release determination
// ---------------------------------------------------------------------------

describe('latest-release determination', () => {
  it('picks the newest PUBLISHED stable by released_at regardless of creation order', async () => {
    const s = await setup()
    const v1 = await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.0.0', draft: false },
    })
    const v11 = await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.1.0', draft: false },
    })
    expect(v1.statusCode).toBe(v11.statusCode && 201)

    // Force deterministic ordering: make v1.1.0 strictly later.
    const t1 = new Date(Date.parse(String((v1.json().release as Record<string, unknown>).released_at)))
    s.app.store.db.run(`UPDATE releases SET released_at = ? WHERE tag_name = 'v1.0.0' AND project_id = ?`,
      new Date(t1.getTime() - 60_000).toISOString())

    const latest = await authed(s.app, 'GET', `${releasesBase(s.projectId)}/latest`)
    expect(((latest.json().release as Record<string, unknown>) as { tag_name: string }).tag_name).toBe('v1.1.0')

    // History listing orders published-first, newest-first.
    const list = await authed(s.app, 'GET', releasesBase(s.projectId), { session: s.ownerSession })
    const names = (list.json().releases as Array<{ tag_name: string }>).map((r) => r.tag_name)
    expect(names.indexOf('v1.1.0')).toBeLessThan(names.indexOf('v1.0.0'))
  })

  it('excludes drafts from latest even when they are the most recent', async () => {
    const s = await setup()
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v5.0.0', draft: true },
    })
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v4.0.0', draft: false },
    })
    const latest = await authed(s.app, 'GET', `${releasesBase(s.projectId)}/latest`)
    expect(((latest.json().release as Record<string, unknown>) as { tag_name: string }).tag_name).toBe('v4.0.0')
  })
})

// ---------------------------------------------------------------------------
// Release notes generation (explicit only)
// ---------------------------------------------------------------------------

describe('release notes generation', () => {
  it('generates markdown ONLY on explicit request and never writes it into the release', async () => {
    const s = await setup()
    commit(s, 'feat: alpha', 'one.txt', '1')
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.0.0', draft: false },
    })
    commit(s, 'fix: beta', 'two.txt', '2')
    commit(s, 'docs: gamma', 'three.txt', '3')
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.1.0', draft: false },
    })

    const gen = await authed(s.app, 'POST', `${releasesBase(s.projectId)}/v1.1.0/notes/generate`, {
      session: s.ownerSession, payload: { previous_tag: 'v1.0.0' },
    })
    expect(gen.statusCode).toBe(200)
    const md = gen.json().markdown as string
    expect(md).toContain('# v1.1.0')
    expect(md).toContain('fix: beta')
    expect(md).toContain('docs: gamma')
    expect(gen.json().commit_count).toBe(2)
    // Range exclusion works: commits BEFORE the previous tag are absent.
    expect(md).not.toContain('feat: alpha')

    // The generated text was returned for review, NOT persisted.
    const detail = await authed(s.app, 'GET', `${releasesBase(s.projectId)}/v1.1.0`, { session: s.ownerSession })
    expect(((detail.json().release as Record<string, unknown>).description) === '').toBe(true)
  })

  it('includes merged pull requests whose merge commit landed in the range', async () => {
    const s = await setup()
    commit(s, 'seed', 'seed.txt', 'seed')
    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.0.0', draft: false },
    })

    // Branch, extra commit, PR, merge into main.
    await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/repository/branches`, {
      session: s.ownerSession, payload: { name: 'feature/pr-notes', start_point: 'main' },
    })
    const alice = s.app.store.users.byUsername('alice')!
    const actor = { userId: alice.id, username: 'alice', admin: true, state: 'active' as const, via: { kind: 'session' as const } }
    const c = s.app.repositories.commitChanges(actor, s.projectId, {
      message: 'feat: shiny feature',
      changes: [{ path: 'shiny.txt', content: 'shiny' }],
      branch: 'feature/pr-notes',
    })
    expect(c).toBeTruthy()
    const prRes = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/pull_requests`, {
      session: s.ownerSession,
      payload: { title: 'Add shiny feature', source_branch: 'feature/pr-notes', target_branch: 'main' },
    })
    expect(prRes.statusCode).toBe(201)
    const iid = (prRes.json() as Record<string, unknown>).iid as number
    const mergeRes = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/pull_requests/${iid}/merge`, {
      session: s.ownerSession, payload: { method: 'merge' },
    })
    expect(mergeRes.statusCode).toBe(200)

    await authed(s.app, 'POST', releasesBase(s.projectId), {
      session: s.ownerSession, payload: { tag_name: 'v1.1.0', draft: false },
    })
    const gen = await authed(s.app, 'POST', `${releasesBase(s.projectId)}/v1.1.0/notes/generate`, {
      session: s.ownerSession, payload: { previous_tag: 'v1.0.0' },
    })
    expect(gen.statusCode).toBe(200)
    const md = gen.json().markdown as string
    expect(md).toContain('## Merged pull requests')
    expect(md).toContain(`!${iid} Add shiny feature`)
    expect(gen.json().merged_prs).toBe(1)
  })
})
