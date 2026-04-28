// guardedEvaluate — composer integration tests.
//
// Slice 11/01 task 03 ships the supervisor's single-entry composer that
// sequences BudgetEnforcer.check → MaxDepthGuard.check → evaluator →
// BudgetEnforcer.increment → mission_events INSERT. Every supervisor LLM
// call MUST funnel through this function (the static-grep code-review
// rule). This file covers every documented branch:
//
//   • happy path: evaluator runs, spend incremented, decision event
//     persisted with cost + depth columns
//   • paused kill-switch denial (reason='paused', evaluator never ran)
//   • budget-exhausted denial (reason='budget_exhausted')
//   • depth denial (reason='depth_exceeded') + persisted depth_exceeded
//     event with the guard's payload
//   • evaluator-thrown errors propagate AND no spend is recorded AND no
//     event is written
//   • default eventKind picks `remediation_proposed` when the evaluator
//     emits a proposal, `no_action` otherwise; explicit eventKind wins
//   • cost delta validation runs even on the increment that fires
//     post-evaluator (delegates to BudgetEnforcer)
//   • negative-depth bypass attempt is coerced to 0 (security invariant
//     mirrored from max-depth-guard tests; pinned here too because the
//     composer is the only call path)
//   • a halt that fires during the post-evaluator increment leaves the
//     mission paused for the NEXT call to deny

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { setDb, type FlockctlDb } from "../db/index.js";
import { guardedEvaluate } from "../services/missions/guarded-evaluate.js";
import type { Evaluator, EvaluatorResult } from "../services/missions/guarded-evaluate.js";

let sqlite: BetterSqlite3Database;
let db: FlockctlDb;

