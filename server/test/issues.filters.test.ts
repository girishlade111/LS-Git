import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginRaw, extractSession, authed } from './helpers.js'

/**
 * Search / filter / sort / pagination over the indexed issue list
 * (DATABASE.md §4: issues(project_id, state, updated_at DESC)).
 */

async function setup() {
  const app = makeApp()
  await registerUser(app)
  const alice = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'bob', email: 'bob@example.com' })
  const bob = extractSession((await loginRaw(app, 'bob')).cookies)
  const res = await authed(app, 'POST', '/api/v1/projects', {
    session: alice,
    payload: { name: 'Search', path: 'search-repo', visibility: 'public', description: '', website_url: '', default_branch: 'main', topics: [] },
  })
  expect(res.statusCode).toBe(201)
  const projectId = app.store.projects.byOwnerPath('alice', 'search-repo')!.id

  // Milestones + labels for filter fixtures.
  const ms = await authed(app, 'POST', `/api/v1/projects/${projectId}/milestones`, { session: alice, payload: { title: 'v1' } })
  const msId = ms.json().id as number

  const bobId = app.store.users.byUsername('bob')!.id
  // 12 open issues titled bug-N (first 5 labeled 'bug', first 3 in milestone v1,
  // even indexes assigned to bob), plus 6 closed ones about crashes.
  for (let i = 1; i <= 12; i++) {
    const payload: Record<string, unknown> = {
      title: `bug-${i}`,
      description: i === 7 ? 'special keyword zebra' : '',
      labels: i <= 5 ? ['bug'] : [],
      milestone_id: i <= 3 ? msId : undefined,
      assignee_ids: i % 2 === 0 ? [bobId] : [],
    }
    const r = await authed(app, 'POST', `/api/v1/projects/${projectId}/issues`, { session: alice, payload })
    expect(r.statusCode).toBe(201)
  }
  for (let i = 1; i <= 6; i++) {
    const r = await authed(app, 'POST', `/api/v1/projects/${projectId}/issues`, {
      session: alice,
      payload: { title: `crash-${i}` },
    })
    expect(r.statusCode).toBe(201)
    await authed(app, 'POST', `/api/v1/projects/${projectId}/issues/${r.json().iid as number}/close`, { session: alice })
  }
  return { app, alice, bob, projectId, msId, bobId }
}

function listUrl(projectId: number, qs: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(qs)) if (v !== undefined && v !== '') q.set(k, String(v))
  const s = q.toString()
  return `/api/v1/projects/${projectId}/issues${s ? `?${s}` : ''}`
}

