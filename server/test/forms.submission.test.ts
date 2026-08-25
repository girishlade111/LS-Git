import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginRaw, extractSession, authed } from './helpers.js'

/**
 * End-to-end form submission: template storage in the repository, field
 * rendering contract, server-side validation and structured issue creation.
 */

const BUG_FORM = `name: Bug report
description: Report a reproducible problem
title_prefix: '[bug] '
title_field: summary
labels:
  - bug
fields:
  - type: text
    id: summary
    attributes:
      label: Summary
      placeholder: Login returns 500
    validations:
      required: true
      min_length: 5
  - type: textarea
    id: details
    attributes:
      label: Details
    validations:
      required: true
  - type: dropdown
    id: severity
    attributes:
      label: Severity
      options:
        - low
        - medium
        - high
    validations:
      required: true
  - type: checkbox
    id: consent
    attributes:
      label: I searched for duplicates
    validations:
      required: true
  - type: tasklist
    id: triage
    attributes:
      label: Triage steps
      options:
        - collect logs
        - check dashboards
`

async function setup() {
  const app = makeApp()
  await registerUser(app)
  const alice = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'bob', email: 'bob@example.com' })
  const bob = extractSession((await loginRaw(app, 'bob')).cookies)
  const res = await authed(app, 'POST', '/api/v1/projects', {
    session: alice,
    payload: { name: 'Forms', path: 'forms-repo', visibility: 'public', description: '', website_url: '', default_branch: 'main', topics: [] },
  })
  expect(res.statusCode).toBe(201)
  const projectId = app.store.projects.byOwnerPath('alice', 'forms-repo')!.id

  // 'bug' is part of the GitLab-parity default label set seeded at creation.
  const bugLabel = app.store.labels.byTitle(projectId, 'bug')
  expect(bugLabel).toBeTruthy()
  return { app, alice, bob, projectId }
}

async function saveForm(s: Awaited<ReturnType<typeof setup>>, yaml = BUG_FORM) {
  return authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/issue_forms/bug_report`, {
    session: s.alice,
    payload: { yaml },
  })
}

describe('form template storage (repository-backed)', () => {
  it('saves a validated template as a versioned repo file and reads it back', async () => {
    const s = await setup()
    const saved = await saveForm(s)
    expect(saved.statusCode).toBe(200)
    expect(saved.json().path).toBe('.lsgit/issues/forms/bug_report.yml')
    expect(saved.json().commit_sha).toBeTruthy()

    // The file REALLY lives in the repository tree.
    const project = s.app.store.projects.byId(s.projectId)!
    const files = s.app.projects.storage.readBranchFiles(project.disk_path, project.default_branch)
    expect(files.has('.lsgit/issues/forms/bug_report.yml')).toBe(true)

    const list = await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/issue_forms` })
    const forms = list.json().forms as Array<Record<string, unknown>>
    expect(forms).toHaveLength(1)
    expect(forms[0]).toMatchObject({ name: 'bug_report', title: 'Bug report', valid: true, field_count: 5 })

    const def = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/issue_forms/bug_report`, {})
    const form = def.json().form as Record<string, unknown>
    expect(form.title_prefix).toBe('[bug] ')
    expect((form.fields as Array<Record<string, unknown>>).map((f) => f.id)).toEqual([
      'summary', 'details', 'severity', 'consent', 'triage',
    ])
  })

  it('REFUSES to store invalid or hostile templates (validate-before-commit)', async () => {
    const s = await setup()
    const badSchema = await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/issue_forms/bad`, {
      session: s.alice,
      payload: { yaml: 'description: no name or fields\n' },
    })
    expect(badSchema.statusCode).toBe(400)

    const hostile = await authed(s.app, 'PUT', `/api/v1/projects/${s.projectId}/issue_forms/evil`, {
      session: s.alice,
      payload: { yaml: 'a: !!python/object/new:os.system ["x"]\n' },
    })
    expect(hostile.statusCode).toBe(400)
    expect(String(hostile.json().message)).toContain('tags')

    // Nothing was written — the forms directory does not exist in the repo.
    const list = await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/issue_forms` })
    expect(list.json().forms).toEqual([])
  })

  it('deletes templates with a removal commit', async () => {
    const s = await setup()
    await saveForm(s)
    const del = await authed(s.app, 'DELETE', `/api/v1/projects/${s.projectId}/issue_forms/bug_report`, { session: s.alice })
    expect(del.statusCode).toBe(200)
    const list = await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/issue_forms` })
    expect(list.json().forms).toEqual([])
  })

  it('rejects invalid names that could escape the forms directory', async () => {
    const s = await setup()
    await saveForm(s)
    for (const evil of ['../evil', '..%2Fevil', 'a/b', '.hidden']) {
      const r = await authed(s.app, 'DELETE', `/api/v1/projects/${encodeURIComponent(s.projectId)}/issue_forms/${encodeURIComponent(evil)}`, { session: s.alice })
      expect([400, 404]).toContain(r.statusCode)
    }
  })
})

// -- submissions ------------------------------------------------------------------

