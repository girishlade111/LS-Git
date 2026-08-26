import { AppError } from './identity.js'
import type { IdentityServices } from './identity.js'
import type {
  DiscussionRow,
  DiscussionCommentRow,
  DiscussionCategory,
} from '../db/store.js'
import { DISCUSSION_CATEGORIES } from '../db/store.js'
import type { Actor } from '../authz.js'
import { can, type Permission } from '../authz.js'

/**
 * Community discussions — GitLab Discussions behavior, LSGit-native schema.
 *
 * SEPARATION FROM ISSUES (by design): no iid sequence, no labels/milestones,
 * no state machine. A discussion is a lightweight community thread with a
 * category, lifecycle flags (pinned/locked), and an optional best answer on
 * question-category threads. Comment storage is its own table so issue/PR
 * notes keep their semantics; shared primitives (mention extraction,
 * reaction allowlist + toggle, event bus fanout) are reused, not duplicated.
 *
 * EVENT-BASED INTERACTION: every mutation emits `discussion.*` domain events
 * through the single EventsRepo choke point; notification fanout (watch
 * levels, mentions, mutes) is handled by the existing notifyOnEvent worker.
 */


export function resolveMentionIdsShared(
  s: IdentityServices,
  texts: Array<string | null | undefined>,
): number[] {
  const usernames = new Set<string>()
  for (const t of texts) {
    if (!t) continue
    for (const m of t.matchAll(/(?<!`)@([a-zA-Z0-9_](?:[a-zA-Z0-9_.-]?[a-zA-Z0-9_]){0,29})/g)) {
      usernames.add(m[1]!.toLowerCase())
    }
  }
  const ids: number[] = []
  for (const name of usernames) {
    const u = s.users.byUsername(name)
    if (u && u.state === 'active') ids.push(u.id)
  }
  return ids.sort((a, b) => a - b)
}

export class DiscussionsService {
  constructor(private s: IdentityServices) {}

  // ── gates ─────────────────────────────────────────────────────────────────

  private projectCtx(project: { owner_id: number; visibility: string }) {
    return {
      resourceProject: {
        ownerId: project.owner_id,
        visibility: project.visibility as 'private' | 'internal' | 'public',
      },
    }
  }

  authorize(actor: Actor | null, permission: Permission, project: { owner_id: number; visibility: string }, extraCtx: { resourceUserId?: number } = {}): void {
    const ok = can(actor, permission, { ...this.projectCtx(project), resourceUserId: extraCtx.resourceUserId })
    if (!ok) {
      throw new AppError(actor ? 403 : 401, 'Not allowed', actor ? 'forbidden' : 'unauthenticated')
    }
  }

  visibleDiscussion(actor: Actor | null, projectId: number, did: number): { discussion: DiscussionRow; project: { owner_id: number; visibility: string; id: number } } {
    const project = this.s.projects.byId(projectId)
    if (!project) throw new AppError(404, 'Project not found')
    const readable = can(actor, 'project:read', this.projectCtx(project))
    if (!readable) {
      if (actor) throw new AppError(404, 'Project not found') // existence hidden
      throw new AppError(401, 'Authentication required')
    }
    const d = this.s.discussions.byId(did)
    if (!d || d.project_id !== projectId) throw new AppError(404, 'Discussion not found')
    return { discussion: d, project }
  }

  private requireCategory(raw: unknown): DiscussionCategory {
    const c = String(raw ?? 'general')
    if (!(DISCUSSION_CATEGORIES as readonly string[]).includes(c)) {
      throw new AppError(400, `category must be one of ${DISCUSSION_CATEGORIES.join(', ')}`)
    }
    return c as DiscussionCategory
  }

  private assertTitle(body: unknown): string {
    if (typeof body !== 'string' || body.trim() === '') throw new AppError(400, 'title is required')
    if (body.trim().length > 200) throw new AppError(400, 'title exceeds 200 characters')
    return body.trim()
  }

  private assertBodyText(body: unknown, what = 'body'): string {
    if (typeof body !== 'string' || body.trim() === '') throw new AppError(400, `${what} is required`)
    const v = body.replace(/\r\n/g, '\n').trim()
    if (v.length > MAX_BODY_LIMIT) throw new AppError(400, `${what} exceeds ${MAX_BODY_LIMIT} characters`)
    return v
  }

  // ── discussions ─────────────────────────────────────────────────────────────

  create(actor: Actor, projectId: number, input: Record<string, unknown>): (DiscussionRow & { comment_count: number; author: { id: number; username: string; name: string | null } }) {
    const project = this.s.projects.byId(projectId)
    if (!project) throw new AppError(404, 'Project not found')
    this.authorize(actor, 'discussion:create', project)

    const title = this.assertTitle(input.title)
    const body = typeof input.body === 'string' ? input.body.slice(0, MAX_BODY_LIMIT) : ''
    const category = this.requireCategory(input.category)

    let pollOptions: string[] | null = null
    if (category === 'poll') {
      if (!Array.isArray(input.poll_options) || input.poll_options.length < 2) {
        throw new AppError(400, 'poll discussions need at least two options')
      }
      pollOptions = (input.poll_options as unknown[])
        .map((o) => String(o).trim())
        .filter(Boolean)
        .slice(0, 12)
      if (pollOptions.length < 2) throw new AppError(400, 'poll discussions need at least two non-empty options')
    }

    const row = this.s.discussions.create({
      project_id: projectId,
      author_id: actor.userId,
      category,
      title,
      body,
      poll_options: pollOptions,
    })

    this.fanout(projectId, 'discussion.created', {
      action: 'opened',
      title,
      did: row.id,
      category,
      actor_user_id: actor.userId,
      actor_username: actor.username,
      participant_user_ids: [actor.userId],
      mentioned_user_ids: resolveMentionIdsShared(this.s, [title, body]),
    })

    return {
      ...row,
      pinned: !!row.pinned,
      locked: !!row.locked,
      author: this.userBrief(actor.userId)!,
      comment_count: 0,
    } as DiscussionRow & { comment_count: number; pinned: boolean; locked: boolean; author: { id: number; username: string; name: string | null } }
  }

  update(actor: Actor, projectId: number, did: number, patch: Record<string, unknown>): DiscussionRow {
    const { discussion, project } = this.visibleDiscussion(actor, projectId, did)
    const isMaintainer = can(actor, 'discussion:maintain', this.projectCtx(project))
    const isAuthor = discussion.author_id === actor.userId

    const sets: Record<string, unknown> = {}
    if (patch.title !== undefined) sets.title = this.assertTitle(patch.title)
    if (patch.body !== undefined) sets.body = this.assertBodyText(patch.body)
    if (patch.category !== undefined && String(patch.category) !== discussion.category) {
      if (discussion.category === 'question' && discussion.best_answer_comment_id !== null) {
        throw new AppError(422, 'Clear the best answer before changing the category away from question')
      }
      sets.category = this.requireCategory(patch.category)
    }
    if (patch.pinned !== undefined) {
      this.authorize(actor, 'discussion:maintain', project)
      sets.pinned = patch.pinned === true ? 1 : 0
    }
    if (patch.locked !== undefined) {
      this.authorize(actor, 'discussion:maintain', project)
      sets.locked = patch.locked === true ? 1 : 0
    }
    // Title/body/category edits are author-or-maintainer.
    if (
      (sets.title !== undefined || sets.body !== undefined || sets.category !== undefined) &&
      !isAuthor && !isMaintainer
    ) {
      throw new AppError(403, 'Only the author or a maintainer can edit a discussion')
    }
    if (Object.keys(sets).length === 0) return discussion

    this.s.db.transaction(() => {
      this.s.discussions.update(did, sets as never)
      void actor
    })
    return this.s.discussions.byId(did)!
  }

  delete(actor: Actor, projectId: number, did: number): void {
    const { discussion, project } = this.visibleDiscussion(actor, projectId, did)
    const isAuthor = discussion.author_id === actor.userId
    const maintainer = can(actor, 'discussion:maintain', this.projectCtx(project))
    if (!isAuthor && !maintainer) throw new AppError(403, 'Only the author or a maintainer can delete a discussion')
    this.s.db.transaction(() => this.s.discussions.delete(did))
  }

  list(
    actor: Actor | null,
    projectId: number,
    f: { category?: string; search?: string; page?: number; perPage?: number },
  ) {
    const project = this.s.projects.byId(projectId)
    if (!project) throw new AppError(404, 'Project not found')
    if (!can(actor, 'project:read', this.projectCtx(project))) {
      throw new AppError(actor ? 404 : 401, actor ? 'Project not found' : 'Authentication required')
    }
    const category = f.category ? this.requireCategory(f.category) : undefined
    const result = this.s.discussions.listFiltered(projectId, {
      category,
      search: f.search?.slice(0, 100),
      page: Number(f.page ?? 1),
      perPage: Number(f.perPage ?? 20),
    })
    return {
      discussions: result.rows.map((d) => ({
        ...this.listView(d),
        locked: !!d.locked,
        pinned: !!d.pinned,
      })),
      pagination: {
        page: result.page,
        per_page: result.perPage,
        total: result.total,
        total_pages: Math.max(1, Math.ceil(result.total / result.perPage)),
        has_more: result.page * result.perPage < result.total,
      },
    }
  }

  detail(actor: Actor | null, projectId: number, did: number) {
    const { discussion } = this.visibleDiscussion(actor, projectId, did)
    const comments = this.s.discussionComments.listForDiscussion(discussion.id)

    type Node = DiscussionCommentRow & { replies: Node[] }
    const byId = new Map<number, Node>()
    const roots: Node[] = []
    for (const c of comments) {
      byId.set(c.id, { ...c, replies: [] })
    }
    for (const node of byId.values()) {
      if (node.parent_id !== null && byId.has(node.parent_id)) byId.get(node.parent_id)!.replies.push(node)
      else roots.push(node)
    }

    let poll: { options: string[]; tally: Array<{ option_index: number; votes: number }>; your_vote: number | null } | null = null
    if (discussion.category === 'poll' && discussion.poll_options) {
      try {
        const options = JSON.parse(discussion.poll_options) as string[]
        poll = {
          options,
          tally: this.s.pollVotes.tally(discussion.id),
          your_vote: actor ? this.s.pollVotes.forUser(discussion.id, actor.userId) : null,
        }
      } catch { /* corrupt payload → treated as absent */ }
    }

    return {
      discussion: {
        id: discussion.id,
        author: this.userBrief(discussion.author_id),
        category: discussion.category,
        title: discussion.title,
        body: discussion.body,
        pinned: !!discussion.pinned,
        locked: !!discussion.locked,
        best_answer_comment_id: discussion.best_answer_comment_id,
        created_at: discussion.created_at,
        last_activity_at: discussion.last_activity_at,
      },
      comments: roots.map((root) => this.commentView(root)),
      comment_count: this.s.discussionComments.countForDiscussion(discussion.id),
      poll,
    }
  }

  // ── comments ────────────────────────────────────────────────────────────────

  addComment(
    actor: Actor,
    projectId: number,
    did: number,
    input: { body?: unknown; parent_id?: unknown },
  ): DiscussionCommentRow {
    const { discussion, project } = this.visibleDiscussion(actor, projectId, did)
    this.authorize(actor, 'discussion:comment', project)
    if (discussion.locked) {
      const maintainer = can(actor, 'discussion:maintain', this.projectCtx(project))
      if (!maintainer) throw new AppError(403, 'This discussion is locked', 'locked_discussion')
    }

    const body = this.assertBodyText(input.body)
    let parentId: number | null = null
    if (input.parent_id !== undefined && input.parent_id !== null) {
      const parent = this.s.discussionComments.byId(Number(input.parent_id))
      if (!parent || parent.discussion_id !== did) throw new AppError(404, 'Parent comment not found')
      parentId = parent.id
    }

    const comment = this.s.discussionComments.create({
      discussion_id: did,
      parent_id: parentId,
      author_id: actor.userId,
      body,
    })

    this.fanout(projectId, 'discussion.commented', {
      action: 'commented',
      title: discussion.title,
      did,
      actor_user_id: actor.userId,
      actor_username: actor.username,
      participant_user_ids: [discussion.author_id, ...(parentId ? [this.parentAuthor(parentId)] : [])],
      mentioned_user_ids: resolveMentionIdsShared(this.s, [body]),
    })
    return comment
  }

  updateComment(actor: Actor, projectId: number, did: number, commentId: number, input: { body?: unknown }): void {
    const { discussion, project } = this.visibleDiscussion(actor, projectId, did)
    const comment = this.s.discussionComments.byId(commentId)
    if (!comment || comment.discussion_id !== did) throw new AppError(404, 'Comment not found')
    if (comment.deleted) throw new AppError(422, 'This comment was removed')

    const maintainer = can(actor, 'discussion:maintain', this.projectCtx(project))
    const isAuthor = comment.author_id === actor.userId
    if (!isAuthor && !maintainer) throw new AppError(403, 'You can only edit your own comments')
    if (discussion.locked && !maintainer) throw new AppError(403, 'This discussion is locked', 'locked_discussion')

    const body = this.assertBodyText(input.body)
    this.s.db.transaction(() => {
      this.s.db.run('UPDATE discussion_comments SET body = ?, edited_at = ?, updated_at = ? WHERE id = ?', body, new Date().toISOString(), new Date().toISOString(), commentId)
    })
  }

  /** Moderation delete: soft-delete tombstone keeps the thread shape intact. */
  deleteComment(actor: Actor, projectId: number, did: number, commentId: number): void {
    const { discussion, project } = this.visibleDiscussion(actor, projectId, did)
    const comment = this.s.discussionComments.byId(commentId)
    if (!comment || comment.discussion_id !== did) throw new AppError(404, 'Comment not found')
    if (comment.deleted) return // idempotent

    const maintainer = can(actor, 'discussion:maintain', this.projectCtx(project))
    const isAuthor = comment.author_id === actor.userId
    if (!isAuthor && !maintainer) throw new AppError(403, 'You can only delete your own comments')

    this.s.db.transaction(() => {
      this.s.discussionComments.softDelete(commentId, actor.userId)
      if (discussion.best_answer_comment_id === commentId) {
        this.s.discussions.update(discussion.id, { best_answer_comment_id: null })
      }
      void maintainer
    })
  }

  // ── best answer ──────────────────────────────────────────────────────────────

  setBestAnswer(actor: Actor, projectId: number, did: number, commentId: number | null): void {
    const { discussion, project } = this.visibleDiscussion(actor, projectId, did)
    const isAuthor = discussion.author_id === actor.userId
    const maintainer = can(actor, 'discussion:maintain', this.projectCtx(project))
    if (!isAuthor && !maintainer) {
      throw new AppError(403, 'Only the discussion author or a maintainer can select the best answer')
    }
    if (discussion.category !== 'question') {
      throw new AppError(422, 'Best answers are only available on question discussions')
    }
    if (commentId === null) {
      this.s.discussions.update(did, { best_answer_comment_id: null })
      return
    }
    const comment = this.s.discussionComments.byId(commentId)
    if (!comment || comment.discussion_id !== did || comment.deleted) {
      throw new AppError(404, 'Comment not found on this discussion')
    }
    this.s.discussions.update(did, { best_answer_comment_id: commentId })
    this.fanout(projectId, 'discussion.answered', {
      action: 'best_answer',
      title: discussion.title,
      did,
      actor_user_id: actor.userId,
      actor_username: actor.username,
      participant_user_ids: [discussion.author_id, comment.author_id],
    })
  }

  // ── reactions (shared primitive) ─────────────────────────────────────────────

  toggleReaction(
    actor: Actor,
    projectId: number,
    _targetType: 'discussion' | 'discussion_comment',
    targetId: number,
    rawName: unknown,
  ): 'awarded' | 'revoked' {
    const { project } = this.visibleDiscussion(actor, projectId, targetId)
    void targetId
    this.authorize(actor, 'discussion:comment', project)
    if (rawName !== null && !this.isValidReaction(String(rawName))) {
      throw new AppError(400, 'Unsupported reaction name')
    }
    const name = String(rawName)
    return this.s.reactions.toggle(actor.userId, _targetType, targetId, name as never)
  }

  reactionSummary(targetType: 'discussion' | 'discussion_comment', targetId: number, viewerId?: number) {
    return this.s.reactions.summary(targetType, targetId, viewerId)
  }

  private isValidReaction(name: string): boolean {
    const allowed = ['thumbsup', 'thumbsdown', 'smile', 'tada', 'confetti_ball', 'heart', 'rocket', 'eyes', 'fire', 'thinking']
    return allowed.includes(name)
  }

  // ── poll foundation ──────────────────────────────────────────────────────────

  votePoll(actor: Actor, projectId: number, did: number, optionIndexRaw: unknown) {
    const { discussion, project } = this.visibleDiscussion(actor, projectId, did)
    this.authorize(actor, 'discussion:comment', project)
    if (discussion.locked) throw new AppError(403, 'This discussion is locked', 'locked_discussion')
    if (discussion.category !== 'poll' || !discussion.poll_options) {
      throw new AppError(422, 'This discussion has no poll')
    }
    const optionIndex = Number(optionIndexRaw)
    let options: string[] = []
    try { options = JSON.parse(discussion.poll_options) as string[] } catch { /* fallthrough */ }
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
      throw new AppError(400, 'option_index out of range')
    }
    this.s.pollVotes.vote(did, actor.userId, optionIndex)
    return { tally: this.s.pollVotes.tally(did), your_vote: optionIndex }
  }

  // ── helpers ───────────────────────────────────────────────────────────────────

  private fanout(projectId: number, type: string, payload: Record<string, unknown>): void {
    this.s.events.emit(projectId, type, payload)
  }

  private parentAuthor(parentId: number): number {
    const p = this.s.discussionComments.byId(parentId)
    return p?.author_id ?? 0
  }

  private userBrief(id: number) {
    const u = this.s.users.byId(id)
    return u ? { id: u.id, username: u.username, name: u.name } : null
  }

  private listView(d: DiscussionRow) {
    return {
      id: d.id,
      author: this.userBrief(d.author_id),
      category: d.category,
      title: d.title,
      body_preview: d.body.slice(0, 160),
      comment_count: this.s.discussionComments.countForDiscussion(d.id),
      last_activity_at: d.last_activity_at,
      created_at: d.created_at,
    }
  }

  private commentView(node: DiscussionCommentRow & { replies: DiscussionCommentRow[] }): Record<string, unknown> {
    return {
      id: node.id,
      parent_id: node.parent_id,
      author: this.userBrief(node.author_id),
      body: node.deleted ? '' : node.body,
      deleted: !!node.deleted,
      edited_at: node.edited_at,
      created_at: node.created_at,
      reactions: this.reactionSummary('discussion_comment', node.id),
      replies: node.replies.map((r) => this.commentView(r as DiscussionCommentRow & { replies: DiscussionCommentRow[] })),
    }
  }
}

const MAX_BODY_LIMIT = 20_000
