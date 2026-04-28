// ─── Mission supervisor: guardedEvaluate composer ───
//
// The ONLY call path the supervisor uses to issue an LLM/decision step
// (parent slice.md §01 + §02 invariant). Sequences the safety net:
//
//   1. BudgetEnforcer.check(missionId)                     ← kill switch
//   2. MaxDepthGuard.check(trigger)                        ← recursion gate
//   3. await evaluator(ctx)                                ← LLM / planner
//   4. BudgetEnforcer.increment(missionId, cost)           ← post-call spend
//   5. INSERT mission_events row for the decision          ← timeline write
//
// The evaluator is a pure function in the supervisor's domain ("given the
// trigger and the remaining budget, propose the next move"). The composer
// owns *all* the mutation: it never lets the evaluator touch the DB.
//
// Design rule (parent slice.md §01 threat_surface):
//   "anyone calling the supervisor must go through these guards. Enforce
//    via a single function signature: guardedEvaluate(missionId, event)
//    — direct LLM calls are disallowed by code review and by a lint rule."
//
// Concretely: a static grep of `supervisor.ts` for `BudgetEnforcer.check`
// or `MaxDepthGuard.check` is a code-review red flag — every supervisor
// step must funnel through this file.
//
// Failure-mode contract (corner cases delivered, mirrored in slice 03 tests):
//   - paused kill-switch denies (mission.status='paused' → reason='paused')
//   - budget-exhausted denies (spent ≥ budget at check time)
//   - depth denies (trigger.depth > MAX_ALLOWED_DEPTH)
//   - happy path increments spend AND writes a decision event
//
// Why we DO NOT increment when the evaluator throws: cost is reported by
// the evaluator post-call, after the provider's usage row is in hand. A
// throw means we never observed a usage row → no spend to record. The
// throw propagates and the timeline gets no decision event for that
// attempt (the caller is expected to retry or surface the failure).

import { randomUUID } from "node:crypto";
import { getRawDb } from "../../db/index.js";
import {
  BudgetEnforcer,
  type BudgetDelta,
  type BudgetEnforcerResult,
} from "./budget-enforcer.js";
import {
  MaxDepthGuard,
  type MissionEvent,
  type MissionTrigger,
} from "./max-depth-guard.js";

// ─── Public types ───

/**
 * Closed set of `mission_events.kind` values — mirrors the CHECK constraint
 * in `src/db/schema.ts` (`mission_events_kind_check`). Kept in sync by hand:
 * the constraint and this union must move together or inserts will fail at
 * the DB layer with no useful TS feedback.
 */
export type MissionEventKind =
  | "plan_proposed"
  | "task_observed"
  | "remediation_proposed"
  | "remediation_approved"
  | "remediation_dismissed"
  | "budget_warning"
  | "budget_exceeded"
  | "depth_exceeded"
  | "no_action"
  | "objective_met"
  | "stalled"
  | "heartbeat"
  | "paused";

/**
 * Snapshot the composer hands to the evaluator. Everything an LLM step
 * needs to plan its next move without re-querying the guards itself.
 *
 *   - `missionId`, `trigger`           — what was requested
 *   - `depth`                          — coerced (safe) recursion depth
 *   - `budget`                         — pre-call view from BudgetEnforcer
 *                                        (so the evaluator can self-throttle
 *                                         when `budget.warn` is set)
 */
export interface GuardedEvaluatorContext {
  missionId: string;
  trigger: MissionTrigger;
  depth: number;
  budget: BudgetEnforcerResult;
}

/**
 * What the evaluator returns. `cost` is mandatory — every evaluator must
 * declare its spend so BudgetEnforcer.increment can run; a `0/0` delta is
 * legitimate for evaluators that observed cached / no-op outcomes.
 *
 * `eventKind` and `eventPayload` let the supervisor tag the timeline entry.
 * Defaults (when omitted): `remediation_proposed` if `proposal !== undefined`,
 * otherwise `no_action` — both are valid kinds per the DB CHECK.
 */
export interface EvaluatorResult {
  proposal?: unknown;
  cost: BudgetDelta;
  eventKind?: MissionEventKind;
  eventPayload?: Record<string, unknown>;
}

/** The evaluator function the composer wraps. */
export type Evaluator = (
  ctx: GuardedEvaluatorContext,
) => Promise<EvaluatorResult>;

/** Why a guarded evaluation was denied before the evaluator ran. */
export type GuardDenyReason = "paused" | "budget_exhausted" | "depth_exceeded";

/**
 * Discriminated result. On `allowed: false`, the evaluator was NEVER called
 * and `budget` is the pre-check snapshot. On `allowed: true`, the evaluator
 * ran, spend was incremented (so `budget` is the POST-increment view), and
 * `eventId` references the row written to `mission_events`.
 */
