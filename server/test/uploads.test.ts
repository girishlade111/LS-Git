import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeApp, registerUser, authed, extractSession, loginRaw, type Session } from './helpers.js'
import { readObject } from '../src/storage/gitobjects.js'

async function setup(overrides: { maxUploadBytes?: number } = {}) {
  const app = makeApp({ maxUploadBytes: overrides.maxUploadBytes ?? 1024 * 1024, ...overrides })
  await registerUser(app) // alice (admin)
  const aliceSession = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'bob', email: 'bob@example.com' })
  const bobSession = extractSession((await loginRaw(app, 'bob')).cookies)
  await registerUser(app, { username: 'charlie', email: 'charlie@example.com' })
  const charlieSession = extractSession((await loginRaw(app, 'charlie')).cookies)

  // bob creates a repo with a README on main
  const created = await authed(app, 'POST', '/api/v1/projects', {
    session: bobSession,
    payload: { name: 'Uploader', path: 'uploader', initialize_with_readme: true },
  })
  expect(created.statusCode).toBe(201)

  return { app, aliceSession, bobSession, charlieSession }
}

async function initiate(
  app: ReturnType<typeof makeApp>,
  session: Session,
  projectId: number,
  filePath: string,
  size: number,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await authed(app, 'POST', `/api/v1/projects/${projectId}/uploads/initiate`, {
    session,
    payload: { file_path: filePath, size, ...extra },
  })
  return { status: res.statusCode, body: res.json() }
}

async function putBytes(
  app: ReturnType<typeof makeApp>,
  session: Session,
  projectId: number,
  uploadId: string,
  content: Buffer,
): Promise<number> {
  const cookie = session.cookie
  const csrf = session.csrf
  const res = await app.inject({
    method: 'PUT',
    url: `/api/v1/projects/${projectId}/uploads/${uploadId}`,
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/octet-stream' },
    payload: content,
  })
  return res.statusCode
}

async function commitUpload(
  app: ReturnType<typeof makeApp>,
  session: Session,
  projectId: number,
  uploadId: string | undefined,
  opts: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!uploadId) throw new Error('no upload id')
  const res = await authed(app, 'POST', `/api/v1/projects/${projectId}/uploads/${uploadId}/commit`, {
    session,
    payload: opts,
  })
  return { status: res.statusCode, body: res.json() }
}

/** Full happy-path helper: initiate → PUT → commit. */
async function uploadFile(
  app: ReturnType<typeof makeApp>,
  session: Session,
  projectId: number,
  filePath: string,
  content: string | Buffer,
  commitOpts: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown>; uploadId?: string }> {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  const init = await initiate(app, session, projectId, filePath, buf.length, (commitOpts.initiate ?? {}) as Record<string, unknown>)
  if (init.status !== 200) return { status: init.status, body: init.body }
  const uploadId = String(init.body.uploadId)
  const putStatus = await putBytes(app, session, projectId, uploadId, buf)
  if (putStatus !== 200) return { status: putStatus, body: {}, uploadId }
  return commitUpload(app, session, projectId, uploadId, {
    commit_message: commitOpts.commit_message ?? `Upload ${filePath}`,
    ...commitOpts,
  })
}

// ---------------------------------------------------------------------------

