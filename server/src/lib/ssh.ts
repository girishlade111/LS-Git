/**
 * OpenSSH public key parsing (GitLab-parity behavior):
 * - accepted types: ssh-ed25519, ecdsa-sha2-nistp{256,384,521}, ssh-rsa (>=2048 bit)
 * - SHA256 fingerprint, base64 unpadded ("SHA256:..."), matching `ssh-keygen -lf`
 * - one stored key may belong to exactly one user (uniqueness by fingerprint)
 */

export interface ParsedPublicKey {
  type: string
  bits: number | null
  fingerprintSha256: string // "SHA256:..."
  normalizedKey: string // "<type> <base64>"
  comment: string | null
}

const SUPPORTED = new Set([
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
])

class Cursor {
  constructor(private buf: Buffer) {}
  private offset = 0
  readString(): Buffer {
    if (this.offset + 4 > this.buf.length) throw new Error('truncated')
    const len = this.buf.readUInt32BE(this.offset)
    this.offset += 4
    if (this.offset + len > this.buf.length) throw new Error('truncated')
    const out = this.buf.subarray(this.offset, this.offset + len)
    this.offset += len
    return out
  }
}

function mpintBitLength(b: Buffer): number {
  // strip leading zero byte used to signal positive sign
  let start = 0
  while (start < b.length && b[start] === 0) start++
  const first = b[start]
  if (first === undefined) return 0
  let bits = (b.length - start) * 8
  for (let mask = 0x80; mask > 0; mask >>= 1) {
    if (first & mask) break
    bits--
  }
  return bits
}

export function parseSshPublicKey(line: string): ParsedPublicKey {
  const trimmed = line.trim().replace(/\r/g, '')
  if (!trimmed || trimmed.startsWith('#')) throw new Error('not a public key')
  if (/^-----BEGIN/.test(trimmed)) throw new Error('private keys are not allowed')

  const parts = trimmed.split(/\s+/)
  if (parts.length < 2) throw new Error('malformed public key line')
  const [type, b64] = parts as [string, string]
  const comment = parts.length > 2 ? parts.slice(2).join(' ') : null

  if (!SUPPORTED.has(type)) throw new Error(`unsupported key type: ${type}`)
  const blobMatch = /^[A-Za-z0-9+/]+={0,3}$/.test(b64)

  if (!blobMatch) throw new Error('invalid base64 key body')

  const blob = Buffer.from(b64, 'base64')
  const cursor = new Cursor(blob)

  let wireType: string
  try {
    wireType = cursor.readString().toString('utf8')
  } catch {
    throw new Error('malformed key blob')
  }
  if (wireType !== type) throw new Error('key type does not match blob')

  let bits: number | null = null
  switch (type) {
    case 'ssh-ed25519': {
      const pk = cursor.readString()
      if (pk.length !== 32) throw new Error('invalid ed25519 key length')
      bits = 256
      break
    }
    case 'ssh-rsa': {
      const e = cursor.readString()
      const n = cursor.readString()
      if (e.length === 0 || n.length === 0) throw new Error('malformed RSA key')
      bits = mpintBitLength(n)
      if ((bits ?? 0) < 2048) throw new Error('RSA keys must be at least 2048 bits')
      break
    }
    case 'ecdsa-sha2-nistp256':
      bits = 256
      break
    case 'ecdsa-sha2-nistp384':
      bits = 384
      break
    case 'ecdsa-sha2-nistp521':
      bits = 521
      break
  }

  const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  return {
    type,
    bits,
    fingerprintSha256: `SHA256:${digest}`,
    normalizedKey: `${type} ${b64}`,
    comment,
  }
}

// Imported late to keep the top focused; node:crypto hash.
import { createHash } from 'node:crypto'
