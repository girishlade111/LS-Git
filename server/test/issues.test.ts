import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginRaw, extractSession, authed } from './helpers.js'
import type { FastifyInstance } from 'fastify'
import type { Actor } from '../src/authz.js'

/**
 * Issue lifecycle: creation (per-project iid), updates, state transitions,
 * deletion, activity timeline (system notes), comments, mentions,
 * cross-references, reactions and Markdown task lists.
 */

interface Setup {
  app: FastifyInstance
  projectId: number
  aliceSession: ReturnType<typeof extractSession> // owner
  bobSession: ReturnType<typeof extractSession>
}

async function setup(opts: { visibility?: string } = {}): Promise<Setup> {
  const app = makeApp()
  await registerUser(app)
  const aliceSession = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'bob', email: 'bob@example.com' })
  const bobSession = extractSession((await loginRaw(app, 'bob')).cookies)
  const res = await authed(app, 'POST', '/api/v1/projects', {
    session: aliceSession,
    payload: {
      name: 'Issue Repo', path: 'issue-repo', visibility: opts.visibility ?? 'public',
      description: '', website_url: '', default_branch: 'main', topics: [],
    },
  })
  expect(res.statusCode).toBe(201)
  return { app, projectId: app.store.projects.byOwnerPath('alice', 'issue-repo')!.id, aliceSession, bobSession }
}

function actorOf(app: FastifyInstance, name: string): Actor {
  const u = app.store.users.byUsername(name)!
  return { userId: u.id, username: name, admin: false, state: 'active', via: { kind: 'session' } }
}

async function createIssue(
  app: FastifyInstance,
  session: ReturnType<typeof extractSession>,
  projectId: number,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await authed(app, 'POST', `/api/v1/projects/${projectId}/issues`, { session, payload })
  return { status: res.statusCode, body: res.json() }
}

// -- creation & iid --------------------------------------------------------------

describe('issue creation', () => {
  it('assigns sequential PER-PROJECT iids starting at 1', async () => {
    const s = await setup()
    const a = await createIssue(s.app, s.aliceSession, s.projectId, { title: 'First bug' })
    expect(a.status).toBe(201)
    expect(a.body.iid).toBe(1)
    expect(a.body.state).toBe('opened')
    expect((a.body.author as Record<string, unknown>).username).toBe('alice')

    const b = await createIssue(s.app, s.aliceSession, s.projectId, { title: 'Second bug' })
    expect(b.body.iid).toBe(2)

    // A second project restarts its own sequence.
    const res2 = await authed(s.app, 'POST', '/api/v1/projects', {
      session: s.bobSession,
      payload: { name: 'Other', path: 'other', visibility: 'public', description: '', website_url: '', default_branch: 'main', topics: [] },
    })
    expect(res2.statusCode).toBe(201)
    const otherProject = s.app.store.projects.byOwnerPath('bob', 'other')!
    const c = await createIssue(s.app, s.bobSession, otherProject.id, { title: 'Fresh counter' })
    expect(c.body.iid).toBe(1)
    // Global ids differ even when iids collide.
    expect(a.body.id).not.toBe(c.body.id)
  })

  it('rejects empty titles and overlong titles with 400', async () => {
    const s = await setup()
    expect((await createIssue(s.app, s.aliceSession, s.projectId, { title: '' })).status).toBe(400)
    expect((await createIssue(s.app, s.aliceSession, s.projectId, {})).status).toBe(400)
    expect((await createIssue(s.app, s.aliceSession, s.projectId, { title: 'x'.repeat(256) })).status).toBe(400)
  })

  it('records multiple assignees as a relation', async () => {
    const s = await setup()
    const bobId = s.app.store.users.byUsername('bob')!.id
    const aliceId = s.app.store.users.byUsername('alice')!.id
    const r = await createIssue(s.app, s.aliceSession, s.projectId, {
      title: 'Shared work',
      assignee_ids: [aliceId, bobId],
    })
    expect(r.status).toBe(201)
    const usernames = (r.body.assignees as Array<Record<string, unknown>>).map((u) => u.username)
    expect(usernames.sort()).toEqual(['alice', 'bob'])
  })

  it('rejects unknown assignees and unknown labels with 422', async () => {
    const s = await setup()
    expect(
      (await createIssue(s.app, s.aliceSession, s.projectId, { title: 'X', assignee_ids: [9999] })).status,
    ).toBe(422)
    expect(
      (await createIssue(s.app, s.aliceSession, s.projectId, { title: 'X', labels: ['nope'] })).status,
    ).toBe(422)
  })
})

// -- lifecycle ---------------------------------------------------------------------

