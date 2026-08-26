import { timingSafeEqual, createHmac } from 'node:crypto'

/**
 * Receiver-side signature verification — exactly what a webhook consumer
 * implements: recompute HMAC-SHA256 over the raw body under the shared
 * secret and compare in constant time against `sha256=<hex>`.
 */
export function verifySignature(header: string, body: string, secret: string): boolean {
  const PREFIX = 'sha256='
  if (!header.startsWith(PREFIX)) return false
  const presented = Buffer.from(header.slice(PREFIX.length), 'hex')
  if (presented.length !== 32) return false
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest()
  return timingSafeEqual(presented, expected)
}
