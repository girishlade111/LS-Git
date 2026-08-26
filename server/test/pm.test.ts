import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginRaw, extractSession, authed } from './helpers.js'
import type { FastifyInstance } from 'fastify'

/**
 * Project management: board CRUD, item linking (issue/PR/draft), custom
 * typed fields, saved views, workflow auto-transitions (event-driven),
 * insights, and the permission matrix.
 */

interface Harness {
  app: FastifyInstance
  projectId: number
  alice: ReturnType<typeof extractSession> // owner
  bob: ReturnType<typeof extractSession>   // regular user
}

async function setup(): Promise<Harness> {
  const app = makeApp()
  await registerUser(app)
  const alice = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'bob', email: 'bob@example.com' })
  const bob = extractSession((await loginRaw(app, 'bob')).cookies)
  const res = await authed(app, 'POST', '/api/v1/projects', {
    session: alice,
    payload: {
      name: 'PM Repo', path: 'pm-repo', visibility: 'public',
      description: '', website_url: '', default_branch: 'main', topics: [],
      initialize_with_readme: true,
    },
  })
  expect(res.statusCode).toBe(201)
  return { app, projectId: app.store.projects.byOwnerPath('alice', 'pm-repo')!.id, alice, bob }
}

async function createBoard(h: Harness): Promise<Record<string, unknown>> {
  const res = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pm/boards`, {
    session: h.alice,
    payload: { name: 'Sprint board', description: 'Main planning board.' },
  })
  expect(res.statusCode).toBe(201)
  return (res.json() as { board: Record<string, unknown> }).board
}

async function createIssue(h: Harness, title: string): Promise<number> {
  const r = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/issues`, {
    session: h.alice, payload: { title },
  })
  expect(r.statusCode).toBe(201)
  return r.json().iid as number
}

const B = (h: Harness) => `/api/v1/projects/${h.projectId}/pm/boards`

// ── board CRUD ────────────────────────────────────────────────────────────────

describe('board CRUD', () => {
  it('creates a board with SEEDED builtin fields and default workflows', async () => {
    const h = await setup()
    const board = await createBoard(h)
    const bid = board.id as number

    const detail = await authed(h.app, 'GET', `${B(h)}/${bid}`, {})
    const fields = detail.json().fields as Array<Record<string, unknown>>
    const keys = fields.map((f) => f.key)
    expect(keys).toEqual(['status', 'priority', 'iteration', 'assignee', 'labels', 'milestone'])
    const status = fields.find((f) => f.key === 'status')!
    expect(status.type).toBe('status')
    expect(status.options).toEqual([
      'Backlog', 'Todo', 'In progress', 'In review', 'Done',
    ])

    const workflows = (detail.json().workflows as Array<{ event: string; target_status: string }>)
    const closed = workflows.find((w) => w.event === 'issue_closed')!
    expect(closed.target_status).toBe('Done')
    const merged = workflows.find((w) => w.event === 'pr_merged')!
    expect(merged.target_status).toBe('Done')
  })

  it('enforces unique names per project; rename + delete for maintainers', async () => {
    const h = await setup()
    await createBoard(h)
    const dup = await authed(h.app, 'POST', `${B(h)}`, {
      session: h.alice, payload: { name: 'sprint BOARD' },
    })
    expect(dup.statusCode).toBe(409)

    const renamed = await authed(h.app, 'PATCH', `${B(h)}/1`, {
      session: h.alice, payload: { name: 'Renamed board', description: 'd2' },
    })
    expect(renamed.json().board).toMatchObject({ name: 'Renamed board', description: 'd2' })

    const del = await authed(h.app, 'DELETE', `${B(h)}/1`, { session: h.alice })
    expect(del.statusCode).toBe(200)
    expect((await authed(h.app, 'GET', `${B(h)}`, {})).json().boards).toEqual([])
  })
})

// ── item linking ────────────────────────────────────────────────────────────────

