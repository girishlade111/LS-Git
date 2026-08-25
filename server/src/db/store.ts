import { Database, nowIso, type Row, type SqlParam } from './database.js'

/** Repository layer. All SQL lives here; services never touch SQL directly. */

export interface UserRow {
  id: number
  username: string
  email: string
  name: string | null
  password_hash: string
  state: 'active' | 'blocked' | 'deactivated'
  admin: number
  email_verified: number
  failed_login_count: number
  locked_until: string | null
  bio: string | null
  location: string | null
  website_url: string | null
  public_email: string | null
  avatar_content_type: string | null
  created_at: string
  updated_at: string
}

export class UsersRepo {
  constructor(private db: Database) {}

  create(data: {
    username: string
    email: string
    name?: string
    passwordHash: string
    admin?: boolean
  }): UserRow {
    const now = nowIso()
    const res = this.db.run(
      `INSERT INTO users (username, email, name, password_hash, admin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      data.username,
      data.email,
      data.name ?? null,
      data.passwordHash,
      data.admin ? 1 : 0,
      now,
      now,
    )
    return this.byId(res.lastInsertRowid)!
  }

  byId(id: number): UserRow | undefined {
    return this.db.get('SELECT * FROM users WHERE id = ?', id) as UserRow | undefined
  }

  byUsername(username: string): UserRow | undefined {
    return this.db.get('SELECT * FROM users WHERE username = ?', username.toLowerCase()) as
      | UserRow
      | undefined
  }

  byEmail(email: string): UserRow | undefined {
    return this.db.get('SELECT * FROM users WHERE email = ?', email.toLowerCase()) as
      | UserRow
      | undefined
  }

  /** Login identifier may be username or email (GitLab parity). */
  byLogin(login: string): UserRow | undefined {
    return this.byUsername(login) ?? this.byEmail(login)
  }

  count(): number {
    return Number((this.db.get('SELECT COUNT(*) AS c FROM users') as Row).c)
  }

  updateProfile(
    id: number,
    fields: Partial<
      Pick<
        UserRow,
        | 'name' | 'bio' | 'location' | 'website_url' | 'public_email' | 'email' | 'username'
        | 'state' | 'email_verified' | 'password_hash' | 'failed_login_count' | 'locked_until'
      >
    >,
  ): void {
    const allowed = [
      'name', 'bio', 'location', 'website_url', 'public_email',
      'email', 'username', 'state', 'email_verified', 'password_hash',
      'failed_login_count', 'locked_until',
    ] as const
    const sets: string[] = []
    const values: SqlParam[] = []
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = ?`)
        values.push(fields[key] as SqlParam)
      }
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    values.push(nowIso(), id)
    this.db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...values)
  }

  setAvatar(id: number, contentType: string | null, bytes: Buffer | null): void {
    this.db.run(
      'UPDATE users SET avatar_content_type = ?, avatar_bytes = ?, updated_at = ? WHERE id = ?',
      contentType,
      bytes,
      nowIso(),
      id,
    )
  }

  avatar(id: number): { content_type: string; bytes: Buffer } | undefined {
    const row = this.db.get(
      'SELECT avatar_content_type, avatar_bytes FROM users WHERE id = ?',
      id,
    ) as Row | undefined
    if (!row?.avatar_bytes) return undefined
    return {
      content_type: String(row.avatar_content_type),
      bytes: row.avatar_bytes as Buffer,
    }
  }
}

export interface SessionRow {
  id: number
  token_digest: string
  user_id: number
  created_at: string
  last_active_at: string
  expires_at: string
  ip: string | null
  user_agent: string | null
}

export class SessionsRepo {
  constructor(private db: Database) {}

  create(data: {
    tokenDigest: string
    userId: number
    expiresAt: string
    ip?: string
    userAgent?: string
  }): SessionRow {
    const now = nowIso()
    this.db.run(
      `INSERT INTO sessions (token_digest, user_id, created_at, last_active_at, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      data.tokenDigest,
      data.userId,
      now,
      now,
      data.expiresAt,
      data.ip ?? null,
      data.userAgent ?? null,
    )
    return this.byDigest(data.tokenDigest)!
  }

  byDigest(digest: string): SessionRow | undefined {
    return this.db.get('SELECT * FROM sessions WHERE token_digest = ?', digest) as
      | SessionRow
      | undefined
  }

  listForUser(userId: number): Array<SessionRow> {
    return this.db.all(
      'SELECT * FROM sessions WHERE user_id = ? ORDER BY last_active_at DESC',
      userId,
    ) as unknown as Array<SessionRow>
  }

  touch(id: number, nextExpiry: string): void {
    this.db.run('UPDATE sessions SET last_active_at = ?, expires_at = ? WHERE id = ?', nowIso(), nextExpiry, id)
  }

  delete(id: number): void {
    this.db.run('DELETE FROM sessions WHERE id = ?', id)
  }

  deleteForUser(userId: number, exceptSessionId?: number): number {
    const res =
      exceptSessionId !== undefined
        ? this.db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, exceptSessionId)
        : this.db.run('DELETE FROM sessions WHERE user_id = ?', userId)
    return res.changes
  }

  deleteExpired(): void {
    this.db.run('DELETE FROM sessions WHERE expires_at <= ?', nowIso())
  }
}

export interface SshKeyRow {
  id: number
  user_id: number
  title: string
  key_type: string
  bits: number | null
  fingerprint: string
  public_key: string
  comment: string | null
  usage_mode: string
  expires_at: string | null
  created_at: string
}

export class SshKeysRepo {
  constructor(private db: Database) {}

  create(data: Omit<SshKeyRow, 'id' | 'created_at'>): SshKeyRow {
    const res = this.db.run(
      `INSERT INTO ssh_keys (user_id, title, key_type, bits, fingerprint, public_key, comment, usage_mode, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.user_id,
      data.title,
      data.key_type,
      data.bits,
      data.fingerprint,
      data.public_key,
      data.comment,
      data.usage_mode,
      data.expires_at,
      nowIso(),
    )
    return this.byId(res.lastInsertRowid)!
  }

  byId(id: number): SshKeyRow | undefined {
    return this.db.get('SELECT * FROM ssh_keys WHERE id = ?', id) as SshKeyRow | undefined
  }

  byFingerprint(fingerprint: string): SshKeyRow | undefined {
    return this.db.get('SELECT * FROM ssh_keys WHERE fingerprint = ?', fingerprint) as
      | SshKeyRow
      | undefined
  }

  listForUser(userId: number): Array<SshKeyRow> {
    return this.db.all(
      'SELECT * FROM ssh_keys WHERE user_id = ? ORDER BY created_at DESC',
      userId,
    ) as unknown as Array<SshKeyRow>
  }

  delete(id: number): boolean {
    return this.db.run('DELETE FROM ssh_keys WHERE id = ?', id).changes > 0
  }
}

export interface AccessTokenRow {
  id: number
  user_id: number
  name: string
  description: string | null
  scopes: string // JSON array
  token_digest: string
  expires_at: string
  revoked_at: string | null
  last_used_at: string | null
  created_at: string
}

export class AccessTokensRepo {
  constructor(private db: Database) {}

