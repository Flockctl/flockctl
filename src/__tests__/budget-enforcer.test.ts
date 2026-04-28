// BudgetEnforcer — full negative / edge / race / property test surface.
//
// Slice 11/01 task 03 ships the supervisor-loop kill switch. This file
// covers every contract pinned in `budget-enforcer.ts`'s header comment:
//
//   • happy-path increment + check shapes
//   • delta validation matrix (NaN, Infinity, negative, fractional, type,
//     null, > MAX_INT32, missing field)
//   • paused-status sticky kill switch (idempotent halt, no double
//     budget_exceeded events, post-halt increments still record)
//   • 80% warn threshold (tokens AND cents independently)
//   • exact-100% race: two `Promise.all` increments that sum to the
//     budget — exactly one transitions the mission to `paused` and emits
//     the `budget_exceeded` event
//   • clock-skew: SQLite's `unixepoch()` is the source of truth for
//     `mission_events.created_at`, even when `Date.now()` is stubbed far
//     into the future or the past
//   • property: 1000 fast-check runs of randomised non-negative deltas;
//     the kill switch is sticky and the recorded spend never overshoots
//     the budget by more than a single delta (the call that crosses the
//     threshold)
//
// We attach to `getRawDb()` via `setDb()` so the production class touches
// our :memory: handle. Foreign keys are ON; the missions DDL mirrors
// `migrations/0043_add_missions.sql` exactly so CHECK constraints fire
// the same way they would on a real boot.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as fc from "fast-check";
import * as schema from "../db/schema.js";
import { setDb, type FlockctlDb } from "../db/index.js";
import { BudgetEnforcer } from "../services/missions/budget-enforcer.js";

let sqlite: BetterSqlite3Database;
let db: FlockctlDb;

/**
 * Stand up a :memory: DB pre-loaded with the parent rows the missions
 * FK chain depends on (workspaces, projects) plus the mission/event
 * DDL copied verbatim from `0043_add_missions.sql`. Re-used across every
 * test in this file via `beforeEach` — full reset between cases.
 */
function setupDb(): void {
  sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  sqlite.exec(`
    CREATE TABLE workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL UNIQUE
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      autonomy TEXT NOT NULL DEFAULT 'suggest',
      budget_tokens INTEGER NOT NULL,
      budget_usd_cents INTEGER NOT NULL,
      spent_tokens INTEGER NOT NULL DEFAULT 0,
      spent_usd_cents INTEGER NOT NULL DEFAULT 0,
      supervisor_prompt_version TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      CONSTRAINT missions_status_check
        CHECK (status IN ('drafting','active','paused','completed','failed','aborted')),
      CONSTRAINT missions_autonomy_check
        CHECK (autonomy IN ('manual','suggest','auto')),
      CONSTRAINT missions_budget_tokens_check
        CHECK (budget_tokens > 0),
      CONSTRAINT missions_budget_usd_cents_check
        CHECK (budget_usd_cents > 0)
    );
    CREATE INDEX idx_missions_project ON missions (project_id);

    CREATE TABLE mission_events (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      cost_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd_cents INTEGER NOT NULL DEFAULT 0,
      depth INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      CONSTRAINT mission_events_kind_check
        CHECK (kind IN (
          'plan_proposed','task_observed','remediation_proposed',
          'remediation_approved','remediation_dismissed',
          'budget_warning','budget_exceeded','depth_exceeded',
          'no_action','objective_met','stalled','heartbeat','paused'
        ))
    );
    CREATE INDEX idx_mission_events_mission_created
      ON mission_events (mission_id, created_at DESC);
  `);

  sqlite.prepare("INSERT INTO workspaces (name, path) VALUES ('ws','/tmp/ws')").run();
  sqlite.prepare("INSERT INTO projects (workspace_id, name) VALUES (1, 'p')").run();

  db = drizzle(sqlite, { schema });
  setDb(db, sqlite);
}

/**
 * Insert a fresh mission row with caller-tunable budgets and starting
 * spend. Returns the mission id — convenient for chaining straight into
 * `BudgetEnforcer.check(id)` / `.increment(id, …)`.
 */
