import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeApp, registerUser, authed, extractSession, loginRaw, type Session } from './helpers.js'
import { readObject } from '../src/storage/gitobjects.js'

/**
 * Folder/project (batch) upload workflow — LSGit's primary differentiated
 * feature. Behavioral reference: GitLab multi-file Web IDE / repository
 * upload flows. Every case below exercises the HTTP surface end-to-end.
 */

async function setup(overrides: Parameters<typeof makeApp>[0] = {}) {
  const app = makeApp(overrides)
  await registerUser(app) // alice (admin)
  const aliceSession = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'bob', email: 'bob@example.com' })
  const bobSession = extractSession((await loginRaw(app, 'bob')).cookies)
  await registerUser(app, { username: 'charlie', email: 'charlie@example.com' })
  const charlieSession = extractSession((await loginRaw(app, 'charlie')).cookies)

  // bob owns a repo initialized with a README on main
  const created = await authed(app, 'POST', '/api/v1/projects', {
    session: bobSession,
    payload: { name: 'Folder Uploads', path: 'folder-uploads', initialize_with_readme: true },
  })
  expect(created.statusCode).toBe(201)

  return { app, aliceSession, bobSession, charlieSession }
}

async function createBatch(
  app: ReturnType<typeof makeApp>,
  session: Session,
  projectId: number,
  fileCount: number,
  totalBytes: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await authed(app, 'POST', `/api/v1/projects/${projectId}/uploads/batches`, {
    session,
    payload: { file_count: fileCount, total_bytes: totalBytes },
  })
  return { status: res.statusCode, body: res.json() }
}

async function stageFile(
  app: ReturnType<typeof makeApp>,
  session: Session,
  projectId: number,
  batchId: string,
  filePath: string,
  content: string | Buffer,
): Promise<{ status: number; body: Record<string, unknown>; uploadId?: string }> {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  const init = await authed(app, 'POST', `/api/v1/projects/${projectId}/uploads/initiate`, {
    session,
    payload: { file_path: filePath, size: buf.length, batch_id: batchId },
  })
  if (init.statusCode !== 200) return { status: init.statusCode, body: init.json() }
  const uploadId = String(init.json().uploadId)
  const put = await app.inject({
    method: 'PUT',
    url: `/api/v1/projects/${projectId}/uploads/${uploadId}`,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/octet-stream' },
    payload: buf,
  })
  if (put.statusCode !== 200) return { status: put.statusCode, body: put.json(), uploadId }
  return { status: 200, body: {}, uploadId }
}

async function finalize(
  app: ReturnType<typeof makeApp>,
  session: Session,
  projectId: number,
  batchId: string,
  opts: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await authed(app, 'POST', `/api/v1/projects/${projectId}/uploads/batches/${batchId}/finalize`, {
    session,
    payload: opts,
  })
  return { status: res.statusCode, body: res.json() }
}

function headSha(app: ReturnType<typeof makeApp>, diskPath: string, branch: string): string | null {
  const ref = join(app.cfg.repositoriesRoot, diskPath, 'refs', 'heads', ...branch.split('/'))
  if (!existsSync(ref)) return null
  return readFileSync(ref, 'utf8').trim()
}

// ---------------------------------------------------------------------------

