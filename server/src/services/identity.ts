import { generateToken, hashPassword, tokenDigest, verifyPassword } from '../lib/crypto.js'
import {
  validatePasswordReset,
  validateRegistration,
  passwordIssues,
  usernameSchema,
} from '../lib/validation.js'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/database.js'
import { isoPlus } from '../db/database.js'
import {
  AccessTokensRepo,
  AuditRepo,
  EmailVerificationsRepo,
  MailOutboxRepo,
  ProjectsRepo,
  TopicsRepo,
  RedirectsRepo,
  PasswordResetsRepo,
  SessionsRepo,
  SshKeysRepo,
  UsersRepo,
  type UserRow,
} from '../db/store.js'
import { verificationEmail, passwordResetEmail, type Mailer } from './mailer.js'

/** Domain error carrying an HTTP status and a safe, user-facing message. */
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public extras?: Record<string, unknown>,
  ) {
    super(message)
  }
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export interface IdentityServices {
  db: Database
  users: UsersRepo
  sessions: SessionsRepo
  sshKeys: SshKeysRepo
  tokens: AccessTokensRepo
  resets: PasswordResetsRepo
  verifications: EmailVerificationsRepo
  audit: AuditRepo
  outbox: MailOutboxRepo
  projects: ProjectsRepo
  topics: TopicsRepo
  redirects: RedirectsRepo
}

export function makeServices(db: Database): IdentityServices {
  return {
    db,
    users: new UsersRepo(db),
    sessions: new SessionsRepo(db),
    sshKeys: new SshKeysRepo(db),
    tokens: new AccessTokensRepo(db),
    resets: new PasswordResetsRepo(db),
    verifications: new EmailVerificationsRepo(db),
    audit: new AuditRepo(db),
    outbox: new MailOutboxRepo(db),
    projects: new ProjectsRepo(db),
    topics: new TopicsRepo(db),
    redirects: new RedirectsRepo(db),
  }
}

// ---------------------------------------------------------------------------
// Identity service — registration, authentication, recovery, profile.
// Authorization decisions are NOT made here; routes consult the authz service.
// ---------------------------------------------------------------------------

export class IdentityService {
  constructor(private s: IdentityServices, private cfg: AppConfig, private mailer: Mailer) {}

  // -- registration ---------------------------------------------------------

  register(input: unknown): UserRow {
    const parsed = validateRegistration(input, this.cfg.passwordMinLength)
    if (!parsed.ok) throw new AppError(400, parsed.error, 'validation_failed')

    const { username, email, name, password } = parsed.value
    if (this.s.users.byUsername(username)) {
      throw new AppError(409, 'Username has already been taken', 'username_taken')
    }
    if (this.s.users.byEmail(email)) {
      throw new AppError(409, 'Email has already been taken', 'email_taken')
    }

    // GitLab parity: the first registered user becomes the instance administrator.
    const isFirst = this.s.users.count() === 0

    const user = this.db.transaction(() => {
      const created = this.s.users.create({
        username,
        email,
        name,
        passwordHash: hashPassword(password),
        admin: isFirst,
      })
      this.issueVerification(created)
      return created
    })

    this.s.audit.record({ userId: user.id, name: 'register_success' })
    return user
  }

  private issueVerification(user: UserRow): void {
    const raw = generateToken()
    this.s.verifications.create(user.id, tokenDigest(raw), isoPlus(this.cfg.verificationTokenTtlDays * DAY))
    const mail = verificationEmail(this.cfg.origin, raw)
    this.mailer.send(user.email, mail.subject, mail.body)
  }

  resendVerification(userId: number): void {
    const user = this.requireUser(userId)
    if (user.email_verified) throw new AppError(400, 'Email is already verified')
    this.issueVerification(user)
  }

  verifyEmail(rawToken: string): void {
    const row = this.consumeOneTime(
      this.s.verifications.byDigest(tokenDigest(rawToken)),
      'verification',
    )
    this.s.verifications.markVerified(row.id)
    this.s.users.updateProfile(row.user_id, { email_verified: 1 })
    this.s.audit.record({ userId: row.user_id, name: 'email_verified' })
  }

  // -- authentication -------------------------------------------------------