describe('issue lifecycle', () => {
  it('updates title/description and records SYSTEM NOTES on the timeline', async () => {
    const s = await setup()
    const created = await createIssue(s.app, s.aliceSession, s.projectId, { title: 'Original' })
    const iid = created.body.iid as number

    const patched = await authed(s.app, 'PATCH', `/api/v1/projects/${s.projectId}/issues/${iid}`, {
      session: s.aliceSession,
      payload: { title: 'Renamed issue', description: 'Now with details.' },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().title).toBe('Renamed issue')

    const timeline = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/issues/${iid}/notes`, {
      session: s.aliceSession,
    })
    const notes = timeline.json().notes as Array<Record<string, unknown>>
    const systemNotes = notes.filter((n) => n.system === true)
    expect(systemNotes.some((n) => String(n.body).includes('changed title'))).toBe(true)
  })

  it('closes (closed_at/closed_by recorded) and reopens (fields cleared)', async () => {
    const s = await setup()
    const created = await createIssue(s.app, s.bobSession, s.projectId, { title: 'Bob reports a bug' })
    const iid = created.body.iid as number

    const closed = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues/${iid}/close`, {
      session: s.bobSession, // the author may close their own issue
    })
    expect(closed.statusCode).toBe(200)
    expect(closed.json().state).toBe('closed')
    expect(closed.json().closed_at).toBeTruthy()
    expect((closed.json().closed_by as Record<string, unknown>).username).toBe('bob')

    const reopened = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues/${iid}/reopen`, {
      session: s.bobSession,
    })
    expect(reopened.json().state).toBe('opened')
    expect(reopened.json().closed_at).toBeNull()
    expect(reopened.json().closed_by).toBeNull()

    // Timeline carries both events.
    const tl = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/issues/${iid}/notes`, { session: s.bobSession })
    const bodies = (tl.json().notes as Array<Record<string, string>>).map((n) => n.body)
    expect(bodies.some((b) => b === 'closed this issue')).toBe(true)
    expect(bodies.some((b) => b === 'reopened this issue')).toBe(true)
  })

  it('supports GitLab-style state_event on PATCH', async () => {
    const s = await setup()
    const created = await createIssue(s.app, s.aliceSession, s.projectId, { title: 'Via state event' })
    const iid = created.body.iid as number
    const r = await authed(s.app, 'PATCH', `/api/v1/projects/${s.projectId}/issues/${iid}`, {
      session: s.aliceSession,
      payload: { state_event: 'close' },
    })
    expect(r.json().state).toBe('closed')
  })

  it('deletes only for the project owner and removes the row', async () => {
    const s = await setup()
    const created = await createIssue(s.app, s.bobSession, s.projectId, { title: 'To be deleted' })
    const iid = created.body.iid as number

    const forbidden = await authed(s.app, 'DELETE', `/api/v1/projects/${s.projectId}/issues/${iid}`, {
      session: s.bobSession,
    })
    expect(forbidden.statusCode).toBe(403)

    const ok = await authed(s.app, 'DELETE', `/api/v1/projects/${s.projectId}/issues/${iid}`, {
      session: s.aliceSession,
    })
    expect(ok.statusCode).toBe(200)
    expect(
      (await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/issues/${iid}` })).statusCode,
    ).toBe(404)
  })
})

// -- comments -----------------------------------------------------------------------

describe('comments', () => {
  it('posts, edits and deletes comments; system notes are protected', async () => {
    const s = await setup()
    const created = await createIssue(s.app, s.aliceSession, s.projectId, { title: 'Discuss me' })
    const iid = created.body.iid as number

    const post = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues/${iid}/notes`, {
      session: s.bobSession,
      payload: { body: 'I can reproduce this.' },
    })
    expect(post.statusCode).toBe(201)
    const noteId = post.json().id as number
    expect(post.json().system).toBe(false)

    const edit = await authed(s.app, 'PATCH', `/api/v1/projects/${s.projectId}/issues/${iid}/notes/${noteId}`, {
      session: s.bobSession,
      payload: { body: 'Repro steps attached.' },
    })
    expect(edit.statusCode).toBe(200)

    // Bob cannot edit ALICE'S system notes… (generate one via a title change)
    await authed(s.app, 'PATCH', `/api/v1/projects/${s.projectId}/issues/${iid}`, {
      session: s.aliceSession,
      payload: { title: 'Discuss me v2' },
    })
    const sysNote = s.app.store.notes
      .timeline('issue', created.body.id as number)
      .find((n) => n.system === 1)!
    expect(sysNote).toBeTruthy()
    const editSys = await authed(s.app, 'PATCH', `/api/v1/projects/${s.projectId}/issues/${iid}/notes/${sysNote.id}`, {
      session: s.bobSession,
      payload: { body: 'hijack' },
    })
    expect(editSys.statusCode).toBe(422)

    const del = await authed(s.app, 'DELETE', `/api/v1/projects/${s.projectId}/issues/${iid}/notes/${noteId}`, {
      session: s.bobSession,
    })
    expect(del.statusCode).toBe(200)
  })
})

