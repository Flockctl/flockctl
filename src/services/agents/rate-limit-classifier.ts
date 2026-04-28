/**
 * Rate-limit / usage-limit error classifier.
 *
 * The AI clients (`@anthropic-ai/claude-agent-sdk`, the Copilot SDK, the
 * Anthropic SDK proper) raise different error shapes for what is fundamentally
 * the same situation — "the provider declined this request because the caller
 * has used too much, try again later." The task executor and chat executor
 * both need to recognise this case so they can park the row in
 * `status='rate_limited'` and let the scheduler resume it instead of failing
 * the user out.
 *
 * Rather than scatter `err.status === 429 || err.message.includes('usage')`
 * checks across both executors, we centralise the heuristic here. The output
 * shape (`RateLimitInfo`) tells callers two things:
 *   1. Whether this error IS a rate-limit at all (`null` if not — the executor
 *      should fall back to its existing FAILED / TIMED_OUT / CANCELLED path).
 *   2. When to come back (`resumeAtMs`, absolute unix-epoch ms).
 *
 * The `resumeAtMs` is always populated; the difference between a precise
 * Anthropic 429 (we know the exact reset from `retry-after-ms`) and a CLI
 * weekly-limit text error (we have to guess) is captured by `confidence`.
 *
 * Polling lattice for `confidence: 'estimated'`: the scheduler escalates
 * 15min → 30min → 60min, then holds at 60min indefinitely. The classifier
 * itself does NOT track attempt count — that's the scheduler's job (it owns
 * the per-task / per-chat retry counter). The classifier returns a *minimum*
 * delay; the scheduler may push it further out based on history.
 *
 * Per CLAUDE.md rule: max polling interval is one hour. Don't change
 * MAX_ESTIMATED_DELAY_MS without re-reading that decision.
 */

const MIN_ESTIMATED_DELAY_MS = 15 * 60 * 1000;        // 15 min — first guess
const MAX_ESTIMATED_DELAY_MS = 60 * 60 * 1000;        // 60 min — hard cap
const DEFAULT_RATE_LIMIT_FALLBACK_MS = 60 * 1000;     // 1 min — when 429 has no headers (defensive)

/** Possible kinds of "you've hit a limit" the classifier can recognise. */
export type RateLimitKind =
  | "rate_limit"     // short-window, structured (e.g. tokens/min, RPM)
  | "usage_limit"    // long-window, often unstructured (Pro/Max weekly cap)
  | "quota";         // Copilot premium-request quota; coarse-grained

/** Where the error came from — kept in the result for telemetry / logs. */
export type RateLimitProvider = "anthropic" | "copilot" | "openai" | "unknown";

export interface RateLimitInfo {
  kind: RateLimitKind;
  provider: RateLimitProvider;
  /**
   * Absolute unix-epoch milliseconds at which the limit is expected to clear.
   * For `confidence: 'exact'` this is derived from a provider-supplied header
   * (Anthropic 429 `retry-after` / `retry-after-ms`). For `'estimated'` it is
   * a forward projection from a hardcoded heuristic; the scheduler may push
   * it further out via its escalation lattice.
   */
  resumeAtMs: number;
  confidence: "exact" | "estimated";
  /**
   * The original error message, preserved verbatim so executors can persist it
   * to `tasks.errorMessage` / surface it in the UI without re-deriving.
   */
  rawMessage: string;
}

// ─── Heuristic regex bank ──────────────────────────────────────────────────
//
// Patterns observed across the SDKs we use. Stable enough to drive routing,
// but NOT stable enough to drive timing — that's what the headers are for
// (when present). All patterns are anchored on the message text only; we
// never inspect the message for "wait N minutes" tokens because the user-
// facing wording drifts more often than the structured headers.

const ANTHROPIC_USAGE_LIMIT_PATTERNS: RegExp[] = [
  /\busage limit\b/i,
  /\bweekly limit\b/i,
  /claude ai usage limit reached/i,
  /\bbilling[_-]?error\b/i,
  /\bquota\s+exceeded\b/i,
];