describe('form submissions create structured issues', () => {
  const VALID_ANSWERS = {
    summary: 'Login page crashes',
    details: 'Open /login, submit the form, observe a blank screen.',
    severity: 'high',
    consent: true,
    triage: ['collect logs'],
  }

  async function seedIssueForm(s: Awaited<ReturnType<typeof setup>>) {
    await saveForm(s)
  }

  it('creates the issue with rendered body, prefixed title and labels', async () => {
    const s = await setup()
    await seedIssueForm(s)

    const res = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issue_forms/bug_report/submissions`, {
      session: s.bob,
      payload: { answers: VALID_ANSWERS },
    })
    expect(res.statusCode).toBe(201)
    const issue = res.json().issue as Record<string, unknown>

    // Title: prefix + title_field answer.
    expect(issue.title).toBe('[bug] Login page crashes')
    // Metadata: existing configured labels applied; author preserved.
    expect((issue.labels as Array<Record<string, unknown>>).map((l) => l.title)).toEqual(['bug'])
    expect(issue.author).toMatchObject({ username: 'bob' })

    // Body is STRUCTURED: one section per answered field + provenance footer.
    const body = String(issue.description)
    expect(body).toContain('### Summary\n\nLogin page crashes')
    expect(body).toContain('### Severity\n\nhigh')
    expect(body).toContain('### Details\n\nOpen /login')
    expect(body).toContain('_Submitted via form `Bug report`._')

    // Task-list integration: consent checkbox [x] + triage tasks (1 of 2 done)
    // ⇒ 3 checkbox lines in total, 2 already complete.
    expect(issue.task_progress).toEqual({ total: 3, completed: 2 })

    // The created issue participates in normal lifecycle endpoints.
    const iid = issue.iid as number
    const single = await authed(s.app, 'GET', `/api/v1/projects/${s.projectId}/issues/${iid}`, { session: s.alice })
    expect(single.statusCode).toBe(200)
  })

  it('rejects invalid submissions with 422 and never creates an issue', async () => {
    const s = await setup()
    await seedIssueForm(s)
    const before = s.app.store.issues.countForProject(s.projectId)

    const cases: Array<{ answers: Record<string, unknown>; field?: string }> = [
      { answers: {}, field: 'summary' }, // everything required missing
      { answers: { ...VALID_ANSWERS, summary: 'abc' }, field: 'summary' }, // min_length
      { answers: { ...VALID_ANSWERS, severity: 'CATASTROPHIC' }, field: 'severity' }, // membership
      { answers: { ...VALID_ANSWERS, consent: false }, field: 'consent' }, // required checkbox
      { answers: { ...VALID_ANSWERS, invented: 'x' }, field: 'invented' }, // unknown id
      { answers: { ...VALID_ANSWERS, details: 42 }, field: 'details' }, // wrong type
    ]
    for (const c of cases) {
      const r = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issue_forms/bug_report/submissions`, {
        session: s.bob,
        payload: { answers: c.answers },
      })
      expect(r.statusCode).toBe(422)
      if (c.field) expect((r.json() as { field?: string }).field).toBe(c.field)
    }
    expect(s.app.store.issues.countForProject(s.projectId)).toBe(before)
  })

  it('guards against templates corrupted AFTER storage (defense in depth)', async () => {
    const s = await setup()
    const alice = s.app.store.users.byUsername('alice')!
    const actor = { userId: alice.id, username: 'alice', admin: false, state: 'active' as const, via: { kind: 'session' as const } }

    // Write a HOSTILE template straight into the repository, bypassing
    // saveForm's validation — simulates a malicious push.
    s.app.repositories.commitChanges(actor, s.projectId, {
      branch: 'main',
      message: 'hostile template',
      changes: [{ path: '.lsgit/issues/forms/evil.yml', content: 'a: !!python/object/new:os.system ["x"]\n' }],
    })

    // Listing flags it invalid instead of crashing or executing…
    const list = await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/issue_forms` })
    const evil = (list.json().forms as Array<Record<string, unknown>>).find((f) => f.name === 'evil')!
    expect(evil.valid).toBe(false)
    expect(String(evil.error)).toContain('tags')

    // …the definition endpoint refuses with 422…
    expect(
      (await s.app.inject({ method: 'GET', url: `/api/v1/projects/${s.projectId}/issue_forms/evil` })).statusCode,
    ).toBe(422)

    // …and submissions fail closed with 422. Nothing ever executed.
    expect(
      (
        await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issue_forms/evil/submissions`, {
          session: s.bob,
          payload: { answers: {} },
        })
      ).statusCode,
    ).toBe(422)
  })

  it('explicit submission titles override title_field', async () => {
    const s = await setup()
    await seedIssueForm(s)
    const r = await authed(s.app, 'POST', `/api/v1/projects/${s.projectId}/issue_forms/bug_report/submissions`, {
      session: s.bob,
      payload: { title: 'Custom headline', answers: { ...VALID_ANSWERS, summary: 'Field value ignored' } },
    })
    expect(r.statusCode).toBe(201)
    expect((r.json().issue as Record<string, unknown>).title).toBe('[bug] Custom headline')
  })
})