describe('batch creation', () => {
  it('opens a session and returns limits for client-side pre-validation', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const res = await createBatch(app, bobSession, project.id, 3, 100)
    expect(res.status).toBe(201)
    expect(res.body.batchId).toMatch(/^[a-f0-9-]{36}$/)
    expect(res.body.limits).toMatchObject({
      max_file_bytes: app.cfg.maxUploadBytes,
      max_batch_files: app.cfg.maxBatchFiles,
      max_batch_total_bytes: app.cfg.maxBatchTotalBytes,
    })
  })

  it('rejects unauthorized users, oversized declarations, and bad counts', async () => {
    const { app, bobSession, charlieSession } = await setup({ maxBatchFiles: 10 })
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!

    const denied = await createBatch(app, charlieSession, project.id, 1, 10)
    expect(denied.status).toBe(403)

    expect((await createBatch(app, bobSession, project.id, 0, 10)).status).toBe(413)
    expect((await createBatch(app, bobSession, project.id, 11, 10)).status).toBe(413)
    expect((await createBatch(app, bobSession, project.id, 5, app.cfg.maxBatchTotalBytes + 1)).status).toBe(413)
  })

  it('requires authentication', async () => {
    const { app } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const res = await authed(app, 'POST', `/api/v1/projects/${project.id}/uploads/batches`, {
      payload: { file_count: 1, total_bytes: 1 },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('staging rules inside a batch', () => {
  it('rejects duplicate paths within the same batch but allows them across batches', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const batch = String((await createBatch(app, bobSession, project.id, 2, 20)).body.batchId)

    const first = await stageFile(app, bobSession, project.id, batch, 'dup.txt', 'one')
    expect(first.status).toBe(200)

    const dup = await stageFile(app, bobSession, project.id, batch, 'dup.txt', 'two')
    expect(dup.status).toBe(409)
    expect(String(dup.body.message)).toMatch(/already staged/)

    const other = String((await createBatch(app, bobSession, project.id, 1, 3)).body.batchId)
    expect((await stageFile(app, bobSession, project.id, other, 'dup.txt', 'other-batch')).status).toBe(200)
  })

  it('enforces declared batch size: staging beyond the declared count fails', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const batch = String((await createBatch(app, bobSession, project.id, 1, 10)).body.batchId)
    expect((await stageFile(app, bobSession, project.id, batch, 'a.txt', 'aaa')).status).toBe(200)
    expect((await stageFile(app, bobSession, project.id, batch, 'b.txt', 'bbb')).status).toBe(413)
  })

  it('rejects per-file violations exactly like single uploads (size cap, invalid path)', async () => {
    const { app, bobSession } = await setup({ maxUploadBytes: 8 })
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const batch = String((await createBatch(app, bobSession, project.id, 5, 50)).body.batchId)

    expect((await stageFile(app, bobSession, project.id, batch, 'big.bin', Buffer.alloc(64, 1))).status).toBe(413)
    expect((await stageFile(app, bobSession, project.id, batch, '../escape.txt', 'x')).status).toBe(400)
    expect((await stageFile(app, bobSession, project.id, batch, 'C:\\boot.ini', 'x')).status).toBe(400)
  })

  it('cannot stage into another user’s batch or a closed batch', async () => {
    const { app, bobSession, charlieSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const batch = String((await createBatch(app, bobSession, project.id, 5, 50)).body.batchId)

    const foreign = await stageFile(app, charlieSession, project.id, batch, 'steal.txt', 'x')
    expect(foreign.status).toBe(403) // push authz runs before batch existence is revealed

    // Cancel closes the batch…
    await authed(app, 'DELETE', `/api/v1/projects/${project.id}/uploads/batches/${batch}`, { session: bobSession })
    const late = await stageFile(app, bobSession, project.id, batch, 'late.txt', 'x')
    expect(late.status).toBe(409)
  })
})

describe('finalize — one commit for the whole set', () => {
  it('commits nested folders as ONE commit with correct tree structure and a single event', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const batch = String((await createBatch(app, bobSession, project.id, 4, 64)).body.batchId)

    expect((await stageFile(app, bobSession, project.id, batch, 'src/app/main.ts', 'export {}')).status).toBe(200)
    expect((await stageFile(app, bobSession, project.id, batch, 'src/lib/util/deep/nested/helper.js', '// h')).status).toBe(200)
    expect((await stageFile(app, bobSession, project.id, batch, '.gitkeep', '')).status).toBe(200)
    expect((await stageFile(app, bobSession, project.id, batch, 'README.md', '# overwritten readme')).status).toBe(200)

    const before = headSha(app, project.disk_path, 'main')!
    const res = await finalize(app, bobSession, project.id, batch, {
      commit_message: 'Upload project folder',
      replace: true, // README.md already exists on main
    })
    expect(res.status).toBe(201)
    expect(res.body.committed_files).toBe(4)
    expect(String(res.body.commit_sha)).toMatch(/^[0-9a-f]{40}$/)
    expect(res.body.commit_sha).not.toBe(before)

    // Files landed with exact bytes; README replaced; pre-existing content preserved.
    const files = app.projects.storage.readBranchFiles(project.disk_path, 'main')
    expect(files.get('src/app/main.ts')!.toString()).toBe('export {}')
    expect(files.get('src/lib/util/deep/nested/helper.js')!.toString()).toBe('// h')
    expect(files.has('.gitkeep')).toBe(true)
    expect(files.get('README.md')!.toString()).toBe('# overwritten readme')

    // Parent linkage: one commit whose parent is the previous head.
    const abs = join(app.cfg.repositoriesRoot, project.disk_path)
    const commitBody = readObject(join(abs, 'objects'), String(res.body.commit_sha)).body.toString('utf8')
    expect(commitBody).toContain(`parent ${before}`)

    // Exactly ONE durable event for the whole batch.
    const events = app.store.events.listForProject(project.id).filter((e) => e.type === 'repository.files_committed')
    expect(events.length).toBe(1)
    const payload = JSON.parse(String(events[0]!.payload))
    expect(payload).toMatchObject({ branch: 'main', file_count: 4, replaced_count: 1 })

    // Staged temp bytes are gone after success.
    for (const row of app.store.uploads.listByBatch(batch)) {
      expect(existsSync(join(app.cfg.uploadsRoot, row.id))).toBe(false)
    }

    // The batch is terminal; re-finalizing is refused.
    const again = await finalize(app, bobSession, project.id, batch, { commit_message: 'double' })
    expect(again.status).toBe(409)
  })

  it('reports every conflicting path when replace=false and commits over them with replace=true', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!

    const batch = String((await createBatch(app, bobSession, project.id, 2, 32)).body.batchId)
    await stageFile(app, bobSession, project.id, batch, 'README.md', 'new readme')
    await stageFile(app, bobSession, project.id, batch, 'docs/new.md', 'fresh')
    const conflict = await finalize(app, bobSession, project.id, batch, { commit_message: 'clash' })
    expect(conflict.status).toBe(409)
    expect(conflict.body.conflict_paths).toEqual(['README.md'])

    // Same batch retries cleanly with replace=true (staging survived).
    const ok = await finalize(app, bobSession, project.id, batch, {
      commit_message: 'replace everything',
      replace: true,
    })
    expect(ok.status).toBe(201)
    expect(ok.body.replaced_count).toBe(1)
  })

  it('skips byte-identical replacements and refuses an all-identical batch (empty-commit guard)', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!

    const allSame = String((await createBatch(app, bobSession, project.id, 1, 17)).body.batchId)
    await stageFile(app, bobSession, project.id, allSame, 'README.md', 'same bytes')
    const noop = await finalize(app, bobSession, project.id, allSame, {
      commit_message: 'noop',
      replace: true,
    })
    expect(noop.status).toBe(400)
    expect(String(noop.body.message)).toMatch(/identical/i)

    const mixed = String((await createBatch(app, bobSession, project.id, 2, 34)).body.batchId)
    await stageFile(app, bobSession, project.id, mixed, 'README.md', 'same bytes') // identical
    await stageFile(app, bobSession, project.id, mixed, 'changed.txt', 'actually new')
    const done = await finalize(app, bobSession, project.id, mixed, {
      commit_message: 'mixed',
      replace: true,
    })
    expect(done.status).toBe(201)
    expect(done.body.committed_files).toBe(1)
    expect(done.body.identical_skipped).toBe(1)
  })

  it('lands on a NEW branch forked from start_branch without touching the base', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const mainBefore = headSha(app, project.disk_path, 'main')!

    const batch = String((await createBatch(app, bobSession, project.id, 1, 12)).body.batchId)
    await stageFile(app, bobSession, project.id, batch, 'feature/index.ts', '// feature')
    const res = await finalize(app, bobSession, project.id, batch, {
      new_branch: 'feature/project-import',
      start_branch: 'main',
      commit_message: 'Import on a branch',
    })
    expect(res.status).toBe(201)
    expect(res.body.branch).toBe('feature/project-import')
    expect(headSha(app, project.disk_path, 'main')).toBe(mainBefore)
    expect(headSha(app, project.disk_path, 'feature/project-import')).toBeTruthy()
    expect(app.projects.storage.readBranchFiles(project.disk_path, 'main').has('feature/index.ts')).toBe(false)
    expect(
      app.projects.storage.readBranchFiles(project.disk_path, 'feature/project-import').get('feature/index.ts')!.toString(),
    ).toBe('// feature')
  })

  it('refuses finalize while any file has not finished transferring (interrupted queue)', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const batch = String((await createBatch(app, bobSession, project.id, 2, 32)).body.batchId)

    await stageFile(app, bobSession, project.id, batch, 'complete.txt', 'done')
    // Interrupted: initiated but never transferred.
    const ghostInit = await authed(app, 'POST', `/api/v1/projects/${project.id}/uploads/initiate`, {
      session: bobSession,
      payload: { file_path: 'interrupted.txt', size: 5, batch_id: batch },
    })
    void ghostInit

    const res = await finalize(app, bobSession, project.id, batch, { commit_message: 'partial' })
    expect(res.status).toBe(409)
    expect(res.body.code ?? '').toBe('incomplete_batch')
    expect(res.body.pending_paths).toEqual(['interrupted.txt'])
  })

  it('supports retry: re-transferring a rejected transfer then finalizing succeeds', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const batch = String((await createBatch(app, bobSession, project.id, 1, 6)).body.batchId)

    const init = await authed(app, 'POST', `/api/v1/projects/${project.id}/uploads/initiate`, {
      session: bobSession,
      payload: { file_path: 'retry.txt', size: 6, batch_id: batch },
    })
    const uploadId = String(init.json().uploadId)
    // Truncated transfer (simulated connection drop).
    const bad = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${project.id}/uploads/${uploadId}`,
      headers: { cookie: bobSession.cookie, 'x-csrf-token': bobSession.csrf, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('abc'),
    })
    expect(bad.statusCode).toBe(400)
    // Finalize while incomplete is refused; the batch stays open for retry.
    const partial = await finalize(app, bobSession, project.id, batch, { commit_message: 'x' })
    expect(partial.status).toBe(409)
    // Retry with full bytes overwrites staging.
    const good = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${project.id}/uploads/${uploadId}`,
      headers: { cookie: bobSession.cookie, 'x-csrf-token': bobSession.csrf, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('retry!'),
    })
    expect(good.statusCode).toBe(200)
    const done = await finalize(app, bobSession, project.id, batch, { commit_message: 'retry wins' })
    expect(done.status).toBe(201)
    expect(app.projects.storage.readBranchFiles(project.disk_path, 'main').get('retry.txt')!.toString()).toBe('retry!')
  })

  it('removing a file from the queue cancels its slot; finalize commits only what remains', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const batch = String((await createBatch(app, bobSession, project.id, 2, 16)).body.batchId)

    const kept = await stageFile(app, bobSession, project.id, batch, 'kept.txt', 'keep me')
    const removed = await stageFile(app, bobSession, project.id, batch, 'removed.txt', 'remove me')
    expect(removed.uploadId).toBeTruthy()

    const del = await authed(app, 'DELETE', `/api/v1/projects/${project.id}/uploads/${removed.uploadId}`, {
      session: bobSession,
    })
    expect(del.statusCode).toBe(200)

    const done = await finalize(app, bobSession, project.id, batch, { commit_message: 'only kept' })
    expect(done.status).toBe(201)
    expect(done.body.committed_files).toBe(1)
    expect(app.projects.storage.readBranchFiles(project.disk_path, 'main').has('removed.txt')).toBe(false)
    expect(app.projects.storage.readBranchFiles(project.disk_path, 'main').get('kept.txt')!.toString()).toBe('keep me')
  })

  it('cancelling the whole batch destroys staged bytes and makes finalize impossible', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const batch = String((await createBatch(app, bobSession, project.id, 1, 8)).body.batchId)
    const staged = await stageFile(app, bobSession, project.id, batch, 'doomed.txt', 'bye')
    expect(existsSync(join(app.cfg.uploadsRoot, staged.uploadId!))).toBe(true)

    await authed(app, 'DELETE', `/api/v1/projects/${project.id}/uploads/batches/${batch}`, { session: bobSession })
    expect(existsSync(join(app.cfg.uploadsRoot, staged.uploadId!))).toBe(false)

    const zombie = await finalize(app, bobSession, project.id, batch, { commit_message: 'zombie' })
    expect(zombie.status).toBe(409)
  })
})

