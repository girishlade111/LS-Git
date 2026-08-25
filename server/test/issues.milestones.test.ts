import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginRaw, extractSession, authed } from './helpers.js'

/**
 * Milestones: CRUD, unique titles per project, due-date validation,
 * close/activate lifecycle, completion percentage (closed/total), issue
 * linkage and automatic unlinking on deletion.
 */

async function setup() {
  const app = makeApp()
  await registerUser(app)
  const alice = extractSession((await loginRaw(app, 'alice')).cookies)
  const res = await authed(app, 'POST', '/api/v1/projects', {
    session: alice,
    payload: { name: 'Milestones', path: 'ms-repo', visibility: 'public', description: '', website_url: '', default_branch: 'main', topics: [] },
  })
  expect(res.statusCode).toBe(201)
  const projectId = app.store.projects.byOwnerPath('alice', 'ms-repo')!.id
  return { app, alice, projectId }
}

async function createMilestone(s: Awaited<ReturnType<typeof setup>>, payload: Record<string, unknown>) {
  return authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/milestones`, { session: s.alice, payload })
}

describe('milestone management', () => {
  it('creates milestones with title/description/due date', async () => {
    const s = await setup()
    const r = await createMilestone(s, { title: 'v1.0', description: 'First release', due_date: '2026-12-01' })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({
      title: 'v1.0',
      description: 'First release',
      due_date: '2026-12-01',
      state: 'active',
      merge_requests_count: 0, // contract present before the MR phase
    })
  })

  it('enforces per-project title uniqueness and valid due dates', async () => {
    const s = await setup()
    await createMilestone(s, { title: 'Sprint 1' })
    const dup = await createMilestone(s, { title: 'sprint 1' })
    expect(dup.statusCode).toBe(409)

    expect((await createMilestone(s, { title: 'Bad date', due_date: 'soon' })).statusCode).toBe(400)
    expect((await createMilestone(s, { title: '' })).statusCode).toBe(400)
  })

  it('computes completion percentage from linked issues', async () => {
    const s = await setup()
    const ms = await createMilestone(s, { title: 'Q3' })
    const msId = ms.json().id as number

    for (const t of ['a', 'b', 'c', 'd']) {
      await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues`, {
        session: s.alice,
        payload: { title: t, milestone_id: msId },
      })
    }
    // Close two of the four.
    await authed(s.app, 'PATCH', `/api/v1/projects/${s.projectId}/issues/1`, {
      session: s.alice,
      payload: { state_event: 'close' },
    })
    await authed(s.app, 'PATCH', `/api/v1/projects/${s.projectId}/issues/2`, {
      session: s.alice,
      payload: { state_event: 'close' },
    })

    const detail = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/milestones/${msId}`, { session: s.alice })
    expect(detail.json()).toMatchObject({
      total_issues: 4,
      closed_issues: 2,
      opened_issues: 2,
      completion_percent: 50,
    })
  })

  it('closes and reactivates milestones via state_event', async () => {
    const s = await setup()
    const ms = await createMilestone(s, { title: 'Done-zo' })
    const id = ms.json().id as number
    const closed = await authed(s.app, 'PATCH', `/api/v1/projects/${s.projectId}/milestones/${id}`, {
      session: s.alice,
      payload: { state_event: 'close' },
    })
    expect(closed.json().state).toBe('closed')
    const active = await authed(s.app, 'PATCH', `/api/v1/projects/${s.projectId}/milestones/${id}`, {
      session: s.alice,
      payload: { state_event: 'activate' },
    })
    expect(active.json().state).toBe('active')
    const bad = await authed(s.app, 'PATCH', `/api/v1/projects/${s.projectId}/milestones/${id}`, {
      session: s.alice,
      payload: { state_event: 'nonsense' },
    })
    expect(bad.statusCode).toBe(400)
  })

  it('deleting a milestone UNLINKS its issues instead of deleting them', async () => {
    const s = await setup()
    const ms = await createMilestone(s, { title: 'Doomed' })
    const msId = ms.json().id as number
    await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues`, {
      session: s.alice,
      payload: { title: 'Orphan-to-be', milestone_id: msId },
    })

    const del = await authed(s.app, 'DELETE', `/api/v1/projects/${s.projectId}/milestones/${msId}`, { session: s.alice })
    expect(del.statusCode).toBe(200)

    const issue = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/issues/1`, { session: s.alice })
    expect(issue.json().milestone).toBeNull()
    expect(issue.json().state).toBe('opened')
  })

  it('rejects milestones from other projects when linking issues', async () => {
    const s = await setup()
    const foreign = await authed(s.app, 'POST', '/api/v1/projects', {
      session: s.alice,
      payload: { name: 'Other', path: 'other-ms', visibility: 'public', description: '', website_url: '', default_branch: 'main', topics: [] },
    })
    expect(foreign.statusCode).toBe(201)
    const otherProject = s.app.store.projects.byOwnerPath('alice', 'other-ms')!
    const ms = await authed(s.app, 'POST', `/api/v1/projects/${otherProject.id}/milestones`, {
      session: s.alice,
      payload: { title: 'Foreign MS' },
    })
    const r = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues`, {
      session: s.alice,
      payload: { title: 'Cross-project link attempt', milestone_id: ms.json().id },
    })
    expect(r.statusCode).toBe(422)
  })
})
