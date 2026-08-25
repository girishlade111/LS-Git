import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginRaw, extractSession, authed } from './helpers.js'
import type { FastifyInstance } from 'fastify'

/**
 * Pull request STATE MACHINE tests:
 *   create→opened · draft flag · close/reopen · terminal merged ·
 *   timeline system notes · filters/pagination.
 * Merge-specific transitions live in pullRequests.merge.test.ts.
 */

export interface PrHarness {
  app: FastifyInstance
  projectId: number
  alice: ReturnType<typeof extractSession>
  bob: ReturnType<typeof extractSession>
}

/** Creates the project plus main/feature branches with distinct commits. */
export async function prSetup(): Promise<PrHarness> {
  const app = makeApp()
  await registerUser(app)
  const alice = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'bob', email: 'bob@example.com' })
  const bob = extractSession((await loginRaw(app, 'bob')).cookies)

  const res = await authed(app, 'POST', '/api/v1/projects', {
    session: alice,
    payload: {
      name: 'PR Repo', path: 'pr-repo', visibility: 'public',
      description: '', website_url: '', default_branch: 'main',
      topics: [], initialize_with_readme: true,
    },
  })
  expect(res.statusCode).toBe(201)
  const projectId = app.store.projects.byOwnerPath('alice', 'pr-repo')!.id

  const commitTo = async (branch: string, newBranch: boolean, content: string, message: string) => {
    const r = await authed(app, 'POST', `/api/v1/projects/${projectId}/repository/commit`, {
      session: alice,
      payload: {
        branch,
        ...(newBranch ? { new_branch: branch, start_branch: 'main' } : {}),
        commit_message: message,
        changes: [{ path: 'feature.txt', content }],
      },
    })
    expect(r.statusCode).toBe(201)
    return r.json() as { commit_sha: string }
  }
  await commitTo('feature', true, 'feature work v1\n', 'Add feature work')
  void commitTo

  return { app, projectId, alice, bob }
}

export async function createPr(
  h: PrHarness,
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests`, {
    session: h.alice,
    payload: {
      title: 'Merge feature into main',
      source_branch: 'feature',
      target_branch: 'main',
      ...overrides,
    },
  })
  return { status: res.statusCode, body: res.json() }
}

// -- creation -----------------------------------------------------------------

describe('PR creation', () => {
  it('creates an opened PR with sequential per-project iids and eager mergeability', async () => {
    const h = await prSetup()
    const first = await createPr(h)
    expect(first.status).toBe(201)
    expect(first.body.iid).toBe(1)
    expect(first.body.state).toBe('opened')
    expect(first.body.draft).toBe(false)
    expect(first.body.source_branch).toBe('feature')
    expect(first.body.target_branch).toBe('main')
    expect(first.body.author).toMatchObject({ username: 'alice' })

    // Second branch + PR increments the MR sequence independently of issues.
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/repository/commit`, {
      session: h.alice,
      payload: {
        branch: 'feature2', new_branch: 'feature2', start_branch: 'main',
        commit_message: 'Second feature',
        changes: [{ path: 'other.txt', content: 'x\n' }],
      },
    })
    const second = await createPr(h, {
      title: 'Second PR', source_branch: 'feature2',
      labels: ['bug'], milestone_id: undefined,
    })
    expect(second.body.iid).toBe(2)
    expect(second.body.merge_status).toBe('can_be_merged')
  })

  it('rejects missing branches, identical branches, and duplicate OPEN pairs', async () => {
    const h = await prSetup()
    expect(
      (await createPr(h, { source_branch: 'ghost' })).status,
    ).toBe(422)
    expect(
      (await createPr(h, { target_branch: 'feature', source_branch: 'feature' })).status,
    ).toBe(422)

    expect((await createPr(h)).status).toBe(201)
    const dup = await createPr(h, { title: 'Duplicate pair' })
    expect(dup.status).toBe(409)
    expect((dup.body as Record<string, unknown>).code).toBe('duplicate_pr')

    // A CLOSED PR for the same pair does not block a fresh one.
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/close`, { session: h.alice })
    const revived = await createPr(h, { title: 'Fresh attempt' })
    expect(revived.status).toBe(201)
  })

  it('requires developer-level rights: authenticated readers cannot open PRs', async () => {
    const h = await prSetup()
    const r = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests`, {
      session: h.bob,
      payload: { title: 'Bob tries', source_branch: 'feature', target_branch: 'main' },
    })
    expect(r.statusCode).toBe(403)
  })
})