function seedMission(overrides: {
  id?: string;
  budgetTokens?: number;
  budgetCents?: number;
  spentTokens?: number;
  spentCents?: number;
  status?: "drafting" | "active" | "paused" | "completed" | "failed" | "aborted";
} = {}): string {
  const id = overrides.id ?? `m-${Math.random().toString(36).slice(2, 10)}`;
  sqlite
    .prepare(
      `INSERT INTO missions
         (id, project_id, objective, status, autonomy,
          budget_tokens, budget_usd_cents, spent_tokens, spent_usd_cents,
          supervisor_prompt_version)
       VALUES (?, 1, 'objective', ?, 'suggest', ?, ?, ?, ?, 'v1')`,
    )
    .run(
      id,
      overrides.status ?? "active",
      overrides.budgetTokens ?? 1000,
      overrides.budgetCents ?? 5000,
      overrides.spentTokens ?? 0,
      overrides.spentCents ?? 0,
    );
  return id;
}

/** Read current mission status — used by tests that assert the kill-switch transition. */
function readMissionStatus(id: string): string {
  const row = sqlite.prepare("SELECT status FROM missions WHERE id = ?").get(id) as
    | { status: string }
    | undefined;
  return row?.status ?? "<missing>";
}

/** Count mission_events rows of a given kind for a mission. */
function countEvents(missionId: string, kind?: string): number {
  if (kind) {
    const r = sqlite
      .prepare("SELECT COUNT(*) as c FROM mission_events WHERE mission_id = ? AND kind = ?")
      .get(missionId, kind) as { c: number };
    return r.c;
  }
  const r = sqlite
    .prepare("SELECT COUNT(*) as c FROM mission_events WHERE mission_id = ?")
    .get(missionId) as { c: number };
  return r.c;
}

beforeAll(() => {
  setupDb();
});

afterAll(() => {
  sqlite.close();
});

beforeEach(() => {
  // Wipe rows but reuse the connection so the BEGIN IMMEDIATE semantics
  // we exercise in the race test stay attached to the same handle.
  sqlite.exec(`
    DELETE FROM mission_events;
    DELETE FROM missions;
  `);
});

describe("BudgetEnforcer.check — happy paths and shapes", () => {
  it("returns allowed=true with full budget remaining on a fresh active mission", () => {
    const id = seedMission({ budgetTokens: 1000, budgetCents: 5000 });
    const r = BudgetEnforcer.check(id);
    expect(r.allowed).toBe(true);
    expect(r.warn).toBe(false);
    expect(r.remaining).toEqual({ tokens: 1000, cents: 5000 });
  });

  it("returns warn=true at exactly the 80% token threshold and remains allowed", () => {
    const id = seedMission({ budgetTokens: 1000, budgetCents: 5000, spentTokens: 800 });
    const r = BudgetEnforcer.check(id);
    expect(r.allowed).toBe(true);
    expect(r.warn).toBe(true);
    expect(r.remaining.tokens).toBe(200);
  });

  it("returns warn=true at 80% cents even when tokens are nowhere near", () => {
    const id = seedMission({ budgetTokens: 1000, budgetCents: 5000, spentCents: 4000 });
    const r = BudgetEnforcer.check(id);
    expect(r.warn).toBe(true);
    expect(r.allowed).toBe(true);
  });

  it("returns warn=false just below the 80% threshold (79.9% of tokens)", () => {
    const id = seedMission({ budgetTokens: 1000, budgetCents: 5000, spentTokens: 799 });
    expect(BudgetEnforcer.check(id).warn).toBe(false);
  });

  it("returns allowed=false when status is already paused", () => {
    const id = seedMission({ status: "paused" });
    const r = BudgetEnforcer.check(id);
    expect(r.allowed).toBe(false);
  });

  it("clamps remaining to 0 when spent has already overshot the budget", () => {
    // Forward-construct the post-overshoot state; check() never lets you get
    // here, but a stale row from a previous supervisor binary would.
    const id = seedMission({
      budgetTokens: 1000,
      budgetCents: 5000,
      spentTokens: 1500,
      spentCents: 6000,
    });
    const r = BudgetEnforcer.check(id);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toEqual({ tokens: 0, cents: 0 });
  });

  it("throws on a mission that does not exist", () => {
    expect(() => BudgetEnforcer.check("nonexistent")).toThrow(/not found/);
  });
});

