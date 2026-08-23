import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword, generateToken, tokenDigest, formatPersonalAccessToken, parsePersonalAccessToken } from '../src/lib/crypto.js'
import { parseSshPublicKey } from '../src/lib/ssh.js'
import { RateLimiter } from '../src/lib/rateLimiter.js'
import { usernameSchema, emailSchema, passwordIssues, validateRegistration, RESERVED_USERNAMES } from '../src/lib/validation.js'
import { can, scopeAllows, type Actor } from '../src/authz.js'

describe('password hashing (scrypt)', () => {
  it('round-trips and uses per-password salt', () => {
    const h1 = hashPassword('hunter2hunter2')
    const h2 = hashPassword('hunter2hunter2')
    expect(h1).not.toBe(h2) // unique salts
    expect(verifyPassword('hunter2hunter2', h1)).toBe(true)
    expect(verifyPassword('wrong', h1)).toBe(false)
  })

  it('rejects malformed stored hashes safely', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(verifyPassword('x', '')).toBe(false)
    expect(hashPassword('x')).toMatch(/^scrypt\$16384\$8\$1\$/)
  })
})

describe('opaque tokens & digests', () => {
  it('generates url-safe high-entropy tokens and stable digests', () => {
    const t = generateToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]{40,64}$/)
    expect(tokenDigest(t)).toBe(tokenDigest(t))
    expect(tokenDigest(t)).not.toBe(t)
  })

  it('formats and parses personal access tokens with the lspat_ prefix', () => {
    const raw = 'A'.repeat(43)
    const formatted = formatPersonalAccessToken(raw)
    expect(formatted.startsWith('lspat_')).toBe(true)
    expect(parsePersonalAccessToken(formatted)).toBe(raw)
    expect(parsePersonalAccessToken(`ghp_${raw}`)).toBeNull()
    expect(parsePersonalAccessToken('lspat_short')).toBeNull()
  })
})

describe('SSH public key parsing', () => {
  function ed25519Line(comment = 'dev@machine'): string {
    // blob: string("ssh-ed25519") + 32 key bytes
    const typeBuf = Buffer.from([0, 0, 0, 11])
    const typeStr = Buffer.from('ssh-ed25519')
    const keyBytes = Buffer.alloc(32, 7)
    const blob = Buffer.concat([typeBuf, typeStr, Buffer.from([0, 0, 0, 32]), keyBytes])
    return `ssh-ed25519 ${blob.toString('base64')} ${comment}`
  }

  function rsaLine(bits: number): string {
    const u32 = (n: number): Buffer => {
      const b = Buffer.alloc(4)
      b.writeUInt32BE(n)
      return b
    }
    const encStr = (s: string) => {
      const b = Buffer.from(s)
      return Buffer.concat([u32(b.length), b])
    }
    const encMpint = (n: number) => {
      const bytes = Math.ceil(n / 8) + 1 // leading zero for positive
      const buf = Buffer.alloc(bytes)
      buf[0] = 0
      buf[1] = 0xf6 // high bits set → full bit count after stripping the sign byte
      return Buffer.concat([u32(bytes), buf])
    }
    const blob = Buffer.concat([
      encStr('ssh-rsa'),
      (() => {
        const e = Buffer.from([1, 0, 1])
        return Buffer.concat([u32(e.length), e])
      })(),
      encMpint(bits),
    ])
    return `ssh-rsa ${blob.toString('base64')} rsa-test`
  }

  it('parses an ed25519 key with SHA256 fingerprint', () => {
    const parsed = parseSshPublicKey(ed25519Line())
    expect(parsed.type).toBe('ssh-ed25519')
    expect(parsed.bits).toBe(256)
    expect(parsed.fingerprintSha256).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(parsed.comment).toBe('dev@machine')
  })

  it('accepts RSA >=2048 bits and rejects smaller keys', () => {
    expect(parseSshPublicKey(rsaLine(2048)).bits).toBe(2048)
    expect(parseSshPublicKey(rsaLine(3072)).bits).toBeGreaterThanOrEqual(2048)
    expect(() => parseSshPublicKey(rsaLine(1024))).toThrow(/at least 2048/)
  })

  it('rejects garbage, private keys, unknown types, and mismatched blobs', () => {
    expect(() => parseSshPublicKey('hello world')).toThrow()
    expect(() => parseSshPublicKey('-----BEGIN OPENSSH PRIVATE KEY-----')).toThrow(/private/i)
    expect(() => parseSshPublicKey(`ssh-dss ${Buffer.alloc(10).toString('base64')}`)).toThrow(/unsupported/)
    expect(() => parseSshPublicKey(`ssh-ed25519 not-base64!!`)).toThrow()
    const rsa = parseSshPublicKey(rsaLine(2048))
    expect(() =>
      parseSshPublicKey(rsa.normalizedKey.replace('ssh-rsa', 'ssh-ed25519')),
    ).toThrow()
  })
})

