import { formatPersonalAccessToken, generateToken, tokenDigest } from '../lib/crypto.js'
import { parseSshPublicKey } from '../lib/ssh.js'
import { AppError } from './identity.js'
import type { IdentityServices } from './identity.js'
import { isoPlus, nowIso } from '../db/database.js'
import type { SshKeyRow, AccessTokenRow } from '../db/store.js'

/** Scopes mirror GitLab personal access tokens (registry scopes come with the registry phase). */
export const ALLOWED_PAT_SCOPES = ['api', 'read_api', 'read_user', 'read_repository', 'write_repository'] as const

const DAY = 24 * 60 * 60_000

export class CredentialsService {
  constructor(private s: IdentityServices, private patMaxTtlDays: number, private patDefaultTtlDays: number) {}

  // -- SSH keys -------------------------------------------------------------

  addSshKey(
    userId: number,
    input: { title?: unknown; key?: unknown; usage_mode?: unknown; expires_at?: unknown },
  ): SshKeyRow {
    const title = String(input.title ?? '').trim()
    if (title.length < 1 || title.length > 255) {
      throw new AppError(400, 'Key title is required (1–255 characters)', 'validation_failed')
    }
    const line = String(input.key ?? '')
    let parsed
    try {
      parsed = parseSshPublicKey(line)
    } catch (err) {
      throw new AppError(400, `Invalid public key: ${(err as Error).message}`, 'validation_failed')
    }
    if (this.s.sshKeys.byFingerprint(parsed.fingerprintSha256)) {
      throw new AppError(409, 'Fingerprint has already been taken', 'fingerprint_taken')
    }

    const usage =
      input.usage_mode === 'auth' || input.usage_mode === 'signing' ? input.usage_mode : 'auth_and_signing'

    let expiresAt: string | null = null
    if (input.expires_at !== undefined && input.expires_at !== null && input.expires_at !== '') {
      const d = new Date(String(input.expires_at))
      if (Number.isNaN(d.getTime()) || d.getTime() < Date.now()) {
        throw new AppError(400, 'Expiry must be a future date', 'validation_failed')
      }
      expiresAt = d.toISOString()
    }

    const row = this.s.sshKeys.create({
      user_id: userId,
      title,
      key_type: parsed.type,
      bits: parsed.bits,
      fingerprint: parsed.fingerprintSha256,
      public_key: parsed.normalizedKey,
      comment: parsed.comment,
      usage_mode: usage,
      expires_at: expiresAt,
    })
    this.s.audit.record({
      userId,
      name: 'ssh_key_added',
      detail: { key_id: row.id, fingerprint: row.fingerprint, type: row.key_type },
    })
    return row
  }

  listSshKeys(userId: number): Array<SshKeyRow> {
    return this.s.sshKeys.listForUser(userId)
  }

  deleteSshKey(userId: number, keyId: number): void {
    const key = this.s.sshKeys.byId(keyId)
    if (!key || key.user_id !== userId) throw new AppError(404, 'Key not found')
    this.s.sshKeys.delete(keyId)
    this.s.audit.record({
      userId,
      name: 'ssh_key_removed',
      detail: { key_id: keyId, fingerprint: key.fingerprint },
    })
  }

  // -- Personal access tokens -------------------------------------------------

  createPat(
    userId: number,
    input: { name?: unknown; description?: unknown; scopes?: unknown; expires_in_days?: unknown },
  ): { record: AccessTokenRow; plaintext: string } {
    const name = String(input.name ?? '').trim()
    if (name.length < 1 || name.length > 255) {
      throw new AppError(400, 'Token name is required (1–255 characters)', 'validation_failed')
    }
    const description =
      input.description !== undefined ? String(input.description).slice(0, 255) : undefined

    const scopes = Array.isArray(input.scopes) ? input.scopes.map(String) : []
    if (scopes.length === 0) {
      throw new AppError(400, 'Select at least one scope', 'validation_failed')
    }
    for (const sc of scopes) {
      if (!(ALLOWED_PAT_SCOPES as readonly string[]).includes(sc)) {
        throw new AppError(400, `Invalid scope: ${sc}`, 'validation_failed')
      }
    }
    // api implies everything read_* / repository scopes provide.
    const effectiveScopes = scopes.includes('api') ? ['api'] : [...new Set(scopes)]

    let days = this.patDefaultTtlDays
    if (input.expires_in_days !== undefined && input.expires_in_days !== null) {
      days = Number(input.expires_in_days)
    }
    if (!Number.isInteger(days) || days < 1 || days > this.patMaxTtlDays) {
      throw new AppError(400, `Expiration must be between 1 and ${this.patMaxTtlDays} days`, 'validation_failed')
    }

    const raw = generateToken()
    const record = this.s.tokens.create({
      userId,
      name,
      description,
      scopes: effectiveScopes,
      tokenDigest: tokenDigest(raw),
      expiresAt: isoPlus(days * DAY),
    })
    this.s.audit.record({
      userId,
      name: 'pat_created',
      detail: { token_id: record.id, scopes: effectiveScopes },
    })

    // Plaintext is returned exactly once, at creation. Only the SHA-256 digest persists.
    return { record, plaintext: formatPersonalAccessToken(raw) }
  }

  listPats(userId: number): Array<AccessTokenRow> {
    return this.s.tokens.listForUser(userId)
  }

  revokePat(userId: number, tokenId: number): void {
    const token = this.s.tokens.byId(tokenId)
    if (!token || token.user_id !== userId) throw new AppError(404, 'Token not found')
    if (!this.s.tokens.revoke(tokenId)) {
      throw new AppError(400, 'Token is already revoked')
    }
    this.s.audit.record({ userId, name: 'pat_revoked', detail: { token_id: tokenId } })
  }

  /** Used by the auth plugin to resolve a presented PAT. Updates last_used_at (throttled). */
  resolvePat(rawWithoutPrefix: string):
    | { userId: number; scopes: string[]; tokenId: number }
    | null {
    const row = this.s.tokens.byDigest(tokenDigest(rawWithoutPrefix))
    if (!row) return null
    if (row.revoked_at) return null
    if (new Date(row.expires_at).getTime() <= Date.now()) return null
    const last = row.last_used_at ? new Date(row.last_used_at).getTime() : 0
    if (Date.now() - last > 60_000) {
      this.db.run('UPDATE access_tokens SET last_used_at = ? WHERE id = ?', nowIso(), row.id)
    }
    return { userId: row.user_id, scopes: JSON.parse(row.scopes) as string[], tokenId: row.id }
  }

  private get db() {
    return this.s.db
  }
}