// -- mentions & notifications ----------------------------------------------------------

describe('mentions', () => {
  it('notifies @mentioned users through the persisted inbox (never the actor)', async () => {
    const s = await setup()
    await registerUser(s.app, { username: 'carol', email: 'carol@example.com' })

    const created = await createIssue(s.app, s.aliceSession, s.projectId, {
      title: 'Needs review',
      description: 'cc @carol please take a look',
    })
    expect(created.status).toBe(201)

    const carolSession = extractSession((await loginRaw(s.app, 'carol')).cookies)
    const inbox = await authed(s.app, 'GET', '/api/v1/user/notifications', { session: carolSession })
    const items = inbox.json().notifications as Array<Record<string, unknown>>
    expect(items.length).toBeGreaterThan(0)
    expect(String(items[0]!.title)).toContain('alice opened issue')
    expect(items.map((n) => n.type)).toContain('issue')

    // Alice (actor) never receives her own event.
    const aliceInbox = await authed(s.app, 'GET', '/api/v1/user/notifications', { session: s.aliceSession })
    expect(aliceInbox.json().unread_count).toBe(0)
  })

  it('resolves mentions inside COMMENTS and respects mute levels', async () => {
    const s = await setup()
    await registerUser(s.app, { username: 'dave', email: 'dave@example.com' })
    const daveSession = extractSession((await loginRaw(s.app, 'dave')).cookies)

    // Dave silences everything globally.
    await authed(s.app, 'PUT', '/api/v1/user/notification_preferences', {
      session: daveSession,
      payload: { level: 'disabled' },
    })

    const created = await createIssue(s.app, s.aliceSession, s.projectId, { title: 'Comment mention target' })
    const iid = created.body.iid as number
    await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues/${iid}/notes`, {
      session: s.aliceSession,
      payload: { body: 'paging @dave' },
    })

    const inbox = await authed(s.app, 'GET', '/api/v1/user/notifications', { session: daveSession })
    expect(inbox.json().notifications).toEqual([]) // muted ⇒ nothing delivered
  })
})

// -- issue references ---------------------------------------------------------------

describe('issue references', () => {
  it('creates a cross-reference system note on the TARGET issue', async () => {
    const s = await setup()
    const one = await createIssue(s.app, s.aliceSession, s.projectId, { title: 'Source' })
    const two = await createIssue(s.app, s.aliceSession, s.projectId, { title: 'Target' })

    const iidOne = one.body.iid as number
    const iidTwo = two.body.iid as number
    await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues/${iidOne}/notes`, {
      session: s.aliceSession,
      payload: { body: `Blocks #${iidTwo}` },
    })

    const target = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/issues/${iidTwo}/notes`, {
      session: s.aliceSession,
    })
    const bodies = (target.json().notes as Array<Record<string, unknown>>).map((n) => n.body)
    expect(bodies).toContain(`mentioned in issue #${iidOne}`)
  })

  it('ignores self references and dangling numbers', async () => {
    const s = await setup()
    const one = await createIssue(s.app, s.aliceSession, s.projectId, {
      title: 'Self ref #1 and dangling #99',
    })
    const iidOne = one.body.iid as number
    const tl = await s.app.store.notes.timeline('issue', one.body.id as number)
    expect(tl.filter((n) => String(n.body).includes('mentioned in'))).toEqual([])
    void iidOne
  })
})

// -- reactions ------------------------------------------------------------------------

describe('reactions', () => {
  it('toggles awards idempotently and summarizes with viewer state', async () => {
    const s = await setup()
    const created = await createIssue(s.app, s.aliceSession, s.projectId, { title: 'React to me' })
    const iid = created.body.iid as number
    const url = `/api/v1/projects/${s.projectId}/issues/${iid}/award_emoji`

    const first = await authed(s.app, 'POST', url, { session: s.bobSession, payload: { name: 'thumbsup' } })
    expect(first.statusCode).toBe(200)
    expect(first.json().action).toBe('awarded')

    const second = await authed(s.app, 'POST', url, { session: s.bobSession, payload: { name: 'thumbsup' } })
    expect(second.json().action).toBe('revoked') // toggle-off, never duplicated

    await authed(s.app, 'POST', url, { session: s.bobSession, payload: { name: 'tada' } })
    await authed(s.app, 'POST', url, { session: s.bobSession, payload: { name: 'thumbsup' } })
    const summary = await authed(s.app, 'GET', url, { session: s.bobSession })
    const byName = new Map((summary.json() as Array<Record<string, unknown>>).map((r) => [r.name, r]))
    expect(byName.get('thumbsup')).toMatchObject({ count: 1, me: true })
    expect(byName.get('tada')).toMatchObject({ count: 1, me: true })

    const bad = await authed(s.app, 'POST', url, { session: s.bobSession, payload: { name: '<script>' } })
    expect(bad.statusCode).toBe(400)
  })

  it('supports reactions on comments scoped to the right issue', async () => {
    const s = await setup()
    const created = await createIssue(s.app, s.aliceSession, s.projectId, { title: 'Note reactions' })
    const iid = created.body.iid as number
    const note = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues/${iid}/notes`, {
      session: s.aliceSession,
      payload: { body: 'first!' },
    })
    const noteId = note.json().id as number

    const r = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues/${iid}/notes/${noteId}/award_emoji`, {
      session: s.bobSession,
      payload: { name: 'smile' },
    })
    expect(r.json().action).toBe('awarded')

    // A different issue's id in the path must not leak this note's reactions.
    const other = await createIssue(s.app, s.aliceSession, s.projectId, { title: 'Other issue' })
    const wrongScope = await authed(
      s.app,
      'POST',
      `/api/v1/projects/${s.projectId}/issues/${other.body.iid}/notes/${noteId}/award_emoji`,
      { session: s.bobSession, payload: { name: 'smile' } },
    )
    expect(wrongScope.statusCode).toBe(404)
  })
})

