import type { IdentityServices } from './identity.js'
import { resolveNotificationSetting } from '../db/store.js'
import type { EventRow, NotificationType, WatchLevel } from '../db/store.js'

/**
 * Social notification fanout (GitLab watch-behavior parity, LSGit-native).
 *
 * Delivery is EVENT-DRIVEN through one choke point: EventsRepo.emit invokes
 * `notifyOnEvent` after the durable outbox row is written. The function is
 * idempotent (dedupe keys include the event row id), so replaying events —
 * today inline, later from a queue worker sweep — can never duplicate an
 * inbox entry.
 *
 * Unnecessary notifications are prevented three ways:
 *   1. Actors never receive notifications about their own actions;
 *   2. Per-repository preference levels gate every recipient
 *      (disabled / participating / mention / watch — absent rows resolve to
 *      the user's global preference, default 'participating');
 *   3. Per-user muted event types silence specific categories everywhere.
 */

/** Domain event names produced by existing services → notification types. */
const EVENT_TYPE_MAP: Record<string, NotificationType> = {
  'repo.push': 'push',
  'repository.file_committed': 'push',
  'repository.files_committed': 'push',
  'project.forked': 'fork',
  // Issue domain (services/issues.ts). Deletions are silent (render returns null).
  'issue.opened': 'issue',
  'issue.updated': 'issue',
  'issue.commented': 'discussion',
  'issue.deleted': 'issue',
  // Direct catalog names pass through unchanged (future producers).
  issue: 'issue',
  merge_request: 'merge_request',
  discussion: 'discussion',
  mention: 'mention',
  review_request: 'review_request',
  release: 'release',
  deployment: 'deployment',
  workflow: 'workflow',
  security_alert: 'security_alert',
  fork: 'fork',
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

interface RenderedNotification {
  type: NotificationType
  title: string
  body: string | null
  url: string | null
}

/** Builds the human-facing headline/link from the domain event payload. */
export function renderNotification(
  event: EventRow,
  projectFullPath: string,
): RenderedNotification | null {
  const type = EVENT_TYPE_MAP[event.type]
  if (!type) return null // unmapped internal event → no notification
  const p = event.payload

  switch (type) {
    case 'push': {
      const ref = String(p.ref ?? '')
      const branch = ref.replace(/^refs\/heads\//, '') || ref || 'branch'
      if (p.action === 'fork_synced') return null // sync echoes upstream work; not news
      return {
        type,
        title: truncate(String(p.action === 'new_branch_commit' ? 'New branch commits' : 'Push to branch'), 120),
        body: truncate(`${projectFullPath} · ${branch}`, 200),
        url: `/proj/${projectFullPath}/tree/${encodeURIComponent(branch)}`,
      }
    }
    case 'fork':
      return {
        type,
        title: 'New fork of your repository',
        body: truncate(`${String(p.fork_full_path ?? '')} was forked from ${projectFullPath}`, 200),
        url: p.fork_full_path ? `/proj/${String(p.fork_full_path)}` : null,
      }
    case 'issue':
      return { type, title: truncate(`Issue: ${String(p.title ?? 'updated')}`, 140), body: truncate(projectFullPath, 200), url: null }
    case 'merge_request':
      return { type, title: truncate(`Merge request: ${String(p.title ?? 'updated')}`, 140), body: truncate(projectFullPath, 200), url: null }
    case 'mention':
      return { type, title: truncate(`You were mentioned: ${String(p.title ?? '')}`, 140), body: truncate(projectFullPath, 200), url: null }
    case 'review_request':
      return { type, title: truncate(`Review requested: ${String(p.title ?? '')}`, 140), body: truncate(projectFullPath, 200), url: null }
    case 'release':
      return { type, title: truncate(`Release ${String(p.tag ?? '')}`, 140), body: truncate(projectFullPath, 200), url: null }
    case 'deployment':
      return { type, title: truncate(`Deployment ${String(p.status ?? '')}`, 140), body: truncate(projectFullPath, 200), url: null }
    case 'workflow':
      return { type, title: truncate(`Workflow ${String(p.status ?? 'update')}`, 140), body: truncate(projectFullPath, 200), url: null }
    case 'security_alert':
      return { type, title: truncate(`Security alert: ${String(p.title ?? 'vulnerability reported')}`, 160), body: truncate(projectFullPath, 200), url: null }
    case 'discussion':
      return { type, title: truncate(`New discussion: ${String(p.title ?? '')}`, 140), body: truncate(projectPayloadLine(p), 200), url: null }
    default: return null
  }
}

function projectPayloadLine(p: Record<string, unknown>): string {
  return typeof p.project_path === 'string' ? p.project_path : ''
}

/**
 * Entry point wired into EventsRepo.emit. Creates persisted in-app
 * notifications for eligible recipients. Safe to call repeatedly.
 */
export function notifyOnEvent(s: IdentityServices, row: EventRow): void {
  if (row.project_id == null) return
  const projectId = row.project_id
  const project = s.projects.byId(projectId)
  if (!project) return

  const ownerUsername = s.users.byId(project.owner_id)?.username ?? ''
  const rendered = renderNotification(row, `${ownerUsername}/${project.path}`)
  if (!rendered) return

  const actorId = readActorId(row.payload)
  const mentioned = readIdList(row.payload.mentioned_user_ids)
  const participants = new Set<number>([
    project.owner_id, // repository owner is inherently a participant
    ...readIdList(row.payload.participant_user_ids),
  ])

  // Candidate recipients: explicit watch rows plus anyone named in the event.
  const candidates = new Map<number, WatchLevel>()
  for (const w of s.watchSubscriptions.listForProject(projectId)) candidates.set(w.user_id, w.level)
  for (const uid of [...participants, ...mentioned]) {
    if (!candidates.has(uid)) {
      candidates.set(uid, resolveNotificationSetting(s.watchSubscriptions, s.notificationPreferences, uid, projectId).level)
    }
  }

  let created = 0
  for (const [userId] of candidates) {
    if (actorId !== null && userId === actorId) continue // never notify yourself

    const setting = resolveNotificationSetting(s.watchSubscriptions, s.notificationPreferences, userId, projectId)
    const pref = setting
    if (pref.muted_events.includes(rendered.type)) continue

    let eligible = false
    switch (pref.level) {
      case 'disabled': break
      case 'watch': eligible = true; break
      case 'mention': eligible = mentioned.includes(userId); break
      case 'participating': eligible = participants.has(userId) || mentioned.includes(userId); break
    }
    if (!eligible) continue

    const ok = s.notifications.insert({
      user_id: userId,
      project_id: projectId,
      type: rendered.type,
      title: rendered.title,
      body: rendered.body,
      url: rendered.url,
      actor_user_id: actorId,
      dedupe_key: `evt${row.id}:u${userId}`,
    })
    if (ok) created++
  }
  void created // useful for worker metrics once the queue lands
}

function readActorId(payload: Record<string, unknown>): number | null {
  const raw = payload.actor_user_id ?? payload.user_id
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

function readIdList(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return raw.map(Number).filter((n) => Number.isInteger(n) && n > 0)
}