describe("BudgetEnforcer.increment — happy path + halt transition", () => {
  it("adds the delta and returns the post-increment view", () => {
    const id = seedMission({ budgetTokens: 1000, budgetCents: 5000 });
    const r = BudgetEnforcer.increment(id, { tokens: 100, cents: 250 });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toEqual({ tokens: 900, cents: 4750 });
    const post = sqlite
      .prepare("SELECT spent_tokens, spent_usd_cents FROM missions WHERE id = ?")
      .get(id) as { spent_tokens: number; spent_usd_cents: number };
    expect(post).toEqual({ spent_tokens: 100, spent_usd_cents: 250 });
  });

  it("transitions to paused and emits exactly one budget_exceeded event when tokens cross", () => {
    const id = seedMission({ budgetTokens: 1000, budgetCents: 5000, spentTokens: 800 });
    const r = BudgetEnforcer.increment(id, { tokens: 200, cents: 0 });
    expect(r.allowed).toBe(false);
    expect(readMissionStatus(id)).toBe("paused");
    expect(countEvents(id, "budget_exceeded")).toBe(1);

    const evt = sqlite
      .prepare("SELECT payload, cost_tokens, cost_usd_cents FROM mission_events WHERE mission_id = ?")
      .get(id) as { payload: string; cost_tokens: number; cost_usd_cents: number };
    expect(evt.cost_tokens).toBe(200);
    expect(evt.cost_usd_cents).toBe(0);
    const payload = JSON.parse(evt.payload);
    expect(payload.spent_tokens).toBe(1000);
    expect(payload.budget_tokens).toBe(1000);
    expect(payload.delta_tokens).toBe(200);
  });

  it("halts on cents independently of tokens", () => {
    const id = seedMission({ budgetTokens: 1_000_000, budgetCents: 100, spentCents: 80 });
    const r = BudgetEnforcer.increment(id, { tokens: 1, cents: 30 });
    expect(r.allowed).toBe(false);
    expect(readMissionStatus(id)).toBe("paused");
  });

  it("does NOT emit a second budget_exceeded event on subsequent post-halt increments", () => {
    // Sticky kill-switch: halt fires once, the timeline records the
    // *transition*, not every overrun.
    const id = seedMission({ budgetTokens: 100, budgetCents: 100 });
    BudgetEnforcer.increment(id, { tokens: 100, cents: 100 }); // halts.
    BudgetEnforcer.increment(id, { tokens: 50, cents: 50 });   // overrun.
    BudgetEnforcer.increment(id, { tokens: 50, cents: 50 });   // overrun.
    expect(countEvents(id, "budget_exceeded")).toBe(1);
  });

  it("still records spend on a paused mission (provider already charged us)", () => {
    const id = seedMission({ status: "paused", budgetTokens: 1000, budgetCents: 5000 });
    BudgetEnforcer.increment(id, { tokens: 7, cents: 11 });
    const post = sqlite
      .prepare("SELECT spent_tokens, spent_usd_cents, status FROM missions WHERE id = ?")
      .get(id) as { spent_tokens: number; spent_usd_cents: number; status: string };
    expect(post.spent_tokens).toBe(7);
    expect(post.spent_usd_cents).toBe(11);
    expect(post.status).toBe("paused");
    // No new budget_exceeded event for an already-paused mission.
    expect(countEvents(id, "budget_exceeded")).toBe(0);
  });

  it("treats halt as `>=` budget — exact-equal triggers paused", () => {
    const id = seedMission({ budgetTokens: 100, budgetCents: 5000 });
    const r = BudgetEnforcer.increment(id, { tokens: 100, cents: 0 });
    expect(r.allowed).toBe(false);
    expect(readMissionStatus(id)).toBe("paused");
  });

  it("zero-delta increments are legal and never halt", () => {
    const id = seedMission({ budgetTokens: 100 });
    const r = BudgetEnforcer.increment(id, { tokens: 0, cents: 0 });
    expect(r.allowed).toBe(true);
    expect(readMissionStatus(id)).toBe("active");
  });

  it("throws on a mission that does not exist (no silent autopass)", () => {
    expect(() => BudgetEnforcer.increment("ghost", { tokens: 1, cents: 1 })).toThrow(
      /not found/,
    );
  });
});

