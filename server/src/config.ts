import { randomBytes } from 'node:crypto'

export interface AppConfig {
  env: 'development' | 'test' | 'production'
  /** HMAC/cookie secret. REQUIRED in production; generated per-process otherwise (with a warning). */
  secret: string
  databaseFile: string // ':memory:' supported
  port: number
  origin: string

  /** Sliding inactivity window for cookie sessions (minutes). GitLab default: 10080 = 7 days. */
  sessionTtlMinutes: number
  cookieName: string
  csrfCookieName: string
  secureCookies: boolean

  /** Failed sign-in lockout (Devise lockable parity: GitLab default is 10 attempts). */
  maxFailedLogins: number
  lockoutMinutes: number
  /** Rate limit buckets for sensitive auth endpoints (requests per window per IP). */
  authRateLimit: { max: number; windowSeconds: number }

  /** Password reset token validity (hours). Devise/GitLab default: 6 hours. */
  resetTokenTtlHours: number
  /** Email verification token validity (days). GitLab confirmation grace analog. */
  verificationTokenTtlDays: number
  passwordMinLength: number

  /** Personal access tokens: mandatory expiry (GitLab 16.0+), default/max lifetime in days. */
  patDefaultTtlDays: number
  patMaxTtlDays: number

  /** Root directory for hashed bare repositories (@hashed/...). */
  repositoriesRoot: string
  /** Max topics per project (GitLab parity). */
  maxTopicsPerProject: number
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = (process.env.NODE_ENV as AppConfig['env']) ?? 'development'
  let secret = overrides.secret ?? process.env.LSGIT_SECRET ?? ''
  if (!secret && env !== 'test') {
    secret = randomBytes(32).toString('base64url')
    if (env === 'development') {
      // Ephemeral dev secret: sessions do not survive restarts. Set LSGIT_SECRET for persistence.
      process.stderr.write('[lsgit] LSGIT_SECRET not set; generated ephemeral secret\n')
    }
  }
  const base: AppConfig = {
    env,
    secret,
    databaseFile: process.env.LSGIT_DB ?? './data/lsgit.db',
    port: Number(process.env.PORT ?? 4000),
    origin: process.env.LSGIT_ORIGIN ?? 'http://localhost:5173',
    sessionTtlMinutes: Number(process.env.LSGIT_SESSION_TTL_MINUTES ?? 60 * 24 * 7), // 7 days (GitLab parity)
    cookieName: 'lsgit_session',
    csrfCookieName: 'lsgit_csrf',
    secureCookies: env === 'production',
    maxFailedLogins: Number(process.env.LSGIT_MAX_FAILED_LOGINS ?? 10),
    lockoutMinutes: Number(process.env.LSGIT_LOCKOUT_MINUTES ?? 60),
    authRateLimit: {
      max: Number(process.env.LSGIT_AUTH_RATE_MAX ?? 20),
      windowSeconds: Number(process.env.LSGIT_AUTH_RATE_WINDOW_S ?? 60),
    },
    resetTokenTtlHours: Number(process.env.LSGIT_RESET_TTL_HOURS ?? 6),
    verificationTokenTtlDays: Number(process.env.LSGIT_VERIFY_TTL_DAYS ?? 3),
    passwordMinLength: Number(process.env.LSGIT_PASSWORD_MIN_LENGTH ?? 10),
    patDefaultTtlDays: 365,
    patMaxTtlDays: 365, // GitLab 16.0+: non-expiring PATs removed; 365-day default & max
    ...overrides,
  }
  return base
}
