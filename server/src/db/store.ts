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