const ANTHROPIC_RATE_LIMIT_MESSAGE_PATTERNS: RegExp[] = [
  /\brate[_-]?limit/i,
  /\b429\b/,
  /requests per minute/i,
  /tokens per minute/i,
];

const COPILOT_LIMIT_PATTERNS: RegExp[] = [
  /\bpremium request/i,
  /\bquota\b/i,
  /\brate[_-]?limit/i,
  /usage limit/i,
];

// ─── Header parsing ────────────────────────────────────────────────────────

/**
 * Read `retry-after-ms` (preferred — Anthropic-specific) then `retry-after`
 * (RFC 7231 — seconds OR HTTP-date) from a Headers-shaped object. Returns
 * milliseconds-from-now or null if neither header is set.
 *
 * The function is tolerant of:
 *   - Native `Headers` (has `.get()`)
 *   - Plain objects (`{ "retry-after": "30" }`)
 *   - `Map`-like objects (has `.get()` but no `.has()`)
 * because different SDK versions hand us different shapes.
 */
function readRetryAfterMs(headers: unknown, nowMs: number): number | null {
  if (!headers || typeof headers !== "object") return null;

  const get = (name: string): string | null => {
    const h = headers as { get?: (k: string) => string | null | undefined } & Record<string, unknown>;
    if (typeof h.get === "function") {
      const v = h.get(name) ?? h.get(name.toLowerCase()) ?? h.get(name.toUpperCase());
      return v == null ? null : String(v);
    }
    // Plain-object shape — try a few case variants.
    for (const k of [name, name.toLowerCase(), name.toUpperCase()]) {
      if (k in h) {
        const v = (h as Record<string, unknown>)[k];
        if (v == null) continue;
        return String(v);
      }
    }
    return null;
  };

  const raMs = get("retry-after-ms");
  if (raMs) {
    const n = Number(raMs);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const ra = get("retry-after");
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
    // HTTP-date form (RFC 7231): "Wed, 21 Oct 2026 07:28:00 GMT"
    const t = Date.parse(ra);
    if (Number.isFinite(t)) {
      const delta = t - nowMs;
      return delta > 0 ? delta : 0;
    }
  }
  return null;
}

// ─── Main classifier ───────────────────────────────────────────────────────

interface ClassifyOptions {
  /** Override `Date.now()` — only used by the unit tests. */
  now?: () => number;
}

/**
 * Inspect an arbitrary thrown value and return a `RateLimitInfo` if and only
 * if it looks like a provider-side limit response. Returns `null` for every
 * other error class (network, validation, code bug, abort, …) — those should
 * follow the executor's existing FAILED / TIMED_OUT / CANCELLED path.
 */
