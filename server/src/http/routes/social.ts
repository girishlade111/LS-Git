import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError } from '../../services/identity.js'
import { resolveNotificationSetting, type WatchLevel } from '../../db/store.js'

/**
 * Social discovery routes: stars, watch subscriptions, notification
 * preferences and the persisted in-app inbox.
 *
 *   POST   /api/v1/projects/:id/star              star (idempotent)
 *   DELETE /api/v1/projects/:id/star              unstar
 *   GET    /api/v1/projects/:id/star              {count, starred}
 *   PUT    /api/v1/projects/:id/watch             {level} — per-user watch state
 *   DELETE /api/v1/projects/:id/watch             revert to global default
 *   GET    /api/v1/user/notifications             inbox (filters + pagination)
 *   GET    /api/v1/user/notifications/unread_count
 *   POST   /api/v1/user/notifications/read_all   {project_id?}
 *   POST   /api/v1/user/notifications/:id/read
 *   POST   /api/v1/user/notifications/:id/unread
 *   GET/PUT /api/v1/user/notification_preferences  {project_id?, level, muted_events?}
 */

const LEVELS: WatchLevel[] = ['disabled', 'participating', 'mention', 'watch']

export function registerSocialRoutes(app: FastifyInstance): void {
  const auth = app.requireAuth()

  function projectId(req: FastifyRequest): number {
    return Number((req.params as { id: string }).id)
  }

  // -- stars -----------------------------------------------------------------

  app.post('/api/v1/projects/:id/star', { preHandler: auth }, async (req, reply) => {
    const project = requireProject(app, projectId(req))
    const created = app.store.stars.star(req.actor!.userId, project.id)
    // Outbox emission only — webhook/notification fan-out is async (EVENTS.md §1).
    if (created) {
      app.store.events.emit(project.id, 'star.added', { actor_user_id: req.actor!.userId })
    }
    reply.code(created ? 201 : 200) // duplicate star is a no-op, not an error
    return { starred: true, count: app.store.stars.count(project.id), created }
  })

  app.delete('/api/v1/projects/:id/star', { preHandler: auth }, async (req) => {
    const project = requireProject(app, projectId(req))
    const removed = app.store.stars.unstar(req.actor!.userId, project.id)
    if (removed) {
      app.store.events.emit(project.id, 'star.removed', { actor_user_id: req.actor!.userId })
    }
    return { starred: false, count: app.store.stars.count(project.id), removed }
  })

  app.get('/api/v1/projects/:id/star', async (req) => {
    const project = requireProject(app, projectId(req))
    return {
      count: app.store.stars.count(project.id),
      starred: req.actor ? app.store.stars.has(req.actor.userId, project.id) : false,
    }
  })

  app.get('/api/v1/user/stars', { preHandler: auth }, async (req) => {
    return {
      stars: app.store.stars.listByUser(req.actor!.userId).map((p) => ({
        id: p.id,
        full_path: fullPath(app, p),
        name: p.name,
        visibility: p.visibility,
      })),
    }
  })

  // -- watches -----------------------------------------------------------------

  app.put('/api/v1/projects/:id/watch', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const level = String(body.level ?? '') as WatchLevel
    if (!LEVELS.includes(level)) {
      throw new AppError(400, `level must be one of ${LEVELS.join(', ')}`, 'validation_failed')
    }
    const project = requireProject(app, projectId(req))
    app.store.watchSubscriptions.set(req.actor!.userId, project.id, level)
    return { level }
  })

  app.delete('/api/v1/projects/:id/watch', { preHandler: auth }, async (req) => {
    const project = requireProject(app, projectId(req))
    app.store.watchSubscriptions.unset(req.actor!.userId, project.id)
    return { level: null } // reverted to the user's global default
  })

  app.get('/api/v1/projects/:id/watch', { preHandler: auth }, async (req) => {
    const project = requireProject(app, projectId(req))
    const explicit = app.store.watchSubscriptions.get(req.actor!.userId, project.id)
    const resolved = resolveNotificationSetting(
      app.store.watchSubscriptions,
      app.store.notificationPreferences,
      req.actor!.userId,
      project.id,
    )
    return {
      level: explicit?.level ?? null,
      muted_events: explicit?.muted_events ?? [],
      effective_level: resolved.level,
      source: resolved.source,
      default_level: 'participating',
    }
  })

  // -- notification preferences ----------------------------------------------------

  app.get('/api/v1/user/notification_preferences', { preHandler: auth }, async (req) => {
    const q = req.query as { project_id?: string }
    if (q.project_id !== undefined) {
      const pid = Number(q.project_id)
      // Repository-level levels live in the watch subscription; mutes are global.
      const watchLevel = app.store.watchSubscriptions.get(req.actor!.userId, pid)
      const resolved = resolveNotificationSetting(
        app.store.watchSubscriptions,
        app.store.notificationPreferences,
        req.actor!.userId,
        pid,
      )
      return {
        project_id: pid,
        level: watchLevel,
        effective_level: resolved.level,
        source: resolved.source,
        muted_events: resolved.muted_events,
        default_level: 'participating',
      }
    }
    const global = app.store.notificationPreferences.getGlobal(req.actor!.userId)
    return {
      project_id: null,
      level: global?.level ?? null,
      effective_level: global?.level ?? 'participating',
      muted_events: global?.muted_events ?? [],
      default_level: 'participating',
    }
  })

  /**
   * Sets notification preferences. With a project_id this writes the
   * repository watch level (single source of truth); without one it writes
   * the user's GLOBAL default. muted_events are global-only.
   */
  app.put('/api/v1/user/notification_preferences', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const level = String(body.level ?? '') as WatchLevel
    if (!LEVELS.includes(level)) {
      throw new AppError(400, `level must be one of ${LEVELS.join(', ')}`, 'validation_failed')
    }
    const hasProject = body.project_id !== undefined && body.project_id !== null
    const projectId = hasProject ? Number(body.project_id) : null
    if (hasProject && !Number.isInteger(projectId)) {
      throw new AppError(400, 'project_id must be an integer or null for global', 'validation_failed')
    }

    const mutedEvents = Array.isArray(body.muted_events)
      ? [...new Set((body.muted_events as unknown[]).map(String))]
      : undefined

    if (hasProject) {
      app.store.watchSubscriptions.set(req.actor!.userId, projectId!, level, mutedEvents)
    } else {
      const existing = app.store.notificationPreferences.getGlobal(req.actor!.userId)
      app.store.notificationPreferences.setGlobal(req.actor!.userId, level, mutedEvents ?? existing?.muted_events ?? [])
    }
    return {
      project_id: projectId,
      level,
      muted_events: (hasProject
        ? app.store.notificationPreferences.getGlobal(req.actor!.userId)?.muted_events ?? []
        : mutedEvents),
    }
  })

  // -- inbox ------------------------------------------------------------------------

  app.get('/api/v1/user/notifications', { preHandler: auth }, async (req) => {
    const q = req.query as { unread?: string; type?: string; project_id?: string; limit?: string }
    const notifications = app.store.notifications.listForUser(req.actor!.userId, {
      unreadOnly: q.unread === '1' || q.unread === 'true',
      type: q.type,
      projectId: q.project_id !== undefined ? Number(q.project_id) : undefined,
      limit: Math.max(1, Math.min(Number(q.limit ?? 50), 200)),
    })
    return {
      unread_count: app.store.notifications.unreadCount(req.actor!.userId),
      notifications: notifications.map((n) => serializeNotification(app, n)),
    }
  })

  app.get('/api/v1/user/notifications/unread_count', { preHandler: auth }, async (req) => {
    return { count: app.store.notifications.unreadCount(req.actor!.userId) }
  })

  app.post('/api/v1/user/notifications/read_all', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const projectId = body.project_id !== undefined && body.project_id !== null ? Number(body.project_id) : undefined
    const changed = app.store.notifications.markAllRead(req.actor!.userId, projectId)
    return { marked_read: changed }
  })

  app.post('/api/v1/user/notifications/:id/read', { preHandler: auth }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    if (!app.store.notifications.markRead(req.actor!.userId, id)) {
      throw new AppError(404, 'Notification not found')
    }
    return { ok: true }
  })

  app.post('/api/v1/user/notifications/:id/unread', { preHandler: auth }, async (req) => {
    const id = Number((req.params as { id: string }).id)
    if (!app.store.notifications.markUnread(req.actor!.userId, id)) {
      throw new AppError(404, 'Notification not found')
    }
    return { ok: true }
  })
}

function requireProject(app: FastifyInstance, id: number) {
  const p = app.store.projects.byId(id)
  if (!p) throw new AppError(404, 'Project not found')
  return p
}

function fullPath(app: FastifyInstance, p: { owner_id: number; path: string }): string {
  const owner = app.store.users.byId(p.owner_id)
  return `${owner?.username ?? ''}/${p.path}`
}

function serializeNotification(
  app: FastifyInstance,
  n: import('../../db/store.js').NotificationRow,
): Record<string, unknown> {
  let project_path: string | null = null
  if (n.project_id != null) {
    const p = app.store.projects.byId(n.project_id)
    if (p) project_path = fullPath(app, p)
  }
  const actor = n.actor_user_id != null ? app.store.users.byId(n.actor_user_id) : undefined
  return {
    id: n.id,
    project_id: n.project_id,
    project_path,
    type: n.type,
    title: n.title,
    body: n.body,
    url: n.url,
    actor_username: actor?.username ?? null,
    read_at: n.read_at,
    created_at: n.created_at,
  }
}