// -- task lists -------------------------------------------------------------------------

describe('task lists', () => {
  it('parses Markdown checkboxes into progress and persists toggles', async () => {
    const s = await setup()
    const description = [
      '- [x] investigate',
      '- [ ] write fix',
      '1. [ ] add regression test',
      'plain text is not a task',
    ].join('\n')
    const created = await createIssue(s.app, s.aliceSession, s.projectId, { title: 'With tasks', description })
    const iid = created.body.iid as number

    expect(created.body.task_progress).toEqual({ total: 3, completed: 1 })
    expect(created.body.has_tasks).toBe(true)

    // Toggle the SECOND checkbox (index 1) → completed becomes 2.
    const t1 = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues/${iid}/tasks/toggle`, {
      session: s.aliceSession,
      payload: { index: 1 },
    })
    expect(t1.statusCode).toBe(200)
    expect(t1.json().task_progress).toEqual({ total: 3, completed: 2 })

    // Completion state PERSISTS — a fresh read sees it.
    const fresh = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/issues/${iid}`, { session: s.aliceSession })
    expect(fresh.json().task_progress).toEqual({ total: 3, completed: 2 })
    expect(String(fresh.json().description)).toContain('- [x] write fix')

    // Toggle back off restores 1.
    await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues/${iid}/tasks/toggle`, {
      session: s.aliceSession,
      payload: { index: 1 },
    })
    const afterOff = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/issues/${iid}`, { session: s.aliceSession })
    expect(afterOff.json().task_progress).toEqual({ total: 3, completed: 1 })

    // Out-of-range index → 404.
    const missing = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues/${iid}/tasks/toggle`, {
      session: s.aliceSession,
      payload: { index: 42 },
    })
    expect(missing.statusCode).toBe(404)
  })

  it('records a system note when a task is marked complete', async () => {
    const s = await setup()
    const created = await createIssue(s.app, s.aliceSession, s.projectId, {
      title: 'Audit trail',
      description: '- [ ] step one',
    })
    const iid = created.body.iid as number
    await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues/${iid}/tasks/toggle`, {
      session: s.aliceSession,
      payload: { index: 0 },
    })
    const tl = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/issues/${iid}/notes`, { session: s.aliceSession })
    const bodies = (tl.json().notes as Array<Record<string, string>>).map((n) => n.body)
    expect(bodies.some((b) => b.includes("marked task 'step one' complete"))).toBe(true)
  })
})

// -- confidentiality (PERMISSIONS.md §6) ---------------------------------------------

describe('confidential issues', () => {
  it('are visible ONLY to author, assignees, and owner/admin', async () => {
    const s = await setup()
    await registerUser(s.app, { username: 'carol', email: 'carol@example.com' })
    const carolSession = extractSession((await loginRaw(s.app, 'carol')).cookies)
    const bobId = s.app.store.users.byUsername('bob')!.id

    const secret = await createIssue(s.app, carolSession, s.projectId, {
      title: 'Security hole',
      confidential: true,
      assignee_ids: [bobId],
    })
    const iid = secret.body.iid as number

    // Author + assignee + owner see it.
    for (const sess of [carolSession, s.bobSession, s.aliceSession]) {
      const r = await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/issues/${iid}`, headers: { cookie: sess.cookie } })
      expect(r.statusCode).toBe(200)
    }

    // Anonymous and unrelated users get 404 (existence hidden), list excludes it.
    expect(
      (await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/issues/${iid}` })).statusCode,
    ).toBe(404)
    const anonList = await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/issues` })
    expect(anonList.json().pagination.total).toBe(0)
  })
})