  create(data: {
    userId: number
    name: string
    description?: string
    scopes: string[]
    tokenDigest: string
    expiresAt: string
  }): AccessTokenRow {
    this.db.run(
      `INSERT INTO access_tokens (user_id, name, description, scopes, token_digest, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      data.userId,
      data.name,
      data.description ?? null,
      JSON.stringify(data.scopes),
      data.tokenDigest,
      data.expiresAt,
      nowIso(),
    )
    return this.byDigest(data.tokenDigest)!
  }

  byId(id: number): AccessTokenRow | undefined {
    return this.db.get('SELECT * FROM access_tokens WHERE id = ?', id) as AccessTokenRow | undefined
  }

  byDigest(digest: string): AccessTokenRow | undefined {
    return this.db.get('SELECT * FROM access_tokens WHERE token_digest = ?', digest) as
      | AccessTokenRow
      | undefined
  }

  listForUser(userId: number): Array<AccessTokenRow> {
    return this.db.all(
      'SELECT * FROM access_tokens WHERE user_id = ? ORDER BY created_at DESC',
      userId,
    ) as unknown as Array<AccessTokenRow>
  }

  revoke(id: number): boolean {
    return (
      this.db.run(
        'UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
        nowIso(),
        id,
      ).changes > 0
    )
  }
}

export interface OneTimeTokenRow {
  id: number
  user_id: number
  token_digest: string
  expires_at: string
  used_at: string | null
  created_at: string
}

export class PasswordResetsRepo {
  constructor(private db: Database) {}
  create(userId: number, digest: string, expiresAt: string): void {
    this.db.run(
      `INSERT INTO password_resets (user_id, token_digest, expires_at, created_at) VALUES (?, ?, ?, ?)`,
      userId,
      digest,
      expiresAt,
      nowIso(),
    )
  }
  byDigest(digest: string): OneTimeTokenRow | undefined {
    return this.db.get('SELECT * FROM password_resets WHERE token_digest = ?', digest) as
      | OneTimeTokenRow
      | undefined
  }
  markUsed(id: number): void {
    this.db.run('UPDATE password_resets SET used_at = ? WHERE id = ?', nowIso(), id)
  }
  invalidateForUser(userId: number): void {
    this.db.run(
      'UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL',
      nowIso(),
      userId,
    )
  }
}

export class EmailVerificationsRepo {
  constructor(private db: Database) {}
  create(userId: number, digest: string, expiresAt: string): void {
    this.db.run(
      `INSERT INTO email_verifications (user_id, token_digest, expires_at, created_at) VALUES (?, ?, ?, ?)`,
      userId,
      digest,
      expiresAt,
      nowIso(),
    )
  }
  byDigest(digest: string): OneTimeTokenRow | undefined {
    return this.db.get('SELECT * FROM email_verifications WHERE token_digest = ?', digest) as
      | OneTimeTokenRow
      | undefined
  }
  /** Marks the token consumed (single-use) and records the verification timestamp. */
  markVerified(id: number): void {
    this.db.run('UPDATE email_verifications SET verified_at = ?, used_at = ? WHERE id = ?', nowIso(), nowIso(), id)
  }
}

export type AuditEventName =
  | 'register_success'
  | 'login_success'
  | 'login_failed'
  | 'account_locked'
  | 'logout'
  | 'password_changed'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'email_verified'
  | 'session_revoked'
  | 'ssh_key_added'
  | 'ssh_key_removed'
  | 'pat_created'
  | 'pat_revoked'
  | 'profile_updated'
  | 'avatar_updated'
  // Repository operations (git-core writes; every write is auditable)
  | 'repo_commit_created'
  | 'repo_branch_created'
  | 'repo_branch_deleted'
  | 'repo_branch_renamed'
  | 'repo_default_branch_changed'
  | 'repo_tag_created'
  | 'repo_tag_deleted'
  | 'repo_ref_updated'
  | 'repo_write_denied'

export class AuditRepo {
  constructor(private db: Database) {}

  record(event: {
    userId?: number | null
    name: AuditEventName
    ip?: string | null
    userAgent?: string | null
    detail?: Record<string, unknown>
  }): void {
    this.db.run(
      `INSERT INTO audit_events (user_id, event, ip, user_agent, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      event.userId ?? null,
      event.name,
      event.ip ?? null,
      event.userAgent ?? null,
      event.detail ? JSON.stringify(event.detail) : null,
      nowIso(),
    )
  }

  listForUser(userId: number, limit = 50): Array<Row> {
    return this.db.all(
      'SELECT * FROM audit_events WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      userId,
      limit,
    )
  }
}

export class MailOutboxRepo {
  constructor(private db: Database) {}

  send(to: string, subject: string, body: string): void {
    this.db.run(
      'INSERT INTO mail_outbox (to_email, subject, body, created_at) VALUES (?, ?, ?, ?)',
      to,
      subject,
      body,
      nowIso(),
    )
  }

  /** Dev/test inspection of the outbox (never exposed via HTTP). */
  drain(limit = 100): Array<Row> {
    return this.db.all('SELECT * FROM mail_outbox ORDER BY id DESC LIMIT ?', limit)
  }
}

// ---------------------------------------------------------------------------
// Projects & topics
// ---------------------------------------------------------------------------

export type Visibility = 'private' | 'internal' | 'public'

export interface ProjectRow {
  id: number
  owner_id: number
  name: string
  path: string
  visibility: Visibility
  description: string
  website_url: string
  default_branch: string
  archived: number
  is_template: number
  repository_storage: string
  disk_path: string
  initialized: number
  /** Direct upstream project when this project is a fork. */
  forked_from_project_id: number | null
  /** Id of the fork network's root project; null when not (or no longer) part of a network. */
  fork_network_id: number | null
  last_activity_at: string
  created_at: string
  updated_at: string
}

export class ProjectsRepo {
  constructor(private db: Database) {}

  create(data: {
    owner_id: number
    name: string
    path: string
    visibility?: Visibility
    description?: string
    website_url?: string
    default_branch?: string
    disk_path: string
    initialized?: boolean
  }): ProjectRow {
    const now = nowIso()
    const res = this.db.run(
      `INSERT INTO projects (owner_id, name, path, visibility, description, website_url,
         default_branch, repository_storage, disk_path, initialized, last_activity_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'default', ?, ?, ?, ?, ?)`,
      data.owner_id,
      data.name,
      data.path,
      data.visibility ?? 'private',
      data.description ?? '',
      data.website_url ?? '',
      data.default_branch ?? 'main',
      data.disk_path,
      data.initialized ? 1 : 0,
      now,
      now,
      now,
    )
    return this.byId(res.lastInsertRowid)!
  }

  byId(id: number): ProjectRow | undefined {
    return this.db.get('SELECT * FROM projects WHERE id = ?', id) as ProjectRow | undefined
  }

  /** Live project at an exact owner/path — used for duplicate checks. */
  byOwnerPath(ownerUsername: string, path: string): ProjectRow | undefined {
    return this.db.get(
      `SELECT p.* FROM projects p JOIN users u ON u.id = p.owner_id
       WHERE u.username = ? AND p.path = ?`,
      ownerUsername.toLowerCase(),
      path.toLowerCase(),
    ) as ProjectRow | undefined
  }

  listByOwner(ownerId: number): Array<ProjectRow> {
    return this.db.all(
      'SELECT * FROM projects WHERE owner_id = ? ORDER BY last_activity_at DESC',
      ownerId,
    ) as unknown as Array<ProjectRow>
  }

  listPublic(opts: { search?: string; topic?: string; limit?: number } = {}): Array<ProjectRow> {
    const clauses: string[] = ["p.visibility = 'public'", 'p.archived = 0']
    const params: SqlParam[] = []
    if (opts.search) {
      clauses.push('(p.name LIKE ? OR p.description LIKE ? OR p.path LIKE ?)')
      const like = `%${opts.search}%`
      params.push(like, like, like)
    }
    if (opts.topic) {
      clauses.push(
        'p.id IN (SELECT ptl.project_id FROM project_topic_links ptl JOIN project_topics t ON t.id = ptl.topic_id WHERE t.title = ?)',
      )
      params.push(opts.topic.toLowerCase())
    }
    params.push(opts.limit ?? 50)
    return this.db.all(
      `SELECT p.* FROM projects p WHERE ${clauses.join(' AND ')} ORDER BY p.last_activity_at DESC LIMIT ?`,
      ...params,
    ) as unknown as Array<ProjectRow>
  }

  listTemplates(): Array<ProjectRow> {
    return this.db.all(
      "SELECT * FROM projects WHERE is_template = 1 ORDER BY name",
    ) as unknown as Array<ProjectRow>
  }

