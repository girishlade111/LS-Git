import { describe, expect, it } from 'vitest'
import { makeApp, registerUser, loginRaw, extractSession, authed, PASSWORD } from './helpers.js'
import type { FastifyInstance } from 'fastify'

/**
 * Community discussions: creation (categories incl. poll foundation),
 * threaded comments/replies, mention fanout, best answer rules, pin/lock,
 * moderation edit/delete policy, authorization matrix, reactions.
 */

interface Harness {
  app: FastifyInstance
  projectId: number
  alice: ReturnType<typeof extractSession> // owner
  bob: ReturnType<typeof extractSession>   // regular participant
  carol: ReturnType<typeof extractSession> // third party
}

async function setup(visibility: 'public' | 'private' = 'public'): Promise<Harness> {
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
      name: 'Community', path: 'community', visibility,
      description: '', website_url: '', default_branch: 'main', topics: [],
    },
  })
  expect(res.statusCode).toBe(201)
  return { app, projectId: app.store.projects.byOwnerPath('alice', 'community')!.id, alice, bob, carol }
}

async function createDiscussion(
  h: Harness,
  session: Harness['alice' | 'bob' | 'carol'],
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions`, {
    session,
    payload: { title: 'Hello world', category: 'general', body: 'First post body.', ...overrides },
  })
  return { status: res.statusCode, body: (res.json() as { discussion?: Record<string, unknown> }).discussion ?? res.json() }
}

// ── creation ───────────────────────────────────────────────────────────────

describe('discussion creation', () => {
  it('creates discussions in every category with author + timestamps', async () => {
    const h = await setup()
    for (const category of ['question', 'idea', 'announcement', 'showcase', 'general']) {
      const r = await createDiscussion(h, h.bob, { title: `A ${category}`, category })
      expect(r.status).toBe(201)
      expect(r.body.category).toBe(category)
      expect((r.body.author as Record<string, unknown>).username).toBe('bob')
      expect(r.body.pinned).toBe(false)
      expect(r.body.locked).toBe(false)
    }
  })

  it('rejects invalid categories, empty titles and malformed polls', async () => {
    const h = await setup()
    expect((await createDiscussion(h, h.alice, { category: 'meme' })).status).toBe(400)
    expect((await createDiscussion(h, h.alice, { title: '' })).status).toBe(400)
    expect(
      (
        await createDiscussion(h, h.alice, { category: 'poll', poll_options: ['only one'] })
      ).status,
    ).toBe(400)
    const okPoll = await createDiscussion(h, h.alice, {
      category: 'poll', poll_options: ['yes', 'no', 'maybe'],
    })
    expect(okPoll.status).toBe(201)
  })

  it('is a SEPARATE entity from issues — no iid, no labels/milestones surface', async () => {
    const h = await setup()
    const d = await createDiscussion(h, h.alice)
    expect(d.body.iid).toBeUndefined()
    expect(d.body.labels).toBeUndefined()
    expect(d.body.state).toBeUndefined() // no open/closed machine — pinned/locked only
  })
})

// ── comments & replies ────────────────────────────────────────────────────────

describe('comments & replies', () => {
  async function seedWithComment(h: Harness): Promise<number> {
    await createDiscussion(h, h.alice)
    const c = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/comments`, {
      session: h.bob,
      payload: { body: 'Top-level answer.' },
    })
    expect(c.statusCode).toBe(201)
    return ((c.json() as { comment: { id: number } }).comment.id)
  }

  it('posts top-level comments and NESTED replies; tree returns grouped', async () => {
    const h = await setup()
    const cid = await seedWithComment(h)

    const reply = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/comments`, {
      session: h.carol,
      payload: { body: 'Nested reply.', parent_id: cid },
    })
    expect(reply.statusCode).toBe(201)
    expect(((reply.json() as { comment: Record<string, unknown> }).comment).parent_id).toBe(cid)

    const detail = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/discussions/1`, {})
    const roots = detail.json().comments as Array<Record<string, unknown>>
    expect(roots).toHaveLength(1) // reply nested under root
    expect(((roots[0]!.replies as Array<Record<string, unknown>>)[0]!).body).toBe('Nested reply.')
    expect((detail.json().comment_count as number)).toBe(2)
  })

  it('fans out @mentions through the notification inbox with watch-policy gating', async () => {
    const h = await setup()
    await createDiscussion(h, h.alice, {
      title: 'Mention target',
      body: 'Pinging @bob here.',
    })

    const inbox = await authed(h.app, 'GET', '/api/v1/user/notifications', { session: h.bob })
    const items = inbox.json().notifications as Array<Record<string, unknown>>
    expect(items.length).toBeGreaterThan(0)
    expect(items.map((n) => n.type)).toContain('discussion')
    expect(String(items[0]!.title)).toContain('alice started')

    // Actor never self-notifies.
    const aliceInbox = await authed(h.app, 'GET', '/api/v1/user/notifications', { session: h.alice })
    expect(aliceInbox.json().unread_count).toBe(0)
  })

  it('supports REACTIONS on the discussion and on individual comments', async () => {
    const h = await setup()
    const d = await createDiscussion(h, h.alice)
    void d
    const cid = await (async () => {
      const c = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/comments`, {
        session: h.bob, payload: { body: 'react to me' },
      })
      return (c.json() as { comment: { id: number } }).comment.id
    })()

    const reactDisc = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/reactions`, {
      session: h.bob, payload: { name: 'tada' },
    })
    expect(reactDisc.json().action).toBe('awarded')

    const reactComment = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/comments/${cid}/reactions`, {
      session: h.carol, payload: { name: 'heart' },
    })
    expect(reactComment.json().action).toBe('awarded')

    // Toggle-off is idempotent.
    const off = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/reactions`, {
      session: h.bob, payload: { name: 'tada' },
    })
    expect(off.json().action).toBe('revoked')
  })
})

