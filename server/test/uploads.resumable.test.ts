import { describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeApp, registerUser, authed, extractSession, loginRaw, type Session } from './helpers.js'

/**
 * Resumable upload session infrastructure (UPLOADS.md) — HTTP-level
 * integration tests covering the full lifecycle: create → chunked transfer →
 * interruption/resume → verify → finalize (idempotent) → events, plus every
 * guard rail: expiry, cleanup, quotas, attempt caps, cross-user isolation,
 * protected branches and structured partial failures.
 */

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).digest('hex')
}

async function setup(overrides: Parameters<typeof makeApp>[0] = {}) {
  const app = makeApp(overrides)
  await registerUser(app) // alice (admin)
  const aliceSession = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'bob', email: 'bob@example.com' })
  const bobSession = extractSession((await loginRaw(app, 'bob')).cookies)
  await registerUser(app, { username: 'charlie', email: 'charlie@example.com' })
  const charlieSession = extractSession((await loginRaw(app, 'charlie')).cookies)

  const created = await authed(app, 'POST', '/api/v1/projects', {
    session: bobSession,
    payload: { name: 'Resumable', path: 'resumable', initialize_with_readme: true },
  })
  expect(created.statusCode).toBe(201)

  return { app, aliceSession, bobSession, charlieSession }
}

interface ManifestEntry {
  file_path: string
  size: number
  mime?: string
  last_modified?: number
  sha256?: string
}

async function createSession(
  app: ReturnType<typeof makeApp>,
  session: Session,
  projectId: number,
  items: ManifestEntry[],
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await authed(app, 'POST', `/api/v1/projects/${projectId}/upload_sessions`, {
    session,
    payload: { items, ...extra },
  })
  return { status: res.statusCode, body: res.json() }
}