describe('browser refresh behavior — orphan recovery', () => {
  it('garbage-collects abandoned open batches: temps removed, finalize impossible, status visible', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const batch = String((await createBatch(app, bobSession, project.id, 2, 16)).body.batchId)
    const staged = await stageFile(app, bobSession, project.id, batch, 'abandoned.txt', 'orphan bytes')

    // Simulate the passage of the TTL (page was refreshed and never resumed).
    const purged = app.uploads.purgeStale(new Date(Date.now() + app.cfg.staleUploadTtlMinutes * 60_000 + 60_000))
    expect(purged).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(app.cfg.uploadsRoot, staged.uploadId!))).toBe(false)

    const status = await authed(app, 'GET', `/api/v1/projects/${project.id}/uploads/batches/${batch}`, {
      session: bobSession,
    })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({ state: 'cancelled' })

    const zombie = await finalize(app, bobSession, project.id, batch, { commit_message: 'after refresh' })
    expect(zombie.status).toBe(409)

    // Fresh sessions are unaffected by GC.
    const fresh = String((await createBatch(app, bobSession, project.id, 1, 4)).body.batchId)
    expect((await stageFile(app, bobSession, project.id, fresh, 'post-gc.txt', 'ok!')).status).toBe(200)
  })

  it('exposes session status so a resumed tab can reconcile its manifest', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const batch = String((await createBatch(app, bobSession, project.id, 2, 12)).body.batchId)
    await stageFile(app, bobSession, project.id, batch, 'one.txt', '111')
    await stageFile(app, bobSession, project.id, batch, 'two.txt', '22222')

    const status = await authed(app, 'GET', `/api/v1/projects/${project.id}/uploads/batches/${batch}`, {
      session: bobSession,
    })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({
      state: 'open',
      received_files: 2,
      cancelled_files: 0,
      received_bytes: 8,
    })
  })
})