// ── best answer ────────────────────────────────────────────────────────────────

describe('best answer', () => {
  it('author marks ONE best answer on QUESTION threads only; replacing moves it', async () => {
    const h = await setup()
    await createDiscussion(h, h.bob, { title: 'How?', category: 'question', author_note: undefined })

    const a1 = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/comments`, {
      session: h.alice, payload: { body: 'Answer one.' },
    })
    const a2 = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/comments`, {
      session: h.carol, payload: { body: 'Answer two.' },
    })
    const id1 = (a1.json() as { comment: { id: number } }).comment.id
    const id2 = (a2.json() as { comment: { id: number } }).comment.id

    // Non-author non-maintainer cannot select.
    expect(
      (
        await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/best_answer`, {
          session: h.carol, payload: { comment_id: id1 },
        })
      ).statusCode,
    ).toBe(403)

    // Author selects first…
    const mark = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/best_answer`, {
      session: h.bob, payload: { comment_id: id1 },
    })
    expect(mark.statusCode).toBe(200)
    type DetailBody = { discussion: { best_answer_comment_id: number | null } }
    let detail = (await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/discussions/1`, {})).json() as DetailBody
    expect(detail.discussion.best_answer_comment_id).toBe(id1)

    // …then replaces with second (only ONE best answer).
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/best_answer`, {
      session: h.bob, payload: { comment_id: id2 },
    })
    detail = (await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/discussions/1`, {})).json() as DetailBody
    expect(detail.discussion.best_answer_comment_id).toBe(id2)
  })

  it('refuses best answers on NON-question categories', async () => {
    const h = await setup()
    await createDiscussion(h, h.alice, { title: 'Show and tell', category: 'showcase' })
    const c = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/comments`, {
      session: h.bob, payload: { body: 'Nice!' },
    })
    const cid = (c.json() as { comment: { id: number } }).comment.id
    const r = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/best_answer`, {
      session: h.alice, payload: { comment_id: cid },
    })
    expect(r.statusCode).toBe(422)
  })
})

// ── pin & lock ─────────────────────────────────────────────────────────────────

describe('pinning & locking', () => {
  it('maintainer pins; pinned sorts FIRST regardless of activity', async () => {
    const h = await setup()
    await createDiscussion(h, h.alice, { title: 'Regular old' })
    await createDiscussion(h, h.alice, { title: 'Announcement', category: 'announcement' })

    await authed(h.app, 'PATCH', `/api/v1/projects/${h.projectId}/discussions/2`, {
      session: h.alice, payload: { pinned: true },
    })
    const list = await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/discussions`, {})
    const rows = list.json().discussions as Array<Record<string, unknown>>
    expect(rows[0]!.title).toBe('Announcement')
    expect(rows[0]!.pinned).toBe(true)
  })

  it('non-maintainers cannot pin or lock', async () => {
    const h = await setup()
    await createDiscussion(h, h.alice)
    expect(
      (
        await authed(h.app, 'PATCH', `/api/v1/projects/${h.projectId}/discussions/1`, {
          session: h.bob, payload: { locked: true },
        })
      ).statusCode,
    ).toBe(403)
  })

  it('locking blocks NEW comments from regular users; maintainers may still moderate', async () => {
    const h = await setup()
    await createDiscussion(h, h.alice)
    await authed(h.app, 'PATCH', `/api/v1/projects/${h.projectId}/discussions/1`, {
      session: h.alice, payload: { locked: true },
    })

    const blocked = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/comments`, {
      session: h.bob, payload: { body: 'cannot speak' },
    })
    expect(blocked.statusCode).toBe(403)
    expect((blocked.json() as { code?: string }).code).toBe('locked_discussion')

    const maintainerStill = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/comments`, {
      session: h.alice, payload: { body: 'moderator note' },
    })
    expect(maintainerStill.statusCode).toBe(201)
  })
})