async function putChunk(
  app: ReturnType<typeof makeApp>,
  session: Session,
  projectId: number,
  sid: string,
  itemId: string,
  index: number,
  content: Buffer,
  opts: { sha?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }> {
  const headers: Record<string, string> = {
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
    'content-type': 'application/octet-stream',
  }
  if (opts.sha) headers['x-chunk-sha256'] = sha256(content)
  const res = await app.inject({
    method: 'PUT',
    url: `/api/v1/projects/${projectId}/upload_sessions/${sid}/items/${itemId}/chunks/${index}`,
    headers,
    payload: content,
  })
  return { status: res.statusCode, body: res.json(), headers: res.headers as never }
}

async function getChunkMap(
  app: ReturnType<typeof makeApp>,
  session: Session,
  projectId: number,
  sid: string,
  itemId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await authed(
    app,
    'GET',
    `/api/v1/projects/${projectId}/upload_sessions/${sid}/items/${itemId}/chunks`,
    { session },
  )
  return { status: res.statusCode, body: res.json() }
}

async function finalize(
  app: ReturnType<typeof makeApp>,
  session: Session,
  projectId: number,
  sid: string,
  opts: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await authed(
    app,
    'POST',
    `/api/v1/projects/${projectId}/upload_sessions/${sid}/finalize`,
    { session, payload: opts },
  )
  return { status: res.statusCode, body: res.json() }
}

function stagingDir(app: ReturnType<typeof makeApp>, sid: string): string {
  return join(app.cfg.uploadsRoot, 'resumable', sid)
}

let counter = 0
const nextPath = (prefix: string) => `${prefix}-${(counter += 1)}.txt`

// ---------------------------------------------------------------------------

describe('session creation — manifest reception + authorization', () => {
  it('creates a session with per-item chunk plans and echoes limits', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'resumable')!
    const res = await createSession(app, bobSession, project.id, [
      { file_path: 'docs/a.md', size: 20, mime: 'text/markdown' },
      { file_path: 'deep/nested/b.txt', size: 8 },
      { file_path: 'empty.bin', size: 0 },
    ], { chunk_size: 8 })

    expect(res.status).toBe(201)
    const items = res.body.items as Array<Record<string, unknown>>
    expect(items).toHaveLength(3)
    const byPath = Object.fromEntries(items.map((i) => [String(i.file_path), i]))
    // Requested chunk_size floors at min_chunk_size (default 256 KB); files
    // smaller than the floor collapse to ONE whole-file chunk.
    expect(byPath['docs/a.md']).toMatchObject({ chunk_size: 20, chunk_count: 1 })
    expect(byPath['deep/nested/b.txt']).toMatchObject({ chunk_size: 8, chunk_count: 1 })
    expect(byPath['empty.bin']).toMatchObject({ chunk_count: 1 })
    expect(res.body.state).toBe('open')
    expect(typeof res.body.expires_at).toBe('string')
  })

  it('rejects traversal, absolute, reserved and duplicate manifest paths before any storage exists', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'resumable')!
    for (const bad of ['../evil.txt', '/abs.txt', 'C:\\x.txt', '.git/config', 'a/../../b']) {
      const res = await createSession(app, bobSession, project.id, [{ file_path: bad, size: 1 }])
      expect(res.status, bad).toBe(400)
      // Nothing was created — no session id is ever returned for a rejected manifest.
      expect(res.body.session_id).toBeUndefined()
    }
    const dup = await createSession(app, bobSession, project.id, [
      { file_path: 'same.txt', size: 1 },
      { file_path: 'same.txt', size: 2 },
    ])
    expect(dup.status).toBe(409)
  })

  it('enforces declared size/count caps and anonymous denial', async () => {
    const { app, bobSession } = await setup({ maxUploadBytes: 16, maxSessionFiles: 3, maxSessionTotalBytes: 100 })
    const project = app.store.projects.byOwnerPath('bob', 'resumable')!

    expect(
      (await createSession(app, bobSession, project.id, [{ file_path: 'big.bin', size: 32 }])).status,
    ).toBe(413)
    expect(
      (
        await createSession(app, bobSession, project.id, [
          { file_path: 'a', size: 1 },
          { file_path: 'b', size: 1 },
          { file_path: 'c', size: 1 },
          { file_path: 'd', size: 1 },
        ])
      ).status,
    ).toBe(413)
    expect(
      (await createSession(app, bobSession, project.id, [{ file_path: 'x', size: 90 }, { file_path: 'y', size: 20 }])).status,
    ).toBe(413)

    const anon = await authed(app, 'POST', `/api/v1/projects/${project.id}/upload_sessions`, {
      payload: { items: [{ file_path: 'z', size: 1 }] },
    })
    expect(anon.statusCode).toBe(401)
  })

  it('applies the per-user staging quota and releases it on cancel (exhaustion guard)', async () => {
    const { app, bobSession } = await setup({ maxUserStagingBytes: 1000 })
    const project = app.store.projects.byOwnerPath('bob', 'resumable')!

    const first = await createSession(app, bobSession, project.id, [{ file_path: 'one.bin', size: 600 }])
    expect(first.status).toBe(201)
    const sidA = String(first.body.session_id)

    const overflow = await createSession(app, bobSession, project.id, [{ file_path: 'two.bin', size: 600 }])
    expect(overflow.status).toBe(413)
    expect(overflow.body.code ?? '').toBe('storage_quota_exceeded')

    await authed(app, 'DELETE', `/api/v1/projects/${project.id}/upload_sessions/${sidA}`, { session: bobSession })
    const retry = await createSession(app, bobSession, project.id, [{ file_path: 'three.bin', size: 600 }])
    expect(retry.status).toBe(201)
  })
})

