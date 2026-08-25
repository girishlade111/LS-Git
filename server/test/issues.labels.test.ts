import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginRaw, extractSession, authed } from './helpers.js'

/**
 * Labels: CRUD, per-project uniqueness (case-insensitive), color
 * normalization/validation, default seeding, issue attachment and label-based
 * filtering. Colors are stored canonical (#rrggbb lowercase) — the PRESENTATION
 * layer constrains rendering so user colors cannot break the UI contract.
 */

async function setup() {
  const app = makeApp()
  await registerUser(app)
  const alice = extractSession((await loginRaw(app, 'alice')).cookies)
  const res = await authed(app, 'POST', '/api/v1/projects', {
    session: alice,
    payload: { name: 'Labels', path: 'labels-repo', visibility: 'public', description: '', website_url: '', default_branch: 'main', topics: [] },
  })
  expect(res.statusCode).toBe(201)
  const projectId = app.store.projects.byOwnerPath('alice', 'labels-repo')!.id
  return { app, alice, projectId }
}

describe('label management', () => {
  it('seeds the GitLab-parity default set at project creation', async () => {
    const s = await setup()
    const list = await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/labels` })
    expect(list.statusCode).toBe(200)
    const titles = (list.json() as Array<Record<string, unknown>>).map((l) => l.title).sort()
    expect(titles).toEqual(['bug', 'critical', 'documentation', 'feature'])
  })

  it('creates labels with normalized colors and rejects duplicates case-insensitively', async () => {
    const s = await setup()
    const created = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/labels`, {
      session: s.alice,
      payload: { title: 'Performance', color: '#FF00AA', description: 'Slow paths' },
    })
    expect(created.statusCode).toBe(201)
    // Titles keep their typed case (display fidelity) while uniqueness is
    // case-insensitive; colors normalize to canonical lowercase #rrggbb.
    expect(created.json()).toMatchObject({ title: 'Performance', color: '#ff00aa', scope: 'project' })

    // Short-hex spelling normalizes to full form.
    const short = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/labels`, {
      session: s.alice,
      payload: { title: 'Ux', color: '#0af' },
    })
    expect(short.json().color).toBe('#00aaff')

    // Case-insensitive duplicate → 409.
    const dup = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/labels`, {
      session: s.alice,
      payload: { title: 'PERFORMANCE' },
    })
    expect(dup.statusCode).toBe(409)
    expect((dup.json() as Record<string, unknown>).code).toBe('taken')
  })

  it('rejects invalid colors with 400 (no uncontrolled values enter the system)', async () => {
    const s = await setup()
    for (const bad of ['neon', '#12345', 'javascript:alert(1)', '#zzzzzz', 42]) {
      const r = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/labels`, {
        session: s.alice,
        payload: { title: `bad-${String(bad).slice(0, 8)}`, color: bad },
      })
      expect(r.statusCode).toBe(400)
    }
  })

  it('updates and deletes labels; deletion detaches them from issues', async () => {
    const s = await setup()
    const mk = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/labels`, {
      session: s.alice,
      payload: { title: 'wip', description: 'work in progress' },
    })
    const labelId = mk.json().id as number

    const issue = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues`, {
      session: s.alice,
      payload: { title: 'Uses wip', labels: ['wip'] },
    })
    expect((issue.json().labels as Array<Record<string, unknown>>)[0]!.title).toBe('wip')

    const upd = await authed(s.app, 'PATCH', `/api/v1/projects/${s.projectId}/labels/${labelId}`, {
      session: s.alice,
      payload: { description: 'almost there', color: '#3ecf5e' },
    })
    expect(upd.json()).toMatchObject({ description: 'almost there', color: '#3ecf5e' })

    const del = await authed(s.app, 'DELETE', `/api/v1/projects/${s.projectId}/labels/${labelId}`, { session: s.alice })
    expect(del.statusCode).toBe(200)

    const fresh = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/issues`, { session: s.alice })
    const row = (fresh.json().issues as Array<Record<string, unknown>>)[0]!
    expect(row.labels).toEqual([])
  })

  it('reports usage counts with with_counts=true', async () => {
    const s = await setup()
    await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues`, {
      session: s.alice,
      payload: { title: 'A', labels: ['bug'] },
    })
    await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issues`, {
      session: s.alice,
      payload: { title: 'B', labels: ['bug'] },
    })
    const list = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/labels?with_counts=true`, { session: s.alice })
    const bug = (list.json() as Array<Record<string, unknown>>).find((l) => l.title === 'bug')!
    expect(bug.open_issues_count).toBe(2)
  })
})
