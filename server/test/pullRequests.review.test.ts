import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginRaw, extractSession, authed } from './helpers.js'
import type { FastifyInstance } from 'fastify'

/**
 * Review & approval workflow: reviewer management (author/maintainer gated,
 * author never reviewable), approval rules (self-approval denied, one vote
 * per user, withdrawal), and the aggregate status surfaced on the PR view.
 */

interface Harness {
  app: FastifyInstance
  projectId: number
  alice: ReturnType<typeof extractSession>
  bob: ReturnType<typeof extractSession>
  carol: ReturnType<typeof extractSession>
}

async function setup(): Promise<Harness> {
  const app = makeApp()
  await registerUser(app)
  const alice = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'bob', email: 'bob@example.com' })
  const bob = extractSession((await loginRaw(app, 'bob')).cookies)
  await registerUser(app, { username: 'carol', email: 'carol@example.com' })
  const carol = extractSession((await loginRaw(app, 'carol')).cookies)

  const res = await authed(app, 'POST', '/api/v1/projects', {
    session: alice,
    payload: {
      name: 'Review Repo', path: 'review-repo', visibility: 'public',
      description: '', website_url: '', default_branch: 'main',
      topics: [], initialize_with_readme: true,
    },
  })
  expect(res.statusCode).toBe(201)
  const projectId = app.store.projects.byOwnerPath('alice', 'review-repo')!.id

  await authed(app, 'POST', `/api/v1/projects/${projectId}/repository/commit`, {
    session: alice,
    payload: {
      branch: 'feature', new_branch: 'feature', start_branch: 'main',
      commit_message: 'work', changes: [{ path: 'f.txt', content: 'f\n' }],
    },
  })
  return { app, projectId, alice, bob, carol }
}

async function openPr(h: Harness): Promise<Record<string, unknown>> {
  const res = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests`, {
    session: h.alice,
    payload: { title: 'Reviewed PR', source_branch: 'feature', target_branch: 'main' },
  })
  expect(res.statusCode).toBe(201)
  return res.json()
}

describe('reviewer management', () => {
  it('sets reviewers, excludes the author silently, and records requests on the timeline', async () => {
    const h = await setup()
    const pr = await openPr(h)
    const iid = pr.iid as number
    const bobId = h.app.store.users.byUsername('bob')!.id
    const carolId = h.app.store.users.byUsername('carol')!.id
    const aliceId = h.app.store.users.byUsername('alice')!.id

    const set = await authed(h.app, 'PUT', `/api/v1/projects/${h.projectId}/pull_requests/${iid}/reviewers`, {
      session: h.alice,
      payload: { reviewer_ids: [bobId, carolId, aliceId] }, // author included on purpose
    })
    expect(set.statusCode).toBe(200)
    const reviewers = set.json().reviewers as Array<Record<string, unknown>>
    expect(reviewers.map((r) => (r as { username?: string }).username).sort()).toEqual(['bob', 'carol'])
    expect(reviewers.every((r) => r.review_state === 'unreviewed')).toBe(true)

    const tl = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/${iid}/notes`, { session: h.alice })
    const bodies = (tl.json().notes as Array<Record<string, string>>).map((n) => n.body)
    expect(bodies.some((b) => b.includes('requested review from @bob'))).toBe(true)

    // Non-maintainer/non-author cannot manage reviewers.
    expect(
      (
        await authed(h.app, 'PUT', `/api/v1/projects/${h.projectId}/pull_requests/${iid}/reviewers`, {
          session: h.bob,
          payload: { reviewer_ids: [] },
        })
      ).statusCode,
    ).toBe(403)
  })

  it('removing a reviewer records the removal and clears their review state', async () => {
    const h = await setup()
    const pr = await openPr(h)
    const iid = pr.iid as number
    const bobId = h.app.store.users.byUsername('bob')!.id

    await authed(h.app, 'PUT', `/api/v1/projects/${h.projectId}/pull_requests/${iid}/reviewers`, {
      session: h.alice,
      payload: { reviewer_ids: [bobId] },
    })
    const removed = await authed(h.app, 'PUT', `/api/v1/projects/${h.projectId}/pull_requests/${iid}/reviewers`, {
      session: h.alice,
      payload: { reviewer_ids: [] },
    })
    expect(removed.json().reviewers).toEqual([])

    const tl = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/${iid}/notes`, { session: h.alice })
    const bodies = (tl.json().notes as Array<Record<string, string>>).map((n) => n.body)
    expect(bodies.some((b) => b.includes('removed review request for @bob'))).toBe(true)
  })
})

describe('approvals', () => {
  it('denies AUTHOR self-approval with the precise business code', async () => {
    const h = await setup()
    const pr = await openPr(h)
    const r = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/${pr.iid as number}/approve`, {
      session: h.alice,
    })
    expect(r.statusCode).toBe(422)
    expect((r.json() as { code?: string }).code).toBe('self_approval_denied')
  })

  it('records ONE vote per user, updates reviewer state, and supports withdrawal', async () => {
    const h = await setup()
    const pr = await openPr(h)
    const iid = pr.iid as number
    const bobId = h.app.store.users.byUsername('bob')!.id
    await authed(h.app, 'PUT', `/api/v1/projects/${h.projectId}/pull_requests/${iid}/reviewers`, {
      session: h.alice,
      payload: { reviewer_ids: [bobId] },
    })

    // Bob is not the author → guest-level approval works even without push rights.
    const approved = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/${iid}/approve`, {
      session: h.bob,
    })
    expect(approved.statusCode).toBe(200)
    expect(approved.json().approvals).toMatchObject({ count: 1, required: 0 })
    expect(
      ((approved.json().reviewers as Array<Record<string, unknown>>).find((r) => r.username === 'bob') ?? {}) as Record<string, unknown>,
    ).toMatchObject({ review_state: 'approved' })

    // Duplicate approval is idempotent — still exactly one vote.
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/${iid}/approve`, { session: h.bob })
    const stillOne = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/${iid}`, { session: h.alice })
    expect((stillOne.json().approvals as { count: number }).count).toBe(1)

    // Withdrawal clears the vote AND the reviewer state.
    const withdrawn = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/${iid}/unapprove`, {
      session: h.bob,
    })
    expect((withdrawn.json().approvals as { count: number }).count).toBe(0)
    expect(
      ((withdrawn.json().reviewers as Array<Record<string, unknown>>).find((r) => r.username === 'bob') ?? {}) as Record<string, unknown>,
    ).toMatchObject({ review_state: 'unreviewed' })

    // With nothing held there is nothing to withdraw.
    expect(
      (
        await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/${iid}/unapprove`, {
          session: h.bob,
        })
      ).statusCode,
    ).toBe(404)
  })

  it('refuses approvals on CLOSED pull requests', async () => {
    const h = await setup()
    const pr = await openPr(h)
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/${pr.iid as number}/close`, {
      session: h.alice,
    })
    const r = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/${pr.iid as number}/approve`, {
      session: h.bob,
    })
    expect(r.statusCode).toBe(422)
  })

  it('prints the approval trail on the timeline', async () => {
    const h = await setup()
    const pr = await openPr(h)
    const iid = pr.iid as number
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/${iid}/approve`, { session: h.bob })
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/${iid}/unapprove`, { session: h.bob })

    const tl = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/${iid}/notes`, { session: h.alice })
    const bodies = (tl.json().notes as Array<Record<string, string>>).map((n) => n.body)
    expect(bodies.some((b) => b.includes('approved this pull request'))).toBe(true)
    expect(bodies.some((b) => b.includes('withdrew their approval'))).toBe(true)
  })
})
