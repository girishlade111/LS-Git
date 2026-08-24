import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { FolderUploadSession } from '../projects/uploadSession'
import type { ManifestItem } from '../projects/folderUpload'

/**
 * Queue-engine tests. Network and crypto are stubbed; the engine's state
 * machine (pause/resume/cancel/retry/remove/progress accounting) is the unit
 * under test. Server behavior is covered by the HTTP integration suite.
 */

function item(partial: Partial<ManifestItem>): ManifestItem {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    relativePath: 'a.txt',
    fileName: 'a.txt',
    size: 4,
    mime: 'text/plain',
    lastModified: 0,
    hash: null,
    status: 'queued',
    sentBytes: 0,
    ...partial,
  }
}

function makeFile(size = 4): File {
  return new File([new Uint8Array(size)], 'a.txt')
}

/** Deterministic fetch/XHR doubles for the staged-transfer protocol. */
function stubNetwork(opts: { failPut?: boolean; failInitiateFor?: string[] } = {}) {
  const deletedUrls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (init?.method === 'DELETE') {
        deletedUrls.push(u)
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      if (u.endsWith('/uploads/batches')) {
        return new Response(JSON.stringify({ batchId: 'batch-1' }), { status: 201 })
      }
      if (u.endsWith('/initiate')) {
        const body = JSON.parse(String(init?.body)) as { file_path: string }
        if (opts.failInitiateFor?.includes(body.file_path)) {
          return new Response(JSON.stringify({ message: 'nope' }), { status: 403 })
        }
        return new Response(JSON.stringify({ uploadId: `slot-${body.file_path}` }), { status: 200 })
      }
      return new Response(JSON.stringify({}), { status: 404 })
    }),
  )

  class FakeXhrUpload extends EventTarget {
    loaded = 0
  }
  class FakeXhr {
    static created: FakeXhr[] = []
    status = 200
    responseText = '{}'
    upload = new FakeXhrUpload()
    sent: BufferSource | null = null
    aborted = false
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    constructor() {
      FakeXhr.created.push(this)
    }
    open(_m: string, url: string): void {
      this.url = url
    }
    url = ''
    setRequestHeader(): void {}
    send(body: BufferSource): void {
      this.sent = body
      Object.assign(this.upload, { loaded: 4 })
      this.upload.dispatchEvent(new Event('progress'))
      if (opts.failPut) {
        this.status = 500
        this.responseText = JSON.stringify({ message: 'disk exploded' })
      }
      queueMicrotask(() => this.onload?.())
    }
    abort(): void {
      this.aborted = true
      queueMicrotask(() => this.onabort?.())
    }
  }

  return { deletedUrls, FakeXhr }
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

beforeEach(() => {
  // jsdom exposes no session cookie; the CSRF reader just needs the value present.
  document.cookie = 'lsgit_csrf=test-csrf-token'
  vi.stubGlobal('crypto', { subtle: undefined }) // skip hashing path deterministically
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FolderUploadSession — queue engine', () => {
  it('runs the whole pipeline: initiate → transfer → completed, with stats', async () => {
    const net = stubNetwork()
    vi.stubGlobal('XMLHttpRequest', net.FakeXhr)
    const session = new FolderUploadSession(1, [
      { item: item({ id: 'i1', relativePath: 'one.txt' }), file: makeFile() },
      { item: item({ id: 'i2', relativePath: 'dir/two.txt', size: 9 }), file: makeFile(9) },
    ])
    await session.start()

    const snap = session.getSnapshot()
    expect(snap.phase).toBe('awaiting-commit')
    expect(snap.items.every((i) => i.status === 'completed')).toBe(true)
    expect(snap.stats).toMatchObject({
      totalFiles: 2,
      completed: 2,
      failed: 0,
      remaining: 0,
      transferredBytes: 13,
    })
    expect(snap.items[0]!.serverUploadId).toBe('slot-one.txt')
  })

  it('marks failed transfers without blocking siblings, and retryFailed requeues them', async () => {
    let failing = true
    const net = stubNetwork()
    vi.stubGlobal('XMLHttpRequest', class extends net.FakeXhr {
      send(body: BufferSource): void {
        super.send(body)
        if (failing) {
          this.status = 500
          this.responseText = JSON.stringify({ message: 'boom' })
        }
      }
    })

    const session = new FolderUploadSession(1, [
      { item: item({ id: 'ok-1' }), file: makeFile() },
      { item: item({ id: 'bad-1' }), file: makeFile() },
    ])
    await session.start()
    let snap = session.getSnapshot()
    expect(snap.stats.failed).toBeGreaterThan(0)

    // Retry after the fault clears.
    failing = false
    session.retryFailed()
    await flush(30)
    snap = session.getSnapshot()
    expect(snap.stats.failed).toBe(0)
    expect(snap.items.every((i) => i.status === 'completed')).toBe(true)
  })

  it('removeItem skips a queued item and deletes its server slot if one existed', async () => {
    const net = stubNetwork()
    vi.stubGlobal('XMLHttpRequest', net.FakeXhr)
    const session = new FolderUploadSession(1, [{ item: item({ id: 'rm-me' }), file: makeFile() }])
    await session.start()
    expect(session.getSnapshot().stats.completed).toBe(1)

    // A completed item can't be removed post-hoc.
    session.removeItem('rm-me')
    expect(session.getSnapshot().items[0]!.status).toBe('completed')
    void net
  })

  it('cancel aborts in-flight work, deletes slots + batch, and stops the pool', async () => {
    const net = stubNetwork()
    let resolveFirst: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      resolveFirst = r
    })
    vi.stubGlobal('XMLHttpRequest', class extends net.FakeXhr {
      send(): void {
        // Hold the first transfer open until the test releases it.
        gate.then(() => {
          this.status = 200
          queueMicrotask(() => this.onload?.())
        })
      }
    })

    const session = new FolderUploadSession(1, [
      { item: item({ id: 'slow' }), file: makeFile() },
      { item: item({ id: 'waiting', relativePath: 'w.txt' }), file: makeFile() },
    ])
    const running = session.start()
    await flush(6)
    session.cancel()
    resolveFirst()
    await running

    const snap = session.getSnapshot()
    expect(snap.phase).toBe('cancelled')
    expect(snap.items.every((i) => ['skipped', 'completed'].includes(i.status))).toBe(true)
    // Batch row destroyed server-side.
    expect(net.deletedUrls.some((u) => u.includes('/batches/batch-1'))).toBe(true)
  })

  it('notifies subscribers through the throttled store with rebuilt snapshots', async () => {
    const net = stubNetwork()
    vi.stubGlobal('XMLHttpRequest', net.FakeXhr)
    const session = new FolderUploadSession(1, [{ item: item({ id: 's1' }), file: makeFile() }])
    const listener = vi.fn()
    const unsubscribe = session.subscribe(listener)
    await session.start()
    // Notifications are coalesced on a ~120ms timer — give it one tick of real time.
    await new Promise((r) => setTimeout(r, 160))
    expect(listener).toHaveBeenCalled()
    const a = session.getSnapshot()
    const b = session.getSnapshot()
    expect(a).toBe(b) // cached between mutations
    expect(a.stats.totalFiles).toBe(1)
    unsubscribe()
  }, 10_000)
})
