import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginRaw, extractSession, authed } from './helpers.js'
import type { FastifyInstance } from 'fastify'

/**
 * Code-review tests: inline single/multi-line threads, replies, resolve,
 * outdated diff handling, suggestion apply/batch (REAL commits), reviews
 * (approve / request changes / comment-only), drafts, permissions, and the
 * approvals-reset-on-push policy.
 */

interface Harness {
  app: FastifyInstance
  projectId: number
  alice: ReturnType<typeof extractSession>
  bob: ReturnType<typeof extractSession>
}

const FILE_V1 = 'alpha\nbeta\ngamma\ndelta\nepsilon\n'

async function setup(): Promise<Harness> {
  const app = makeApp()
  await registerUser(app)
  const alice = extractSession((await loginRaw(app, 'alice')).cookies)
  await registerUser(app, { username: 'bob', email: 'bob@example.com' })
  const bob = extractSession((await loginRaw(app, 'bob')).cookies)
  const res = await authed(app, 'POST', '/api/v1/projects', {
    session: alice,
    payload: {
      name: 'Review', path: 'review-pr', visibility: 'public',
      description: '', website_url: '', default_branch: 'main',
      topics: [], initialize_with_readme: true,
    },
  })
  expect(res.statusCode).toBe(201)
  const projectId = app.store.projects.byOwnerPath('alice', 'review-pr')!.id

  // Base file on main, then a feature branch that MODIFIES it (so the diff exists).
  await authed(app, 'POST', `/api/v1/projects/${projectId}/repository/commit`, {
    session: alice,
    payload: {
      branch: 'main', commit_message: 'base file',
      changes: [{ path: 'src.txt', content: FILE_V1 }],
    },
  })
  await authed(app, 'POST', `/api/v1/projects/${projectId}/repository/commit`, {
    session: alice,
    payload: {
      branch: 'feature', new_branch: 'feature', start_branch: 'main',
      commit_message: 'edit gamma line',
      changes: [{ path: 'src.txt', content: FILE_V1.replace('gamma', 'GAMMA-EDITED') }],
    },
  })
  return { app, projectId, alice, bob }
}

async function openPr(h: Harness): Promise<Record<string, unknown>> {
  const res = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests`, {
    session: h.alice,
    payload: { title: 'Diff PR', source_branch: 'feature', target_branch: 'main' },
  })
  expect(res.statusCode).toBe(201)
  return res.json()
}

function engineOf(h: Harness) {
  return h.app.projects.storage.repository(h.app.store.projects.byId(h.projectId)!.disk_path)
}

async function createThread(
  h: Harness,
  session: Harness['bob'],
  body: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/threads`, {
    session,
    payload: { body, ...extra },
  })
  return { status: res.statusCode, body: res.json() }
}

// ── inline comments ─────────────────────────────────────────────────────────