describe('draft lifecycle', () => {
  it('creates drafts and flips them ready via PATCH without leaving opened state', async () => {
    const h = await prSetup()
    const created = await createPr(h, { draft: true, title: '[WIP] experimental' })
    expect(created.body.draft).toBe(true)

    // Draft flag toggles while state stays opened.
    const ready = await authed(h.app, 'PATCH', `/api/v1/projects/${h.projectId}/pull_requests/1`, {
      session: h.alice,
      payload: { draft: false },
    })
    expect(ready.json().draft).toBe(false)
    expect(ready.json().state).toBe('opened')

    const tl = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1/notes`, { session: h.alice })
    const bodies = (tl.json().notes as Array<Record<string, string>>).map((n) => n.body)
    expect(bodies.some((b) => b.includes('marked this pull request as ready'))).toBe(true)
  })
})

describe('open / close / reopen transitions', () => {
  it('walks opened → closed → opened and records SYSTEM NOTES for each hop', async () => {
    const h = await prSetup()
    await createPr(h)

    const closed = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/close`, { session: h.alice })
    expect(closed.json().state).toBe('closed')
    expect(closed.json().closed_at).toBeTruthy()
    expect(closed.json().closed_by).toMatchObject({ username: 'alice' })

    const reopened = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/reopen`, { session: h.alice })
    expect(reopened.json().state).toBe('opened')
    expect(reopened.json().closed_at).toBeNull()

    const tl = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1/notes`, { session: h.alice })
    const bodies = (tl.json().notes as Array<Record<string, string>>).map((n) => n.body)
    expect(bodies).toContain('closed this pull request')
    expect(bodies).toContain('reopened this pull request')
  })

  it('is idempotent on repeat close/reopen but never leaves the machine', async () => {
    const h = await prSetup()
    await createPr(h)
    const c1 = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/close`, { session: h.alice })
    const c2 = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/close`, { session: h.alice })
    expect(c1.json().state).toBe('closed')
    expect(c2.json().state).toBe('closed')

    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/reopen`, { session: h.alice })
    const r2 = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/reopen`, { session: h.alice })
    expect(r2.json().state).toBe('opened')
  })

  it('rejects invalid state_event values with 400', async () => {
    const h = await prSetup()
    await createPr(h)
    const bad = await authed(h.app, 'PATCH', `/api/v1/projects/${h.projectId}/pull_requests/1`, {
      session: h.alice,
      payload: { state_event: 'explode' },
    })
    expect(bad.statusCode).toBe(400)
  })

  it('reopen refuses when branches were deleted after closing', async () => {
    const h = await prSetup()
    await createPr(h)
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/close`, { session: h.alice })
    await authed(h.app, 'DELETE', `/api/v1/projects/${h.projectId}/repository/branches/feature`, { session: h.alice })
    const r = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/reopen`, { session: h.alice })
    expect(r.statusCode).toBe(422)
  })
})

describe('comments & activity timeline', () => {
  it('posts comments alongside system notes; edits/deletes are author-gated', async () => {
    const h = await prSetup()
    await createPr(h)

    const post = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/notes`, {
      session: h.bob, // guest-level participation
      payload: { body: 'Left a comment on the diff.' },
    })
    expect(post.statusCode).toBe(201)
    expect(post.json().system).toBe(false)

    // Bob may edit his own comment…
    const noteId = post.json().id as number
    expect(
      (
        await authed(h.app, 'PATCH', `/api/v1/projects/${h.projectId}/pull_requests/1/notes/${noteId}`, {
          session: h.bob,
          payload: { body: 'Updated comment.' },
        })
      ).statusCode,
    ).toBe(200)

    // …but not ALICE'S system notes (generate one via a title change first).
    await authed(h.app, 'PATCH', `/api/v1/projects/${h.projectId}/pull_requests/1`, {
      session: h.alice,
      payload: { title: 'Renamed PR' },
    })
    const tl = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1/notes`, { session: h.bob })
    const sysNote = (tl.json().notes as Array<Record<string, unknown>>).find((n) => n.system === true)!
    expect(sysNote).toBeTruthy()
    expect(
      (
        await authed(h.app, 'PATCH', `/api/v1/projects/${h.projectId}/pull_requests/1/notes/${sysNote.id}`, {
          session: h.bob,
          payload: { body: 'hijack' },
        })
      ).statusCode,
    ).toBe(422)
  })
})

describe('listing, filters & pagination', () => {
  it('filters by state/draft/search with total-count headers and stable paging', async () => {
    const h = await prSetup()
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/repository/commit`, {
      session: h.alice,
      payload: {
        branch: 'feature2', new_branch: 'feature2', start_branch: 'main',
        commit_message: 'second', changes: [{ path: 'b.txt', content: 'b\n' }],
      },
    })
    await createPr(h, { title: 'alpha pr one' })
    await createPr(h, { title: 'beta draft two', source_branch: 'feature2', draft: true })
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/close`, { session: h.alice })

    const opened = await h.app.inject({ method: 'GET', url: `/api/v1/projects/${h.projectId}/pull_requests?state=opened` })
    expect(opened.headers['x-total-count']).toBe('1')
    expect(((opened.json().pull_requests as Array<Record<string, unknown>>)[0]!).title).toBe('beta draft two')

    const drafts = await h.app.inject({ method: 'GET', url: `/api/v1/projects/${h.projectId}/pull_requests?draft=true` })
    expect(drafts.headers['x-total-count']).toBe('1')

    const search = await h.app.inject({ method: 'GET', url: `/api/v1/projects/${h.projectId}/pull_requests?search=alpha` })
    expect(search.headers['x-total-count']).toBe('1')

    const paged = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${h.projectId}/pull_requests?state=all&per_page=1&page=2&sort=asc&order_by=created_at`,
    })
    const body = paged.json() as { pull_requests: unknown[]; pagination: Record<string, unknown> }
    expect(body.pull_requests).toHaveLength(1)
    expect(body.pagination.total).toBe(2)
    expect(body.pagination.has_more).toBe(false)
  })
})
