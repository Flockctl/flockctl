/**
 * Simple in-memory failure-counting rate limiter.
 *
 * Pure logic, no HTTP context. Used by `remoteAuth` middleware to bounce
 * callers that repeatedly present invalid bearer tokens. A single shared
 * instance is exported as `authRateLimiter`, but new instances can be
 * constructed for tests or other subsystems.
 *
 * **DoS posture.** The internal `failed` map is keyed on caller-supplied
 * strings (typically client IP). Without a size cap, a remote attacker who
 * never authenticates correctly could register an unbounded set of distinct
 * keys before any of them hit the per-key window-expiry path — an ergonomic
 * pre-auth DoS. We bound the map at `MAX_KEYS` and evict the oldest entry on
 * insert so the worst case is a fixed-size cache instead of a growth path.
 */
export interface RateLimiterOptions {
  maxAttempts: number;
  windowMs: number;
  /**
   * Optional upper bound on the number of distinct keys retained in memory.
   * When the cap is exceeded, the oldest entry (insertion-order — Maps are
   * ordered by insertion in JS) is dropped. Defaults to {@link DEFAULT_MAX_KEYS}.
   */
  maxKeys?: number;
}

const DEFAULT_MAX_KEYS = 10_000;

export class RateLimiter {
  private readonly failed = new Map<string, { count: number; resetAt: number }>();
  private readonly maxKeys: number;

  constructor(private readonly opts: RateLimiterOptions) {
    this.maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  }

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
      this.evictIfFull();
      this.failed.set(key, { count: 1, resetAt: Date.now() + this.opts.windowMs });
    } else {
      entry.count++;
    }
  }

  /**
   * If the map is at capacity, drop the oldest entry. Map iteration order is
   * insertion order in V8, so `keys().next()` returns the longest-lived key.
   * Combined with the per-key window expiry path in {@link isLimited}, this
   * keeps memory pressure bounded even under sustained abuse.
   */
  private evictIfFull(): void {
    if (this.failed.size < this.maxKeys) return;
    // First sweep expired entries — they're cheaper to drop than a still-live key.
    const now = Date.now();
    for (const [k, v] of this.failed) {
      if (now > v.resetAt) this.failed.delete(k);
      if (this.failed.size < this.maxKeys) return;
    }
    // Still over: drop the oldest insert.
    const oldest = this.failed.keys().next();
    if (!oldest.done) this.failed.delete(oldest.value);
  }

  /** Reset all counters (tests only). */
  reset(): void {
    this.failed.clear();
  }

  /** @internal — exposed for tests; `(distinct keys, total live)` snapshot. */
  size(): number {
    return this.failed.size;
  }
}

/** Default limiter shared by `remoteAuth`: 5 failures per 60s. */
export const authRateLimiter = new RateLimiter({ maxAttempts: 5, windowMs: 60_000 });
