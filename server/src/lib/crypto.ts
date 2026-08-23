import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'

/**
 * Password hashing with Node's built-in scrypt (memory-hard KDF, OWASP-approved).
 * Stored format is versioned for future migration:
 *   scrypt$N$r$p$<salt b64>$<hash b64>
 * GitLab uses bcrypt via Devise; the KDF is an implementation detail — the
 * behavioral contract (salted, slow, constant-time compare) is preserved.
 */

/**
 * Cost parameters. Defaults are production-grade (16 MiB memory factor);
 * tests override via LSGIT_SCRYPT_* env vars to keep suites fast.
 * Stored hashes embed their own parameters, so changing costs never breaks
 * verification of existing passwords.
 */
function scryptParams() {
  return {
    N: Number(process.env.LSGIT_SCRYPT_N ?? 16384),
    R: Number(process.env.LSGIT_SCRYPT_R ?? 8),
    P: Number(process.env.LSGIT_SCRYPT_P ?? 1),
  }
}

export function hashPassword(password: string): string {
  const { N, R, P } = scryptParams()
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, nStr, rStr, pStr, saltB64, hashB64] = stored.split('$')
    if (scheme !== 'scrypt') return false
    const N2 = Number(nStr)
    const r2 = Number(rStr)
    const p2 = Number(pStr)
    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(hashB64, 'base64')
    const actual = scryptSync(password, salt, expected.length, { N: N2, r: r2, p: p2 })
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** Opaque high-entropy token (session ids, PATs, reset/verification tokens). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** Tokens are stored only as SHA-256 digests; lookup happens by digest. */
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Human-checkable prefix for personal access tokens (GitLab uses glpat-). */
export function formatPersonalAccessToken(rawToken: string): string {
  return `lspat_${rawToken}`
}

export function parsePersonalAccessToken(value: string): string | null {
  if (!value.startsWith('lspat_')) return null
  const raw = value.slice('lspat_'.length)
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(raw)) return null
  return raw
}