function setupDb(): void {
  sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  // DDL mirrors migrations/0043_add_missions.sql. Inlined so this test
  // never depends on the broader helpers.ts schema (which doesn't ship
  // missions tables today; adding them there would create a circular
  // coupling between the supervisor tier and the route-level tests).
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

function seedMission(overrides: {
  id?: string;
  budgetTokens?: number;
  budgetCents?: number;
  spentTokens?: number;
  spentCents?: number;
  status?: "drafting" | "active" | "paused" | "completed";
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
      overrides.budgetTokens ?? 10_000,
      overrides.budgetCents ?? 50_000,
      overrides.spentTokens ?? 0,
      overrides.spentCents ?? 0,
    );
  return id;
}

function listEvents(missionId: string): Array<{
  kind: string;
  payload: string;
  cost_tokens: number;
  cost_usd_cents: number;
  depth: number;
}> {
  return sqlite
    .prepare(
      "SELECT kind, payload, cost_tokens, cost_usd_cents, depth FROM mission_events WHERE mission_id = ? ORDER BY created_at, id",
    )
    .all(missionId) as Array<{
    kind: string;
    payload: string;
    cost_tokens: number;
    cost_usd_cents: number;
    depth: number;
  }>;
}

/** Make a one-shot evaluator with caller-tunable result + invocation flag. */
function makeEvaluator(
  result: EvaluatorResult,
): { fn: Evaluator; calls: number; calledWith: unknown } {
  const wrapper: { fn: Evaluator; calls: number; calledWith: unknown } = {
    calls: 0,
    calledWith: null,
    fn: async (ctx) => {
      wrapper.calls += 1;
      wrapper.calledWith = ctx;
      return result;
    },
  };
  return wrapper;
}

beforeAll(() => setupDb());
afterAll(() => sqlite.close());
beforeEach(() => {
  sqlite.exec("DELETE FROM mission_events; DELETE FROM missions;");
});

describe("guardedEvaluate — happy path", () => {
  it("runs the evaluator, increments spend, and writes a decision event", async () => {
    const id = seedMission({ budgetTokens: 1000, budgetCents: 5000 });
    const ev = makeEvaluator({
      proposal: { action: "rerun_failed_test" },
      cost: { tokens: 50, cents: 25 },
    });

    const r = await guardedEvaluate(
      id,
      { kind: "task_observed", payload: { task_id: 7 } },
      ev.fn,
    );

    expect(ev.calls).toBe(1);
    // The evaluator received the pre-call budget snapshot.
    expect((ev.calledWith as { budget?: { allowed?: boolean } }).budget?.allowed).toBe(true);

    if (!r.allowed) throw new Error("expected allowed=true");
    expect(r.depth).toBe(0);
    expect(r.proposal).toEqual({ action: "rerun_failed_test" });
    expect(r.cost).toEqual({ tokens: 50, cents: 25 });
    expect(r.eventKind).toBe("remediation_proposed");
    expect(typeof r.eventId).toBe("string");

    // Spend landed.
    const post = sqlite
      .prepare("SELECT spent_tokens, spent_usd_cents FROM missions WHERE id = ?")
      .get(id) as { spent_tokens: number; spent_usd_cents: number };
    expect(post).toEqual({ spent_tokens: 50, spent_usd_cents: 25 });

    // Exactly one event row, with the correct kind/cost/depth columns.
    const events = listEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("remediation_proposed");
    expect(events[0].cost_tokens).toBe(50);
    expect(events[0].cost_usd_cents).toBe(25);
    expect(events[0].depth).toBe(0);
    const payload = JSON.parse(events[0].payload);
    expect(payload.proposal).toEqual({ action: "rerun_failed_test" });
    expect(payload.trigger_kind).toBe("task_observed");
  });

  it("default eventKind is no_action when the evaluator returns no proposal", async () => {
    const id = seedMission();
    const ev = makeEvaluator({ cost: { tokens: 1, cents: 1 } });
    const r = await guardedEvaluate(id, { kind: "heartbeat" }, ev.fn);
    expect(r.allowed).toBe(true);
    if (!r.allowed) return;
    expect(r.eventKind).toBe("no_action");
    const events = listEvents(id);
    expect(events[0].kind).toBe("no_action");
    // proposal key not present in payload when undefined.
    expect(JSON.parse(events[0].payload).proposal).toBeUndefined();
  });

  it("explicit eventKind overrides the default", async () => {
    const id = seedMission();
    const ev = makeEvaluator({
      proposal: { x: 1 },
      cost: { tokens: 0, cents: 0 },
      eventKind: "objective_met",
      eventPayload: { reason: "all_tasks_done" },
    });
    const r = await guardedEvaluate(id, { kind: "task_observed" }, ev.fn);
    expect(r.allowed).toBe(true);
    if (!r.allowed) return;
    expect(r.eventKind).toBe("objective_met");
    const events = listEvents(id);
    expect(events[0].kind).toBe("objective_met");
    const payload = JSON.parse(events[0].payload);
    expect(payload.reason).toBe("all_tasks_done");
    expect(payload.proposal).toEqual({ x: 1 });
  });

  it("zero-cost evaluations still write a decision event (and do not halt)", async () => {
    const id = seedMission({ budgetTokens: 100, budgetCents: 100 });
    const ev = makeEvaluator({ cost: { tokens: 0, cents: 0 } });
    await guardedEvaluate(id, { kind: "heartbeat" }, ev.fn);
    expect(listEvents(id)).toHaveLength(1);
    const m = sqlite
      .prepare("SELECT spent_tokens, spent_usd_cents, status FROM missions WHERE id = ?")
      .get(id) as { spent_tokens: number; spent_usd_cents: number; status: string };
    expect(m).toEqual({ spent_tokens: 0, spent_usd_cents: 0, status: "active" });
  });

  it("threads the trigger and depth into the evaluator context", async () => {
    const id = seedMission();
    const ev = makeEvaluator({ cost: { tokens: 0, cents: 0 } });
    await guardedEvaluate(
      id,
      { kind: "remediation", payload: { depth: 2, task_id: 11 } },
      ev.fn,
    );
    const ctx = ev.calledWith as {
      missionId: string;
      trigger: { kind: string; payload?: { task_id?: number } };
      depth: number;
    };
    expect(ctx.missionId).toBe(id);
    expect(ctx.trigger.kind).toBe("remediation");
    expect(ctx.trigger.payload?.task_id).toBe(11);
    expect(ctx.depth).toBe(2);
  });
});

describe("guardedEvaluate — denials", () => {
  it("paused mission denies with reason='paused' and never invokes the evaluator", async () => {
    const id = seedMission({ status: "paused" });
    const ev = makeEvaluator({ cost: { tokens: 1, cents: 1 } });
    const r = await guardedEvaluate(id, { kind: "task_observed" }, ev.fn);
    expect(r.allowed).toBe(false);
    if (r.allowed) return;
    expect(r.reason).toBe("paused");
    expect(ev.calls).toBe(0);
    // No new event rows.
    expect(listEvents(id)).toHaveLength(0);
  });

  it("budget-exhausted mission denies with reason='budget_exhausted'", async () => {
    // Mission still 'active' (operator never paused it) but spent >= budget
    // due to a stale row from a crashed supervisor. classifyBudgetDenial
    // should pick budget_exhausted, not paused.
    const id = seedMission({
      budgetTokens: 1000,
      budgetCents: 5000,
      spentTokens: 1000,
      spentCents: 0,
      status: "active",
    });
    const ev = makeEvaluator({ cost: { tokens: 1, cents: 1 } });
    const r = await guardedEvaluate(id, { kind: "task_observed" }, ev.fn);
    expect(r.allowed).toBe(false);
    if (r.allowed) return;
    expect(r.reason).toBe("budget_exhausted");
    expect(ev.calls).toBe(0);
  });

  it("depth-exceeded denies with reason='depth_exceeded' and persists a depth_exceeded event", async () => {
    const id = seedMission();
    const ev = makeEvaluator({ cost: { tokens: 1, cents: 1 } });
    const r = await guardedEvaluate(
      id,
      { kind: "remediation", payload: { depth: 9, task_id: 42 } },
      ev.fn,
    );
    expect(r.allowed).toBe(false);
    if (r.allowed) return;
    expect(r.reason).toBe("depth_exceeded");
    expect(r.depth).toBe(9);
    expect(ev.calls).toBe(0);

    // The event is written with cost=0 (no spend was incurred) and depth
    // = the rejected value.
    const events = listEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("depth_exceeded");
    expect(events[0].cost_tokens).toBe(0);
    expect(events[0].cost_usd_cents).toBe(0);
    expect(events[0].depth).toBe(9);
    const payload = JSON.parse(events[0].payload);
    expect(payload.depth).toBe(9);
    expect(payload.task_id).toBe(42);
    expect(payload.trigger_kind).toBe("remediation");
  });

  it("a negative-depth bypass attempt is coerced to 0 and the evaluator runs", async () => {
    // Mirrors the security invariant from max-depth-guard.test.ts. Pinned
    // here too because the composer is the ONLY call path; if a future
    // refactor moves coercion out of the guard, this test guarantees the
    // composer either re-applies it or fails loudly.
    const id = seedMission();
    const ev = makeEvaluator({ cost: { tokens: 0, cents: 0 } });
    const r = await guardedEvaluate(
      id,
      { kind: "remediation", payload: { depth: -100 } },
      ev.fn,
    );
    expect(r.allowed).toBe(true);
    if (!r.allowed) return;
    expect(r.depth).toBe(0);
    expect(ev.calls).toBe(1);
  });
});

describe("guardedEvaluate — evaluator failure semantics", () => {
  it("propagates a thrown error and records NO spend and NO event", async () => {
    const id = seedMission({ budgetTokens: 1000, budgetCents: 5000 });
    const failing: Evaluator = async () => {
      throw new Error("LLM provider 500");
    };

    await expect(
      guardedEvaluate(id, { kind: "task_observed" }, failing),
    ).rejects.toThrow(/LLM provider 500/);

    const post = sqlite
      .prepare("SELECT spent_tokens, spent_usd_cents FROM missions WHERE id = ?")
      .get(id) as { spent_tokens: number; spent_usd_cents: number };
    expect(post).toEqual({ spent_tokens: 0, spent_usd_cents: 0 });
    expect(listEvents(id)).toHaveLength(0);
  });

  it("a malformed cost delta surfaces as a thrown error from BudgetEnforcer.increment", async () => {
    const id = seedMission();
    const ev: Evaluator = async () => ({
      proposal: undefined,
      cost: { tokens: -1, cents: 0 }, // invalid — increment must reject.
    });

    await expect(guardedEvaluate(id, { kind: "task_observed" }, ev)).rejects.toThrow(
      /non-negative/,
    );

    // Note: in the validation-fails branch the running total stays
    // untouched (validation runs OUTSIDE the transaction). No decision
    // event was written either — the failed increment short-circuited
    // the composer before step (5).
    const post = sqlite
      .prepare("SELECT spent_tokens FROM missions WHERE id = ?")
      .get(id) as { spent_tokens: number };
    expect(post.spent_tokens).toBe(0);
    expect(listEvents(id).filter((e) => e.kind !== "depth_exceeded")).toHaveLength(0);
  });
});

describe("guardedEvaluate — halt during post-evaluator increment", () => {
  it("an increment that crosses the budget halts the mission; the NEXT call denies", async () => {
    const id = seedMission({ budgetTokens: 100, budgetCents: 5000 });
    const ev1 = makeEvaluator({
      proposal: { x: 1 },
      cost: { tokens: 100, cents: 0 }, // exact halt threshold.
    });

    const r1 = await guardedEvaluate(id, { kind: "task_observed" }, ev1.fn);
    expect(r1.allowed).toBe(true);
    if (!r1.allowed) return;
    // Post-increment budget snapshot reflects the halt: allowed=false.
    expect(r1.budget.allowed).toBe(false);
    // Mission is paused; budget_exceeded event landed in the same
    // transaction as the increment.
    const status = (sqlite.prepare("SELECT status FROM missions WHERE id = ?").get(id) as {
      status: string;
    }).status;
    expect(status).toBe("paused");

    const evts = listEvents(id);
    // Two events: budget_exceeded (from BudgetEnforcer.increment) and
    // remediation_proposed (the decision event the composer writes).
    expect(evts.map((e) => e.kind).sort()).toEqual([
      "budget_exceeded",
      "remediation_proposed",
    ]);

    // Next call denies at step (1).
    const ev2 = makeEvaluator({ cost: { tokens: 1, cents: 1 } });
    const r2 = await guardedEvaluate(id, { kind: "task_observed" }, ev2.fn);
    expect(r2.allowed).toBe(false);
    if (r2.allowed) return;
    expect(r2.reason).toBe("paused");
    expect(ev2.calls).toBe(0);
  });
});

describe("guardedEvaluate — missing mission", () => {
  it("propagates the BudgetEnforcer.check error for an unknown mission", async () => {
    const ev = makeEvaluator({ cost: { tokens: 0, cents: 0 } });
    await expect(
      guardedEvaluate("does-not-exist", { kind: "task_observed" }, ev.fn),
    ).rejects.toThrow(/not found/);
    expect(ev.calls).toBe(0);
  });
});