describe("BudgetEnforcer.increment — delta validation matrix", () => {
  const id = "m-validate";

  beforeEach(() => {
    seedMission({ id });
  });

  it.each([
    ["NaN", { tokens: NaN, cents: 0 }, /NaN/],
    ["Infinity", { tokens: Infinity, cents: 0 }, /finite/],
    ["-Infinity", { tokens: -Infinity, cents: 0 }, /finite/],
    ["fractional tokens", { tokens: 1.5, cents: 0 }, /integer/],
    ["fractional cents", { tokens: 0, cents: 0.1 }, /integer/],
    ["negative tokens", { tokens: -1, cents: 0 }, /non-negative/],
    ["negative cents", { tokens: 0, cents: -1 }, /non-negative/],
    ["tokens > MAX_INT32", { tokens: 2_147_483_648, cents: 0 }, /MAX_INT32/],
    ["cents > MAX_INT32", { tokens: 0, cents: 2_147_483_648 }, /MAX_INT32/],
    ["string tokens", { tokens: "1" as unknown as number, cents: 0 }, /must be a number/],
    ["null tokens", { tokens: null as unknown as number, cents: 0 }, /must be a number/],
    ["undefined tokens", { tokens: undefined as unknown as number, cents: 0 }, /must be a number/],
  ])("rejects %s", (_label, delta, msg) => {
    expect(() => BudgetEnforcer.increment(id, delta)).toThrow(msg);
  });

  it("rejects a null delta object outright", () => {
    expect(() =>
      BudgetEnforcer.increment(id, null as unknown as { tokens: number; cents: number }),
    ).toThrow(/must be an object/);
  });

  it("rejects a non-object delta (string)", () => {
    expect(() =>
      BudgetEnforcer.increment(id, "nope" as unknown as { tokens: number; cents: number }),
    ).toThrow(/must be an object/);
  });

  it("accepts MAX_INT32 exactly (boundary)", () => {
    // Pre-bake spent so we don't trip on actual arithmetic overflow when we
    // add to spent_tokens — the validator should pass the boundary value.
    seedMission({ id: "m-int32-edge", budgetTokens: 5_000_000_000, budgetCents: 5_000_000_000 });
    const r = BudgetEnforcer.increment("m-int32-edge", {
      tokens: 2_147_483_647,
      cents: 2_147_483_647,
    });
    expect(r.allowed).toBe(true);
  });

  it("does NOT touch the running total when validation fails", () => {
    expect(() => BudgetEnforcer.increment(id, { tokens: -1, cents: 0 })).toThrow();
    const row = sqlite
      .prepare("SELECT spent_tokens FROM missions WHERE id = ?")
      .get(id) as { spent_tokens: number };
    expect(row.spent_tokens).toBe(0);
    // No event row either (validation runs OUTSIDE the transaction).
    expect(countEvents(id)).toBe(0);
  });
});

describe("BudgetEnforcer.increment — race atomicity", () => {
  it("two concurrent Promise.all increments summing to the budget halt exactly once", async () => {
    // The contract: BEGIN IMMEDIATE serialises the two writes through
    // SQLite's write lock, so even though they were dispatched in parallel,
    // exactly one increment observes the threshold-crossing transition and
    // emits the budget_exceeded event. Better-sqlite3 is synchronous, so
    // Promise.all here is the JavaScript-level expression of "the
    // supervisor double-spent because two LLM calls returned at the same
    // tick"; what we're really pinning is that the increment writes can
    // never interleave to produce two halts on a single threshold
    // crossing.
    const id = seedMission({ budgetTokens: 100, budgetCents: 5000 });

    const half = { tokens: 50, cents: 0 };
    const results = await Promise.all([
      Promise.resolve().then(() => BudgetEnforcer.increment(id, half)),
      Promise.resolve().then(() => BudgetEnforcer.increment(id, half)),
    ]);

    // Both calls succeed.
    expect(results).toHaveLength(2);

    // After both, status is paused.
    expect(readMissionStatus(id)).toBe("paused");

    // Exactly one budget_exceeded event was emitted (the threshold
    // crossing happens once, not once-per-overrun).
    expect(countEvents(id, "budget_exceeded")).toBe(1);

    // Exactly one of the two return values had allowed=false (the call
    // that crossed the threshold). The first writer in serial order
    // observed allowed=true (50/100); the second observed allowed=false
    // (100/100).
    const denials = results.filter((r) => r.allowed === false).length;
    expect(denials).toBe(1);

    // Final spent_tokens = exactly the budget; no double-counting, no
    // missed write.
    const row = sqlite
      .prepare("SELECT spent_tokens FROM missions WHERE id = ?")
      .get(id) as { spent_tokens: number };
    expect(row.spent_tokens).toBe(100);
  });
});