describe('inline diff comments', () => {
  it('creates a SINGLE-LINE thread with validated position and covered lines', async () => {
    const h = await setup()
    const pr = await openPr(h)
    const iid = pr.iid as number

    const r = await createThread(h, h.bob, 'This line looks wrong.', {
      path: 'src.txt', side: 'new', line_start: 3, line_end: 3,
    })
    expect(r.status).toBe(201)
    const thread = ((r.body as Record<string, unknown>).thread ?? r.body) as unknown as Record<string, unknown>
    expect(thread.path).toBe('src.txt')
    expect(thread.line_start).toBe(3)
    expect(thread.line_end).toBe(3)
    // Outdated-ness is computed at read time, not stored — verified via list.

    const list = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/${iid}/threads`, {})
    const threads = list.json().threads as Array<Record<string, unknown>>
    expect(threads).toHaveLength(1)
    expect(((threads[0]!.notes as Array<Record<string, unknown>>)[0]!).body).toBe('This line looks wrong.')
  })

  it('creates MULTI-LINE threads spanning an inclusive range', async () => {
    const h = await setup()
    await openPr(h)
    const r = await createThread(h, h.bob, 'These two lines together read oddly.', {
      path: 'src.txt', side: 'new', line_start: 2, line_end: 3,
    })
    expect(r.status).toBe(201)
    expect(r.body.line_end).toBe(3)
  })

  it('REJECTS invalid positions: missing file, out-of-bounds, inverted ranges', async () => {
    const h = await setup()
    await openPr(h)
    expect(
      (
        await createThread(h, h.bob, 'x', { path: 'nope.txt', side: 'new', line_start: 1, line_end: 1 })
      ).status,
    ).toBe(422)
    expect(
      (
        await createThread(h, h.bob, 'x', { path: 'src.txt', side: 'new', line_start: 99, line_end: 100 })
      ).status,
    ).toBe(422)
    expect(
      (
        await createThread(h, h.bob, 'x', { path: 'src.txt', side: 'new', line_start: 4, line_end: 2 })
      ).status,
    ).toBe(422)
  })

  it('supports replies on a thread; resolve/reopen records system notes', async () => {
    const h = await setup()
    await openPr(h)
    const t = await createThread(h, h.bob, 'Initial concern.', {
      path: 'src.txt', side: 'new', line_start: 3, line_end: 3,
    })
    const tid = (t.body as unknown as { id: number }).id

    const reply = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/threads/${tid}/replies`, {
      session: h.alice,
      payload: { body: 'Fixed in the next commit.' },
    })
    expect(reply.statusCode).toBe(201)

    const resolved = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/threads/${tid}/resolve`, {
      session: h.alice,
    })
    expect(resolved.json().resolved).toBe(true)

    const reopened = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/threads/${tid}/unresolve`, {
      session: h.bob,
    })
    expect(reopened.json().resolved).toBe(false)

    const tl = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1/notes`, { session: h.alice })
    const bodies = (tl.json().notes as Array<Record<string, string>>).map((n) => n.body)
    expect(bodies.some((b) => b.includes('resolved the thread on src.txt'))).toBe(true)
    expect(bodies.some((b) => b.includes('reopened the thread on src.txt'))).toBe(true)
  })
})

// ── outdated diff comments ────────────────────────────────────────────────────

describe('outdated diff handling', () => {
  it('marks threads OUTDATED after the source branch moves; replies still work', async () => {
    const h = await setup()
    await openPr(h)
    const t = await createThread(h, h.bob, 'Commented on GAMMA-EDITED.', {
      path: 'src.txt', side: 'new', line_start: 3, line_end: 3,
    })

    // Push new commits to the feature branch.
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/repository/commit`, {
      session: h.alice,
      payload: {
        branch: 'feature', commit_message: 'more work',
        changes: [{ path: 'extra.txt', content: 'extra\n' }],
      },
    })

    const list = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1/threads`, {})
    const thread = (list.json().threads as Array<Record<string, unknown>>)[0]!
    expect(thread.outdated).toBe(true)

    // Replying to outdated threads remains possible (GitLab parity).
    const tid = (t.body as unknown as { id: number }).id
    expect(
      (
        await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/threads/${tid}/replies`, {
          session: h.alice,
          payload: { body: 'Still relevant context.' },
        })
      ).statusCode,
    ).toBe(201)
  })
})

// ── suggestions ───────────────────────────────────────────────────────────────