  update(
    id: number,
    fields: Partial<Pick<ProjectRow, 'name' | 'path' | 'visibility' | 'description' | 'website_url' | 'default_branch' | 'archived' | 'is_template' | 'owner_id' | 'last_activity_at'>>,
  ): void {
    const sets: string[] = []
    const values: SqlParam[] = []
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key} = ?`)
      values.push(value as SqlParam)
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    values.push(nowIso(), id)
    this.db.run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, ...values)
  }

  count(): number {
    return Number((this.db.get('SELECT COUNT(*) AS c FROM projects') as Row).c)
  }
}

export class TopicsRepo {
  constructor(private db: Database) {}

  /** Normalizes to the canonical (lowercase) form; returns existing row on dedup hit. */
  ensure(title: string): { id: number; title: string } {
    const canonical = title.trim().toLowerCase()
    const existing = this.db.get('SELECT id, title FROM project_topics WHERE title = ?', canonical) as
      | { id: number; title: string }
      | undefined
    if (existing) return existing
    this.db.run('INSERT INTO project_topics (title) VALUES (?)', canonical)
    return this.db.get('SELECT id, title FROM project_topics WHERE title = ?', canonical) as {
      id: number
      title: string
    }
  }

  byTitle(title: string): { id: number; title: string } | undefined {
    return this.db.get('SELECT id, title FROM project_topics WHERE title = ?', title.toLowerCase()) as
      | { id: number; title: string }
      | undefined
  }

  search(query: string, limit = 20): Array<{ id: number; title: string }> {
    return this.db.all(
      'SELECT id, title FROM project_topics WHERE title LIKE ? ORDER BY title LIMIT ?',
      `%${query.toLowerCase()}%`,
      limit,
    ) as unknown as Array<{ id: number; title: string }>
  }

  listForProject(projectId: number): Array<string> {
    return (
      this.db.all(
        `SELECT t.title FROM project_topics t
         JOIN project_topic_links l ON l.topic_id = t.id
         WHERE l.project_id = ? ORDER BY t.title`,
        projectId,
      ) as Array<Row>
    ).map((r) => String(r.title))
  }

  setForProject(projectId: number, titles: string[]): void {
    // Replace-set semantics inside a caller-managed transaction.
    this.db.run('DELETE FROM project_topic_links WHERE project_id = ?', projectId)
    for (const title of titles) {
      const topic = this.ensure(title)
      this.db.run(
        'INSERT OR IGNORE INTO project_topic_links (project_id, topic_id) VALUES (?, ?)',
        projectId,
        topic.id,
      )
    }
  }

  /** Removes topic rows that no longer have any project linked. */
  pruneOrphans(): void {
    this.db.run(
      'DELETE FROM project_topics WHERE id NOT IN (SELECT DISTINCT topic_id FROM project_topic_links)',
    )
  }
}

export interface RedirectRow {
  owner_username: string
  path: string
  project_id: number
  created_at: string
}

export class RedirectsRepo {
  constructor(private db: Database) {}

  create(ownerUsername: string, path: string, projectId: number): void {
    // A live project occupies its own path; never shadow one with a redirect.
    this.db.run(
      `INSERT OR REPLACE INTO project_redirects (owner_username, path, project_id, created_at)
       SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM projects p JOIN users u ON u.id = p.owner_id
         WHERE u.username = ? AND p.path = ?
       )`,
      ownerUsername.toLowerCase(),
      path.toLowerCase(),
      projectId,
      nowIso(),
      ownerUsername.toLowerCase(),
      path.toLowerCase(),
    )
  }

  resolve(ownerUsername: string, path: string): number | undefined {
    const row = this.db.get(
      'SELECT project_id FROM project_redirects WHERE owner_username = ? AND path = ?',
      ownerUsername.toLowerCase(),
      path.toLowerCase(),
    ) as Row | undefined
    return row ? Number(row.project_id) : undefined
  }

  deleteForProject(projectId: number): void {
    this.db.run('DELETE FROM project_redirects WHERE project_id = ?', projectId)
  }

  /** Drops redirects that point where a live project already sits (stale after rename chains). */
  pruneSuperseded(): void {
    this.db.run(
      `DELETE FROM project_redirects
       WHERE EXISTS (
         SELECT 1 FROM projects p JOIN users u ON u.id = p.owner_id
         WHERE u.username = project_redirects.owner_username AND p.path = project_redirects.path
       )`,
    )
  }
}

// ---------------------------------------------------------------------------
// Uploads & events (repository mutation pipeline)
// ---------------------------------------------------------------------------

export interface UploadRow {
  id: string
  project_id: number
  user_id: number
  file_path: string
  declared_size: number
  received_size: number
  sha256: string | null
  state: 'pending' | 'completed' | 'cancelled'
  batch_id: string | null
  created_at: string
  updated_at: string
}

export class UploadsRepo {
  constructor(private db: Database) {}

  create(data: {
    id: string
    projectId: number
    userId: number
    filePath: string
    declaredSize: number
    batchId?: string | null
  }): void {
    const now = nowIso()
    this.db.run(
      `INSERT INTO uploads (id, project_id, user_id, file_path, declared_size, batch_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      data.id,
      data.projectId,
      data.userId,
      data.filePath,
      data.declaredSize,
      data.batchId ?? null,
      now,
      now,
    )
  }

  byId(id: string): UploadRow | undefined {
    return this.db.get('SELECT * FROM uploads WHERE id = ?', id) as UploadRow | undefined
  }

  /** Live (non-terminal) rows of a batch, used by finalize/cancel and duplicate checks. */
  listByBatch(batchId: string): Array<UploadRow> {
    return this.db.all(
      'SELECT * FROM uploads WHERE batch_id = ? ORDER BY created_at, id',
      batchId,
    ) as unknown as Array<UploadRow>
  }

  /** Finds a live staging row for the same path inside the same batch. */
  liveByBatchAndPath(batchId: string, filePath: string): UploadRow | undefined {
    return this.db.get(
      `SELECT * FROM uploads WHERE batch_id = ? AND file_path = ? AND state = 'pending'`,
      batchId,
      filePath,
    ) as UploadRow | undefined
  }

  markReceived(id: string, size: number, sha256: string): void {
    this.db.run(
      "UPDATE uploads SET received_size = ?, sha256 = ?, state = 'pending', updated_at = ? WHERE id = ?",
      size,
      sha256,
      nowIso(),
      id,
    )
  }

  markCompleted(id: string): void {
    this.db.run("UPDATE uploads SET state = 'completed', updated_at = ? WHERE id = ?", nowIso(), id)
  }

  markCancelled(id: string): void {
    this.db.run("UPDATE uploads SET state = 'cancelled', updated_at = ? WHERE id = ?", nowIso(), id)
  }
}

export interface UploadBatchRow {
  id: string
  project_id: number
  user_id: number
  state: 'open' | 'completed' | 'cancelled'
  declared_files: number
  declared_bytes: number
  created_at: string
  updated_at: string
}

export class UploadBatchesRepo {
  constructor(private db: Database) {}

