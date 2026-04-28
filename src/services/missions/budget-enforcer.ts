// BudgetEnforcer — supervisor-loop safety net for token + USD spend.
//
// Two methods on a static class so callers can `BudgetEnforcer.check(id)` /
// `BudgetEnforcer.increment(id, delta)` without threading an instance through
// the supervisor. Both methods open a SQLite transaction (BEGIN IMMEDIATE) so
// concurrent increments racing on the same mission row cannot double-count
// or miss the halt threshold — the test suite (slice 11/01 task 03) drives a
// 100%-sum race and asserts exactly one caller halts.
//
// Why BEGIN IMMEDIATE specifically: SQLite's default deferred mode upgrades to
// a write lock lazily on the first UPDATE, which under WAL leaves a window for
// two `increment()` callers to both read `spent < budget`, both decide to
// allow, and only then race on the upgrade — one wins, one fails with
// SQLITE_BUSY but the read-side allowed=true result has already escaped to
// the caller. IMMEDIATE grabs the write lock at BEGIN, so the second caller
// blocks until the first commits and then sees the post-commit `spent`.
//
// On halt (post-increment `spent_tokens >= budget_tokens` OR
// `spent_usd_cents >= budget_usd_cents`), `increment` flips
// `missions.status = 'paused'` and writes a `mission_events` row with
// `kind='budget_exceeded'` in the same transaction — atomically, so a
// supervisor restart between the UPDATE and the INSERT cannot leave a paused
// mission without its terminal event in the timeline.
//
// `check()` returns `allowed=false` once `status='paused'` (the kill-switch
// stays armed across restarts) and `warn=true` when either dimension hits
// the 80% threshold. `remaining` is clamped to ≥ 0 so a final post-call
// increment that overshoots the budget still reports a sensible 0 to UI
// callers instead of a negative number.
//
// Delta validation rejects: non-numbers, NaN, Infinity, non-integers,
// negative values, and values > INT32_MAX. The DB columns are SQLite INTEGER
// which fits INT64, but the test contract pins MAX_INT32 as the per-call
// upper bound — defends against malformed `usage` rows from upstream
// providers that occasionally surface absurd token counts.

import { getRawDb } from "../../db/index.js";
import { randomUUID } from "node:crypto";

/**
 * Result returned from `BudgetEnforcer.check()` and `BudgetEnforcer.increment()`.
 *
 * `allowed` is the gate the supervisor consults before issuing the next LLM
 * call. `warn` flips at the 80% threshold so callers can surface a UI banner
 * one call before the halt. `remaining` is informational and clamped to ≥ 0.
 */
export interface BudgetEnforcerResult {
  allowed: boolean;
  warn: boolean;
  remaining: { tokens: number; cents: number };
}

/**
 * Per-call cost delta. Both fields are non-negative integers ≤ INT32_MAX.
 * Tokens are raw token counts; cents are integer USD-cents (the DB column
 * is `budget_usd_cents` for the same reason — float drift on running totals).
 */
export interface BudgetDelta {
  tokens: number;
  cents: number;
}

/** 80% spend ratio flips `warn=true` so the UI can pre-warn one call early. */
const WARN_THRESHOLD = 0.8;

/**
 * Per-call upper bound on a delta value. The slice 11/01 task 03 negative
 * test pins this at INT32_MAX; the DB is INT64 but we want a hard cap at the
 * service layer to catch malformed provider usage rows before they corrupt
 * the running total.
 */
const MAX_DELTA = 2_147_483_647;

/** Shape of the missions row touched by enforcer reads/writes. */
interface MissionRow {
  status: string;
  budget_tokens: number;
  budget_usd_cents: number;
  spent_tokens: number;
  spent_usd_cents: number;
}

export class BudgetEnforcer {
  /**
   * Read-only gate consulted before issuing the next LLM call. Wrapped in a
   * BEGIN IMMEDIATE transaction so a concurrent `increment()` cannot land
   * mid-read and produce a torn `spent_*` snapshot — the caller sees either
   * the pre- or post-increment view, never a mix.
   *
   * Returns `allowed=false` when:
   *   - `missions.status = 'paused'` (kill switch armed by a prior halt or
   *     by an external operator pause)
   *   - `spent_tokens >= budget_tokens` OR `spent_usd_cents >= budget_usd_cents`
   *     (defensive: in practice `increment()` always pauses before this
   *     gets observed, but a stale read of an in-flight transaction could
   *     theoretically expose this state)
   *
   * Throws if the mission does not exist — silently returning allowed=true
   * for a missing mission would let the supervisor run unbounded against a
   * deleted target.
   */
  static check(missionId: string): BudgetEnforcerResult {
    const sqlite = getRawDb();
    const tx = sqlite.transaction((mid: string) => {
      const row = readMission(sqlite, mid);
      return computeResult(row);
    });
    return tx.immediate(missionId);
  }