describe('issue search & filters', () => {
  it('filters by state with an accurate total count header', async () => {
    const s = await setup()
    const open = await s.app.inject({ method: 'GET', url: listUrl(s.projectId, { state: 'opened' }) })
    expect(open.statusCode).toBe(200)
    expect(open.headers['x-total-count']).toBe('12')

    const closed = await s.app.inject({ method: 'GET', url: listUrl(s.projectId, { state: 'closed' }) })
    expect(closed.headers['x-total-count']).toBe('6')
    expect((closed.json().issues as Array<Record<string, unknown>>).every((i) => i.state === 'closed')).toBe(true)

    const all = await s.app.inject({ method: 'GET', url: listUrl(s.projectId, {}) })
    expect(all.headers['x-total-count']).toBe('18')
  })

  it('searches titles AND descriptions case-insensitively', async () => {
    const s = await setup()
    const byTitle = await authed(s.app, 'GET', listUrl(s.projectId, { search: 'CRASH' }), {})
    expect(byTitle.json().pagination.total).toBe(6)

    const byDesc = await authed(s.app, 'GET', listUrl(s.projectId, { search: 'zebra' }), {})
    expect(byDesc.json().pagination.total).toBe(1)
    expect((byDesc.json().issues as Array<Record<string, unknown>>)[0]!.title).toBe('bug-7')
  })

  it('filters by label, milestone (title/none/any) and assignee', async () => {
    const s = await setup()
    const labeled = await authed(s.app, 'GET', listUrl(s.projectId, { labels: 'bug' }), {})
    expect(labeled.json().pagination.total).toBe(5)

    const byMsTitle = await authed(s.app, 'GET', listUrl(s.projectId, { milestone: 'v1' }), {})
    expect(byMsTitle.json().pagination.total).toBe(3)

    const none = await authed(s.app, 'GET', listUrl(s.projectId, { milestone: 'none' }), {})
    expect(none.json().pagination.total).toBe(15)

    const any = await authed(s.app, 'GET', listUrl(s.projectId, { milestone: 'any' }), {})
    expect(any.json().pagination.total).toBe(3)

    const assignedBob = await authed(s.app, 'GET', listUrl(s.projectId, { assignee_username: 'bob', state: 'opened' }), {})
    expect(assignedBob.json().pagination.total).toBe(6) // bug-2,4,6,8,10,12

    const unassigned = await authed(s.app, 'GET', listUrl(s.projectId, { assignee_username: 'none' }), {})
    expect(unassigned.json().pagination.total).toBe(12)

    const byAuthor = await authed(s.app, 'GET', listUrl(s.projectId, { author_username: 'bob' }), {})
    expect(byAuthor.json().pagination.total).toBe(0)

    // Unknown label → explicit error, never a silent empty page.
    const badLabel = await authed(s.app, 'GET', listUrl(s.projectId, { labels: 'ghost' }), {})
    expect(badLabel.statusCode).toBe(422)
  })

  it('sorts by created_at/updated_at in both directions', async () => {
    const s = await setup()
    const asc = await authed(s.app, 'GET', listUrl(s.projectId, { order_by: 'created_at', sort: 'asc' }), {})
    const firstAsc = (asc.json().issues as Array<Record<string, unknown>>)[0]!
    expect(firstAsc.title).toBe('bug-1')

    const desc = await authed(s.app, 'GET', listUrl(s.projectId, { order_by: 'created_at', sort: 'desc' }), {})
    const firstDesc = (desc.json().issues as Array<Record<string, unknown>>)[0]!
    expect(firstDesc.title).toBe('crash-6')

    // Touching bug-1 bumps its updated_at above everything else.
    await authed(s.app, 'PATCH', `/api/v1/projects/${s.projectId}/issues/1`, {
      session: s.alice,
      payload: { description: 'bumped' },
    })
    const byUpdated = await authed(s.app, 'GET', listUrl(s.projectId, {}), {})
    expect((byUpdated.json().issues as Array<Record<string, unknown>>)[0]!.title).toBe('bug-1')
  })

  it('paginates deterministically with metadata and headers', async () => {
    const s = await setup()
    const p1 = await s.app.inject({ method: 'GET', url: listUrl(s.projectId, { per_page: 10, page: 1 }) })
    const body1 = p1.json() as { issues: Array<Record<string, unknown>>; pagination: Record<string, unknown> }
    expect(body1.issues.length).toBe(10)
    expect(p1.headers['x-total-count']).toBe('18')
    expect(p1.headers['x-total-pages']).toBe('2')
    expect(body1.pagination.has_more).toBe(true)

    const p2 = await s.app.inject({ method: 'GET', url: listUrl(s.projectId, { per_page: 10, page: 2 }) })
    const body2 = p2.json() as { issues: Array<Record<string, unknown>>; pagination: Record<string, unknown> }
    expect(body2.issues.length).toBe(8)
    expect(body2.pagination.has_more).toBe(false)

    // No overlap between pages (stable ordering).
    const ids1 = new Set(body1.issues.map((i) => i.id))
    for (const row of body2.issues) expect(ids1.has(row.id as number)).toBe(false)

    // Out-of-range page → empty list, still valid.
    const p9 = await s.app.inject({ method: 'GET', url: listUrl(s.projectId, { per_page: 10, page: 9 }) })
    expect(p9.json().issues).toEqual([])
  })
})