  create(data: {
    id: string
    projectId: number
    userId: number
    declaredFiles: number
    declaredBytes: number
  }): UploadBatchRow {
    const now = nowIso()
    this.db.run(
      `INSERT INTO upload_batches (id, project_id, user_id, declared_files, declared_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      data.id,
      data.projectId,
      data.userId,
      data.declaredFiles,
      data.declaredBytes,
      now,
      now,
    )
    return this.byId(data.id)!
  }

  byId(id: string): UploadBatchRow | undefined {
    return this.db.get('SELECT * FROM upload_batches WHERE id = ?', id) as
      | UploadBatchRow
      | undefined
  }

  setState(id: string, state: UploadBatchRow['state']): void {
    this.db.run('UPDATE upload_batches SET state = ?, updated_at = ? WHERE id = ?', state, nowIso(), id)
  }

  /** Pending batches untouched for longer than the TTL — browser-refresh orphans. */
  staleOpenBefore(cutoffIso: string): Array<UploadBatchRow> {
    return this.db.all(
      "SELECT * FROM upload_batches WHERE state = 'open' AND updated_at < ?",
      cutoffIso,
    ) as unknown as Array<UploadBatchRow>
  }
}

export type ProtectedPushLevel = 'no_one' | 'maintainer'
export interface ProtectedBranchRow {
  project_id: number
  name: string
  push_access_level: ProtectedPushLevel
}

export class ProtectedBranchesRepo {
  constructor(private db: Database) {}

  ensure(projectId: number, name: string, level: ProtectedPushLevel = 'maintainer'): void {
    this.db.run(
      `INSERT OR IGNORE INTO protected_branches (project_id, name, push_access_level)
       VALUES (?, ?, ?)`,
      projectId,
      name,
      level,
    )
  }

  set(projectId: number, name: string, level: ProtectedPushLevel): void {
    this.db.run(
      `INSERT INTO protected_branches (project_id, name, push_access_level) VALUES (?, ?, ?)
       ON CONFLICT(project_id, name) DO UPDATE SET push_access_level = excluded.push_access_level`,
      projectId,
      name,
      level,
    )
  }

  listForProject(projectId: number): Array<ProtectedBranchRow> {
    return this.db.all(
      'SELECT * FROM protected_branches WHERE project_id = ? ORDER BY name',
      projectId,
    ) as unknown as Array<ProtectedBranchRow>
  }

  byName(projectId: number, name: string): ProtectedBranchRow | undefined {
    return this.db.get(
      'SELECT * FROM protected_branches WHERE project_id = ? AND name = ?',
      projectId,
      name,
    ) as ProtectedBranchRow | undefined
  }

  /**
   * Central protected-ref decision (GitLab "push access level" parity).
   * Maintainer-level rules allow owner/admin; `no_one` denies everyone except
   * instance admins. Exact names only until glob support lands.
   */
  pushAllowed(actorIsOwnerOrAdmin: boolean, actorIsAdmin: boolean, row: ProtectedBranchRow | undefined): boolean {
    if (!row) return true
    if (row.push_access_level === 'maintainer') return actorIsOwnerOrAdmin
    return actorIsAdmin // no_one
  }
}

export class EventsRepo {
  constructor(private db: Database, private onEmit?: (row: EventRow) => void) {}

  emit(projectId: number | null, type: string, payload: Record<string, unknown>): void {
    const res = this.db.run(
      'INSERT INTO events (project_id, type, payload, created_at) VALUES (?, ?, ?, ?)',
      projectId,
      type,
      JSON.stringify(payload),
      nowIso(),
    )
    if (this.onEmit) {
      try {
        this.onEmit({ id: Number(res.lastInsertRowid), project_id: projectId, type, payload })
      } catch {
        // Notification fanout must never break the emitting operation.
      }
    }
  }

  listForProject(projectId: number, limit = 50): Array<Row> {
    return this.db.all(
      'SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT ?',
      projectId,
      limit,
    )
  }
}

export interface EventRow {
  id: number
  project_id: number | null
  type: string
  payload: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Social discovery: stars, watches, notification preferences, inbox.
// ---------------------------------------------------------------------------

export class StarsRepo {
  constructor(private db: Database) {}

  /** Idempotent; returns true only when THIS call created the star. */
  star(userId: number, projectId: number): boolean {
    const res = this.db.run(
      `INSERT OR IGNORE INTO stars (user_id, project_id, created_at) VALUES (?, ?, ?)`,
      userId,
      projectId,
      nowIso(),
    )
    return res.changes > 0
  }

  unstar(userId: number, projectId: number): boolean {
    return this.db.run('DELETE FROM stars WHERE user_id = ? AND project_id = ?', userId, projectId).changes > 0
  }

  has(userId: number, projectId: number): boolean {
    return !!this.db.get('SELECT 1 FROM stars WHERE user_id = ? AND project_id = ?', userId, projectId)
  }

  count(projectId: number): number {
    return Number((this.db.get('SELECT COUNT(*) AS c FROM stars WHERE project_id = ?', projectId) as Row).c)
  }

  listByUser(userId: number): Array<ProjectRow> {
    return this.db.all(
      `SELECT p.* FROM projects p JOIN stars s ON s.project_id = p.id
        WHERE s.user_id = ? ORDER BY s.created_at DESC`,
      userId,
    ) as unknown as Array<ProjectRow>
  }
}

export type WatchLevel = 'disabled' | 'participating' | 'mention' | 'watch'

export class WatchSubscriptionsRepo {
  constructor(private db: Database) {}

  set(userId: number, projectId: number, level: WatchLevel, mutedEvents?: string[]): void {
    const now = nowIso()
    if (mutedEvents !== undefined) {
      this.db.run(
        `INSERT INTO watch_subscriptions (user_id, project_id, level, muted_events, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, project_id) DO UPDATE SET
           level = excluded.level, muted_events = excluded.muted_events, updated_at = excluded.updated_at`,
        userId,
        projectId,
        level,
        JSON.stringify(mutedEvents),
        now,
        now,
      )
      return
    }
    this.db.run(
      `INSERT INTO watch_subscriptions (user_id, project_id, level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, project_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
      userId,
      projectId,
      level,
      now,
      now,
    )
  }

  /** Removing the row returns the user to their global default. */
  unset(userId: number, projectId: number): void {
    this.db.run('DELETE FROM watch_subscriptions WHERE user_id = ? AND project_id = ?', userId, projectId)
  }

  get(userId: number, projectId: number): { level: WatchLevel; muted_events: string[] } | null {
    const row = this.db.get(
      'SELECT level, muted_events FROM watch_subscriptions WHERE user_id = ? AND project_id = ?',
      userId,
      projectId,
    ) as Row | undefined
    if (!row) return null
    return { level: row.level as WatchLevel, muted_events: JSON.parse(String(row.muted_events)) as string[] }
  }

  listForProject(projectId: number, level?: WatchLevel): Array<{ user_id: number; level: WatchLevel }> {
    const rows = level
      ? this.db.all('SELECT user_id, level FROM watch_subscriptions WHERE project_id = ? AND level = ?', projectId, level)
      : this.db.all('SELECT user_id, level FROM watch_subscriptions WHERE project_id = ?', projectId)
    return rows as unknown as Array<{ user_id: number; level: WatchLevel }>
  }
}

/** Reserved project_id sentinel meaning "the user's global default". */
export const GLOBAL_PREF_PROJECT_ID = 0

/**
 * Global-only preference rows (defaults + muted event categories).
 * Per-REPOSITORY levels live in watch_subscriptions — the single source of
 * truth — so there is exactly one writer per concept.
 */
export class NotificationPreferencesRepo {
  constructor(private db: Database) {}

  setGlobal(userId: number, level: WatchLevel, mutedEvents: string[] = []): void {
    this.set(userId, GLOBAL_PREF_PROJECT_ID, level, mutedEvents)
  }

  set(
    userId: number,
    projectId: number | null,
    level: WatchLevel,
    mutedEvents: string[] = [],
  ): void {
    const pid = projectId ?? GLOBAL_PREF_PROJECT_ID
    this.db.run(
      `INSERT INTO notification_preferences (user_id, project_id, level, muted_events, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, project_id) DO UPDATE SET
         level = excluded.level, muted_events = excluded.muted_events, updated_at = excluded.updated_at`,
      userId,
      pid,
      level,
      JSON.stringify(mutedEvents),
      nowIso(),
    )
  }

  getForProject(userId: number, projectId: number): { level: WatchLevel; muted_events: string[] } | null {
    const pid = projectId ?? GLOBAL_PREF_PROJECT_ID
    const row = this.db.get(
      'SELECT level, muted_events FROM notification_preferences WHERE user_id = ? AND project_id = ?',
      userId,
      pid,
    ) as Row | undefined
    if (!row) return null
    return { level: row.level as WatchLevel, muted_events: JSON.parse(String(row.muted_events)) as string[] }
  }

  getGlobal(userId: number): { level: WatchLevel; muted_events: string[] } | null {
    return this.getForProject(userId, GLOBAL_PREF_PROJECT_ID)
  }
}

/**
 * Unified resolution used by fanout and API reads:
 *   explicit repository watch level → global preference level → 'participating'.
 * Global muted categories apply everywhere.
 */
export function resolveNotificationSetting(
  watch: WatchSubscriptionsRepo,
  prefs: NotificationPreferencesRepo,
  userId: number,
  projectId: number,
): { level: WatchLevel; muted_events: string[]; source: 'repository' | 'global' | 'default' } {
  const explicit = watch.get(userId, projectId)
  const global = prefs.getGlobal(userId)
  if (explicit) {
    return {
      level: explicit.level,
      muted_events: [...new Set([...explicit.muted_events, ...(global?.muted_events ?? [])])],
      source: 'repository',
    }
  }
  if (global) return { level: global.level, muted_events: global.muted_events, source: 'global' }
  return { level: 'participating', muted_events: [], source: 'default' }
}

export type NotificationType =
  | 'push'
  | 'issue'
  | 'merge_request'
  | 'discussion'
  | 'mention'
  | 'review_request'
  | 'release'
  | 'deployment'
  | 'workflow'
  | 'security_alert'
  | 'fork'

export interface NotificationRow {
  id: number
  user_id: number
  project_id: number | null
  type: NotificationType
  title: string
  body: string | null
  url: string | null
  actor_user_id: number | null
  dedupe_key: string
  read_at: string | null
  created_at: string
}

export class NotificationsRepo {
  constructor(private db: Database) {}

