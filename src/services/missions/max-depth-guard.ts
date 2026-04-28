// ─── Mission supervisor: max-depth guard ───
// Enforces the nested-remediation depth ceiling so a misbehaving supervisor
// loop cannot recurse forever (remediation -> task -> failure -> remediation
// -> …). Depths 0, 1, 2 are allowed; anything at depth 3 or beyond is
// rejected and emitted as a `depth_exceeded` event so the caller persists a
// stop reason on the mission timeline (see `mission_events.kind` in
// `src/db/schema.ts`).
//
// Security contract (parent slice.md §01,
// "max_depth_guard_cannot_be_bypassed_by_passing_negative_depth"):
//   - Caller-supplied `payload.depth` is untrusted.
//   - Negative numbers, NaN, Infinity, non-numeric values, and missing
//     fields are all coerced to 0 BEFORE the comparison. We never let a
//     caller smuggle past the gate by sending `depth: -1` (which would
//     otherwise compare-less-than 3 and pass).
//   - Non-remediation triggers don't carry a depth — they're treated as
//     depth 0 (top-level entry into the supervisor).

/** Maximum allowed nested remediation depth. Depths [0..MAX_ALLOWED_DEPTH]
 *  are admitted; (MAX_ALLOWED_DEPTH, ∞) is rejected. */
export const MAX_ALLOWED_DEPTH = 2;

export interface MissionTrigger {
  /** Trigger kind. Only `remediation` carries a depth; everything else is
   *  treated as depth 0. The string is intentionally open (not a closed
   *  union) so the supervisor can add new trigger kinds without churning
   *  this guard. */
  kind: string;
  payload?: {
    depth?: unknown;
    [key: string]: unknown;
  };
}

export type MissionEvent =
  | { kind: "depth_exceeded"; payload: Record<string, unknown> }
  | { kind: string; payload: Record<string, unknown> };

export type EventSink = (event: MissionEvent) => void;

export interface DepthCheckResult {
  allowed: boolean;
  /** The post-coercion depth that was compared against the ceiling. Useful
   *  for callers that want to log "we treated input X as depth Y". */
  depth: number;
}

/**
 * Coerce an untrusted depth value to a non-negative integer. Anything that
 * isn't a finite number ≥ 0 collapses to 0 — that's the bypass-protection
 * promise from the security contract.
 */
function coerceDepth(raw: unknown): number {
  if (typeof raw !== "number") return 0;
  if (!Number.isFinite(raw)) return 0;
  if (raw < 0) return 0;
  // Fractional depths are floored — depth is conceptually an integer.
  return Math.floor(raw);
}

export class MaxDepthGuard {
  private readonly maxAllowedDepth: number;
  private readonly eventSink: EventSink;

  constructor(eventSink: EventSink, maxAllowedDepth: number = MAX_ALLOWED_DEPTH) {
    this.eventSink = eventSink;
    this.maxAllowedDepth = maxAllowedDepth;
  }

  /**
   * Inspect a trigger and decide whether the supervisor may proceed.
   *
   *   - Non-remediation triggers always run at depth 0.
   *   - Remediation triggers read `payload.depth`, coerced to a safe
   *     non-negative integer.
   *   - If the (coerced) depth exceeds the ceiling, emits a
   *     `depth_exceeded` event carrying the original trigger payload plus
   *     the rejected/limit metadata, and returns `{ allowed: false }`.
   */
  check(trigger: MissionTrigger): DepthCheckResult {
    const rawDepth =
      trigger.kind === "remediation" ? trigger.payload?.depth : 0;
    const depth = coerceDepth(rawDepth);

    if (depth > this.maxAllowedDepth) {
      const payload: Record<string, unknown> = {
        ...(trigger.payload ?? {}),
        depth,
        max_allowed_depth: this.maxAllowedDepth,
        trigger_kind: trigger.kind,
      };
      this.eventSink({ kind: "depth_exceeded", payload });
      return { allowed: false, depth };
    }

    return { allowed: true, depth };
  }
}
