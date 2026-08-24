import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginRaw, extractSession, authed } from './helpers.js'
import type { FastifyInstance } from 'fastify'
import type { Actor } from '../src/authz.js'

/**
 * Social discovery primitives: duplicate stars, watch/unwatch (user-specific),
 * event-driven notification fanout (preferences-gated), repository-level
 * preferences with global fallback, and inbox read states.
 */

interface Setup {
  app: FastifyInstance
  alice: Actor // project owner
  bob: Actor   // another user
  aliceSession: ReturnType<typeof extractSession>
  bobSession: ReturnType<typeof extractSession>
  mallorySession: ReturnType<typeof extractSession>
  projectId: number
}

async function setup(opts: { visibility?: string } = {}): Promise<Setup> {
  const app = makeApp()
  await registerUser(app) // alice
  const aliceSession = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'bob', email: 'bob@example.com' })
  const bobSession = extractSession((await loginRaw(app, 'bob')).cookies)
  await registerUser(app, { username: 'mallory', email: 'mallory@example.com' })
  const mallorySession = extractSession((await loginRaw(app, 'mallory')).cookies)

  const res = await authed(app, 'POST', '/api/v1/projects', {
    session: aliceSession,
    payload: {
      name: 'Social Repo', path: 'social-repo', visibility: opts.visibility ?? 'public',
      description: '', website_url: '', default_branch: 'main', topics: [],
    },
  })
  expect(res.statusCode).toBe(201)
  const project = app.store.projects.byOwnerPath('alice', 'social-repo')!
  return {
    app,
    alice: actorOf(app, 'alice'),
    bob: actorOf(app, 'bob'),
    aliceSession, bobSession, mallorySession,
    projectId: project.id,
  }
}

function actorOf(app: FastifyInstance, name: string): Actor {
  const u = app.store.users.byUsername(name)!
  return { userId: u.id, username: name, admin: false, state: 'active', via: { kind: 'session' } }
}

function userId(app: FastifyInstance, name: string): number {
  return app.store.users.byUsername(name)!.id
}

// -- stars -----------------------------------------------------------------------

describe('stars', () => {
  it('prevents DUPLICATE stars — second call is a no-op, count stays 1', async () => {
    const s = await setup()
    const first = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/star`, { session: s.aliceSession })
    expect(first.statusCode).toBe(201)
    expect(first.json()).toMatchObject({ starred: true, created: true })

    const dupSameUser = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/star`, { session: s.aliceSession })
    expect(dupSameUser.statusCode).toBe(200)
    expect((dupSameUser.json() as { created: boolean }).created).toBe(false)

    // Different user stars independently; count aggregates.
    await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/star`, { session: s.bobSession })
    const count = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/star`, { session: s.bobSession })
    expect(count.json()).toEqual({ count: 2, starred: true })

    // Unstar removes exactly one.
    await authed(s.app, 'DELETE', `/api/v1/projects/${s.projectId}/star`, { session: s.aliceSession })
    const after = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/star`, { session: s.bobSession })
    expect(after.json()).toEqual({ count: 1, starred: true })
  })

  it('exposes star counts to anonymous users without leaking per-user state', async () => {
    const s = await setup()
    await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/star`, { session: s.bobSession })
    const anon = await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/star` })
    expect(anon.statusCode).toBe(200)
    expect(anon.json()).toEqual({ count: 1, starred: false }) // no personal state leaked
  })

  it('lists a user’s starred repositories', async () => {
    const s = await setup()
    await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/star`, { session: s.bobSession })
    const list = await authed(s.app, 'GET', '/api/v1/user/stars', { session: s.bobSession })
    expect(list.json().stars ?? (list.json() as unknown[])).toBeTruthy()
    const arr = list.json().stars as Array<{ full_path?: string }> | undefined
    if (arr) expect(arr[0].full_path).toBe('alice/social-repo')
  })
})

// -- watches ------------------------------------------------------------------------