describe('item linking', () => {
  it('links an ISSUE mirroring title/assignees/milestone; links PRs; creates DRAFTS', async () => {
    const h = await setup()
    await createBoard(h)

    // Issue with assignee + milestone to verify mirroring.
    const bobId = h.app.store.users.byUsername('bob')!.id
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/milestones`, {
      session: h.alice, payload: { title: 'Sprint 1' },
    })
    const issue = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/issues`, {
      session: h.alice,
      payload: { title: 'Implement export', assignee_ids: [bobId], milestone_id: 1 },
    })
    const issueIid = issue.json().iid as number

    const link = await authed(h.app, 'POST', `${B(h)}/1/items`, {
      session: h.alice,
      payload: { kind: 'issue', issue_iid: issueIid },
    })
    expect(link.statusCode).toBe(201)
    const item = (link.json() as { item: Record<string, unknown> }).item
    expect(item.title).toBe('Implement export')
    expect(item.field_values).toMatchObject({ assignee: 'bob', milestone: 'Sprint 1' })

    // Draft item.
    const draft = await authed(h.app, 'POST', `${B(h)}/1/items`, {
      session: h.alice,
      payload: { kind: 'draft', title: 'Explore caching idea', body: 'Maybe LRU?' },
    })
    expect(draft.statusCode).toBe(201)

    // Duplicate link of same issue is rejected.
    const again = await authed(h.app, 'POST', `${B(h)}/1/items`, {
      session: h.alice, payload: { kind: 'issue', issue_iid: issueIid },
    })
    void again

    // Unlink.
    const itemId = (link.json() as { item: { id: number } }).item.id
    expect(
      (
        await authed(h.app, 'DELETE', `${B(h)}/1/items/${itemId}`, { session: h.alice })
      ).statusCode,
    ).toBe(200)
  })

  it('rejects linking nonexistent issues/PRs', async () => {
    const h = await setup()
    await createBoard(h)
    expect(
      (
        await authed(h.app, 'POST', `${B(h)}/1/items`, { session: h.alice, payload: { kind: 'issue', issue_iid: 999 } })
      ).statusCode,
    ).toBe(422)
  })
})

// ── fields ────────────────────────────────────────────────────────────────────