  /** Deduped insert; returns true only when THIS call created the row. */
  insert(n: Omit<NotificationRow, 'id' | 'read_at' | 'created_at'> & { created_at?: string }): boolean {
    const res = this.db.run(
      `INSERT OR IGNORE INTO notifications
         (user_id, project_id, type, title, body, url, actor_user_id, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      n.user_id,
      n.project_id,
      n.type,
      n.title,
      n.body,
      n.url,
      n.actor_user_id,
      n.dedupe_key,
      n.created_at ?? nowIso(),
    )
    return res.changes > 0
  }

  listForUser(
    userId: number,
    opts: { unreadOnly?: boolean; type?: string; projectId?: number; limit?: number } = {},
  ): Array<NotificationRow> {
    const clauses: string[] = ['user_id = ?']
    const params: SqlParam[] = [userId]
    if (opts.unreadOnly) clauses.push('read_at IS NULL')
    if (opts.type) { clauses.push('type = ?'); params.push(opts.type) }
    if (opts.projectId !== undefined) { clauses.push('project_id = ?'); params.push(opts.projectId) }
    params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)))
    return this.db.all(
      `SELECT * FROM notifications WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...params,
    ) as unknown as Array<NotificationRow>
  }

  unreadCount(userId: number, projectId?: number): number {
    const row = projectId !== undefined
      ? (this.db.get('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND project_id = ? AND read_at IS NULL', userId, projectId) as Row)
      : (this.db.get('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL', userId) as Row)
    return Number(row.c)
  }

  markRead(userId: number, id: number): boolean {
    return this.db.run(
      'UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL',
      nowIso(),
      userId,
      id,
    ).changes > 0
  }

  markUnread(userId: number, id: number): boolean {
    return this.db.run(
      'UPDATE notifications SET read_at = NULL WHERE user_id = ? AND id = ? AND read_at IS NOT NULL',
      userId,
      id,
    ).changes > 0
  }

  markAllRead(userId: number, projectId?: number): number {
    return projectId !== undefined
      ? this.db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND project_id = ? AND read_at IS NULL', nowIso(), userId, projectId).changes
      : this.db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', nowIso(), userId).changes
  }
}

// ---------------------------------------------------------------------------
// Resumable upload sessions (UPLOADS.md) — chunked, resumable, idempotent.
// Chunk bytes live in the staging store; rows here are bookkeeping only.
// ---------------------------------------------------------------------------

export type UploadSessionState = 'open' | 'committed' | 'failed' | 'cancelled' | 'expired'
export type UploadItemState =
  | 'pending'
  | 'transferring'
  | 'transferred'
  | 'verified'
  | 'failed'
  | 'skipped'

export interface UploadSessionRow {
  id: string
  project_id: number
  user_id: number
  state: UploadSessionState
  declared_files: number
  declared_bytes: number
  received_bytes: number
  received_chunks: number
  committed_branch: string | null
  committed_sha: string | null
  committed_files: number | null
  finalized_at: string | null
  expires_at: string
  created_at: string
  updated_at: string
}

export interface UploadSessionItemRow {
  id: string
  session_id: string
  file_path: string
  size: number
  mime: string
  last_modified: number | null
  sha256: string | null
  chunk_size: number
  chunk_count: number
  received_chunks: number
  received_bytes: number
  state: UploadItemState
  attempts: number
  failure_code: string | null
  failure_message: string | null
  created_at: string
  updated_at: string
}

export class UploadSessionsRepo {
  constructor(private db: Database) {}

  create(data: {
    id: string
    projectId: number
    userId: number
    declaredFiles: number
    declaredBytes: number
    expiresAt: string
  }): UploadSessionRow {
    const now = nowIso()
    this.db.run(
      `INSERT INTO upload_sessions (id, project_id, user_id, declared_files, declared_bytes, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      data.id,
      data.projectId,
      data.userId,
      data.declaredFiles,
      data.declaredBytes,
      data.expiresAt,
      now,
      now,
    )
    return this.byId(data.id)!
  }

  byId(id: string): UploadSessionRow | undefined {
    return this.db.get('SELECT * FROM upload_sessions WHERE id = ?', id) as
      | UploadSessionRow
      | undefined
  }

  setState(id: string, state: UploadSessionState): void {
    this.db.run(
      'UPDATE upload_sessions SET state = ?, updated_at = ? WHERE id = ?',
      state,
      nowIso(),
      id,
    )
  }

  markCommitted(id: string, result: { branch: string; sha: string; files: number }): void {
    this.db.run(
      `UPDATE upload_sessions SET state = 'committed', committed_branch = ?, committed_sha = ?,
         committed_files = ?, finalized_at = ?, updated_at = ? WHERE id = ?`,
      result.branch,
      result.sha,
      result.files,
      nowIso(),
      nowIso(),
      id,
    )
  }

  /** Declared bytes across a user's OPEN sessions — the staging quota input. */
  openDeclaredBytesForUser(userId: number): number {
    const row = this.db.get(
      "SELECT COALESCE(SUM(declared_bytes), 0) AS total FROM upload_sessions WHERE user_id = ? AND state = 'open'",
      userId,
    ) as Row
    return Number(row.total)
  }

  /** Open sessions whose hard TTL has passed (abandonment sweep input). */
  openExpiredBefore(cutoffIso: string): Array<UploadSessionRow> {
    return this.db.all(
      "SELECT * FROM upload_sessions WHERE state = 'open' AND expires_at <= ?",
      cutoffIso,
    ) as unknown as Array<UploadSessionRow>
  }
}

export class UploadSessionItemsRepo {
  constructor(private db: Database) {}

  createBatch(
    sessionId: string,
    items: Array<{
      id: string
      filePath: string
      size: number
      mime: string
      lastModified?: number | null
      sha256?: string | null
      chunkSize: number
      chunkCount: number
    }>,
  ): void {
    const now = nowIso()
    for (const it of items) {
      this.db.run(
        `INSERT INTO upload_session_items
           (id, session_id, file_path, size, mime, last_modified, sha256, chunk_size, chunk_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        it.id,
        sessionId,
        it.filePath,
        it.size,
        it.mime,
        it.lastModified ?? null,
        it.sha256 ?? null,
        it.chunkSize,
        it.chunkCount,
        now,
        now,
      )
    }
  }

  byId(id: string): UploadSessionItemRow | undefined {
    return this.db.get('SELECT * FROM upload_session_items WHERE id = ?', id) as
      | UploadSessionItemRow
      | undefined
  }

  listForSession(sessionId: string): Array<UploadSessionItemRow> {
    return this.db.all(
      'SELECT * FROM upload_session_items WHERE session_id = ? ORDER BY file_path',
      sessionId,
    ) as unknown as Array<UploadSessionItemRow>
  }

  /**
   * Advisory progress counters. The staging store is authoritative for which
   * chunks exist; these numbers exist for cheap status rendering.
   */
  recordChunk(id: string, byteDelta: number): void {
    this.db.transaction(() => {
      this.db.run(
        `UPDATE upload_session_items SET
           received_chunks = received_chunks + 1,
           received_bytes = received_bytes + ?,
           state = CASE WHEN received_chunks + 1 >= chunk_count THEN 'transferred' ELSE 'transferring' END,
           updated_at = ?
         WHERE id = ?`,
        byteDelta,
        nowIso(),
        id,
      )
      this.db.run(
        `UPDATE upload_sessions SET
           received_chunks = received_chunks + 1,
           received_bytes = received_bytes + ?,
           updated_at = ?
         WHERE id = (SELECT session_id FROM upload_session_items WHERE id = ?)`,
        byteDelta,
        nowIso(),
        id,
      )
    })
  }