  /**
   * Returns the user on success. Throws AppError:
   *  - 400 invalid_credentials (generic message — never reveals which part was wrong,
   *    and identical for unknown users to prevent enumeration)
   *  - 423 account_locked with retry_after_seconds
   */
  authenticate(login: string, password: string, ctx: { ip?: string; userAgent?: string } = {}): UserRow {
    const user = this.s.users.byLogin(login.trim().toLowerCase())

    if (!user) {
      // Burn comparable time so timing does not leak account existence.
      verifyPassword(password, hashPassword('timing-equalizer'))
      this.auditFailure(null, login, ctx)
      throw new AppError(400, 'Invalid login or password', 'invalid_credentials')
    }
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      const retryAfter = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000)
      throw new AppError(423, 'Account locked due to too many failed sign-in attempts', 'account_locked', {
        retry_after_seconds: retryAfter,
      })
    }

    if (!verifyPassword(password, user.password_hash)) {
      const count = user.failed_login_count + 1
      if (count >= this.cfg.maxFailedLogins) {
        const until = isoPlus(this.cfg.lockoutMinutes * MIN)
        this.s.users.updateProfile(user.id, {
          failed_login_count: count,
          locked_until: until,
        } as never)
        this.s.audit.record({
          userId: user.id,
          name: 'account_locked',
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          detail: { failed_attempts: count },
        })
        throw new AppError(423, 'Account locked due to too many failed sign-in attempts', 'account_locked', {
          retry_after_seconds: Math.ceil((new Date(until).getTime() - Date.now()) / 1000),
        })
      }
      this.s.users.updateProfile(user.id, { failed_login_count: count } as never)
      this.auditFailure(user.id, login, ctx)
      throw new AppError(400, 'Invalid login or password', 'invalid_credentials')
    }

    if (user.state !== 'active') {
      throw new AppError(403, 'This account is not allowed to sign in', 'account_inactive')
    }

    this.s.users.updateProfile(user.id, { failed_login_count: 0, locked_until: null } as never)
    this.s.audit.record({ userId: user.id, name: 'login_success', ip: ctx.ip, userAgent: ctx.userAgent })
    return user
  }

  private auditFailure(userId: number | null, login: string, ctx: { ip?: string; userAgent?: string }) {
    this.s.audit.record({
      userId: undefined,
      name: 'login_failed',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      detail: { login_attempt: login.slice(0, 100), user_id: userId },
    })
  }

  // -- sessions -------------------------------------------------------------

  createSession(user: UserRow, meta: { ip?: string; userAgent?: string }): string {
    const raw = generateToken()
    this.s.sessions.create({
      tokenDigest: tokenDigest(raw),
      userId: user.id,
      expiresAt: isoPlus(this.cfg.sessionTtlMinutes * MIN),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 255),
    })
    return raw
  }

  logoutByDigest(digest: string, userId: number | null): void {
    const session = this.s.sessions.byDigest(digest)
    if (session) this.s.sessions.delete(session.id)
    if (userId) this.s.audit.record({ userId, name: 'logout' })
  }

  revokeOtherSessions(userId: number, currentSessionId: number | null): number {
    const n = this.s.sessions.deleteForUser(userId, currentSessionId ?? undefined)
    if (n > 0) {
      this.s.audit.record({
        userId,
        name: 'session_revoked',
        detail: { scope: 'others', revoked_count: n },
      })
    }
    return n
  }

  // -- password management --------------------------------------------------

  changePassword(userId: number, currentPassword: string, newPassword: string, keepSessionId: number | null): void {
    const user = this.requireUser(userId)
    if (!verifyPassword(currentPassword, user.password_hash)) {
      throw new AppError(400, 'Current password is incorrect', 'invalid_credentials')
    }
    this.applyNewPassword(user, newPassword, keepSessionId)
  }

  requestPasswordReset(email: string): void {
    // Anti-enumeration: identical externally-visible behavior for unknown emails.
    const user = this.s.users.byEmail(email.trim().toLowerCase())
    if (!user) return
    const raw = generateToken()
    this.s.resets.create(user.id, tokenDigest(raw), isoPlus(this.cfg.resetTokenTtlHours * HOUR))
    this.s.audit.record({ userId: user.id, name: 'password_reset_requested' })
    const mail = passwordResetEmail(this.cfg.origin, raw)
    this.mailer.send(user.email, mail.subject, mail.body)
  }

  completePasswordReset(rawToken: string, input: unknown): void {
    const parsed = validatePasswordReset({ password: (input as { password?: string }).password, resetToken: rawToken }, this.cfg.passwordMinLength)
    if (!parsed.ok) throw new AppError(400, parsed.error, 'validation_failed')
    const row = this.consumeOneTime(this.s.resets.byDigest(tokenDigest(rawToken)), 'password reset')
    const user = this.requireUser(row.user_id)
    this.db.transaction(() => {
      this.s.resets.markUsed(row.id)
      this.s.resets.invalidateForUser(user.id)
      this.applyNewPassword(user, parsed.value.password, null) // revokes all sessions
    })
  }

  private applyNewPassword(user: UserRow, newPassword: string, keepSessionId: number | null): void {
    const issues = passwordIssues(newPassword, this.cfg.passwordMinLength)
    if (issues.length) throw new AppError(400, issues[0]!, 'validation_failed')
    if (newPassword.toLowerCase().includes(user.username.toLowerCase())) {
      throw new AppError(400, 'Password must not contain your username', 'validation_failed')
    }
    this.s.users.updateProfile(user.id, {
      password_hash: hashPassword(newPassword),
      failed_login_count: 0,
      locked_until: null,
    } as never)
    // Password change invalidates every other session (GitLab parity).
    this.revokeOtherSessions(user.id, keepSessionId)
    this.s.audit.record({ userId: user.id, name: 'password_changed' })
  }

  // -- profile --------------------------------------------------------------

  updateProfile(userId: number, fields: Record<string, unknown>): UserRow {
    const user = this.requireUser(userId)

    if (fields.username !== undefined && String(fields.username).toLowerCase() !== user.username) {
      const uname = usernameSchema.safeParse(String(fields.username))
      if (!uname.success) throw new AppError(400, uname.error.issues[0]?.message ?? 'Invalid username')
      if (this.s.users.byUsername(uname.data)) {
        throw new AppError(409, 'Username has already been taken', 'username_taken')
      }
    }
    const str = (v: unknown, max: number) => {
      const s = String(v ?? '').trim()
      if (s.length > max) throw new AppError(400, `Value exceeds ${max} characters`)
      return s === '' ? null : s
    }
    this.s.users.updateProfile(user.id, {
      ...(fields.name !== undefined ? { name: str(fields.name, 255) } : {}),
      ...(fields.bio !== undefined ? { bio: str(fields.bio, 500) } : {}),
      ...(fields.location !== undefined ? { location: str(fields.location, 128) } : {}),
      ...(fields.website_url !== undefined ? { website_url: str(fields.website_url, 255) } : {}),
      ...(fields.public_email !== undefined ? { public_email: str(fields.public_email, 255)?.toLowerCase() ?? null } : {}),
      ...(fields.username !== undefined ? { username: String(usernameSchema.parse(String(fields.username))) } : {}),
    })
    this.s.audit.record({ userId, name: 'profile_updated' })
    return this.requireUser(userId)
  }

  setAvatar(userId: number, dataBase64: string): { contentType: string; size: number } {
    let buf: Buffer
    try {
      buf = Buffer.from(dataBase64, 'base64')
    } catch {
      throw new AppError(400, 'Avatar must be base64-encoded image data')
    }
    if (buf.length === 0 || buf.length > 512 * 1024) {
      throw new AppError(400, 'Avatar must be between 1 byte and 512 KB')
    }
    const contentType = sniffImage(buf)
    if (!contentType) throw new AppError(400, 'Avatar must be a PNG, JPEG or WebP image')
    this.s.users.setAvatar(userId, contentType, buf)
    this.s.audit.record({ userId, name: 'avatar_updated', detail: { content_type: contentType } })
    return { contentType, size: buf.length }
  }

  removeAvatar(userId: number): void {
    this.s.users.setAvatar(userId, null, null)
  }

  private consumeOneTime(
    row: { id: number; user_id: number; expires_at: string; used_at: string | null } | undefined,
    kind: string,
  ): { id: number; user_id: number } {
    if (!row) throw new AppError(400, `Invalid or expired ${kind} link`, 'invalid_token')
    if (row.used_at) throw new AppError(400, `Invalid or expired ${kind} link`, 'invalid_token')
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      throw new AppError(400, `Invalid or expired ${kind} link`, 'invalid_token')
    }
    return row
  }

  requireUser(id: number): UserRow {
    const user = this.s.users.byId(id)
    if (!user) throw new AppError(404, 'User not found')
    return user
  }

  private get db() {
    return this.s.db
  }
}

function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}