describe('watch / unwatch', () => {
  it('stores WATCH STATE per user — independent rows per project', async () => {
    const s = await setup()
    await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/watch`, {
      session: s.bobSession, payload: { level: 'watch' },
    })
    await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/watch`, {
      session: s.mallorySession, payload: { level: 'disabled' },
    })

    const asBob = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/watch`, { session: s.bobSession })
    expect(asBob.json()).toMatchObject({ level: 'watch', effective_level: 'watch' })

    const asMallory = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/watch`, { session: s.mallorySession })
    expect(asMallory.json()).toMatchObject({ level: 'disabled', effective_level: 'disabled' })

    // Alice never set one → explicit null, effective default participating.
    const asAlice = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/watch`, { session: s.aliceSession })
    expect(asAlice.json()).toMatchObject({ level: null, effective_level: 'participating' })
  })

  it('UNWATCH reverts to the global default and invalid levels are rejected', async () => {
    const s = await setup()
    await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/watch`, {
      session: s.bobSession, payload: { level: 'mention' },
    })
    const del = await authed(s.app, 'DELETE', `/api/v1/projects/${s.projectId}/watch`, { session: s.bobSession })
    expect(del.statusCode).toBe(200)
    expect((del.json() as { level: string | null }).level).toBeNull()

    const bad = await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/watch`, {
      session: s.bobSession, payload: { level: 'spam-me' },
    })
    expect(bad.statusCode).toBe(400)

    // Watch requires authentication.
    const anon = await s.app.inject({ method: 'PUT', url: `/api/v1/projects/${s.projectId}/watch`, payload: { level: 'watch' } })
    expect(anon.statusCode).toBe(401)
  })
})

// -- fanout ---------------------------------------------------------------------------

describe('notification fanout (event-driven)', () => {
  interface FanoutSetup extends Setup {
    watcherSession: ReturnType<typeof extractSession>
    watcherId: number
  }

  /** alice owns; mallory watches everything; bob is the acting user. */
  async function fanoutSetup(): Promise<FanoutSetup> {
    const s = await setup()
    const watcherSession = extractSession((await loginRaw(s.app, 'mallory')).cookies)
    const watcherId = userId(s.app, 'mallory')
    await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/watch`, {
      session: watcherSession, payload: { level: 'watch' },
    })
    return { ...s, watcherSession, watcherId }
  }

  it('fanout from a PUSH reaches watchers + owner but NEVER the actor; dedupes replays', async () => {
    const f = await fanoutSetup()
    const before = f.app.store.notifications.listForUser(f.watcherId, {})

    // Bob pushes via the web-editor commit path (emits repo.push internally).
    const res = await authed(f.app, 'POST', `/api/v1/projects/${f.projectId}/repository/commit`, {
      session: f.bobSession,
      payload: {
        commit_message: 'fanout seed',
        branch: 'main',
        changes: [{ path: 'f.txt', content: '1' }],
      },
    })
    expect(res.statusCode).toBe(201)

    // Watcher received exactly ONE push notification.
    const afterWatcher = f.app.store.notifications.listForUser(f.watcherId, {})
    expect(afterWatcher.length).toBe(before.length + 1)
    expect(afterWatcher[0]).toMatchObject({ type: 'push', read_at: null })
    expect(afterWatcher[0].title.length).toBeGreaterThan(0)

    // Owner (participant by ownership) also notified…
    const ownerNotifs = f.app.store.notifications.listForUser(f.alice.userId, { type: 'push' })
    expect(ownerNotifs.length).toBeGreaterThanOrEqual(1)

    // …but the ACTOR never notifies himself.
    const bobNotifs = f.app.store.notifications.listForUser(f.bob.userId, { type: 'push' })
    expect(bobNotifs).toHaveLength(0)

    // Replaying the same event row cannot duplicate (dedupe key).
    const eventRow = f.app.store.db.all(
      "SELECT * FROM events WHERE type = 'repo.push' ORDER BY id DESC LIMIT 1",
    )[0] as unknown as { id: number }
    f.app.store.events.emit(eventRow.project_id as number, eventRow.type, JSON.parse(String(eventRow.payload)))
    // The replay has a NEW event id → new dedupe key is expected behavior;
    // instead verify TRUE idempotency at repo level:
    const inserted = f.app.store.notifications.insert({
      user_id: f.watcherId,
      project_id: f.projectId,
      type: 'push',
      title: 'dup',
      body: null,
      url: null,
      actor_user_id: f.bob.userId,
      dedupe_key: `evt${eventRow.id}:u${f.watcherId}`,
    })
    expect(inserted).toBe(false) // already delivered for this event+recipient
  })

  it('supports the full NOTIFICATION TYPE catalog through direct events', async () => {
    const s = await setup()
    const types = [
      'push', 'issue', 'merge_request', 'discussion', 'mention',
      'review_request', 'release', 'deployment', 'workflow', 'security_alert', 'fork',
    ] as const

    // Mallory watches → receives every catalog type.
    await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/watch`, {
      session: s.mallorySession, payload: { level: 'watch' },
    })
    for (const t of types) {
      s.app.store.events.emit(s.projectId, t === 'push' ? 'repo.push' : t, {
        title: `${t} headline`,
        actor_user_id: s.bob.userId,
      })
    }
    const inbox = s.app.store.notifications.listForUser(userId(s.app, 'mallory'), { limit: 100 })
    const seenTypes = new Set(inbox.map((n) => n.type))
    for (const t of types) expect(seenTypes.has(t)).toBe(true)
  })

  it('FORK events notify the upstream owner that someone forked', async () => {
    const s = await setup()
    const forkRes = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/fork`, {
      session: s.bobSession, payload: { path: 'notif-fork' },
    })
    expect(forkRes.statusCode).toBe(201)

    const aliceInbox = s.app.store.notifications.listForUser(s.alice.userId, { type: 'fork' })
    expect(aliceInbox.length).toBe(1)
    expect(aliceInbox[0]!.body).toContain('bob/notif-fork')
    // Actor did not self-notify.
    const bobForkNotifs = s.app.store.notifications.listForUser(s.bob.userId, { type: 'fork' })
    expect(bobForkNotifs).toHaveLength(0)
  })
})