  markVerified(ids: Array<string>): void {
    const now = nowIso()
    for (const id of ids) {
      this.db.run(
        "UPDATE upload_session_items SET state = 'verified', updated_at = ? WHERE id = ?",
        now,
        id,
      )
    }
  }

  markSkipped(ids: Array<string>): void {
    const now = nowIso()
    for (const id of ids) {
      this.db.run(
        "UPDATE upload_session_items SET state = 'skipped', failure_code = 'excluded', updated_at = ? WHERE id = ?",
        now,
        id,
      )
    }
  }

  failItem(id: string, code: string, message: string): void {
    this.db.run(
      `UPDATE upload_session_items SET state = 'failed', attempts = attempts + 1,
         failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ?`,
      code,
      message,
      nowIso(),
      id,
    )
  }

  bumpAttempts(id: string, code: string, message: string): void {
    this.db.run(
      `UPDATE upload_session_items SET attempts = attempts + 1,
         failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ?`,
      code,
      message,
      nowIso(),
      id,
    )
  }
}

// ---------------------------------------------------------------------------
// Collaboration: issues, labels, milestones, notes, reactions.
// All SQL for the issue domain lives here (repository-layer contract).
// ---------------------------------------------------------------------------

export interface IssueRow {
  id: number
  project_id: number
  iid: number
  author_id: number
  title: string
  description: string
  state: 'opened' | 'closed'
  confidential: number
  milestone_id: number | null
  due_date: string | null
  closed_at: string | null
  closed_by_id: number | null
  moved_to_id: number | null
  created_at: string
  updated_at: string
}

/** Per-project sequence numbers — GitLab internal_ids parity. */
export class InternalIdsRepo {
  constructor(private db: Database) {}

  next(projectId: number, usage: 'issue'): number {
    return this.db.transaction(() => {
      this.db.run(
        `INSERT INTO internal_ids (project_id, usage_name, last_value) VALUES (?, ?, 0)
         ON CONFLICT(project_id, usage_name) DO NOTHING`,
        projectId,
        usage,
      )
      this.db.run(
        'UPDATE internal_ids SET last_value = last_value + 1 WHERE project_id = ? AND usage_name = ?',
        projectId,
        usage,
      )
      const row = this.db.get(
        'SELECT last_value FROM internal_ids WHERE project_id = ? AND usage_name = ?',
        projectId,
        usage,
      ) as Row
      return Number(row.last_value)
    })
  }
}

export interface IssueFilterOptions {
  state?: 'opened' | 'closed' | 'all'
  milestoneId?: number | 'none' | 'any'
  labelIds?: number[]
  assigneeId?: number | null // null = unassigned ('None')
  authorId?: number
  search?: string
  orderBy?: 'created_at' | 'updated_at'
  sort?: 'asc' | 'desc'
  page?: number
  perPage?: number
  /** Confidentiality scope (PERMISSIONS.md §6). */
  viewerId?: number | null
  /** true ⇒ viewer sees every confidential issue (reporter+/admin/owner). */
  unrestrictedConfidential?: boolean
}

export interface IssueListResult {
  rows: Array<IssueRow>
  total: number
  page: number
  perPage: number
}

export class IssuesRepo {
  constructor(private db: Database) {}

  create(data: {
    project_id: number
    author_id: number
    title: string
    description?: string
    confidential?: boolean
    milestone_id?: number | null
    due_date?: string | null
  }): IssueRow {
    const now = nowIso()
    const iid = new InternalIdsRepo(this.db).next(data.project_id, 'issue')
    const res = this.db.run(
      `INSERT INTO issues (project_id, iid, author_id, title, description, confidential, milestone_id, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.project_id,
      iid,
      data.author_id,
      data.title,
      data.description ?? '',
      data.confidential ? 1 : 0,
      data.milestone_id ?? null,
      data.due_date ?? null,
      now,
      now,
    )
    return this.byId(res.lastInsertRowid)!
  }

  byId(id: number): IssueRow | undefined {
    return this.db.get('SELECT * FROM issues WHERE id = ?', id) as IssueRow | undefined
  }

  byIid(projectId: number, iid: number): IssueRow | undefined {
    return this.db.get('SELECT * FROM issues WHERE project_id = ? AND iid = ?', projectId, iid) as
      | IssueRow
      | undefined
  }

  update(id: number, fields: Partial<Pick<
    IssueRow,
    'title' | 'description' | 'state' | 'confidential' | 'milestone_id' | 'due_date' | 'closed_at' | 'closed_by_id'
  >>): void {
    const allowed = [
      'title', 'description', 'state', 'confidential',
      'milestone_id', 'due_date', 'closed_at', 'closed_by_id',
    ] as const
    const sets: string[] = []
    const values: SqlParam[] = []
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = ?`)
        values.push(fields[key] as SqlParam)
      }
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    values.push(nowIso(), id)
    this.db.run(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`, ...values)
  }

  delete(id: number): boolean {
    return this.db.run('DELETE FROM issues WHERE id = ?', id).changes > 0
  }

  countForProject(projectId: number, state: 'opened' | 'closed' | 'all' = 'all'): number {
    if (state === 'all') {
      const row = this.db.get('SELECT COUNT(*) AS c FROM issues WHERE project_id = ?', projectId) as Row
      return Number(row.c)
    }
    const row = this.db.get(
      'SELECT COUNT(*) AS c FROM issues WHERE project_id = ? AND state = ?',
      projectId,
      state,
    ) as Row
    return Number(row.c)
  }

  /**
   * Filtered listing. Every branch keeps the query on idx_issues_list
   * (project_id, state) so pagination stays index-driven; label/assignee
   * filters are EXISTS probes against their PK-backed link tables.
   */
  listFiltered(projectId: number, f: IssueFilterOptions): IssueListResult {
    const clauses: string[] = ['i.project_id = ?']
    const params: SqlParam[] = [projectId]

    clauses.push(f.state === undefined || f.state === 'all' ? '1=1' : 'i.state = ?')
    if (f.state && f.state !== 'all') params.push(f.state)

    if (f.milestoneId === 'none') {
      clauses.push('i.milestone_id IS NULL')
    } else if (f.milestoneId === 'any') {
      clauses.push('i.milestone_id IS NOT NULL')
    } else if (typeof f.milestoneId === 'number') {
      clauses.push('i.milestone_id = ?')
      params.push(f.milestoneId)
    }

    if (f.labelIds && f.labelIds.length > 0) {
      const placeholders = f.labelIds.map(() => '?').join(',')
      clauses.push(
        `(SELECT COUNT(DISTINCT il.label_id) FROM issue_labels il
          WHERE il.issue_id = i.id AND il.label_id IN (${placeholders})) = ${f.labelIds.length}`,
      )
      params.push(...f.labelIds)
    }

    if (f.assigneeId === null) {
      clauses.push('NOT EXISTS (SELECT 1 FROM issue_assignees ia WHERE ia.issue_id = i.id)')
    } else if (f.assigneeId !== undefined) {
      clauses.push('EXISTS (SELECT 1 FROM issue_assignees ia WHERE ia.issue_id = i.id AND ia.user_id = ?)')
      params.push(f.assigneeId)
    }

    if (f.authorId !== undefined) {
      clauses.push('i.author_id = ?')
      params.push(f.authorId)
    }

    if (f.search) {
      clauses.push('(i.title LIKE ? OR i.description LIKE ?)')
      const like = `%${f.search}%`
      params.push(like, like)
    }

    // Confidential issues: hidden from anonymous viewers; visible to their
    // author/assignees; unrestricted for reporter+ equivalents.
    if (!f.unrestrictedConfidential) {
      if (f.viewerId === null || f.viewerId === undefined) {
        clauses.push('i.confidential = 0')
      } else {
        clauses.push(
          `(i.confidential = 0 OR i.author_id = ? OR EXISTS (
             SELECT 1 FROM issue_assignees cv WHERE cv.issue_id = i.id AND cv.user_id = ?))`,
        )
        params.push(f.viewerId, f.viewerId)
      }
    }

    const order = f.orderBy === 'created_at' ? 'i.created_at' : 'i.updated_at'
    const dir = f.sort === 'asc' ? 'ASC' : 'DESC'
    const page = Math.max(1, Math.floor(f.page ?? 1))
    const perPage = Math.min(100, Math.max(1, Math.floor(f.perPage ?? 20)))

    const total = Number(
      ((this.db.get(`SELECT COUNT(*) AS c FROM issues i WHERE ${clauses.join(' AND ')}`, ...params)) as Row).c,
    )
    const rows = this.db.all(
      `SELECT i.* FROM issues i WHERE ${clauses.join(' AND ')}
       ORDER BY ${order} ${dir}, i.iid ${dir}
       LIMIT ? OFFSET ?`,
      ...params,
      perPage,
      (page - 1) * perPage,
    ) as unknown as Array<IssueRow>

    return { rows, total, page, perPage }
  }

  setAssignees(issueId: number, userIds: number[]): void {
    this.db.run('DELETE FROM issue_assignees WHERE issue_id = ?', issueId)
    for (const uid of [...new Set(userIds)]) {
      this.db.run(
        'INSERT OR IGNORE INTO issue_assignees (issue_id, user_id) VALUES (?, ?)',
        issueId,
        uid,
      )
    }
  }

  assigneeIds(issueId: number): number[] {
    return (
      this.db.all(
        'SELECT user_id FROM issue_assignees WHERE issue_id = ? ORDER BY user_id',
        issueId,
      ) as Array<Row>
    ).map((r) => Number(r.user_id))
  }

  /** Issues where the user participates (author or assignee) — notification fanout input. */
  participationCount(userId: number, projectId: number): number {
    const row = this.db.get(
      `SELECT COUNT(*) AS c FROM issues i
       WHERE i.project_id = ? AND (i.author_id = ?
         OR EXISTS (SELECT 1 FROM issue_assignees ia WHERE ia.issue_id = i.id AND ia.user_id = ?))`,
      projectId,
      userId,
      userId,
    ) as Row
    return Number(row.c)
  }
}

// -- labels -------------------------------------------------------------------

export interface LabelRow {
  id: number
  project_id: number
  title: string
  description: string
  color: string
  scope: 'project' | 'group'
  created_at: string
  updated_at: string
}

const HEX_COLOR = /^#[0-9a-f]{6}$/

/**
 * Canonical form for user-defined colors: strict lowercase #rrggbb hex.
 * Accepts #rgb, #rrggbb and bare rrggbb spellings; everything else is
 * rejected so no named/neon garbage ever reaches the presentation layer.
 */
export function normalizeHexColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let v = raw.trim().toLowerCase()
  if (!v.startsWith('#')) v = `#${v}`
  if (/^#[0-9a-f]{3}$/.test(v)) {
    v = `#${[1, 2, 3].map((i) => `${v[i]}${v[i]}`).join('')}`
  }
  return HEX_COLOR.test(v) ? v : null
}

export class LabelsRepo {
  constructor(private db: Database) {}

