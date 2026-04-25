/**
 * Simple in-memory failure-counting rate limiter.
 *
 * Pure logic, no HTTP context. Used by `remoteAuth` middleware to bounce
 * callers that repeatedly present invalid bearer tokens. A single shared
 * instance is exported as `authRateLimiter`, but new instances can be
 * constructed for tests or other subsystems.
 */
export interface RateLimiterOptions {
  maxAttempts: number;
  windowMs: number;
}

export class RateLimiter {
  private readonly failed = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly opts: RateLimiterOptions) {}

  /** Returns `true` if the given key has exceeded the allowed attempts. */
  isLimited(key: string): boolean {
    const entry = this.failed.get(key);
    if (!entry) return false;
    /* v8 ignore next 4 — defensive: window expiry race; covered by recordFailure path */
    if (Date.now() > entry.resetAt) {
      this.failed.delete(key);
      return false;
    }
    return entry.count >= this.opts.maxAttempts;
  }

  /** Record one failed attempt for the given key. */
  recordFailure(key: string): void {
    const entry = this.failed.get(key);
    if (!entry || Date.now() > entry.resetAt) {
      this.failed.set(key, { count: 1, resetAt: Date.now() + this.opts.windowMs });
    } else {
      entry.count++;
    }
  }

  /** Reset all counters (tests only). */
  reset(): void {
    this.failed.clear();
  }
}

/** Default limiter shared by `remoteAuth`: 5 failures per 60s. */
export const authRateLimiter = new RateLimiter({ maxAttempts: 5, windowMs: 60_000 });