export type GuardedEvaluateResult =
  | {
      allowed: false;
      reason: GuardDenyReason;
      depth: number;
      budget: BudgetEnforcerResult;
    }
  | {
      allowed: true;
      depth: number;
      proposal: unknown;
      cost: BudgetDelta;
      budget: BudgetEnforcerResult;
      eventKind: MissionEventKind;
      eventId: string;
    };

// ─── Composer ───

/**
 * Run a single guarded supervisor step. See file header for the full
 * sequencing contract.
 *
 * Throws only if (a) the evaluator throws (propagated; no spend recorded),
 * or (b) the underlying guards throw (e.g. mission_id doesn't exist —
 * BudgetEnforcer.check is the source of truth on that and rejects unknown
 * missions rather than silently allowing them).
 */
export async function guardedEvaluate(
  missionId: string,
  trigger: MissionTrigger,
  evaluator: Evaluator,
): Promise<GuardedEvaluateResult> {
  // (1) Budget / kill-switch gate. BudgetEnforcer.check is atomic
  //     (BEGIN IMMEDIATE) so a concurrent increment can't tear the snapshot.
  const preBudget = BudgetEnforcer.check(missionId);
  if (!preBudget.allowed) {
    const reason = classifyBudgetDenial(missionId);
    return {
      allowed: false,
      reason,
      depth: 0,
      budget: preBudget,
    };
  }

  // (2) Depth guard. We capture the guard's emitted event into a local
  //     so we can persist it to mission_events on denial — the guard
  //     itself is DB-agnostic by design (constructor takes an EventSink).
  let pendingDepthEvent: MissionEvent | null = null;
  const guard = new MaxDepthGuard((evt) => {
    pendingDepthEvent = evt;
  });
  const depthResult = guard.check(trigger);
  if (!depthResult.allowed) {
    if (pendingDepthEvent) {
      // Persist the depth_exceeded event the guard already shaped for us.
      writeMissionEvent(
        missionId,
        (pendingDepthEvent as MissionEvent).kind as MissionEventKind,
        (pendingDepthEvent as MissionEvent).payload,
        { tokens: 0, cents: 0 },
        depthResult.depth,
      );
    }
    return {
      allowed: false,
      reason: "depth_exceeded",
      depth: depthResult.depth,
      budget: preBudget,
    };
  }

  // (3) Evaluator runs INSIDE the gate, OUTSIDE any DB transaction. A throw
  //     here propagates without writing an event or incrementing spend —
  //     no usage row was observed, so there is nothing to charge.
  const evalResult = await evaluator({
    missionId,
    trigger,
    depth: depthResult.depth,
    budget: preBudget,
  });

  // (4) Spend increment. Atomic; may transition the mission to 'paused' and
  //     emit its own `budget_exceeded` event in the same transaction (see
  //     BudgetEnforcer.increment). The next call will then deny at step (1).
  const postBudget = BudgetEnforcer.increment(missionId, evalResult.cost);

  // (5) Decision event. Default kind picks `remediation_proposed` when the
  //     evaluator emitted a proposal, `no_action` otherwise — the supervisor
  //     can override either with `evalResult.eventKind`.
  const eventKind: MissionEventKind =
    evalResult.eventKind ??
    (evalResult.proposal !== undefined ? "remediation_proposed" : "no_action");
  const eventPayload: Record<string, unknown> = {
    ...(evalResult.eventPayload ?? {}),
    trigger_kind: trigger.kind,
    ...(evalResult.proposal !== undefined ? { proposal: evalResult.proposal } : {}),
  };
  const eventId = writeMissionEvent(
    missionId,
    eventKind,
    eventPayload,
    evalResult.cost,
    depthResult.depth,
  );

  return {
    allowed: true,
    depth: depthResult.depth,
    proposal: evalResult.proposal,
    cost: evalResult.cost,
    budget: postBudget,
    eventKind,
    eventId,
  };
}

// ─── Internals ───

/**
 * Disambiguate the two BudgetEnforcer denial paths so the caller can tell
 * "operator hit pause" apart from "budget exhausted on its own". One small
 * extra read; only happens on the (rare) denial branch.
 */
function classifyBudgetDenial(missionId: string): "paused" | "budget_exhausted" {
  const sqlite = getRawDb();
  const row = sqlite
    .prepare("SELECT status FROM missions WHERE id = ?")
    .get(missionId) as { status?: string } | undefined;
  return row?.status === "paused" ? "paused" : "budget_exhausted";
}

/**
 * Single insert helper for `mission_events`. Centralized so the composer
 * has exactly one place that touches the timeline table — keeps the column
 * list and the `cost_*` semantics (delta, not running total) in lockstep
 * with `BudgetEnforcer.increment`.
 */
function writeMissionEvent(
  missionId: string,
  kind: MissionEventKind,
  payload: Record<string, unknown>,
  cost: BudgetDelta,
  depth: number,
): string {
  const sqlite = getRawDb();
  const id = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO mission_events
         (id, mission_id, kind, payload, cost_tokens, cost_usd_cents, depth)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, missionId, kind, JSON.stringify(payload), cost.tokens, cost.cents, depth);
  return id;
}