  create(data: { project_id: number; title: string; description?: string; color?: string; scope?: 'project' | 'group' }): LabelRow {
    const now = nowIso()
    const res = this.db.run(
      `INSERT INTO labels (project_id, title, description, color, scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      data.project_id,
      data.title,
      data.description ?? '',
      normalizeHexColor(data.color) ?? '#8a8a8a',
      data.scope ?? 'project',
      now,
      now,
    )
    return this.byId(res.lastInsertRowid)!
  }

  byId(id: number): LabelRow | undefined {
    return this.db.get('SELECT * FROM labels WHERE id = ?', id) as LabelRow | undefined
  }

  byTitle(projectId: number, title: string): LabelRow | undefined {
    return this.db.get('SELECT * FROM labels WHERE project_id = ? AND title = ?', projectId, title) as
      | LabelRow
      | undefined
  }

  listForProject(projectId: number): Array<LabelRow> {
    return this.db.all('SELECT * FROM labels WHERE project_id = ? ORDER BY title COLLATE NOCASE', projectId) as
      unknown as Array<LabelRow>
  }

  update(id: number, fields: Partial<Pick<LabelRow, 'title' | 'description' | 'color'>>): void {
    const sets: string[] = []
    const values: SqlParam[] = []
    if (fields.title !== undefined) { sets.push('title = ?'); values.push(fields.title) }
    if (fields.description !== undefined) { sets.push('description = ?'); values.push(fields.description) }
    if (fields.color !== undefined) {
      const c = normalizeHexColor(fields.color)
      if (c) { sets.push('color = ?'); values.push(c) }
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    values.push(nowIso(), id)
    this.db.run(`UPDATE labels SET ${sets.join(', ')} WHERE id = ?`, ...values)
  }

  delete(id: number): boolean {
    return this.db.run('DELETE FROM labels WHERE id = ?', id).changes > 0
  }

  /** GitLab-parity starter set applied once at project creation. */
  seedDefaults(projectId: number): void {
    const defaults: Array<[string, string, string]> = [
      ['bug', 'Something is not working', '#e5484d'],
      ['feature', 'New functionality', '#3ecf5e'],
      ['documentation', 'Writing or improving docs', '#e07856'],
      ['critical', 'Highest priority — drop everything', '#e5484d'],
    ]
    for (const [title, description, color] of defaults) {
      if (!this.byTitle(projectId, title)) this.create({ project_id: projectId, title, description, color })
    }
  }

  attach(issueId: number, labelId: number): boolean {
    return this.db.run(
      'INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)',
      issueId,
      labelId,
    ).changes > 0
  }

  detach(issueId: number, labelId: number): boolean {
    return this.db.run(
      'DELETE FROM issue_labels WHERE issue_id = ? AND label_id = ?',
      issueId,
      labelId,
    ).changes > 0
  }

  setForIssue(issueId: number, labelIds: number[]): void {
    this.db.run('DELETE FROM issue_labels WHERE issue_id = ?', issueId)
    for (const lid of labelIds) this.attach(issueId, lid)
  }

  idsForIssue(issueId: number): number[] {
    return (
      this.db.all('SELECT label_id FROM issue_labels WHERE issue_id = ? ORDER BY label_id', issueId) as Array<Row>
    ).map((r) => Number(r.label_id))
  }

  rowsForIssue(issueId: number): Array<LabelRow> {
    return this.db.all(
      `SELECT l.* FROM labels l JOIN issue_labels il ON il.label_id = l.id
       WHERE il.issue_id = ? ORDER BY l.title COLLATE NOCASE`,
      issueId,
    ) as unknown as Array<LabelRow>
  }

  usageCount(labelId: number): number {
    const row = this.db.get('SELECT COUNT(*) AS c FROM issue_labels WHERE label_id = ?', labelId) as Row
    return Number(row.c)
  }
}

// -- milestones ---------------------------------------------------------------

export type MilestoneState = 'active' | 'closed'

export interface MilestoneRow {
  id: number
  project_id: number
  title: string
  description: string
  due_date: string | null
  state: MilestoneState
  created_at: string
  updated_at: string
}

export class MilestonesRepo {
  constructor(private db: Database) {}

  create(data: { project_id: number; title: string; description?: string; due_date?: string | null }): MilestoneRow {
    const now = nowIso()
    const res = this.db.run(
      `INSERT INTO milestones (project_id, title, description, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      data.project_id,
      data.title,
      data.description ?? '',
      data.due_date ?? null,
      now,
      now,
    )
    return this.byId(res.lastInsertRowid)!
  }

  byId(id: number): MilestoneRow | undefined {
    return this.db.get('SELECT * FROM milestones WHERE id = ?', id) as MilestoneRow | undefined
  }

  byTitle(projectId: number, title: string): MilestoneRow | undefined {
    return this.db.get('SELECT * FROM milestones WHERE project_id = ? AND title = ?', projectId, title) as
      | MilestoneRow
      | undefined
  }

  listForProject(projectId: number, state?: MilestoneState): Array<MilestoneRow> {
    if (state) {
      return this.db.all(
        'SELECT * FROM milestones WHERE project_id = ? AND state = ? ORDER BY (due_date IS NULL), due_date, id',
        projectId,
        state,
      ) as unknown as Array<MilestoneRow>
    }
    return this.db.all(
      'SELECT * FROM milestones WHERE project_id = ? ORDER BY (due_date IS NULL), due_date, id',
      projectId,
    ) as unknown as Array<MilestoneRow>
  }

  update(id: number, fields: Partial<Pick<MilestoneRow, 'title' | 'description' | 'due_date' | 'state'>>): void {
    const sets: string[] = []
    const values: SqlParam[] = []
    for (const key of ['title', 'description', 'due_date', 'state'] as const) {
      if (fields[key] !== undefined) { sets.push(`${key} = ?`); values.push(fields[key] as SqlParam) }
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    values.push(nowIso(), id)
    this.db.run(`UPDATE milestones SET ${sets.join(', ')} WHERE id = ?`, ...values)
  }

  delete(id: number): boolean {
    // issues.milestone_id is ON DELETE SET NULL — unlinking is automatic.
    return this.db.run('DELETE FROM milestones WHERE id = ?', id).changes > 0
  }

  counts(milestoneId: number): { total: number; opened: number; closed: number } {
    const row = this.db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN state = 'opened' THEN 1 ELSE 0 END) AS opened,
              SUM(CASE WHEN state = 'closed' THEN 1 ELSE 0 END) AS closed
       FROM issues WHERE milestone_id = ?`,
      milestoneId,
    ) as Row
    return {
      total: Number(row.total ?? 0),
      opened: Number(row.opened ?? 0),
      closed: Number(row.closed ?? 0),
    }
  }

  /** Completion percentage (GitLab parity): closed / total, rounded down. */
  completionPercent(milestoneId: number): number {
    const c = this.counts(milestoneId)
    if (c.total === 0) return 0
    return Math.floor((c.closed / c.total) * 100)
  }
}

// -- notes & timeline -----------------------------------------------------------

export interface NoteRow {
  id: number
  noteable_type: 'issue'
  noteable_id: number
  project_id: number
  author_id: number | null
  note: string
  system: number
  created_at: string
  updated_at: string
}

export class NotesRepo {
  constructor(private db: Database) {}

  create(data: {
    noteable_type: 'issue'
    noteable_id: number
    project_id: number
    author_id: number | null
    note: string
    system?: boolean
  }): NoteRow {
    const now = nowIso()
    const res = this.db.run(
      `INSERT INTO notes (noteable_type, noteable_id, project_id, author_id, note, system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      data.noteable_type,
      data.noteable_id,
      data.project_id,
      data.author_id,
      data.note,
      data.system ? 1 : 0,
      now,
      now,
    )
    return this.byId(res.lastInsertRowid)!
  }

  byId(id: number): NoteRow | undefined {
    return this.db.get('SELECT * FROM notes WHERE id = ?', id) as NoteRow | undefined
  }

  /** Full activity timeline: human comments + system events, chronological. */
  timeline(noteableType: 'issue', noteableId: number, opts: { includeSystem?: boolean } = {}): Array<NoteRow> {
    const sysClause = opts.includeSystem === false ? 'AND system = 0' : ''
    return this.db.all(
      `SELECT * FROM notes WHERE noteable_type = ? AND noteable_id = ? ${sysClause} ORDER BY id`,
      noteableType,
      noteableId,
    ) as unknown as Array<NoteRow>
  }

  update(id: number, note: string): void {
    this.db.run('UPDATE notes SET note = ?, updated_at = ? WHERE id = ? AND system = 0', note, nowIso(), id)
  }

  delete(id: number): boolean {
    return this.db.run('DELETE FROM notes WHERE id = ? AND system = 0', id).changes > 0
  }
}

// -- reactions ------------------------------------------------------------------

/** Server-side allowlist — no arbitrary content enters the reaction column. */
export const REACTION_EMOJI = [
  'thumbsup', 'thumbsdown', 'smile', 'tada', 'confetti_ball',
  'heart', 'rocket', 'eyes', 'fire', 'thinking',
] as const
export type ReactionName = (typeof REACTION_EMOJI)[number]
export function isReactionName(v: unknown): v is ReactionName {
  return typeof v === 'string' && (REACTION_EMOJI as readonly string[]).includes(v)
}

export interface ReactionRow {
  id: number
  user_id: number
  noteable_type: 'issue' | 'note'
  noteable_id: number
  name: ReactionName
  created_at: string
}

export class ReactionsRepo {
  constructor(private db: Database) {}