describe('chunk protocol — boundaries, checksums, idempotency, attempt caps', () => {
  async function oneFileSession(app: ReturnType<typeof makeApp>, s: Session, pid: number, size: number, cs: number) {
    const path = nextPath('file')
    const created = await createSession(app, s, pid, [{ file_path: path, size }], { chunk_size: cs })
    expect(created.status).toBe(201)
    const item = (created.body.items as Array<Record<string, unknown>>)[0]!
    return { sid: String(created.body.session_id), itemId: String(item.id), path, chunkCount: Number(item.chunk_count) }
  }

  it('accepts chunks in any order with checksum verification; replays are duplicates', async () => {
    const { app, bobSession } = await setup({ minChunkSize: 8 })
    const project = app.store.projects.byOwnerPath('bob', 'resumable')!
    const { sid, itemId, chunkCount } = await oneFileSession(app, bobSession, project.id, 30, 8)
    expect(chunkCount).toBe(4)

    const c0 = Buffer.alloc(8, 1), c1 = Buffer.alloc(8, 2), c2 = Buffer.alloc(8, 3), c3 = Buffer.alloc(6, 4)
    expect((await putChunk(app, bobSession, project.id, sid, itemId, 2, c2)).status).toBe(200)

    // Wrong declared checksum → rejected, not counted.
    const badSha = await putChunk(app, bobSession, project.id, sid, itemId, 0, c0, { sha: false })
    void badSha
    const mismatch = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${project.id}/upload_sessions/${sid}/items/${itemId}/chunks/0`,
      headers: { cookie: bobSession.cookie, 'x-csrf-token': bobSession.csrf, 'content-type': 'application/octet-stream', 'x-chunk-sha256': 'f'.repeat(64) },
      payload: c0,
    })
    expect(mismatch.statusCode).toBe(422)
    expect(mismatch.json().code ?? '').toBe('chunk_checksum_mismatch')
    let map = await getChunkMap(app, bobSession, project.id, sid, itemId)
    expect(map.body.received_indices).toEqual([2])

    // Out-of-range index.
    const oor = await putChunk(app, bobSession, project.id, sid, itemId, 9, c0)
    expect(oor.status).toBe(400)

    // Correct transfers out of order, then an exact replay of chunk 2.
    expect((await putChunk(app, bobSession, project.id, sid, itemId, 0, c0, { sha: true })).status).toBe(200)
    const replay = await putChunk(app, bobSession, project.id, sid, itemId, 2, c2)
    expect(replay.status).toBe(200)
    expect(replay.body.duplicate).toBe(true)
    map = await getChunkMap(app, bobSession, project.id, sid, itemId)
    expect(map.body.received_indices).toEqual([0, 2])
    expect(map.body.received_bytes).toBe(16)
    void c1; void c3
  })

  it('violating chunk boundaries consumes attempts until the item fails permanently', async () => {
    const { app, bobSession } = await setup({ maxAttemptsPerItem: 2 })
    const project = app.store.projects.byOwnerPath('bob', 'resumable')!
    const { sid, itemId } = await oneFileSession(app, bobSession, project.id, 10, 8) // chunks [8,2]

    const wrongSize = await putChunk(app, bobSession, project.id, sid, itemId, 0, Buffer.alloc(4))
    expect(wrongSize.status).toBe(422)
    expect(wrongSize.body.code ?? '').toBe('chunk_size_mismatch')

    const fatal = await putChunk(app, bobSession, project.id, sid, itemId, 0, Buffer.alloc(5))
    expect(fatal.status).toBe(409)
    expect(fatal.body.code ?? '').toBe('too_many_attempts')

    // Even valid data is refused now — the item is terminal.
    const tooLate = await putChunk(app, bobSession, project.id, sid, itemId, 0, Buffer.alloc(8))
    expect(tooLate.status).toBe(409)
    expect(String(tooLate.body.message)).toMatch(/no longer receive/)
  })
})

describe('interruption & resume', () => {
  it('resumes an interrupted transfer from the authoritative chunk map and commits exact bytes', async () => {
    const { app, bobSession } = await setup({ minChunkSize: 8 })
    const project = app.store.projects.byOwnerPath('bob', 'resumable')!
    const path = nextPath('resume')
    const created = await createSession(app, bobSession, project.id, [{ file_path: path, size: 30 }], { chunk_size: 8 })
    const sid = String(created.body.session_id)
    const itemId = String((created.body.items as Array<Record<string, unknown>>)[0]!.id)

    // "Connection drops" after two of four chunks.
    await putChunk(app, bobSession, project.id, sid, itemId, 0, Buffer.alloc(8, 10))
    await putChunk(app, bobSession, project.id, sid, itemId, 2, Buffer.from([30, 30, 30, 30, 30, 30, 30, 30]))

    const partial = await finalize(app, bobSession, project.id, sid, { commit_message: 'premature' })
    expect(partial.status).toBe(409)
    expect(partial.body.code ?? '').toBe('session_incomplete')
    const headBefore = app.projects.storage.readBranchFiles(project.disk_path, 'main')

    // Returning client reconciles from the chunk map and sends ONLY what's missing.
    const resumeMap = await getChunkMap(app, bobSession, project.id, sid, itemId)
    expect(resumeMap.body.received_indices).toEqual([0, 2])
    await putChunk(app, bobSession, project.id, sid, itemId, 1, Buffer.alloc(8, 20))
    await putChunk(app, bobSession, project.id, sid, itemId, 3, Buffer.alloc(6, 40))

    const done = await finalize(app, bobSession, project.id, sid, { commit_message: 'resumed' })
    expect(done.status).toBe(201)
    const files = app.projects.storage.readBranchFiles(project.disk_path, 'main')
    const expected = Buffer.concat([
      Buffer.alloc(8, 10),
      Buffer.alloc(8, 20),
      Buffer.from(Array(8).fill(30)),
      Buffer.alloc(6, 40),
    ])
    expect(files.get(path)!.equals(expected)).toBe(true)
    expect(files.has('README.md')).toBe(true) // base tree preserved
    expect(headBefore.size).toBeGreaterThan(0)
  })
})

describe('bounded parallelism', () => {
  it('survives many concurrent chunk uploads across items and on the same chunk', async () => {
    const { app, bobSession } = await setup({ minChunkSize: 12 })
    const project = app.store.projects.byOwnerPath('bob', 'resumable')!

    const paths = [nextPath('p'), nextPath('p'), nextPath('p')]
    const created = await createSession(
      app,
      bobSession,
      project.id,
      paths.map((file_path) => ({ file_path, size: 24 })),
      { chunk_size: 12 }, // 2 chunks each
    )
    const sid = String(created.body.session_id)
    const items = created.body.items as Array<{ id: string }>

    // Cross-item parallelism: 3 items × 2 chunks at once.
    const jobs: Array<Promise<unknown>> = []
    items.forEach((item, iIdx) => {
      for (let cIdx = 0; cIdx < 2; cIdx++) {
        jobs.push(
          putChunk(app, bobSession, project.id, sid, item.id, cIdx, Buffer.alloc(12, iIdx * 10 + cIdx)),
        )
      }
    })
    // Same-chunk race on top.
    jobs.push(putChunk(app, bobSession, project.id, sid, items[0]!.id, 0, Buffer.alloc(12, 0)))
    jobs.push(putChunk(app, bobSession, project.id, sid, items[0]!.id, 0, Buffer.alloc(12, 0)))

    const results = await Promise.all(jobs)
    for (const r of results) expect((r as { status: number }).status).toBe(200)

    const done = await finalize(app, bobSession, project.id, sid, { commit_message: 'parallel' })
    expect(done.status).toBe(201)
    expect(done.body.committed_files).toBe(3)
    const files = app.projects.storage.readBranchFiles(project.disk_path, 'main')
    for (const p of paths) expect(files.get(p)!.length).toBe(24)
  })
})

describe('finalize — idempotency, structured failures, no partial commits', () => {
  async function readySession(
    app: ReturnType<typeof makeApp>,
    s: Session,
    count: number,
    overrides: Parameters<typeof makeApp>[0] = {},
  ) {
    const project = app.store.projects.byOwnerPath('bob', 'resumable')!
    const paths: string[] = []
    const manifest: ManifestEntry[] = []
    for (let i = 0; i < count; i++) {
      const p = nextPath('m')
      paths.push(p)
      manifest.push({ file_path: p, size: 4 })
    }
    const created = await createSession(app, s, project.id, manifest, overrides)
    const sid = String(created.body.session_id)
    const items = created.body.items as Array<{ id: string }>
    for (let i = 0; i < count; i++) {
      await putChunk(app, s, project.id, sid, items[i]!.id, 0, Buffer.from(`v${i}--`))
    }
    return { project, sid, items, paths }
  }

  it('is idempotent: replaying finalize returns the original commit without new side effects', async () => {
    const { app, bobSession } = await setup()
    const { project, sid } = await readySession(app, bobSession, 2)

    const first = await finalize(app, bobSession, project.id, sid, { commit_message: 'once' })
    expect(first.status).toBe(201)
    const sha = String(first.body.commit_sha)

    const refHead = app.projects.storage.readBranchFiles(project.disk_path, 'main')
    const second = await finalize(app, bobSession, project.id, sid, { commit_message: 'twice' })
    expect(second.status).toBe(200)
    expect(second.body.already_committed).toBe(true)
    expect(second.body.commit_sha).toBe(sha)

    // Ref did not move again; exactly one event was emitted for this session.
    expect(app.projects.storage.readBranchFiles(project.disk_path, 'main')).toEqual(refHead)
    const events = app.store.events.listForProject(project.id).filter((e) => e.type === 'repository.files_committed')
    expect(events).toHaveLength(1)
    expect(JSON.parse(String(events[0]!.payload)).session_id).toBe(sid)

    // Staging bytes were reclaimed at commit time.
    expect(existsSync(stagingDir(app, sid))).toBe(false)
  })

  it('reports STRUCTURED state when some items fail — success is never faked, nothing committed', async () => {
    const { app, bobSession } = await setup({ minChunkSize: 4 })
    const project = app.store.projects.byOwnerPath('bob', 'resumable')!
    const mainBefore = readBranchFingerprint()

    function readBranchFingerprint(): Map<string, Buffer> {
      return new Map(
        [...app.projects.storage.readBranchFiles(project.disk_path, 'main').entries()].map(([k, v]) => [k, v]),
      )
    }

    const COUNT = 500
    const manifest: ManifestEntry[] = []
    for (let i = 0; i < COUNT; i++) manifest.push({ file_path: `bulk/f-${String(i).padStart(4, '0')}.txt`, size: 4 })
    const created = await createSession(app, bobSession, project.id, manifest)
    expect(created.status).toBe(201)
    const sid = String(created.body.session_id)
    // Response is sorted by file_path — build an id map instead of positional indexing.
    const items = created.body.items as Array<{ id: string; file_path: string }>
    const idOf = new Map(items.map((it) => [it.file_path, it.id]))

    // Deliver 497 of 500 — three "fail" mid-transfer.
    const failedIdx = new Set([7, 123, 456])
    const pathOf = (i: number) => `bulk/f-${String(i).padStart(4, '0')}.txt`
    for (let i = 0; i < COUNT; i++) {
      if (failedIdx.has(i)) continue
      const res = await putChunk(app, bobSession, project.id, sid, idOf.get(pathOf(i))!, 0, Buffer.from(String(i).padStart(4, '0')))
      expect(res.status).toBe(200)
    }

    const blocked = await finalize(app, bobSession, project.id, sid, { commit_message: 'bulk' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.code ?? '').toBe('session_incomplete')
    expect(blocked.body.committed).toBe(false)
    const report = blocked.body.items as Array<Record<string, unknown>>
    expect(report).toHaveLength(3)
    expect(new Set(report.map((r) => r.file_path))).toEqual(
      new Set([pathOf(7), pathOf(123), pathOf(456)]),
    )
    for (const r of report) {
      expect(r.failure_code).toBe('incomplete_transfer')
      expect(r.received_chunks).toBe(0)
    }
    // Repository untouched by the failed finalize.
    expect(readBranchFingerprint()).toEqual(mainBefore)

    // Operator choice: exclude the three failures and ship the other 497.
    const shipped = await finalize(app, bobSession, project.id, sid, {
      commit_message: 'ship 497 of 500',
      exclude: [...failedItems],
    })
    expect(shipped.status).toBe(201)
    expect(shipped.body.committed_files).toBe(497)
    const files = app.projects.storage.readBranchFiles(project.disk_path, 'main')
    expect(files.has('bulk/f-7.txt')).toBe(false)
    expect(files.has('bulk/f-456.txt')).toBe(false)
    expect(files.get('bulk/f-0.txt')!.toString()).toBe('c0')
  }, 120_000)

  it('verifies whole-file checksums at finalize and reports mismatches structurally', async () => {
    const { app, bobSession } = await setup({ minChunkSize: 4 })
    const project = app.store.projects.byOwnerPath('bob', 'resumable')!
    const good = nextPath('good')
    const corrupt = nextPath('corrupt')
    // Both items are 4 bytes; the second lies about its content checksum.
    const created = await createSession(app, bobSession, project.id, [
      { file_path: good, size: 4, sha256: sha256('ok--') },
      { file_path: corrupt, size: 4, sha256: sha256('want') },
    ])
    const sid = String(created.body.session_id)
    // Items are listed in file_path order — address them by path, never position.
    const byPath = Object.fromEntries(
      (created.body.items as Array<{ id: string; file_path: string }>).map((i) => [i.file_path, i.id]),
    )
    await putChunk(app, bobSession, project.id, sid, byPath[good]!, 0, Buffer.from('ok--'))
    await putChunk(app, bobSession, project.id, sid, byPath[corrupt]!, 0, Buffer.from('got!'))

    const blocked = await finalize(app, bobSession, project.id, sid, { commit_message: 'verify me' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.code ?? '').toBe('session_incomplete')
    const report = blocked.body.items as Array<Record<string, unknown>>
    expect(report).toHaveLength(1)
    expect(report[0]).toMatchObject({ file_path: corrupt, failure_code: 'sha256_mismatch' })
    // The honest file did NOT sneak into the repository either — all-or-nothing.
    const files = app.projects.storage.readBranchFiles(project.disk_path, 'main')
    expect(files.has(good)).toBe(false)
  })

  it('honors protected branches and lets the same session re-route to a branch', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'resumable')!
    await authed(app, 'PUT', `/api/v1/projects/${project.id}/protected_branches`, {
      session: bobSession,
      payload: { name: 'main', push_access_level: 'no_one' },
    })
    const mainRef = join(app.cfg.repositoriesRoot, project.disk_path, 'refs', 'heads', 'main')
    const mainBefore = existsSync(mainRef) ? (await import('node:fs')).readFileSync(mainRef, 'utf8').trim() : null

    const { sid } = await readySession(app, bobSession, 1)

    const blocked = await finalize(app, bobSession, project.id, sid, { commit_message: 'to main' })
    expect(blocked.status).toBe(403)
    expect(blocked.body.code ?? '').toBe('protected_branch')
    // Ref untouched — the denial happened before any git mutation.
    expect(existsSync(mainRef) ? (await import('node:fs')).readFileSync(mainRef, 'utf8').trim() : null).toBe(mainBefore)

    // Same staged session reroutes onto an unprotected branch without restaging.
    const rerouted = await finalize(app, bobSession, project.id, sid, {
      new_branch: 'feature/import',
      start_branch: 'main',
      commit_message: 'branch instead',
    })
    expect(rerouted.status).toBe(201)
    expect(rerouted.body.branch).toBe('feature/import')
  })

  it('rejects empty results (all-identical replace)', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'resumable')!
    const readme = app.projects.storage.readBranchFiles(project.disk_path, 'main').get('README.md')!.toString('utf8')
    const created = await createSession(app, bobSession, project.id, [
      { file_path: 'README.md', size: Buffer.byteLength(readme), sha256: sha256(readme) },
    ])
    const sid = String(created.body.session_id)
    const itemId = String((created.body.items as Array<Record<string, unknown>>)[0]!.id)
    await putChunk(app, bobSession, project.id, sid, itemId, 0, Buffer.from(readme, 'utf8'))
    const res = await finalize(app, bobSession, project.id, sid, { commit_message: 'noop', replace: true })
    expect(res.status).toBe(400)
    expect(res.body.code ?? '').toBe('empty_commit')
  })
})

describe('access control', () => {
  it('isolates sessions per user across every verb; admin may act', async () => {
    const { app, aliceSession, bobSession, charlieSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'resumable')!
    const created = await createSession(app, bobSession, project.id, [{ file_path: 'own.txt', size: 4 }])
    const sid = String(created.body.session_id)
    const itemId = String((created.body.items as Array<Record<string, unknown>>)[0]!.id)

    // Charlie cannot even learn the session exists…
    expect((await authed(app, 'GET', `/api/v1/projects/${project.id}/upload_sessions/${sid}`, { session: charlieSession })).statusCode).toBe(403)
    expect(
      (
        await putChunk(app, charlieSession, project.id, sid, itemId, 0, Buffer.from('xxxx'))
      ).status,
    ).toBe(403)
    expect(
      (await authed(app, 'POST', `/api/v1/projects/${project.id}/upload_sessions/${sid}/finalize`, { session: charlieSession, payload: { commit_message: 'steal' } })).statusCode,
    ).toBe(403)
    expect((await authed(app, 'DELETE', `/api/v1/projects/${project.id}/upload_sessions/${sid}`, { session: charlieSession })).statusCode).toBe(403)

    // …and nothing leaked into bob's staging.
    const ownerMap = await getChunkMap(app, bobSession, project.id, sid, itemId)
    expect(ownerMap.body.received_indices).toEqual([])

    // Instance admin can operate bob's session (central authz parity).
    const adminPut = await putChunk(app, aliceSession, project.id, sid, itemId, 0, Buffer.from('data'))
    expect(adminPut.status).toBe(200)
  })
})

describe('expiration & abandoned-session cleanup', () => {
  function backdate(app: ReturnType<typeof makeApp>, sid: string): void {
    app.store.db.run(
      'UPDATE upload_sessions SET expires_at = ? WHERE id = ?',
      new Date(Date.now() - 60_000).toISOString(),
      sid,
    )
  }

  it('lazily expires due sessions on access: 410, staging discarded, transfers refused', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'resumable')!
    const created = await createSession(app, bobSession, project.id, [{ file_path: 'late.txt', size: 4 }])
    const sid = String(created.body.session_id)
    const itemId = String((created.body.items as Array<Record<string, unknown>>)[0]!.id)
    backdate(app, sid)

    const status = await authed(app, 'GET', `/api/v1/projects/${project.id}/upload_sessions/${sid}`, { session: bobSession })
    expect(status.statusCode).toBe(410)
    expect(status.json().code ?? '').toBe('session_expired')
    expect(existsSync(stagingDir(app, sid))).toBe(false)

    // After the lazy expiry the session is terminal — later ops see session_closed.
    const latePut = await putChunk(app, bobSession, project.id, sid, itemId, 0, Buffer.from('late'))
    expect(latePut.status).toBe(409)
    expect(latePut.body.code ?? '').toBe('session_closed')
    const lateFinalize = await finalize(app, bobSession, project.id, sid, { commit_message: 'ghost' })
    expect(lateFinalize.status).toBe(409)
  })

  it('purgeAbandoned expires past-TTL sessions and removes orphan staging directories', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'resumable')!
    const created = await createSession(app, bobSession, project.id, [{ file_path: 'gone.txt', size: 4 }])
    const sid = String(created.body.session_id)
    backdate(app, sid)

    // A crashed process could leave a directory with no DB row behind.
    const orphan = join(app.cfg.uploadsRoot, 'resumable', randomUUID())
    mkdirSync(orphan, { recursive: true })

    const report = app.uploadSessions.purgeAbandoned()
    expect(report.expiredSessions).toBeGreaterThanOrEqual(1)
    expect(report.orphanDirs).toBeGreaterThanOrEqual(1)
    expect(existsSync(stagingDir(app, sid))).toBe(false)
    expect(existsSync(orphan)).toBe(false)

    const row = app.store.uploadSessions.byId(sid)!
    expect(row.state).toBe('expired')
  })

  it('cancel discards staging immediately and makes further transfer impossible', async () => {
    const { app, bobSession } = await setup()
    const project = app.store.projects.byOwnerPath('bob', 'resumable')!
    const created = await createSession(app, bobSession, project.id, [{ file_path: 'doomed.txt', size: 4 }])
    const sid = String(created.body.session_id)
    const itemId = String((created.body.items as Array<Record<string, unknown>>)[0]!.id)
    await putChunk(app, bobSession, project.id, sid, itemId, 0, Buffer.from('bye!'))

    await authed(app, 'DELETE', `/api/v1/projects/${project.id}/upload_sessions/${sid}`, { session: bobSession })
    expect(existsSync(stagingDir(app, sid))).toBe(false)

    const zombie = await putChunk(app, bobSession, project.id, sid, itemId, 0, Buffer.from('again'))
    expect(zombie.status).toBe(409)
    expect(zombie.body.code ?? '').toBe('session_closed')
  })
})
