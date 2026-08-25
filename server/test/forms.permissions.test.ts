import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginRaw, extractSession, authed } from './helpers.js'

/**
 * Issue-form permission matrix: templates are readable by anyone who can read
 * the project (needed to render the creation flow), but ONLY maintainer-
 * equivalents (owner/admin today) may create/update/delete them. Submissions
 * follow issue-creation rules (guest+ on readable projects).
 */

const TINY_FORM = 'name: Tiny\nfields:\n  - type: text\n    id: note\n    attributes:\n      label: Note\n'

async function setup(visibility: 'public' | 'private' = 'public') {
  const app = makeApp()
  await registerUser(app)
  const alice = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'bob', email: 'bob@example.com' })
  const bob = extractSession((await loginRaw(app, 'bob')).cookies)
  const res = await authed(app, 'POST', '/api/v1/projects', {
    session: alice,
    payload: { name: 'Gate', path: 'forms-gate', visibility, description: '', website_url: '', default_branch: 'main', topics: [] },
  })
  expect(res.statusCode).toBe(201)
  return { app, projectId: app.store.projects.byOwnerPath('alice', 'forms-gate')!.id, alice, bob }
}

describe('issue form permissions', () => {
  it('anonymous users read forms on PUBLIC projects but can never manage them', async () => {
    const s = await setup('public')
    await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/issue_forms/tiny`, {
      session: s.alice,
      payload: { yaml: TINY_FORM },
    })

    expect(
      (await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/issue_forms` })).statusCode,
    ).toBe(200)
    expect(
      (await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/issue_forms/tiny` })).statusCode,
    ).toBe(200)

    expect(
      (await s.app.inject({ method: 'PUT', url: `/api/v1/projects/${s.projectId}/issue_forms/x`, payload: { yaml: TINY_FORM } })).statusCode,
    ).toBe(401)
    expect(
      (await s.app.inject({ method: 'DELETE', url: `/api/v1/projects/${s.projectId}/issue_forms/tiny` })).statusCode,
    ).toBe(401)
    expect(
      (await s.app.inject({ method: 'POST', url: `/api/v1/projects/${s.projectId}/issue_forms/tiny/submissions`, payload: { answers: {} } })).statusCode,
    ).toBe(401)
  })

  it('private projects hide form EXISTENCE from non-members (404)', async () => {
    const s = await setup('private')
    await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/issue_forms/tiny`, {
      session: s.alice,
      payload: { yaml: TINY_FORM },
    })
    for (const url of ['/issue_forms', '/issue_forms/tiny']) {
      expect(
        (await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}${url}`, headers: { cookie: s.bob.cookie } })).statusCode,
      ).toBe(404)
    }
  })

  it('authenticated non-maintainers cannot CREATE, UPDATE or DELETE templates', async () => {
    const s = await setup('public')
    await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/issue_forms/tiny`, {
      session: s.alice,
      payload: { yaml: TINY_FORM },
    })

    // Bob (plain authenticated reader of a public project) is guest-equivalent.
    expect(
      (await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/issue_forms/bobform`, { session: s.bob, payload: { yaml: TINY_FORM } })).statusCode,
    ).toBe(403)
    expect(
      (await authed(s.app, 'PATCH', `/api/v1/projects/${s.projectId}/issue_forms/tiny`, { session: s.bob, payload: {} })).statusCode,
    ).toBe(404) // PATCH not part of the API surface
    expect(
      (await authed(s.app, 'DELETE', `/api/v1/projects/${s.projectId}/issue_forms/tiny`, { session: s.bob })).statusCode,
    ).toBe(403)

    const list = await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/issue_forms` })
    expect((list.json().forms as Array<Record<string, unknown>>).map((f) => f.name)).toEqual(['tiny'])
  })

  it('maintainers manage templates; readers still SUBMIT per issue-create rules', async () => {
    const s = await setup('public')
    await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/issue_forms/tiny`, {
      session: s.alice,
      payload: { yaml: TINY_FORM },
    })

    // Owner updates her own template (maintainer gate passes).
    expect(
      (
        await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/issue_forms/tiny`, {
          session: s.alice,
          payload: { yaml: `${TINY_FORM}\ndescription: updated\n` },
        })
      ).statusCode,
    ).toBe(200)

    // Bob cannot maintain but CAN submit (guest-level participation).
    const submission = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issue_forms/tiny/submissions`, {
      session: s.bob,
      payload: { title: 'From bob', answers: { note: 'hello' } },
    })
    expect(submission.statusCode).toBe(201)
  })

  it('instance admins bypass the maintenance gate', async () => {
    const s = await setup('private')
    const bobId = s.app.store.users.byUsername('bob')!.id
    s.app.store.db.run('UPDATE users SET admin = 1 WHERE id = ?', bobId)

    expect(
      (
        await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/issue_forms/admin_form`, {
          session: s.bob,
          payload: { yaml: TINY_FORM },
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await authed(s.app, 'DELETE', `/api/v1/projects/${s.projectId}/issue_forms/admin_form`, {
          session: s.bob,
        })
      ).statusCode,
    ).toBe(200)
  })
})