  toggle(userId: number, targetType: 'issue' | 'note', targetId: number, name: ReactionName): 'awarded' | 'revoked' {
    const existing = this.db.get(
      'SELECT id FROM reactions WHERE user_id = ? AND noteable_type = ? AND noteable_id = ? AND name = ?',
      userId,
      targetType,
      targetId,
      name,
    ) as Row | undefined
    if (existing) {
      this.db.run('DELETE FROM reactions WHERE id = ?', existing.id)
      return 'revoked'
    }
    this.db.run(
      'INSERT INTO reactions (user_id, noteable_type, noteable_id, name, created_at) VALUES (?, ?, ?, ?, ?)',
      userId,
      targetType,
      targetId,
      name,
      nowIso(),
    )
    return 'awarded'
  }

  summary(targetType: 'issue' | 'note', targetId: number, viewerId?: number): Array<{
    name: string
    count: number
    me: boolean
  }> {
    const rows = this.db.all(
      'SELECT name, user_id FROM reactions WHERE noteable_type = ? AND noteable_id = ? ORDER BY MIN(created_at)',
      targetType,
      targetId,
    ) as Array<Row>
    const agg = new Map<string, { count: number; me: boolean }>()
    for (const r of rows) {
      const n = String(r.name)
      const cur = agg.get(n) ?? { count: 0, me: false }
      cur.count++
      if (viewerId !== undefined && Number(r.user_id) === viewerId) cur.me = true
      agg.set(n, cur)
    }
    return [...agg.entries()].map(([name, v]) => ({ name, ...v }))
  }

  byName(targetType: 'issue' | 'note', targetId: number, name: ReactionName): Array<ReactionRow> {
    return this.db.all(
      'SELECT * FROM reactions WHERE noteable_type = ? AND noteable_id = ? AND name = ?',
      targetType,
      targetId,
      name,
    ) as unknown as Array<ReactionRow>
  }
}

// -- mentions & task lists (pure helpers used by the issues service) ------------

/**
 * Extracts @username mentions from markdown-ish text. Usernames match the
 * registration charset; a mention must be followed by a word boundary and may
 * be escaped with \`@user\` to suppress linking.
 */
export function extractMentions(text: string): string[] {
  const out = new Set<string>()
  const pattern = /(?<!`)@([a-zA-Z0-9_](?:[a-zA-Z0-9_.-]?[a-zA-Z0-9_]){0,29})/g
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text)) !== null) out.add(m[1]!.toLowerCase())
  return [...out]
}

export interface TaskItem { line: number; checked: boolean; text: string }

/** Markdown task-list items (`- [ ]` / `- [x]`), in document order. */
export function extractTaskItems(markdown: string): Array<TaskItem> {
  const items: Array<TaskItem> = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s+)(.*)$/.exec(lines[i]!)
    if (m) items.push({ line: i, checked: m[2]!.toLowerCase() === 'x', text: m[4]! })
  }
  return items
}

/** Flips the nth checkbox across the whole document and returns the new text. */
export function toggleTaskItem(markdown: string, index: number): string | null {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const items = extractTaskItems(markdown)
  const item = items[index]
  if (!item || item.line >= lines.length) return null
  const line = lines[item.line]!
  lines[item.line] =
    item.checked
      ? line.replace(/(\[\s*)x([\]\s])/i, '$1 $2')
      : line.replace(/(\[\s*\])(\s)/, '[x]$2')
  return lines.join('\n')
}

export interface TaskProgress { total: number; completed: number }

export function taskProgress(markdown: string): TaskProgress {
  const items = extractTaskItems(markdown)
  return { total: items.length, completed: items.filter((i) => i.checked).length }
}