describe('authorization boundaries', () => {
  it('blocks every batch verb for a non-owner on someone else’s repo', async () => {
    const { app, bobSession, charlieSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!

    const denied = await createBatch(app, charlieSession, project.id, 1, 4)
    expect(denied.status).toBe(403)

    // Even with a leaked batch id, staging/finalizing under charlie's name fails.
    const batch = String((await createBatch(app, bobSession, project.id, 1, 4)).body.batchId)
    expect((await stageFile(app, charlieSession, project.id, batch, 'x.txt', 'x')).status).toBe(404)
    const fin = await authed(app, 'POST', `/api/v1/projects/${project.id}/uploads/batches/${batch}/finalize`, {
      session: charlieSession,
      payload: { commit_message: 'nope' },
    })
    expect(fin.statusCode).toBe(403)

    // Status/cancel are also scoped to the owning user (admins excepted).
    const st = await authed(app, 'GET', `/api/v1/projects/${project.id}/uploads/batches/${batch}`, {
      session: charlieSession,
    })
    expect(st.statusCode).toBe(403)
  })

  it('read-scoped PATs cannot open or drive a batch', async () => {
    const { app, bobSession, charlieSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const tokenRes = await authed(app, 'POST', '/api/v1/user/personal_access_tokens', {
      session: charlieSession,
      payload: { name: 'ro', scopes: ['read_api'], expires_in_days: 10 },
    })
    const roToken = String(tokenRes.json().token)
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/uploads/batches`,
      headers: { authorization: `Bearer ${roToken}`, 'content-type': 'application/json' },
      payload: { file_count: 1, total_bytes: 4 },
    })
    expect(res.statusCode).toBe(403)
    void bobSession
  })
})

describe('protected branches', () => {
  it('default branch ships protected at Maintainer-push (owner may still push)', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const list = await authed(app, 'GET', `/api/v1/projects/${project.id}/protected_branches`, { session: bobSession })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual([{ project_id: project.id, name: 'main', push_access_level: 'maintainer' }])
  })

  it("pushing to a branch protected with 'no_one' is refused; branch flow still works", async () => {
    const { app, aliceSession, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const mainBefore = headSha(app, project.disk_path, 'main')!

    const lock = await authed(app, 'PUT', `/api/v1/projects/${project.id}/protected_branches`, {
      session: bobSession,
      payload: { name: 'main', push_access_level: 'no_one' },
    })
    expect(lock.statusCode).toBe(200)

    const batch = String((await createBatch(app, bobSession, project.id, 1, 8)).body.batchId)
    await stageFile(app, bobSession, project.id, batch, 'locked.txt', 'attempt')

    const blocked = await finalize(app, bobSession, project.id, batch, { commit_message: 'to main' })
    expect(blocked.status).toBe(403)
    expect(blocked.body.code ?? '').toBe('protected_branch')
    expect(headSha(app, project.disk_path, 'main')).toBe(mainBefore) // untouched

    // Same staged batch reroutes onto an unprotected branch without restaging.
    const ok = await finalize(app, bobSession, project.id, batch, {
      new_branch: 'feature/via-mr',
      start_branch: 'main',
      commit_message: 'branch instead',
    })
    expect(ok.status).toBe(201)
    expect(ok.body.branch).toBe('feature/via-mr')

    // Instance admin overrides protection (GitLab parity).
    const adminBatch = String((await createBatch(app, aliceSession, project.id, 1, 8)).body.batchId)
    await stageFile(app, aliceSession, project.id, adminBatch, 'admin.txt', 'override')
    const adminDone = await finalize(app, aliceSession, project.id, adminBatch, {
      commit_message: 'admin direct',
      replace: true,
    })
    expect(adminDone.status).toBe(201)
  })

  it('single-file commit honors the same protection rule', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    await authed(app, 'PUT', `/api/v1/projects/${project.id}/protected_branches`, {
      session: bobSession,
      payload: { name: 'main', push_access_level: 'no_one' },
    })
    const init = await authed(app, 'POST', `/api/v1/projects/${project.id}/uploads/initiate`, {
      session: bobSession,
      payload: { file_path: 'solo.txt', size: 4 },
    })
    const uploadId = String(init.json().uploadId)
    await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${project.id}/uploads/${uploadId}`,
      headers: { cookie: bobSession.cookie, 'x-csrf-token': bobSession.csrf, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('data'),
    })
    const res = await authed(app, 'POST', `/api/v1/projects/${project.id}/uploads/${uploadId}/commit`, {
      session: bobSession,
      payload: { commit_message: 'blocked too' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code ?? '').toBe('protected_branch')
  })

  it('protection settings require maintainer rights', async () => {
    const { app, bobSession, charlieSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const res = await authed(app, 'PUT', `/api/v1/projects/${project.id}/protected_branches`, {
      session: charlieSession,
      payload: { name: 'main', push_access_level: 'no_one' },
    })
    expect(res.statusCode).toBe(403)
    void bobSession
  })
})

describe('path hygiene across platforms', () => {
  it('normalizes nothing silently: platform-specific inputs are rejected server-side', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const batch = String((await createBatch(app, bobSession, project.id, 10, 128)).body.batchId)
    for (const bad of [
      'C:\\Users\\bob\\proj\\file.txt',
      '/home/bob/file.txt',
      '..\\..\\etc\\passwd',
      'a/../b.txt',
      '.git/config',
    ]) {
      const res = await stageFile(app, bobSession, project.id, batch, bad, 'x')
      expect([400].includes(res.status), `expected 400 for ${bad}, got ${res.status}`).toBe(true)
    }
  })

  it('accepts special characters that are legal in git: unicode, spaces, dots, plus', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const batch = String((await createBatch(app, bobSession, project.id, 4, 256)).body.batchId)
    const names = [
      'docs/café/naïve résumé.md',
      'assets/logos/brand+v2.final.png',
      '中文/目录/文件.txt',
      'emoji/🚀 launch notes.md',
    ]
    for (const n of names) {
      expect((await stageFile(app, bobSession, project.id, batch, n, `content of ${n}`)).status).toBe(200)
    }
    const done = await finalize(app, bobSession, project.id, batch, { commit_message: 'unicode paths' })
    expect(done.status).toBe(201)
    expect(done.body.committed_files).toBe(names.length)
    const files = app.projects.storage.readBranchFiles(project.disk_path, 'main')
    for (const n of names) expect(files.get(n)!.toString()).toBe(`content of ${n}`)
  })
})

describe('scale — 1000-file project', () => {
  it('stages and commits a 1000-file tree as one commit within limits', { timeout: 240_000 }, async () => {
    const { app, bobSession } = await setup({ maxBatchFiles: 5000 })
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!

    const COUNT = 1000
    const batch = String(
      (await createBatch(app, bobSession, project.id, COUNT, COUNT * 16)).body.batchId,
    )
    expect(batch).toMatch(/^[a-f0-9-]{36}$/)

    let stagedBytes = 0
    for (let i = 0; i < COUNT; i++) {
      const dir = `pkg${Math.floor(i / 250)}`
      const path = `${dir}/mod-${i}/file-${i}.txt`
      const content = `file number ${i}\n`
      stagedBytes += Buffer.byteLength(content)
      const res = await stageFile(app, bobSession, project.id, batch, path, content)
      expect(res.status, `staging ${path}`).toBe(200)
    }
    expect(stagedBytes).toBe(COUNT * 16)

    const t0 = Date.now()
    const done = await finalize(app, bobSession, project.id, batch, {
      commit_message: 'Upload 1000-file project',
    })
    expect(done.status).toBe(201)
    expect(done.body.committed_files).toBe(COUNT)
    expect(done.body.total_bytes).toBe(stagedBytes)

    const files = app.projects.storage.readBranchFiles(project.disk_path, 'main')
    expect(files.size).toBe(COUNT + 1) // + README.md
    expect(files.get('pkg0/mod-0/file-0.txt')!.toString()).toBe('file number 0\n')
    expect(files.get('pkg3/mod-999/file-999.txt')!.toString()).toBe('file number 999\n')

    // One commit, one event, terminal batch.
    const events = app.store.events.listForProject(project.id).filter((e) => e.type === 'repository.files_committed')
    expect(events.length).toBe(1)
    const status = await authed(app, 'GET', `/api/v1/projects/${project.id}/uploads/batches/${batch}`, {
      session: bobSession,
    })
    expect(status.json()).toMatchObject({ state: 'completed', received_files: COUNT })
    expect(Date.now() - t0).toBeLessThan(120_000)
  })

  it('declared-count ceiling caps runaway queues even mid-session', async () => {
    const { app, bobSession } = await setup({ maxBatchFiles: 50 })
    const project = app.store.projects.byOwnerPath('bob', 'folder-uploads')!
    const res = await createBatch(app, bobSession, project.id, 51, 1024)
    expect(res.status).toBe(413)
  })
})