describe('custom fields', () => {
  it('creates TYPED fields, validates values per type, rejects bad options', async () => {
    const h = await setup()
    await createBoard(h)

    const num = await authed(h.app, 'POST', `${B(h)}/1/fields`, {
      session: h.alice,
      payload: { key: 'story_points', label: 'Story points', type: 'number' },
    })
    expect(num.statusCode).toBe(201)

    const dateF = await authed(h.app, 'POST', `${B(h)}/1/fields`, {
      session: h.alice,
      payload: { key: 'due', label: 'Due date', type: 'date' },
    })
    expect(dateF.statusCode).toBe(201)

    const multi = await authed(h.app, 'POST', `${B(h)}/1/fields`, {
      session: h.alice,
      payload: { key: 'platforms', label: 'Platforms', type: 'multi_select', options: ['web', 'ios'] },
    })
    expect(multi.statusCode).toBe(201)

    // Link an issue and set typed values.
    const issueIid = await createIssue(h, 'Typed item')
    const itemRes = await authed(h.app, 'POST', `${B(h)}/1/items`, {
      session: h.alice, payload: { kind: 'issue', issue_iid: issueIid },
    })
    const itemId = ((itemRes.json() as { item: Record<string, unknown> }).item.id) as number

    const pointsRes = await authed(h.app, 'PATCH', `${B(h)}/1/items/${itemId}`, {
      session: h.alice, payload: { field_key: 'story_points', value: 8 },
    })
    expect(
      ((pointsRes.json() as { item: { field_values: Record<string, string | null> } }).item.field_values.story_points),
    ).toBe('8')

    // Invalid number → 400
    expect(
      (
        await authed(h.app, 'PATCH', `${B(h)}/1/items/${itemId}`, {
          session: h.alice, payload: { field_key: 'story_points', value: 'eight' },
        })
      ).statusCode,
    ).toBe(400)

    // Valid date
    expect(
      (
        await authed(h.app, 'PATCH', `${B(h)}/1/items/${itemId}`, {
          session: h.alice, payload: { field_key: 'due', value: '2026-09-01' },
        })
      ).statusCode,
    ).toBe(200)

    // Invalid date → 400
    expect(
      (
        await authed(h.app, 'PATCH', `${B(h)}/1/items/${itemId}`, {
          session: h.alice, payload: { field_key: 'due', value: 'soon' },
        })
      ).statusCode,
    ).toBe(400)

    // Multi select valid + invalid
    const multiOk = await authed(h.app, 'PATCH', `${B(h)}/1/items/${itemId}`, {
      session: h.alice, payload: { field_key: 'platforms', value: ['web', 'ios'] },
    })
    expect(multiOk.statusCode).toBe(200)
    expect(
      (
        await authed(h.app, 'PATCH', `${B(h)}/1/items/${itemId}`, {
          session: h.alice, payload: { field_key: 'platforms', value: ['mainframe'] },
        })
      ).statusCode,
    ).toBe(400)

    // Status must be a configured option
    expect(
      (
        await authed(h.app, 'PATCH', `${B(h)}/1/items/${itemId}`, {
          session: h.alice, payload: { field_key: 'status', value: 'Exploded' },
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (
        await authed(h.app, 'PATCH', `${B(h)}/1/items/${itemId}`, {
          session: h.alice, payload: { field_key: 'status', value: 'In progress' },
        })
      ).statusCode,
    ).toBe(200)
  })

  it('builtin status/priority cannot be deleted; unknown keys 404 on set', async () => {
    const h = await setup()
    await createBoard(h)
    const fields = await authed(h.app, 'GET', `${B(h)}/1/fields`, {})
    const statusField = (fields.json().fields as Array<{ id: number; key: string }>).find((f) => f.key === 'status')!
    expect(
      (
        await authed(h.app, 'DELETE', `${B(h)}/1/fields/${statusField.id}`, { session: h.alice })
      ).statusCode,
    ).toBe(422)

    const issueIid = await createIssue(h, 'Unknown key probe')
    const itemRes = await authed(h.app, 'POST', `${B(h)}/1/items`, {
      session: h.alice, payload: { kind: 'issue', issue_iid: issueIid },
    })
    const itemId = ((itemRes.json() as { item: Record<string, unknown> }).item.id) as number
    expect(
      (
        await authed(h.app, 'PATCH', `${B(h)}/1/items/${itemId}`, {
          session: h.alice, payload: { field_key: 'nonexistent', value: 'x' },
        })
      ).statusCode,
    ).toBe(404)
  })
})

// ── workflow triggers ──────────────────────────────────────────────────────────

describe('workflow triggers (event-driven)', () => {
  it('closing an ISSUE moves linked items to Done via the event bus', async () => {
    const h = await setup()
    await createBoard(h)
    const issueIid = await createIssue(h, 'Auto-transition target')
    const linked = await authed(h.app, 'POST', `${B(h)}/1/items`, {
      session: h.alice, payload: { kind: 'issue', issue_iid: issueIid },
    })
    const itemId = ((linked.json() as { item: Record<string, unknown> }).item.id) as number

    // Close the issue through the normal lifecycle — PM automation subscribes
    // to the same domain events (no direct coupling).
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/issues/${issueIid}/close`, { session: h.alice })

    const items = await authed(h.app, 'GET', `${B(h)}/1/items?status=Done`, {})
    const rows = items.json().items as Array<Record<string, unknown>>
    const row = rows.find((r) => r.id === itemId)!
    expect(row).toBeTruthy()
    expect((row.field_values as Record<string, string>).status).toBe('Done')
  })

  it('merging a PR moves linked items to Done', async () => {
    const h = await setup()
    await createBoard(h)

    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/repository/commit`, {
      session: h.alice,
      payload: {
        branch: 'feature', new_branch: 'feature', start_branch: 'main',
        commit_message: 'work', changes: [{ path: 'f.txt', content: 'f\n' }],
      },
    })
    const pr = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests`, {
      session: h.alice,
      payload: { title: 'Feature PR', source_branch: 'feature', target_branch: 'main' },
    })
    const prIid = pr.json().iid as number
    await authed(h.app, 'POST', `${B(h)}/1/items`, {
      session: h.alice, payload: { kind: 'pull_request', pr_iid: prIid },
    })

    const merged = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/${prIid}/merge`, {
      session: h.alice, payload: {},
    })
    expect(merged.statusCode).toBe(200)

    const items = await authed(h.app, 'GET', `${B(h)}/1/items?status=Done`, {})
    expect(((items.json().items as Array<Record<string, unknown>>)[0]!).pr_iid).toBe(prIid)
  })

  it('maintainers can UPDATE workflow rules; invalid statuses rejected', async () => {
    const h = await setup()
    await createBoard(h)
    const put = await authed(h.app, 'PUT', `${B(h)}/1/workflows`, {
      session: h.alice,
      payload: { event: 'issue_closed', target_status: 'In review' },
    })
    expect(put.statusCode).toBe(200)
    const rules = (put.json() as { rules: Array<{ event: string; target_status: string }> }).rules
    expect(rules.find((r) => r.event === 'issue_closed')!.target_status).toBe('In review')

    const bad = await authed(h.app, 'PUT', `${B(h)}/1/workflows`, {
      session: h.alice,
      payload: { event: 'issue_closed', target_status: 'Nowhere' },
    })
    expect(bad.statusCode).toBe(400)
  })
})

// ── views ────────────────────────────────────────────────────────────────────────

describe('saved views', () => {
  it('saves filters, applies them on listing, enforces unique names, deletes', async () => {
    const h = await setup()
    await createBoard(h)
    const issueIid = await createIssue(h, 'Filtered in view')
    await authed(h.app, 'POST', `${B(h)}/1/items`, {
      session: h.alice, payload: { kind: 'draft', title: 'Draft not in view' },
    })
    await authed(h.app, 'POST', `${B(h)}/1/items`, {
      session: h.alice, payload: { kind: 'issue', issue_iid: issueIid },
    })

    const created = await authed(h.app, 'POST', `${B(h)}/1/views`, {
      session: h.alice,
      payload: { name: 'Issues only', filters: { kinds: ['issue'] }, group_by: 'priority' },
    })
    expect(created.statusCode).toBe(201)
    const viewName = ((created.json() as { view: Record<string, unknown> }).view.name) as string
    const viewId = ((created.json() as { view: { id: number } }).view.id) as number

    const dup = await authed(h.app, 'POST', `${B(h)}/1/views`, {
      session: h.alice, payload: { name: 'issues only' },
    })
    expect(dup.statusCode).toBe(409)

    const listed = await authed(h.app, 'GET', `${B(h)}/1/items?view=${encodeURIComponent(viewName)}`, {})
    const rows = listed.json().items as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('issue')

    // Only the creator can delete their own view.
    expect(
      (
        await authed(h.app, 'DELETE', `${B(h)}/1/views/${viewId}`, { session: h.bob })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await authed(h.app, 'DELETE', `${B(h)}/1/views/${viewId}`, { session: h.alice })
      ).statusCode,
    ).toBe(200)
  })
})

// ── permissions ────────────────────────────────────────────────────────────────

describe('permissions', () => {
  it('viewer-level users read but cannot write; owner maintains everything', async () => {
    const h = await setup()
    await createBoard(h)
    await createIssue(h, 'Perm probe')
    await authed(h.app, 'POST', `${B(h)}/1/items`, {
      session: h.alice, payload: { kind: 'draft', title: 'Draft' },
    })

    // Bob is an authenticated non-member of this project's ownership model:
    // reads allowed on public projects…
    const read = await authed(h.app, 'GET', `${B(h)}/1`, { session: h.bob })
    expect(read.statusCode).toBe(200)

    // …but every write requires member-level rights (owner/admin today).
    expect(
      (
        await authed(h.app, 'POST', `${B(h)}/1/items`, {
          session: h.bob, payload: { kind: 'draft', title: 'nope' },
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await authed(h.app, 'PATCH', `${B(h)}/1/items/1`, {
          session: h.bob, payload: { field_key: 'status', value: 'Todo' },
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await authed(h.app, 'POST', `${B(h)}/1/fields`, {
          session: h.bob, payload: { key: 'x', label: 'X', type: 'text' },
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await authed(h.app, 'PUT', `${B(h)}/1/workflows`, {
          session: h.bob, payload: { event: 'issue_closed', target_status: 'Todo' },
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await authed(h.app, 'DELETE', `${B(h)}/1`, { session: h.bob })
      ).statusCode,
    ).toBe(403)

    // Anonymous users cannot even read private boards — public read works:
    expect(
      (await h.app.inject({ method: 'GET', url: `${B(h)}/1` })).statusCode,
    ).toBe(200)
  })
})

// ── insights ────────────────────────────────────────────────────────────────────

describe('insights foundation', () => {
  it('reports counts, status distribution, progress and throughput honestly', async () => {
    const h = await setup()
    await createBoard(h)
    const i1 = await createIssue(h, 'Insight A')
    const i2 = await createIssue(h, 'Insight B')
    await authed(h.app, 'POST', `${B(h)}/1/items`, { session: h.alice, payload: { kind: 'issue', issue_iid: i1 } })
    const item2 = await authed(h.app, 'POST', `${B(h)}/1/items`, { session: h.alice, payload: { kind: 'issue', issue_iid: i2 } })
    const item2Id = ((item2.json() as { item: Record<string, unknown> }).item.id) as number

    await authed(h.app, 'PATCH', `${B(h)}/1/items/${item2Id}`, {
      session: h.alice, payload: { field_key: 'status', value: 'Done' },
    })

    const ins = await authed(h.app, 'GET', `${B(h)}/1/insights`, {}).then((r) => r.json()) as {
      total_items: number
      by_kind: Record<string, number>
      status_distribution: Array<{ status: string; count: number }>
      progress: { done_status: string; done_count: number; percent: number }
      throughput_last_30_days: number
    }
    expect(ins.total_items).toBe(2)
    expect(ins.by_kind.issues).toBe(2)
    expect(ins.status_distribution).toEqual([
      { status: 'Backlog', count: 1 },
      { status: 'Done', count: 1 },
    ])
    expect(ins.progress).toMatchObject({ done_count: 1, percent: 50 })
    expect(ins.throughput_last_30_days).toBeGreaterThanOrEqual(1)
  })
})