describe("BudgetEnforcer.increment — clock-skew", () => {
  it("mission_events.created_at follows the SQLite clock, not Date.now()", () => {
    const id = seedMission({ budgetTokens: 100, budgetCents: 100 });

    // Stub Date.now to return year 2200 — a stub that bleeds through into
    // the timeline would push created_at to ~7e9. We assert the recorded
    // value is close to the real wall clock instead.
    const realNow = Math.floor(Date.now() / 1000);
    const farFuture = 7_258_118_400_000; // 2200-01-01 UTC in ms
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(farFuture);

    BudgetEnforcer.increment(id, { tokens: 100, cents: 100 });

    dateSpy.mockRestore();

    const row = sqlite
      .prepare(
        "SELECT created_at FROM mission_events WHERE mission_id = ? AND kind = 'budget_exceeded'",
      )
      .get(id) as { created_at: number };

    // SQLite's unixepoch() returned the real UNIX time, not the stubbed
    // value. We allow ±5s for test-runner jitter.
    expect(row.created_at).toBeGreaterThanOrEqual(realNow - 5);
    expect(row.created_at).toBeLessThanOrEqual(realNow + 5);
    // And explicitly NOT in the year 2200.
    expect(row.created_at).toBeLessThan(2_000_000_000); // ~2033
  });
});

describe("BudgetEnforcer.increment — fast-check property: 1000 runs", () => {
  it("kill switch is sticky and recorded spend stays within delta of budget after any sequence", () => {
    fc.assert(
      fc.property(
        // A budget bigger than MAX_DELTA but small enough that a sequence
        // of moderately-sized deltas can plausibly cross it within a
        // bounded run. Cents budget is independent.
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        // 1..50 randomised non-negative integer deltas; each capped well
        // below the budget so the property is interesting (if every delta
        // immediately blew past the budget, the test wouldn't exercise
        // the sticky kill-switch).
        fc.array(
          fc.record({
            tokens: fc.integer({ min: 0, max: 500 }),
            cents: fc.integer({ min: 0, max: 500 }),
          }),
          { minLength: 1, maxLength: 50 },
        ),
        (budgetTokens, budgetCents, deltas) => {
          // Reset state inside the property body so each run is isolated.
          sqlite.exec("DELETE FROM mission_events; DELETE FROM missions;");
          const id = seedMission({ budgetTokens, budgetCents });

          let observedHalt = false;
          let firstHaltSpentTokens = -1;
          let firstHaltSpentCents = -1;

          for (const d of deltas) {
            const before = BudgetEnforcer.check(id);

            // Supervisor pattern: only call increment when allowed.
            if (!before.allowed) {
              // Sticky kill switch invariant: once denied, always denied.
              expect(observedHalt).toBe(true);
              continue;
            }

            const after = BudgetEnforcer.increment(id, d);

            // Once the call that crossed the threshold returns
            // allowed=false, all subsequent check()s must agree.
            if (!after.allowed && !observedHalt) {
              observedHalt = true;
              const row = sqlite
                .prepare(
                  "SELECT spent_tokens, spent_usd_cents FROM missions WHERE id = ?",
                )
                .get(id) as { spent_tokens: number; spent_usd_cents: number };
              firstHaltSpentTokens = row.spent_tokens;
              firstHaltSpentCents = row.spent_usd_cents;
            }
          }

          // Final state assertions.
          const final = sqlite
            .prepare(
              "SELECT spent_tokens, spent_usd_cents, status FROM missions WHERE id = ?",
            )
            .get(id) as { spent_tokens: number; spent_usd_cents: number; status: string };

          if (observedHalt) {
            // Status is paused — kill-switch armed.
            expect(final.status).toBe("paused");
            // budget_exceeded fired exactly once (sticky transition).
            expect(countEvents(id, "budget_exceeded")).toBe(1);
            // Recorded spend at the moment of halt did not overshoot the
            // budget by more than a single delta. (We capped delta values
            // at 500 above; reuse the same cap for the bound.)
            expect(firstHaltSpentTokens).toBeLessThanOrEqual(budgetTokens + 500);
            expect(firstHaltSpentCents).toBeLessThanOrEqual(budgetCents + 500);
            // At least one of the dimensions actually crossed the budget
            // (otherwise observedHalt would not be true).
            expect(
              firstHaltSpentTokens >= budgetTokens || firstHaltSpentCents >= budgetCents,
            ).toBe(true);
          } else {
            // No halt observed → final spent strictly below budget on
            // both dimensions.
            expect(final.spent_tokens).toBeLessThan(budgetTokens);
            expect(final.spent_usd_cents).toBeLessThan(budgetCents);
            expect(final.status).toBe("active");
            expect(countEvents(id, "budget_exceeded")).toBe(0);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});
