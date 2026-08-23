/** Simple in-memory sliding-window rate limiter (per-IP buckets for auth endpoints). */

interface Bucket {
  count: number
  resetAt: number
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>()

  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  hit(key: string): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const t = this.now()
    this.gc(t)
    const bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= t) {
      this.buckets.set(key, { count: 1, resetAt: t + this.windowMs })
      return { allowed: true, remaining: this.max - 1, retryAfterSeconds: 0 }
    }
    if (bucket.count >= this.max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - t) / 1000)),
      }
    }
    bucket.count += 1
    return { allowed: true, remaining: this.max - bucket.count, retryAfterSeconds: 0 }
  }

  reset(): void {
    this.buckets.clear()
  }

  private gc(t: number): void {
    if (this.buckets.size < 10_000) return
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= t) this.buckets.delete(k)
    }
  }
}