describe('rate limiter', () => {
  it('allows up to max then blocks until window passes', () => {
    let now = 1_000_000
    const rl = new RateLimiter(3, 60_000, () => now)
    expect(rl.hit('ip').allowed).toBe(true)
    expect(rl.hit('ip').allowed).toBe(true)
    expect(rl.hit('ip').remaining).toBe(0)
    const blocked = rl.hit('ip')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
    now += 60_001
    expect(rl.hit('ip').allowed).toBe(true)
  })

  it('keys buckets independently', () => {
    const rl = new RateLimiter(1, 60_000)
    expect(rl.hit('a').allowed).toBe(true)
    expect(rl.hit('b').allowed).toBe(true)
    expect(rl.hit('a').allowed).toBe(false)
  })
})

describe('validation', () => {
  it('enforces username rules incl. reserved names and lowercasing', () => {
    expect(usernameSchema.parse('Alice_Ok-1')).toBe('alice_ok-1')
    expect(() => usernameSchema.parse('-bad')).toThrow()
    expect(() => usernameSchema.parse('has space')).toThrow()
    expect(() => usernameSchema.parse('.dot')).toThrow()
    expect(() => usernameSchema.parse('root')).toThrow(/reserved/)
    expect(RESERVED_USERNAMES.has('admin')).toBe(true)
  })

  it('normalizes emails', () => {
    expect(emailSchema.parse('  User@Example.COM ')).toBe('user@example.com')
    expect(() => emailSchema.parse('nope')).toThrow()
  })

  it('reports password policy issues', () => {
    expect(passwordIssues('short', 10)).toHaveLength(1)
    expect(passwordIssues('nodigitsonlyletters', 10)).toHaveLength(0)
    expect(passwordIssues('12345678901234', 10)[0]).toMatch(/letter/)
  })

  it('blocks passwords containing username or email', () => {
    const res = validateRegistration(
      { username: 'alice', email: 'alice@example.com', password: 'alicepass1234' },
      10,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/must not contain/)
  })
})

describe('central authorization service', () => {
  const user: Actor = { userId: 1, username: 'alice', admin: false, state: 'active', via: { kind: 'session' } }
  const admin: Actor = { ...user, userId: 2, username: 'root', admin: true }
  const blocked: Actor = { ...user, state: 'blocked' }

  it('denies anonymous actors', () => {
    expect(can(null, 'profile:read_self')).toBe(false)
  })

  it('denies non-active states before any rule evaluation', () => {
    expect(can(blocked, 'profile:read_self')).toBe(false)
  })

  it('scopes *_self permissions to the resource owner; admins bypass', () => {
    expect(can(user, 'account:manage_credentials', { resourceUserId: 1 })).toBe(true)
    expect(can(user, 'account:manage_credentials', { resourceUserId: 99 })).toBe(false)
    expect(can(admin, 'account:manage_credentials', { resourceUserId: 99 })).toBe(true)
  })

  it('gates admin access to admins only', () => {
    expect(can(admin, 'admin:access')).toBe(true)
    expect(can(user, 'admin:access')).toBe(false)
  })

  it('enforces PAT scope requirements (GitLab parity)', () => {
    const readToken: Actor = { ...user, via: { kind: 'personal_access_token', scopes: ['read_api'] } }
    const writeToken: Actor = { ...user, via: { kind: 'personal_access_token', scopes: ['write_repository'] } }
    const apiToken: Actor = { ...user, via: { kind: 'personal_access_token', scopes: ['api'] } }
    expect(scopeAllows(readToken.via, 'read_api')).toBe(true)
    expect(scopeAllows(readToken.via, 'write_api')).toBe(false)
    expect(scopeAllows(writeToken.via, 'write_api')).toBe(false) // repo-only scope ≠ API write
    expect(scopeAllows(apiToken.via, 'write_api')).toBe(true)
    expect(scopeAllows({ kind: 'session' }, 'read_api')).toBe(true)
  })
})