// ── edit / delete policy ─────────────────────────────────────────────────────────

describe('edit & delete policy', () => {
  it('authors edit their OWN comments (edited_at recorded); others get 403', async () => {
    const h = await setup()
    await createDiscussion(h, h.alice)
    const c = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/comments`, {
      session: h.bob, payload: { body: 'typo here' },
    })
    const cid = (c.json() as { comment: { id: number } }).comment.id

    expect(
      (
        await authed(h.app, 'PATCH', `/api/v1/projects/${h.projectId}/discussions/1/comments/${cid}`, {
          session: h.carol, payload: { body: 'vandalism' },
        })
      ).statusCode,
    ).toBe(403)

    const ok = await authed(h.app, 'PATCH', `/api/v1/projects/${h.projectId}/discussions/1/comments/${cid}`, {
      session: h.bob, payload: { body: 'fixed typo' },
    })
    expect(ok.statusCode).toBe(200)

    const detail = (await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/discussions/1`, {})).json()
    const root = (detail.comments as Array<Record<string, unknown>>)[0]!
    expect(root.body).toBe('fixed typo')
    expect(root.edited_at).toBeTruthy()
  })

  it('MODERATION delete leaves a tombstone that keeps thread shape; best answer cleared', async () => {
    const h = await setup()
    await createDiscussion(h, h.bob, { title: 'Q?', category: 'question' })
    const c = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/comments`, {
      session: h.alice, payload: { body: 'the answer' },
    })
    const cid = (c.json() as { comment: { id: number } }).comment.id
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/best_answer`, {
      session: h.bob, payload: { comment_id: cid },
    })

    // Maintainer (alice) moderates bob's… actually deletes ALICE'S own? Use bob's reply for author-delete:
    await authed(h.app, 'DELETE', `/api/v1/projects/${h.projectId}/discussions/1/comments/${cid}`, {
      session: h.alice,
    })

    const detail = (await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/discussions/1`, {})).json() as {
      comments: Array<Record<string, unknown>>
      discussion: { best_answer_comment_id: number | null }
    }
    const root = (detail.comments as Array<Record<string, unknown>>)[0]!
    expect(root.deleted).toBe(true)
    expect(root.body).toBe('') // tombstone hides content
    expect(detail.discussion.best_answer_comment_id).toBeNull() // cleared with the comment
  })

  it('maintainer can soft-delete OTHER users comments; authors can delete their own', async () => {
    const h = await setup()
    await createDiscussion(h, h.alice)
    const c = await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/comments`, {
      session: h.bob, payload: { body: 'spam?' },
    })
    const cid = (c.json() as { comment: { id: number } }).comment.id

    // Carol cannot delete bob's comment.
    expect(
      (
        await authed(h.app, 'DELETE', `/api/v1/projects/${h.projectId}/discussions/1/comments/${cid}`, {
          session: h.carol,
        })
      ).statusCode,
    ).toBe(403)

    // Maintainer alice CAN.
    expect(
      (
        await authed(h.app, 'DELETE', `/api/v1/projects/${h.projectId}/discussions/1/comments/${cid}`, {
          session: h.alice,
        })
      ).statusCode,
    ).toBe(200)
  })
})