  /**
   * Atomic spend-then-evaluate: adds `delta.tokens` / `delta.cents` to the
   * mission's running totals, returns the post-increment evaluation, and —
   * if the increment crosses the halt threshold — flips status to 'paused'
   * and emits a `budget_exceeded` mission_events row in the same
   * transaction.
   *
   * Validation runs OUTSIDE the transaction so a malformed delta fails fast
   * without taking the write lock.
   *
   * Why we still record the increment when the mission is already paused:
   * the LLM cost has already been incurred (the executor calls increment
   * post-call, after the provider returns a usage row), so the running
   * total must reflect reality even on a paused mission. We do NOT emit a
   * second `budget_exceeded` event for an already-paused mission — the
   * timeline records the *transition*, not every subsequent overrun.
   *
   * Throws on:
   *   - missing mission (same reason as `check()`)
   *   - delta validation (negative, NaN, non-integer, > MAX_INT32)
   */
  static increment(missionId: string, delta: BudgetDelta): BudgetEnforcerResult {
    validateDelta(delta);

    const sqlite = getRawDb();
    const tx = sqlite.transaction((mid: string, d: BudgetDelta): BudgetEnforcerResult => {
      const row = readMission(sqlite, mid);

      const newTokens = row.spent_tokens + d.tokens;
      const newCents = row.spent_usd_cents + d.cents;
      const wasPaused = row.status === "paused";
      const willHalt = newTokens >= row.budget_tokens || newCents >= row.budget_usd_cents;
      const transitionsToPaused = willHalt && !wasPaused;
      const newStatus = transitionsToPaused ? "paused" : row.status;

      sqlite
        .prepare(
          `UPDATE missions
             SET spent_tokens = ?,
                 spent_usd_cents = ?,
                 status = ?,
                 updated_at = unixepoch()
           WHERE id = ?`,
        )
        .run(newTokens, newCents, newStatus, mid);

      if (transitionsToPaused) {
        const payload = JSON.stringify({
          spent_tokens: newTokens,
          spent_usd_cents: newCents,
          budget_tokens: row.budget_tokens,
          budget_usd_cents: row.budget_usd_cents,
          delta_tokens: d.tokens,
          delta_cents: d.cents,
        });
        sqlite
          .prepare(
            `INSERT INTO mission_events
               (id, mission_id, kind, payload, cost_tokens, cost_usd_cents)
             VALUES (?, ?, 'budget_exceeded', ?, ?, ?)`,
          )
          .run(randomUUID(), mid, payload, d.tokens, d.cents);
      }

      return computeResult({
        status: newStatus,
        budget_tokens: row.budget_tokens,
        budget_usd_cents: row.budget_usd_cents,
        spent_tokens: newTokens,
        spent_usd_cents: newCents,
      });
    });

    return tx.immediate(missionId, delta);
  }
}

/** Fetch the mission row needed for budget evaluation; throw if missing. */
function readMission(sqlite: ReturnType<typeof getRawDb>, missionId: string): MissionRow {
  const row = sqlite
    .prepare(
      `SELECT status, budget_tokens, budget_usd_cents, spent_tokens, spent_usd_cents
         FROM missions
        WHERE id = ?`,
    )
    .get(missionId) as MissionRow | undefined;
  if (!row) {
    throw new Error(`BudgetEnforcer: mission not found: ${missionId}`);
  }
  return row;
}

/**
 * Reject malformed deltas before they touch the running total. Each branch
 * pins a specific failure mode the slice-03 negative tests assert against
 * (NaN, Infinity, negative, fractional, > MAX_INT32, non-number type).
 */
function validateDelta(delta: BudgetDelta): void {
  if (delta === null || typeof delta !== "object") {
    throw new Error("BudgetEnforcer: delta must be an object { tokens, cents }");
  }
  validateField("tokens", delta.tokens);
  validateField("cents", delta.cents);
}

function validateField(name: "tokens" | "cents", value: unknown): void {
  if (typeof value !== "number") {
    throw new Error(`BudgetEnforcer: delta.${name} must be a number`);
  }
  if (Number.isNaN(value)) {
    throw new Error(`BudgetEnforcer: delta.${name} is NaN`);
  }
  if (!Number.isFinite(value)) {
    throw new Error(`BudgetEnforcer: delta.${name} is not finite`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`BudgetEnforcer: delta.${name} must be an integer`);
  }
  if (value < 0) {
    throw new Error(`BudgetEnforcer: delta.${name} must be non-negative (got ${value})`);
  }
  if (value > MAX_DELTA) {
    throw new Error(
      `BudgetEnforcer: delta.${name} exceeds MAX_INT32 (${MAX_DELTA}); got ${value}`,
    );
  }
}

/**
 * Translate a mission row into the public `{ allowed, warn, remaining }`
 * shape. Pure — no DB access — so both `check()` and `increment()` can
 * reuse it without re-issuing the SELECT.
 *
 * `remaining` is clamped to ≥ 0 because the post-increment view of an
 * overshooting call would otherwise expose a negative number to UI
 * consumers; the supervisor doesn't care, but the metrics dashboard would.
 */
function computeResult(row: MissionRow): BudgetEnforcerResult {
  const remTokens = Math.max(0, row.budget_tokens - row.spent_tokens);
  const remCents = Math.max(0, row.budget_usd_cents - row.spent_usd_cents);
  const exhausted =
    row.spent_tokens >= row.budget_tokens || row.spent_usd_cents >= row.budget_usd_cents;
  const paused = row.status === "paused";
  const tokenRatio = row.budget_tokens > 0 ? row.spent_tokens / row.budget_tokens : 0;
  const centRatio = row.budget_usd_cents > 0 ? row.spent_usd_cents / row.budget_usd_cents : 0;
  const warn = tokenRatio >= WARN_THRESHOLD || centRatio >= WARN_THRESHOLD;
  return {
    allowed: !paused && !exhausted,
    warn,
    remaining: { tokens: remTokens, cents: remCents },
  };
}