describe('code suggestions', () => {
  async function suggestOnGamma(h: Harness): Promise<{ noteId: number }> {
    const t = await createThread(h, h.bob, [
      '```suggestion',
      'gamma-fixed',
      '```',
    ].join('\n'), { path: 'src.txt', side: 'new', line_start: 3, line_end: 3 })
    expect(t.status).toBe(201)
    const notes = ((t.body as unknown as Record<string, unknown>).notes ?? []) as Array<Record<string, unknown>>
    return { noteId: notes[0]!.id as number }
  }

  it('APPLY produces a REAL commit on the source branch with the suggested lines', async () => {
    const h = await setup()
    await openPr(h)
    const { noteId } = await suggestOnGamma(h)

    const applied = await authed(
      h.app,
      'POST',
      `/api/v1/projects/${h.projectId}/pull_requests/1/thread_notes/${noteId}/suggestions/apply`,
      { session: h.alice },
    )
    expect(applied.statusCode).toBe(200)
    const sha = (applied.json() as { commit_sha: string }).commit_sha

    // The commit REALLY exists on the branch with the replaced line.
    const repo = engineOf(h)
    const tip = repo.resolveBranch('feature')!
    expect(repo.readCommit(tip).sha).toBe(sha)
    const blob = repo.findEntryAt(repo.readCommit(tip).tree, 'src.txt')!.sha
    const text = repo.readBlob(blob).toString()
    expect(text).toContain('gamma-fixed')
    expect(text).not.toContain('GAMMA-EDITED')

    // Note status flipped to applied.
    const list = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1/threads`, {})
    const note = (((list.json().threads as Array<Record<string, unknown>>)[0]!.notes) as Array<Record<string, unknown>>)[0]!
    expect(note.suggestion).toMatchObject({ status: 'applied' })
  })

  it('BATCH apply lands multiple suggestions as ONE atomic commit — all-or-nothing', async () => {
    const h = await setup()
    await openPr(h)

    const s1 = await createThread(h, h.bob, ['```suggestion', 'ALPHA-BATCH', '```'].join('\n'), {
      path: 'src.txt', side: 'new', line_start: 1, line_end: 1,
    })
    const s2 = await createThread(h, h.bob, ['```suggestion', 'EPSILON-BATCH', '```'].join('\n'), {
      path: 'src.txt', side: 'new', line_start: 5, line_end: 5,
    })
    const idOf = (r: { status: number; body: Record<string, unknown> }) =>
      ((((r.body as Record<string, unknown>).notes) as Array<Record<string, unknown>>)[0]!.id) as number

    // A failing member blocks the WHOLE batch — nothing is committed.
    const stale = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/repository/commit`, {
      session: h.alice,
      payload: {
        branch: 'feature', commit_message: 'break batch',
        changes: [{ path: 'src.txt', content: 'totally different\nbeta\nGAMMA-EDITED\ndelta\nepsilon\n' }],
      },
    })
    expect(stale.statusCode).toBe(201)
    const blockedBatch = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/suggestions/apply`, {
      session: h.alice,
      payload: { suggestion_note_ids: [idOf(s1), idOf(s2)] },
    })
    expect(blockedBatch.statusCode).toBe(422)
    expect(engineOf(h).readCommit(engineOf(h).resolveBranch('feature')!).message).toContain('break batch')

    // Restore original content so the two suggestions are applicable again…
    const restore = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/repository/commit`, {
      session: h.alice,
      payload: {
        branch: 'feature', commit_message: 'restore for batch',
        changes: [{ path: 'src.txt', content: FILE_V1.replace('gamma', 'GAMMA-EDITED') }],
      },
    })
    expect(restore.statusCode).toBe(201)

    const ok = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/suggestions/apply`, {
      session: h.alice,
      payload: { suggestion_note_ids: [idOf(s1), idOf(s2)] },
    })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { applied: number }).applied).toBe(2)

    // ONE commit containing BOTH replacements.
    const repo = engineOf(h)
    const tip = repo.resolveBranch('feature')!
    expect(repo.readCommit(tip).message).toContain('Apply 2 suggestions')
    const blob = repo.findEntryAt(repo.readCommit(tip).tree, 'src.txt')!.sha
    const text = repo.readBlob(blob).toString()
    expect(text).toContain('ALPHA-BATCH')
    expect(text).toContain('EPSILON-BATCH')
    expect(text).toContain('GAMMA-EDITED') // untouched middle line intact
  })

  it('REFUSES outdated suggestions and never edits arbitrary code paths (permission + position)', async () => {
    const h = await setup()
    await openPr(h)
    const { noteId } = await suggestOnGamma(h)

    // Bob lacks push rights → 403 BEFORE any effect.
    const denied = await authed(
      h.app,
      'POST',
      `/api/v1/projects/${h.projectId}/pull_requests/1/thread_notes/${noteId}/suggestions/apply`,
      { session: h.bob },
    )
    expect(denied.statusCode).toBe(403)

    // Make the thread outdated by rewriting the covered region.
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/repository/commit`, {
      session: h.alice,
      payload: {
        branch: 'feature', commit_message: 'shift lines',
        changes: [{ path: 'src.txt', content: FILE_V1.replace('GAMMA-EDITED', 'GAMMA-REWITTEN-ELSEWHERE') }],
      },
    })
    const outdated = await authed(
      h.app,
      'POST',
      `/api/v1/projects/${h.projectId}/pull_requests/1/thread_notes/${noteId}/suggestions/apply`,
      { session: h.alice },
    )
    expect(outdated.statusCode).toBe(422)
    // The file at the tip was NOT modified by the refused apply.
    const repo = engineOf(h)
    const blob = repo.findEntryAt(repo.readCommit(repo.resolveBranch('feature')!).tree, 'src.txt')!.sha
    expect(repo.readBlob(blob).toString()).toContain('GAMMA-REWITTEN-ELSEWHERE')
  })

  it('reject flow: only the suggestion author or a maintainer can reject', async () => {
    const h = await setup()
    await openPr(h)
    const { noteId } = await suggestOnGamma(h)

    // Carol (third user, neither author nor maintainer) cannot reject.
    await registerUser(h.app, { username: 'carol', email: 'carol@example.com' })
    const carol = extractSession((await loginRaw(h.app, 'carol')).cookies)
    expect(
      (
        await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/thread_notes/${noteId}/suggestions/reject`, {
          session: carol,
        })
      ).statusCode,
    ).toBe(403)

    // The author of the PR (maintainer-equivalent) CAN reject.
    expect(
      (
        await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/thread_notes/${noteId}/suggestions/reject`, {
          session: h.alice,
        })
      ).statusCode,
    ).toBe(200)
  })
})

