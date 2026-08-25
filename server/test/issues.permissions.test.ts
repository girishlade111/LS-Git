import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginRaw, extractSession, authed } from './helpers.js'
import type { FastifyInstance } from 'fastify'

/**
 * Issue-domain permission matrix (PERMISSIONS.md §6/§9 + §10 obligations):
 * anonymous, non-member on private (existence hidden via 404), guest-level
 * capabilities for any authenticated reader (create/comment/react),
 * reporter+-equivalent gates (edit others/assign/label/milestone/close
 * others), owner/admin-only delete.
 */

interface Setup {
  app: FastifyInstance
  projectId: number
  alice: ReturnType<typeof extractSession> // owner
  bob: ReturnType<typeof extractSession>   // authenticated non-member
}

async function setup(visibility: 'public' | 'private' = 'public'): Promise<Setup> {
  const app = makeApp()
  await registerUser(app)
  const alice = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'bob', email: 'bob@example.com' })
  const bob = extractSession((await loginRaw(app, 'bob')).cookies)
  const res = await authed(app, 'POST', '/api/v1/projects', {
    session: alice,
    payload: { name: 'Gate', path: 'gate-repo', visibility, description: '', website_url: '', default_branch: 'main', topics: [] },
  })
  expect(res.statusCode).toBe(201)
  return { app, projectId: app.store.projects.byOwnerPath('alice', 'gate-repo')!.id, alice, bob }
}

describe('issue permissions', () => {
  it('anonymous users can READ public issues but never mutate', async () => {
    const s = await setup('public')
    await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues`, { session: s.alice, payload: { title: 'Public issue' } })

    expect(
      (await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/issues` })).statusCode,
    ).toBe(200)
    expect(
      (await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/issues/1` })).statusCode,
    ).toBe(200)
    expect(
      (await s.app.inject({ method: 'POST', url: `/api/v1/projects/${s.projectId}/issues`, payload: { title: 'anon' } })).statusCode,
    ).toBe(401)
    expect(
      (await s.app.inject({ method: 'POST', url: `/api/v1/projects/${s.projectId}/issues/1/close` })).statusCode,
    ).toBe(401)
  })

  it('private projects hide EXISTENCE from non-members (404 everywhere)', async () => {
    const s = await setup('private')
    await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues`, { session: s.alice, payload: { title: 'Secret' } })

    expect(
      (await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/issues`, headers: { cookie: s.bob.cookie } })).statusCode,
    ).toBe(404)
    expect(
      (await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/issues/1`, headers: { cookie: s.bob.cookie } })).statusCode,
    ).toBe(404)
    expect(
      (await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues`, { session: s.bob, payload: { title: 'nope' } })).statusCode,
    ).toBe(404)
    // Labels/milestones listings are equally gated.
    expect(
      (await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/labels`, headers: { cookie: s.bob.cookie } })).statusCode,
    ).toBe(404)
  })

  it('authenticated readers of a public project may CREATE and COMMENT but not edit/delete others’ work', async () => {
    const s = await setup('public')
    const created = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues`, {
      session: s.bob, payload: { title: 'From a drive-by contributor' },
    })
    expect(created.statusCode).toBe(201) // guest parity

    const comment = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues/1/notes`, {
      session: s.bob, payload: { body: '+1' },
    })
    expect(comment.statusCode).toBe(201)

    // Bob cannot close ALICE'S issue…
    const aliceIssue = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues`, {
      session: s.alice, payload: { title: "Alice's" },
    })
    const aliceIid = aliceIssue.json().iid as number
    expect(
      (await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues/${aliceIid}/close`, { session: s.bob })).statusCode,
    ).toBe(403)

    // …nor PATCH it, nor label/milestone-manage, nor delete.
    expect(
      (await authed(s.app, 'PATCH', `/api/v1/projects/${s.projectId}/issues/${aliceIid}`, { session: s.bob, payload: { title: 'hax' } })).statusCode,
    ).toBe(403)
    expect(
      (await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/labels`, { session: s.bob, payload: { title: 'x' } })).statusCode,
    ).toBe(403)
    expect(
      (await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/milestones`, { session: s.bob, payload: { title: 'x' } })).statusCode,
    ).toBe(403)
    expect(
      (await authed(s.app, 'DELETE', `/api/v1/projects/${s.projectId}/issues/${aliceIid}`, { session: s.bob })).statusCode,
    ).toBe(403)

    // Reactions are guest-level participation — allowed.
    expect(
      (await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues/${aliceIid}/award_emoji`, { session: s.bob, payload: { name: 'tada' } })).statusCode,
    ).toBe(200)
  })

  it('authors keep update/close/reopen rights over THEIR OWN issues', async () => {
    const s = await setup('public')
    const created = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues`, {
      session: s.bob, payload: { title: 'Bob’s own' },
    })
    const iid = created.json().iid as number

    expect(
      (await authed(s.app, 'PATCH', `/api/v1/projects/${s.projectId}/issues/${iid}`, { session: s.bob, payload: { description: 'mine, I may edit' } })).statusCode,
    ).toBe(200)
    expect(
      (await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues/${iid}/close`, { session: s.bob })).statusCode,
    ).toBe(200)
    expect(
      (await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues/${iid}/reopen`, { session: s.bob })).statusCode,
    ).toBe(200)
    // But metadata (assignees) stays a maintainer-side action.
    expect(
      (await authed(s.app, 'PATCH', `/api/v1/projects/${s.projectId}/issues/${iid}`, { session: s.bob, payload: { assignee_ids: [] } })).statusCode,
    ).toBe(403)
  })

  it('instance admins bypass the matrix (audited elsewhere)', async () => {
    const s = await setup('private')
    const bobId = s.app.store.users.byUsername('bob')!.id
    s.app.store.db.run('UPDATE users SET admin = 1 WHERE id = ?', bobId)

    await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues`, { session: s.alice, payload: { title: 'Admin target' } })
    expect(
      (await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/issues/1`, { session: s.bob })).statusCode,
    ).toBe(200)
    expect(
      (await authed(s.app, 'DELETE', `/api/v1/projects/${s.projectId}/issues/1`, { session: s.bob })).statusCode,
    ).toBe(200)
  })
})