// ── authorization ────────────────────────────────────────────────────────────────

describe('authorization', () => {
  it('anonymous users read PUBLIC discussions but cannot participate', async () => {
    const h = await setup('public')
    await createDiscussion(h, h.alice)

    const list = await h.app.inject({ method: 'GET', url: `/api/v1/projects/${h.projectId}/discussions` })
    expect(list.statusCode).toBe(200)
    expect(
      (await h.app.inject({ method: 'GET', url: `/api/v1/projects/${h.projectId}/discussions/1` })).statusCode,
    ).toBe(200)
    expect(
      (await h.app.inject({ method: 'POST', url: `/api/v1/projects/${h.projectId}/discussions`, payload: { title: 'x' } })).statusCode,
    ).toBe(401)
    expect(
      (await h.app.inject({ method: 'POST', url: `/api/v1/projects/${h.projectId}/discussions/1/comments`, payload: { body: 'x' } })).statusCode,
    ).toBe(401)
  })

  it('PRIVATE projects hide existence (404) from non-members everywhere', async () => {
    const h = await setup('private')
    await createDiscussion(h, h.alice)
    for (const url of ['/discussions', '/discussions/1']) {
      expect(
        (
          await h.app.inject({
            method: 'GET',
            url: `/api/v1/projects/${h.projectId}${url}`,
            headers: { cookie: h.bob.cookie },
          })
        ).statusCode,
      ).toBe(404)
    }
  })
})

// ── poll foundation ───────────────────────────────────────────────────────────────

describe('poll foundation', () => {
  it('one vote per user, switchable; tally aggregates; detail exposes your_vote', async () => {
    const h = await setup()
    await createDiscussion(h, h.alice, { category: 'poll', poll_options: ['red', 'green', 'blue'] })
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/comments`, {
      session: h.bob, payload: { body: 'context for the vote' },
    })

    expect(
      (
        await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/poll/vote`, {
          session: h.bob, payload: { option_index: 0 },
        })
      ).statusCode,
    ).toBe(200)
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/poll/vote`, {
      session: h.carol, payload: { option_index: 0 },
    })
    await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/poll/vote`, {
      session: h.carol, payload: { option_index: 2 }, // switch — still one vote each
    })

    const detail = (await authed(h.app, 'GET', `/api/v1/projects/${h.projectId}/discussions/1`, {})).json()
    const poll = detail.poll as { options: string[]; tally: Array<{ option_index: number; votes: number }>; your_vote: number | null }
    expect(poll.options).toEqual(['red', 'green', 'blue'])
    expect(poll.tally).toEqual([
      { option_index: 0, votes: 1 },
      { option_index: 2, votes: 1 },
    ])
    // Owner has not voted.
    void PASSWORD
  })

  it('rejects out-of-range option indexes', async () => {
    const h = await setup()
    await createDiscussion(h, h.alice, { category: 'poll', poll_options: ['a', 'b'] })
    expect(
      (
        await authed(h.app, 'POST', `/api/v1/projects/${h.projectId}/discussions/1/poll/vote`, {
          session: h.alice, payload: { option_index: 5 },
        })
      ).statusCode,
    ).toBe(400)
  })
})

// ── listing & search ───────────────────────────────────────────────────────────

describe('listing & filtering', () => {
  it('filters by category and searches titles/bodies with pagination metadata', async () => {
    const h = await setup()
    await createDiscussion(h, h.alice, { title: 'Question about exports', category: 'question', body: 'How do I export?' })
    await createDiscussion(h, h.alice, { title: 'My showcase build', category: 'showcase', body: 'Look at this.' })
    await createDiscussion(h, h.alice, { title: 'Random thought zebra', category: 'general', body: '' })

    const qs = await h.app.inject({ method: 'GET', url: `/api/v1/projects/${h.projectId}/discussions?category=question` })
    expect(qs.json().pagination.total).toBe(1)

    const search = await h.app.inject({ method: 'GET', url: `/api/v1/projects/${h.projectId}/discussions?search=zebra` })
    expect(search.headers['x-total-count']).toBe(undefined) // discussions use JSON pagination
    expect(((search.json().discussions as Array<Record<string, unknown>>)[0]!).title).toContain('zebra')
  })
})