// ── reviews ───────────────────────────────────────────────────────────────────

describe('reviews: draft → submit → approve / request changes / comment-only', () => {
  async function addDraft(h: Harness, session: Harness['bob'], payload: Record<string, unknown>) {
    return authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/draft_comments`, {
      session, payload,
    })
  }

  it('drafts are per-user, publishable, and approve grants the approval vote', async () => {
    const h = await setup()
    await openPr(h)

    await addDraft(h, h.bob, { body: 'Inline nit.', path: 'src.txt', side: 'new', line_start: 2, line_end: 2 })
    await addDraft(h, h.bob, { body: 'General remark without a line.' })

    const mine = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1/draft_comments`, {
      session: h.bob,
    })
    expect((mine.json().drafts as unknown[]).length).toBe(2)
    // Drafts are private to their author.
    const aliceView = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1/draft_comments`, {
      session: h.alice,
    })
    expect(aliceView.json().drafts).toEqual([])

    const submit = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/reviews`, {
      session: h.bob,
      payload: { state: 'approved', body: 'Looks great.' },
    })
    expect(submit.statusCode).toBe(200)
    expect(submit.json().published_drafts).toBe(2)
    expect((submit.json().pull_request as Record<string, unknown>).approvals).toMatchObject({ count: 1, required: 0 })

    // Drafts cleared after publishing; threads created from positioned drafts.
    expect((mine ? (await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1/draft_comments`, { session: h.bob })).json().drafts : []).length).toBe(0)
    const tl = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1/threads`, {})
    expect((tl.json().threads as unknown[]).length).toBe(1)

    const reviews = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1/reviews`, {})
    const rows = reviews.json().reviews as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'approved' })
    expect((rows[0]!.reviewer as Record<string, unknown>).username).toBe('bob')
  })

  it('REQUEST CHANGES revokes the reviewer approval and flips reviewer state', async () => {
    const h = await setup()
    await openPr(h)
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/approve`, { session: h.bob })

    const rc = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/reviews`, {
      session: h.bob,
      payload: { state: 'changes_requested', body: 'Please split this.' },
    })
    const prAfter = rc.json().pull_request as Record<string, unknown>
    expect(prAfter.approvals).toMatchObject({ count: 0 }) // revoked
    expect(((prAfter.reviewers as Array<Record<string, unknown>>)[0]!).review_state).toBe('changes_requested')

    const latest = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1/reviews`, {})
    expect(((latest.json().reviews as Array<Record<string, unknown>>)[0]!).state).toBe('changes_requested')
  })

  it('comment-only review leaves approvals untouched', async () => {
    const h = await setup()
    await openPr(h)
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/approve`, { session: h.bob })
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/reviews`, {
      session: h.bob,
      payload: { state: 'commented', body: 'Just noting something.' },
    })
    const fresh = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1`, { session: h.alice })
    expect((fresh.json().approvals as { count: number }).count).toBe(1)
  })

  it('AUTHOR cannot submit an approving review (self-approval restriction)', async () => {
    const h = await setup()
    await openPr(h)
    const r = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/reviews`, {
      session: h.alice,
      payload: { state: 'approved' },
    })
    expect(r.statusCode).toBe(422)
    expect((r.json() as { code?: string }).code).toBe('self_approval_denied')
    // …but a comment-only review by the author is fine.
    expect(
      (
        await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/reviews`, {
          session: h.alice,
          payload: { state: 'commented', body: 'Clarifying intent.' },
        })
      ).statusCode,
    ).toBe(200)
  })

  it('approvals RESET when policy requires it and the branch moves ("branch update after review")', async () => {
    const h = await setup()
    await openPr(h)
    h.app.store.db.run('UPDATE projects SET reset_approvals_on_push = 1 WHERE id = ?', h.projectId)
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/approve`, { session: h.bob })

    let fresh = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1`, { session: h.alice })
    expect((fresh.json().approvals as { count: number }).count).toBe(1)

    // Push new commits to the source branch, then hit any PR read path.
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/repository/commit`, {
      session: h.alice,
      payload: {
        branch: 'feature', commit_message: 'force re-review',
        changes: [{ path: 'another.txt', content: 'x\n' }],
      },
    })
    fresh = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1`, { session: h.alice })
    expect((fresh.json().approvals as { count: number }).count).toBe(0)

    const tl = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1/notes`, { session: h.alice })
    const bodies = (tl.json().notes as Array<Record<string, string>>).map((n) => n.body)
    expect(bodies.some((b) => b.includes('approvals were reset because new commits were pushed'))).toBe(true)
  })

  it('reset does NOT fire while the policy is off', async () => {
    const h = await setup()
    await openPr(h)
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/pull_requests/1/approve`, { session: h.bob })
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/repository/commit`, {
      session: h.alice,
      payload: {
        branch: 'feature', commit_message: 'push with policy off',
        changes: [{ path: 'n.txt', content: 'n\n' }],
      },
    })
    const fresh = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1`, { session: h.alice })
    expect((fresh.json().approvals as { count: number }).count).toBe(1)
  })
})

// ── CODEOWNERS foundation ─────────────────────────────────────────────────────

describe('CODEOWNERS foundation', () => {
  it('parses rules and reports per-path ownership coverage', async () => {
    const h = await setup()
    await openPr(h)
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/repository/commit`, {
      session: h.alice,
      payload: {
        branch: 'main', commit_message: 'add codeowners',
        changes: [{ path: 'CODEOWNERS', content: '# comment\n* @alice\nsrc/ @bob @legacy-team\n' }],
      },
    })
    const cov = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/pull_requests/1/codeowners`, {})
    expect(cov.statusCode).toBe(200)
    const rules = cov.json().rules as Array<Record<string, unknown>>
    expect(rules).toHaveLength(2)
    const coverage = cov.json().coverage as Array<{ path: string; owner_users: string[] }>
    const srcRow = coverage.find((c) => c.path === 'src.txt')!
    expect(srcRow.owner_users).toEqual(['bob']) // last match wins
  })
})