export function classifyLimit(err: unknown, opts: ClassifyOptions = {}): RateLimitInfo | null {
  const now = opts.now ? opts.now() : Date.now();
  const obj = err && typeof err === "object" ? (err as Record<string, unknown>) : null;
  const message = extractMessage(err);

  // 1. Anthropic / OpenAI structured 429. These SDKs throw `RateLimitError`
  //    (or a generic `APIError` with `status === 429`); both expose
  //    `.headers` carrying the retry hints. Treat as `confidence: 'exact'`
  //    when we can read the header, `'estimated'` otherwise.
  if (obj && (obj.status === 429 || obj.statusCode === 429)) {
    const provider = guessProviderFromError(obj, message);
    const headerMs = readRetryAfterMs(obj.headers, now);
    if (headerMs !== null) {
      return {
        kind: "rate_limit",
        provider,
        resumeAtMs: now + headerMs,
        confidence: "exact",
        rawMessage: message,
      };
    }
    // 429 without retry-after — uncommon but possible. Fall back to a small
    // delay so we don't hammer the provider.
    return {
      kind: "rate_limit",
      provider,
      resumeAtMs: now + DEFAULT_RATE_LIMIT_FALLBACK_MS,
      confidence: "estimated",
      rawMessage: message,
    };
  }

  // 2. Anthropic billing / usage_limit error. Comes through as either
  //    `error.type === 'billing_error'` (structured) or as a CLI/SDK error
  //    string with one of the patterns below. The CLI path is the only place
  //    we ever see a Pro/Max weekly cap, and the resumeAt has to be guessed.
  const errorType = obj?.type ?? (obj?.error as Record<string, unknown> | undefined)?.type;
  if (errorType === "billing_error" || ANTHROPIC_USAGE_LIMIT_PATTERNS.some((re) => re.test(message))) {
    return {
      kind: "usage_limit",
      provider: "anthropic",
      resumeAtMs: now + MIN_ESTIMATED_DELAY_MS,
      confidence: "estimated",
      rawMessage: message,
    };
  }

  // 3. Anthropic-shaped rate-limit *without* a 429 status (e.g. CLI bubbled
  //    the message text up but we lost the structured envelope along the
  //    way). Fall back to message-pattern matching.
  if (ANTHROPIC_RATE_LIMIT_MESSAGE_PATTERNS.some((re) => re.test(message))) {
    return {
      kind: "rate_limit",
      provider: "anthropic",
      resumeAtMs: now + MIN_ESTIMATED_DELAY_MS,
      confidence: "estimated",
      rawMessage: message,
    };
  }

  // 4. Copilot. The Copilot SDK doesn't expose structured error metadata —
  //    everything reaches us as `Error.message` (see provider.ts:88-93).
  //    Anchor on the substring "Copilot SDK error" the provider prefixes
  //    PLUS a limit-shaped pattern, so we don't false-positive on every
  //    Copilot failure.
  if (/Copilot SDK error/i.test(message) && COPILOT_LIMIT_PATTERNS.some((re) => re.test(message))) {
    return {
      kind: "quota",
      provider: "copilot",
      resumeAtMs: now + MIN_ESTIMATED_DELAY_MS,
      confidence: "estimated",
      rawMessage: message,
    };
  }

  return null;
}

/**
 * Compute the next `resumeAt` for a row that has hit the limit again on
 * resume. Implements the 15→30→60→60→…→60 escalation lattice (capped at
 * MAX_ESTIMATED_DELAY_MS = 60 min per CLAUDE.md). `attempt` is the index of
 * the upcoming wake-up (0 for the first hit, 1 for the second, …). For
 * `confidence: 'exact'` results, callers should use `info.resumeAtMs`
 * directly and ignore this helper — exact headers don't need backoff.
 */
export function nextEstimatedDelayMs(attempt: number): number {
  // Lattice: 0 → 15min, 1 → 30min, 2+ → 60min.
  if (attempt <= 0) return MIN_ESTIMATED_DELAY_MS;
  if (attempt === 1) return 30 * 60 * 1000;
  return MAX_ESTIMATED_DELAY_MS;
}

// Exposed for the unit tests; not part of the public surface.
export const _internals = {
  MIN_ESTIMATED_DELAY_MS,
  MAX_ESTIMATED_DELAY_MS,
  DEFAULT_RATE_LIMIT_FALLBACK_MS,
  readRetryAfterMs,
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    return typeof m === "string" ? m : String(m);
  }
  return String(err);
}

function guessProviderFromError(obj: Record<string, unknown>, message: string): RateLimitProvider {
  if (typeof obj.provider === "string") {
    const p = obj.provider.toLowerCase();
    if (p.includes("anthropic") || p.includes("claude")) return "anthropic";
    if (p.includes("openai")) return "openai";
    if (p.includes("copilot")) return "copilot";
  }
  if (/anthropic|claude/i.test(message)) return "anthropic";
  if (/openai|gpt/i.test(message)) return "openai";
  if (/copilot/i.test(message)) return "copilot";
  return "unknown";
}