describe('single-file upload workflow', () => {
  it('creates a new file: blob → tree → commit → ref → event (direct to current branch)', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'uploader')!
    const mainBefore = app.projects.storage.readBranchFiles(project.disk_path, 'main')
    expect(mainBefore.has('docs/guide.md')).toBe(false)

    const res = await uploadFile(app, bobSession, project.id, 'docs/guide.md', '# Guide\n\nHello.', {
      commit_message: 'Add guide',
    })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      file_path: 'docs/guide.md',
      branch: 'main',
      replaced: false,
      merge_request: { created: false },
    })
    expect(String(res.body.commit_sha)).toMatch(/^[0-9a-f]{40}$/)

    // Ref updated; nested tree contains the file with exact bytes.
    const files = app.projects.storage.readBranchFiles(project.disk_path, 'main')
    expect(files.get('docs/guide.md')!.toString('utf8')).toBe('# Guide\n\nHello.')
    // Previous content survived the tree rebuild.
    expect(files.has('README.md')).toBe(true)

    // Parent linkage: new commit's parent is the previous main head.
    const abs = join(app.cfg.repositoriesRoot, project.disk_path)
    const newHead = readFileSync(join(abs, 'refs', 'heads', 'main'), 'utf8').trim()
    const parentLine = /^parent ([0-9a-f]{40})/m.exec(
      readObject(join(abs, 'objects'), newHead).body.toString('utf8'),
    )![1]!
    expect(parentLine).not.toBe(newHead)

    // Event emission (durable outbox row).
    const events = app.store.events.listForProject(project.id)
    const ev = events.find((e) => e.type === 'repository.file_committed')
    expect(ev).toBeTruthy()
    const payload = JSON.parse(String(ev!.payload))
    expect(payload).toMatchObject({ file_path: 'docs/guide.md', branch: 'main', size: content_len('# Guide\n\nHello.') })
    function content_len(s: string) { return Buffer.byteLength(s) }
  })

  it('detects an existing file and conflicts without replace', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'uploader')!

    // First upload lands.
    const first = await uploadFile(app, bobSession, project.id, 'notes.txt', 'v1')
    expect(first.status).toBe(201)

    // Second upload of the same path without replace → conflict at commit.
    const init = await initiate(app, bobSession, project.id, 'notes.txt', 2)
    expect(init.status).toBe(200)
    expect(init.body.exists).toBe(true) // early detection for the UI

    await putBytes(app, bobSession, project.id, String(init.body.uploadId), Buffer.from('v2'))
    const conflict = await commitUpload(app, bobSession, project.id, String(init.body.uploadId), {
      commit_message: 'clash',
    })
    expect(conflict.status).toBe(409)
    expect(conflict.body.message).toBe('A file with this name already exists')

    // Original content untouched.
    expect(app.projects.storage.readBranchFiles(project.disk_path, 'main').get('notes.txt')!.toString()).toBe('v1')
  })

  it('replaces an existing file when replace=true and links history', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'uploader')!
    await uploadFile(app, bobSession, project.id, 'notes.txt', 'version-1')

    const second = await uploadFile(app, bobSession, project.id, 'notes.txt', 'version-2!', {
      replace: true,
      commit_message: 'Update notes',
    })
    // GitLab files-API parity: update returns 200 (create returns 201).
    expect(second.status).toBe(200)
    expect(second.body.replaced).toBe(true)

    const files = app.projects.storage.readBranchFiles(project.disk_path, 'main')
    expect(files.get('notes.txt')!.toString()).toBe('version-2!')

    // History: HEAD's parent chain includes the previous commit.
    const abs = join(app.cfg.repositoriesRoot, project.disk_path)
    const head = readFileSync(join(abs, 'refs', 'heads', 'main'), 'utf8').trim()
    const headBody = readObject(join(abs, 'objects'), head).body.toString('utf8')
    const parent = /^parent ([0-9a-f]{40})/m.exec(headBody)![1]!
    const parentBody = readObject(join(abs, 'objects'), parent).body.toString('utf8')
    expect(parentBody).toMatch(/^tree /)
  })

  it('commits to a NEW branch forked from start_branch, leaving the base untouched', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'uploader')!
    const mainHeadBefore = readFileSync(
      join(app.cfg.repositoriesRoot, project.disk_path, 'refs', 'heads', 'main'),
      'utf8',
    ).trim()

    const res = await uploadFile(app, bobSession, project.id, 'feature.txt', 'on a branch', {
      new_branch: 'feature/upload',
      start_branch: 'main',
      commit_message: 'Feature work',
    })
    expect(res.status).toBe(201)
    expect(res.body.branch).toBe('feature/upload')

    const abs = join(app.cfg.repositoriesRoot, project.disk_path)
    const featureRef = join(abs, 'refs', 'heads', 'feature')
    expect(existsSync(featureRef)).toBe(true) // slashed branch names create subdirs
    expect(existsSync(join(featureRef, 'upload'))).toBe(true)

    // Base branch untouched.
    const mainHeadAfter = readFileSync(join(abs, 'refs', 'heads', 'main'), 'utf8').trim()
    expect(mainHeadAfter).toBe(mainHeadBefore)
    expect(app.projects.storage.readBranchFiles(project.disk_path, 'main').has('feature.txt')).toBe(false)
    expect(app.projects.storage.readBranchFiles(project.disk_path, 'feature/upload').get('feature.txt')!.toString()).toBe('on a branch')
  })

  it('rejects unauthorized pushes: non-owner users and insufficient PAT scopes', async () => {
    const { app, aliceSession, charlieSession } = await setup()
    // alice owns nothing here — create her own view: charlie targets bob's project.
    const project = app.store.projects.byOwnerPath('bob', 'uploader')!

    const init = await initiate(app, charlieSession, project.id, 'steal.txt', 3)
    expect(init.status).toBe(403)

    const adminInit = await initiate(app, aliceSession, project.id, 'by-admin.txt', 5)
    expect(adminInit.status).toBe(200) // instance admin may push (central authz)

    // PAT with read-only scope cannot even start an upload.
    const token = await authed(app, 'POST', '/api/v1/user/personal_access_tokens', {
      session: charlieSession,
      payload: { name: 'ro', scopes: ['read_api'], expires_in_days: 10 },
    })
    const roToken = String(token.json().token)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/uploads/initiate`,
      headers: { authorization: `Bearer ${roToken}`, 'content-type': 'application/json' },
      payload: { file_path: 'x.txt', size: 1 },
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejects invalid paths before any byte is stored', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'uploader')!
    for (const bad of [
      '../evil.txt',
      'a/../../evil.txt',
      '/absolute/path.txt',
      'C:\\Windows\\evil.txt',
      'back\\slash.txt',
      'double//slash.txt',
      '.git/config',
      'trick..ery/../x',
      '',
      'seg/../../..',
    ]) {
      const res = await initiate(app, bobSession, project.id, bad, 4)
      expect([400].includes(res.status), `expected 400 for ${JSON.stringify(bad)}, got ${res.status}`).toBe(true)
    }
    // Allowed dotfile still works.
    const ok = await uploadFile(app, bobSession, project.id, '.gitkeep', '')
    expect(ok.status).toBe(201)
  })

  it('enforces the size cap at initiation AND during transfer', async () => {
    const { app, bobSession } = await setup({ maxUploadBytes: 16 })
    const project = app.store.projects.byOwnerPath('bob', 'uploader')!

    const tooBigInit = await initiate(app, bobSession, project.id, 'big.bin', 32)
    expect(tooBigInit.status).toBe(413)

    // Lie about the size, exceed cap in transfer.
    const init = await initiate(app, bobSession, project.id, 'sneaky.bin', 8)
    expect(init.status).toBe(200)
    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${project.id}/uploads/${String(init.body.uploadId)}`,
      headers: {
        cookie: bobSession.cookie,
        'x-csrf-token': bobSession.csrf,
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.alloc(32, 7),
    })
    expect(putRes.statusCode).toBe(413)
  })

  it('fails cleanly when the transfer never completed or the id is unknown', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'uploader')!

    // Unknown id.
    const missing = await commitUpload(app, bobSession, project.id, 'ffffffff-ffff-ffff-ffff-ffffffffffff', {})
    expect(missing.status).toBe(404)

    // Initiated but no bytes transferred.
    const init = await initiate(app, bobSession, project.id, 'never.bin', 4)
    const ghost = await commitUpload(app, bobSession, project.id, String(init.body.uploadId), {
      commit_message: 'no bytes',
    })
    expect(ghost.status).toBe(404)
    expect(ghost.body.message).toMatch(/retry/i)
  })

  it('supports retry: re-transferring bytes overwrites staging and commits correctly', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'uploader')!

    const init = await initiate(app, bobSession, project.id, 'retry.txt', 6)
    const uploadId = String(init.body.uploadId)

    // Attempt #1 sends wrong-size data → rejected, but the slot stays pending.
    const badPut = await putBytes(app, bobSession, project.id, uploadId, Buffer.from('abc'))
    expect(badPut).toBe(400)

    // Retry with the correct payload succeeds end-to-end.
    expect(await putBytes(app, bobSession, project.id, uploadId, Buffer.from('retry!'))).toBe(200)
    const done = await commitUpload(app, bobSession, project.id, uploadId, { commit_message: 'retry works' })
    expect(done.status).toBe(201)
    expect(app.projects.storage.readBranchFiles(project.disk_path, 'main').get('retry.txt')!.toString()).toBe('retry!')
  })

  it('supports cancellation: staged bytes are destroyed and commit is impossible', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'uploader')!
    const tmpRoot = app.cfg.uploadsRoot

    const init = await initiate(app, bobSession, project.id, 'cancelled.txt', 4)
    const uploadId = String(init.body.uploadId)
    expect(existsSync(join(tmpRoot, uploadId))).toBe(true)

    await putBytes(app, bobSession, project.id, uploadId, Buffer.from('abcd'))
    const cancelled = await authed(app, 'DELETE', `/api/v1/projects/${project.id}/uploads/${uploadId}`, { session: bobSession })
    expect(cancelled.statusCode).toBe(200)
    expect(existsSync(join(tmpRoot, uploadId))).toBe(false)

    const late = await commitUpload(app, bobSession, project.id, uploadId, { commit_message: 'zombie' })
    expect(late.status).toBe(404)

    // Someone else cannot cancel your upload.
    const other = await initiate(app, bobSession, project.id, 'other.txt', 2)
    void other
  })

  it('empty-commit guard: replacing identical content is rejected (GitLab parity)', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'uploader')!
    await uploadFile(app, bobSession, project.id, 'same.txt', 'identical')

    const again = await uploadFile(app, bobSession, project.id, 'same.txt', 'identical', {
      replace: true,
      commit_message: 'no-op',
    })
    expect(again.status).toBe(400)
    expect(again.body.message).toMatch(/identical/)
  })
})