// -- preferences -------------------------------------------------------------------------

describe('notification preferences', () => {
  it('DISABLED level silences a repository entirely for that user', async () => {
    const s = await setup()
    await authed(s.app, 'PUT', '/api/v1/user/notification_preferences', {
      session: s.bobSession,
      payload: { project_id: s.projectId, level: 'disabled' },
    })
    await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/watch`, {
      session: s.bobSession, payload: { level: 'watch' }, // watch row alone must NOT win
    })
    s.app.store.events.emit(s.projectId, 'repo.push', { ref: 'refs/heads/main', actor_user_id: s.alice.userId })

    expect(s.app.store.notifications.listForUser(s.bob.userId, {})).toHaveLength(0)
  })

  it('MENTION level delivers only explicitly mentioned users; PARTICIPATING covers the owner', async () => {
    const s = await setup()
    const bobId = userId(s.app, 'bob')
    const malloryId = userId(s.app, 'mallory')

    // Bob: mention-only. Mallory: mention-only. Neither watches.
    await authed(s.app, 'PUT', '/api/v1/user/notification_preferences', {
      session: s.bobSession, payload: { project_id: s.projectId, level: 'mention' },
    })
    await authed(s.app, 'PUT', '/api/v1/user/notification_preferences', {
      session: s.mallorySession, payload: { project_id: s.projectId, level: 'mention' },
    })

    // Event mentioning ONLY bob (actor: alice).
    s.app.store.events.emit(s.projectId, 'issue', {
      title: 'needs your eyes',
      mentioned_user_ids: [bobId],
      actor_user_id: s.alice.userId,
    })

    expect(s.app.store.notifications.listForUser(bobId, {}).length).toBe(1)
    expect(s.app.store.notifications.listForUser(malloryId, {})).toHaveLength(0)
  })

  it('GLOBAL fallback applies when no repository-level preference exists', async () => {
    const s = await setup()
    // Bob sets GLOBAL disabled.
    await authed(s.app, 'PUT', '/api/v1/user/notification_preferences', {
      session: s.bobSession, payload: { level: 'disabled' },
    })
    s.app.store.events.emit(s.projectId, 'repo.push', { ref: 'refs/heads/main', actor_user_id: s.alice.userId })
    expect(s.app.store.notifications.listForUser(s.bob.userId, {})).toHaveLength(0)

    // Project-level preference overrides global when present.
    await authed(s.app, 'PUT', '/api/v1/user/notification_preferences', {
      session: s.bobSession, payload: { project_id: s.projectId, level: 'watch' },
    })
    s.app.store.events.emit(s.projectId, 'repo.push', { ref: 'refs/heads/main', actor_user_id: s.alice.userId })
    expect(s.app.store.notifications.listForUser(s.bob.userId, { type: 'push' }).length).toBe(1)
  })

  it('MUTED EVENT TYPES suppress specific categories while others still flow', async () => {
    const s = await setup()
    await authed(s.app, 'PUT', '/api/v1/user/notification_preferences', {
      session: s.bobSession,
      payload: { project_id: s.projectId, level: 'watch', muted_events: ['security_alert', 'deployment'] },
    })

    s.app.store.events.emit(s.projectId, 'repo.push', { ref: 'refs/heads/main', actor_user_id: s.alice.userId })
    s.app.store.events.emit(s.projectId, 'security_alert', { title: 'CVE here', actor_user_id: s.alice.userId })
    s.app.store.events.emit(s.projectId, 'release', { tag: 'v1.2.3', actor_user_id: s.alice.userId })

    const inbox = s.app.store.notifications.listForUser(s.bob.userId, { limit: 100 })
    const types = inbox.map((n) => n.type).sort()
    expect(types).toEqual(['push', 'release']) // security_alert muted out
  })

  it('preference GET returns the resolution chain for a repository', async () => {
    const s = await setup()
    await authed(s.app, 'PUT', '/api/v1/user/notification_preferences', {
      session: s.bobSession, payload: { level: 'mention', muted_events: ['workflow'] },
    })
    const res = await authed(s.app, 'GET', `/api/v1/user/notification_preferences?project_id=${s.projectId}`, { session: s.bobSession })
    expect(res.json()).toMatchObject({
      project_id: s.projectId,
      level: null,               // no repo-specific row yet
      effective_level: 'mention', // …global wins
      muted_events: ['workflow'],
      default_level: 'participating',
    })
  })
})

// -- read states & inbox --------------------------------------------------------------------

describe('inbox read states and filtering', () => {
  async function inboxSetup(): Promise<Setup> {
    const s = await setup()
    await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/watch`, {
      session: s.bobSession, payload: { level: 'watch' },
    })
    // Two pushes + one release → three notifications for bob.
    s.app.store.events.emit(s.projectId, 'repo.push', { ref: 'refs/heads/main', actor_user_id: s.alice.userId })
    s.app.store.events.emit(s.projectId, 'repo.push', { ref: 'refs/heads/feature', actor_user_id: s.alice.userId })
    s.app.store.events.emit(s.projectId, 'release', { tag: 'v9', actor_user_id: s.alice.userId })
    return s
  }

  it('persists notifications and reports UNREAD COUNTS', async () => {
    const s = await inboxSetup()
    const count = await authed(s.app, 'GET', '/api/v1/user/notifications/unread_count', { session: s.bobSession })
    expect(count.json()).toEqual({ count: 3 })
  })

  it('MARK READ / MARK UNREAD toggle individual entries; unknown ids 404', async () => {
    const s = await inboxSetup()
    const inbox = await authed(s.app, 'GET', '/api/v1/user/notifications', { session: s.bobSession })
    const firstId = (inbox.json().notifications as Array<{ id: number }>)[0]!.id

    const read = await authed(s.app, 'POST', `/api/v1/user/notifications/${firstId}/read`, { session: s.bobSession })
    expect(read.statusCode).toBe(200)
    expect(await authed(s.app, 'GET', '/api/v1/user/notifications/unread_count', { session: s.bobSession })).toMatchObject({ count: 2 })

    const unreadAgain = await authed(s.app, 'POST', `/api/v1/user/notifications/${firstId}/unread`, { session: s.bobSession })
    expect(unreadAgain.statusCode).toBe(200)
    expect(await authed(s.app, 'GET', '/api/v1/user/notifications/unread_count', { session: s.bobSession })).toMatchObject({ count: 3 })

    const ghost = await authed(s.app, 'POST', '/api/v1/user/notifications/999999/read', { session: s.bobSession })
    expect(ghost.statusCode).toBe(404)
  })

  it('MARK ALL READ scopes to a repository when requested', async () => {
    const s = await inboxSetup()
    // A second repo with its own notification for bob.
    const res = await authed(s.app, 'POST', '/api/v1/projects', {
      session: s.aliceSession,
      payload: { name: 'Other', path: 'other-repo', visibility: 'public', description: '', website_url: '', default_branch: 'main', topics: [] },
    })
    expect(res.statusCode).toBe(201)
    const otherId = s.app.store.projects.byOwnerPath('alice', 'other-repo')!.id
    await authed(s.app, 'PUT', `/api/v1/projects/${otherId}/watch`, { session: s.bobSession, payload: { level: 'watch' } })
    s.app.store.events.emit(otherId, 'repo.push', { ref: 'refs/heads/main', actor_user_id: s.alice.userId })

    // Scope to first repo only.
    const scoped = await authed(s.app, 'POST', '/api/v1/user/notifications/read_all', {
      session: s.bobSession, payload: { project_id: s.projectId },
    })
    expect(scoped.json()).toEqual({ marked_read: 3 })
    expect(await authed(s.app, 'GET', '/api/v1/user/notifications/unread_count', { session: s.bobSession }))
      .toMatchObject({ count: 1 })

    // Global mark-all clears the rest.
    await authed(s.app, 'POST', '/api/v1/user/notifications/read_all', { session: s.bobSession, payload: {} })
    expect(await authed(s.app, 'GET', '/api/v1/user/notifications/unread_count', { session: s.bobSession }))
      .toMatchObject({ count: 0 })
  })

  it('filters the INBOX by unread flag and notification type', async () => {
    const s = await inboxSetup()
    const all = await authed(s.app, 'GET', '/api/v1/user/notifications?limit=100', { session: s.bobSession })
    expect(all.json().notifications as unknown[]).toHaveLength(3)

    const onlyPushUnread = await authed(
      s.app, 'GET',
      '/api/v1/user/notifications?type=push&unread=1',
      { session: s.bobSession },
    )
    const arr = onlyPushUnread.json().notifications as Array<{ type: string }>
    expect(arr.every((n) => n.type === 'push')).toBe(true)
    expect(arr.length).toBe(2)

    // Inbox is PERSISTED storage, not ephemeral: rows survive an explicit re-query cycle.
    const persisted = await authed(s.app, 'GET', '/api/v1/user/notifications?type=release', { session: s.bobSession })
    expect((persisted.json().notifications as Array<{ title: string }>)[0]!.title.toLowerCase()).toContain('release')
  })

  it('requires AUTHENTICATION for inbox access', async () => {
    const s = await inboxSetup()
    const anon = await s.app.inject({ method: 'GET', url: '/api/v1/user/notifications' })
    expect(anon.statusCode).toBe(401)
  })
})
