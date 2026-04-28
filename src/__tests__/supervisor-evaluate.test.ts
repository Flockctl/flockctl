// SupervisorService.evaluate — integration tests.
//
// Slice 11/01 task 04 wires buildSupervisorPrompt + guardedEvaluate +
// supervisorOutputSchema + wsManager into the single supervisor entry-point.
// This file pins:
//
//   • happy path: LLM returns a zod-valid proposal → guardedEvaluate writes
//     a `remediation_proposed` row with cost + depth + rationale, the WS
//     broadcast fires with the eventId
//   • no_action path: LLM returns the no_action variant → `no_action` row
//   • heartbeat short-circuit: LLM is NEVER invoked, `heartbeat` row written
//   • guard-denied paths never invoke the LLM (paused mission +
//     depth-exceeded both keep the LLM untouched and skip the broadcast)
//   • schema-validation failure (LLM returned junk) is downgraded to a
//     no_action event with the parse error captured in the payload
//   • broadcast envelope shape (type / missionId / kind / eventId / depth)
//
// AND the static-contract test:
//
//   • supervisor_has_no_import_of_plan_generator_helpers — grep enforces
//     that supervisor.ts never imports a plan-creation helper. Mirrors the
//     parent slice §02 invariant ("supervisor proposes; never creates").
//
// Why a fresh in-memory DB per test rather than shared helpers.ts: the
// supervisor module isn't on the helpers' boot path today (helpers.ts
// pre-dates the missions table), so inlining the DDL keeps this test from
// having to grow a circular coupling between the supervisor tier and the
// route-level setup.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schema from "../db/schema.js";
import { setDb, type FlockctlDb } from "../db/index.js";
import {
  SupervisorService,
  SUPERVISOR_BROADCAST_TYPE,
  type SupervisorLLM,
} from "../services/missions/supervisor.js";
import { wsManager } from "../services/ws-manager.js";

let sqlite: BetterSqlite3Database;
let db: FlockctlDb;

function setupDb(): void {
  sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  // DDL mirrors migrations/0043_add_missions.sql + the bare workspace /
  // project tables the foreign keys require. Inlined so this test never
  // depends on the broader helpers.ts schema.
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
  sqlite.prepare("INSERT INTO projects (workspace_id, name) VALUES (1,'p')").run();

  db = drizzle(sqlite, { schema });
  setDb(db, sqlite);
}

function seedMission(overrides: {
  id?: string;
  objective?: string;
  status?: "drafting" | "active" | "paused" | "completed";
  budgetTokens?: number;
  budgetCents?: number;
  spentTokens?: number;
  spentCents?: number;
} = {}): string {
  const id = overrides.id ?? `m-${Math.random().toString(36).slice(2, 10)}`;
  sqlite
    .prepare(
      `INSERT INTO missions
         (id, project_id, objective, status, autonomy,
          budget_tokens, budget_usd_cents, spent_tokens, spent_usd_cents,
          supervisor_prompt_version)
       VALUES (?, 1, ?, ?, 'suggest', ?, ?, ?, ?, 'v1')`,
    )
    .run(
      id,
      overrides.objective ?? "Ship the launcher",
      overrides.status ?? "active",
      overrides.budgetTokens ?? 10_000,
      overrides.budgetCents ?? 50_000,
      overrides.spentTokens ?? 0,
      overrides.spentCents ?? 0,
    );
  return id;
}

interface EventRow {
  kind: string;
  payload: string;
  cost_tokens: number;
  cost_usd_cents: number;
  depth: number;
}

function listEvents(missionId: string): EventRow[] {
  return sqlite
    .prepare(
      "SELECT kind, payload, cost_tokens, cost_usd_cents, depth FROM mission_events WHERE mission_id = ? ORDER BY created_at, id",
    )
    .all(missionId) as EventRow[];
}

/**
 * Tiny fake LLM. Tests pre-arm `nextReply` with a string + cost; calling
 * `complete` returns it (and records the prompt for the prompt-shape
 * assertions). Throws if `nextReply` was never set so a heartbeat that
 * accidentally calls the LLM blows up loudly instead of silently
 * producing a default reply.
 */
function makeFakeLLM(): {
  llm: SupervisorLLM;
  calls: number;
  lastPrompt: string | null;
  setReply: (text: string, cost?: { tokens: number; cents: number }) => void;
  setError: (err: Error) => void;
} {
  let nextReply: { text: string; cost: { tokens: number; cents: number } } | null = null;
  let nextError: Error | null = null;
  const wrapper = {
    calls: 0,
    lastPrompt: null as string | null,
    setReply(text: string, cost: { tokens: number; cents: number } = { tokens: 5, cents: 2 }) {
      nextReply = { text, cost };
      nextError = null;
    },
    setError(err: Error) {
      nextError = err;
      nextReply = null;
    },
    llm: {
      async complete(prompt: string) {
        wrapper.calls += 1;
        wrapper.lastPrompt = prompt;
        if (nextError) throw nextError;
        if (!nextReply) {
          throw new Error("fake LLM was called but no reply was armed");
        }
        return nextReply;
      },
    },
  };
  return wrapper;
}

function attachWsClient(): { send: ReturnType<typeof vi.fn>; readyState: number } {
  const ws = { send: vi.fn(), readyState: 1 };
  // The supervisor uses `broadcastAll`, which fans out to ALL registered
  // clients regardless of bucket. addTaskClient with a sentinel id is the
  // cheapest way to get a global subscription in this test.
  wsManager.addTaskClient(999_999, ws);
  return ws;
}

beforeAll(() => setupDb());
afterAll(() => sqlite.close());
beforeEach(() => {
  sqlite.exec("DELETE FROM mission_events; DELETE FROM missions;");
  // Drain WS state between cases so a leftover send mock can't mask a
  // missing broadcast in the next test.
  // @ts-expect-error — internal API we know exists for cleanup.
  wsManager.allClients?.clear?.();
});

describe("supervisor_evaluate — happy path", () => {
  it("LLM returns a proposal → remediation_proposed event + WS broadcast", async () => {
    const id = seedMission({ objective: "Land the launcher CLI" });
    const ws = attachWsClient();
    const fake = makeFakeLLM();
    fake.setReply(
      JSON.stringify({
        kind: "proposal",
        rationale: "test failed because of a flaky timeout — retry once",
        target_type: "task",
        candidate: {
          action: "retry the failing test",
          target_id: "task-42",
          summary: "Re-run the flaky test once more before escalating",
        },
      }),
      { tokens: 120, cents: 7 },
    );

    const svc = new SupervisorService(fake.llm);
    const r = await svc.evaluate(id, {
      kind: "task_observed",
      payload: { task_output: "FAIL — timeout 30s", task_id: 42 },
    });

    expect(fake.calls).toBe(1);

    if (!r.allowed) throw new Error("expected allowed=true");
    expect(r.eventKind).toBe("remediation_proposed");
    expect(r.cost).toEqual({ tokens: 120, cents: 7 });

    // The mission_events row landed with the right shape.
    const events = listEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("remediation_proposed");
    expect(events[0].cost_tokens).toBe(120);
    const payload = JSON.parse(events[0].payload);
    expect(payload.proposal).toEqual({
      target_type: "task",
      candidate: {
        action: "retry the failing test",
        target_id: "task-42",
        summary: "Re-run the flaky test once more before escalating",
      },
    });
    expect(payload.rationale).toBe(
      "test failed because of a flaky timeout — retry once",
    );

    // The broadcast fired exactly once with the documented envelope.
    expect(ws.send).toHaveBeenCalledOnce();
    const msg = JSON.parse(ws.send.mock.calls[0][0]);
    expect(msg.type).toBe(SUPERVISOR_BROADCAST_TYPE);
    expect(msg.missionId).toBe(id);
    expect(msg.kind).toBe("remediation_proposed");
    expect(msg.eventId).toBe(r.eventId);
    expect(msg.depth).toBe(0);
  });

  it("LLM returns a no_action → no_action event + WS broadcast", async () => {
    const id = seedMission();
    const ws = attachWsClient();
    const fake = makeFakeLLM();
    fake.setReply(
      JSON.stringify({
        kind: "no_action",
        rationale: "task output looks on-objective; no remediation needed",
      }),
      { tokens: 20, cents: 1 },
    );

    const svc = new SupervisorService(fake.llm);
    const r = await svc.evaluate(id, {
      kind: "task_observed",
      payload: { task_output: "PASS — all green" },
    });

    if (!r.allowed) throw new Error("expected allowed=true");
    expect(r.eventKind).toBe("no_action");

    const events = listEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("no_action");
    expect(JSON.parse(events[0].payload).rationale).toMatch(/on-objective/);
    expect(JSON.parse(events[0].payload).proposal).toBeUndefined();

    expect(ws.send).toHaveBeenCalledOnce();
    const msg = JSON.parse(ws.send.mock.calls[0][0]);
    expect(msg.kind).toBe("no_action");
  });

  it("threads the trusted mission context into the prompt", async () => {
    const id = seedMission({ objective: "Eliminate flaky tests in CI" });
    attachWsClient();
    const fake = makeFakeLLM();
    fake.setReply(
      JSON.stringify({ kind: "no_action", rationale: "wait for next signal" }),
    );

    const svc = new SupervisorService(fake.llm);
    await svc.evaluate(id, {
      kind: "task_observed",
      payload: { task_output: "FAIL: ECONNREFUSED" },
    });

    expect(fake.lastPrompt).toBeTruthy();
    expect(fake.lastPrompt).toContain("Eliminate flaky tests in CI");
    expect(fake.lastPrompt).toContain(id);
    // The fenced DATA block carries the untrusted output.
    expect(fake.lastPrompt).toContain("FAIL: ECONNREFUSED");
    // And the trigger kind appears in the trusted context section.
    expect(fake.lastPrompt).toContain("task_observed");
  });
});

describe("supervisor_evaluate — heartbeat short-circuit", () => {
  it("heartbeat trigger writes a heartbeat event WITHOUT calling the LLM", async () => {
    const id = seedMission();
    const ws = attachWsClient();
    const fake = makeFakeLLM();
    // Intentionally arm NO reply — a heartbeat that hits the LLM would
    // throw the "no reply armed" error and fail the test.

    const svc = new SupervisorService(fake.llm);
    const r = await svc.evaluate(id, { kind: "heartbeat" });

    expect(fake.calls).toBe(0);
    if (!r.allowed) throw new Error("expected allowed=true");
    expect(r.eventKind).toBe("heartbeat");
    expect(r.cost).toEqual({ tokens: 0, cents: 0 });

    const events = listEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("heartbeat");
    expect(events[0].cost_tokens).toBe(0);

    // Spend stayed at 0.
    const post = sqlite
      .prepare("SELECT spent_tokens, spent_usd_cents FROM missions WHERE id = ?")
      .get(id) as { spent_tokens: number; spent_usd_cents: number };
    expect(post).toEqual({ spent_tokens: 0, spent_usd_cents: 0 });

    // Broadcast still fires for heartbeats — UI cares about liveness too.
    expect(ws.send).toHaveBeenCalledOnce();
    expect(JSON.parse(ws.send.mock.calls[0][0]).kind).toBe("heartbeat");
  });
});

describe("supervisor_evaluate — guard-denied paths never invoke the LLM", () => {
  it("paused mission denies before the LLM runs and skips the broadcast", async () => {
    const id = seedMission({ status: "paused" });
    const ws = attachWsClient();
    const fake = makeFakeLLM();
    // No reply armed — would throw if hit.

    const svc = new SupervisorService(fake.llm);
    const r = await svc.evaluate(id, {
      kind: "task_observed",
      payload: { task_output: "FAIL" },
    });

    expect(fake.calls).toBe(0);
    expect(r.allowed).toBe(false);
    if (r.allowed) return;
    expect(r.reason).toBe("paused");
    expect(listEvents(id)).toHaveLength(0);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("budget-exhausted mission denies before the LLM runs", async () => {
    const id = seedMission({
      budgetTokens: 100,
      spentTokens: 100,
      status: "active",
    });
    const ws = attachWsClient();
    const fake = makeFakeLLM();

    const svc = new SupervisorService(fake.llm);
    const r = await svc.evaluate(id, {
      kind: "task_observed",
      payload: { task_output: "FAIL" },
    });

    expect(fake.calls).toBe(0);
    expect(r.allowed).toBe(false);
    if (r.allowed) return;
    expect(r.reason).toBe("budget_exhausted");
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("depth-exceeded denies before the LLM runs but still records the depth_exceeded row", async () => {
    const id = seedMission();
    const ws = attachWsClient();
    const fake = makeFakeLLM();

    const svc = new SupervisorService(fake.llm);
    const r = await svc.evaluate(id, {
      kind: "remediation",
      payload: { depth: 9, task_id: 7 },
    });

    expect(fake.calls).toBe(0);
    expect(r.allowed).toBe(false);
    if (r.allowed) return;
    expect(r.reason).toBe("depth_exceeded");

    // depth_exceeded IS persisted (the guard's own event), but the
    // supervisor's broadcast is reserved for `allowed=true` results so we
    // don't double-fire alongside BudgetEnforcer's own broadcasts.
    const events = listEvents(id);
    expect(events.map((e) => e.kind)).toEqual(["depth_exceeded"]);
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe("supervisor_evaluate — schema-validation failure", () => {
  it("non-JSON reply downgrades to a no_action event with the parse error captured", async () => {
    const id = seedMission();
    attachWsClient();
    const fake = makeFakeLLM();
    fake.setReply("This is not JSON at all — sorry!", { tokens: 10, cents: 1 });

    const svc = new SupervisorService(fake.llm);
    const r = await svc.evaluate(id, {
      kind: "task_observed",
      payload: { task_output: "..." },
    });

    if (!r.allowed) throw new Error("expected allowed=true");
    expect(r.eventKind).toBe("no_action");

    const events = listEvents(id);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload);
    expect(payload.rationale).toMatch(/schema validation/i);
    expect(payload.parse_error).toMatch(/JSON parse failed/);
    expect(payload.raw_reply).toBe("This is not JSON at all — sorry!");
    // Cost was still incurred — the call HAPPENED.
    expect(events[0].cost_tokens).toBe(10);
  });

  it("zod-failing JSON (e.g. destructive verb) downgrades to no_action", async () => {
    const id = seedMission();
    attachWsClient();
    const fake = makeFakeLLM();
    fake.setReply(
      JSON.stringify({
        kind: "proposal",
        rationale: "remove the failing test entirely",
        target_type: "task",
        // `delete` is on the destructive-verb deny list.
        candidate: { action: "delete the failing test file" },
      }),
      { tokens: 30, cents: 1 },
    );

    const svc = new SupervisorService(fake.llm);
    const r = await svc.evaluate(id, {
      kind: "task_observed",
      payload: { task_output: "FAIL" },
    });

    if (!r.allowed) throw new Error("expected allowed=true");
    expect(r.eventKind).toBe("no_action");
    const payload = JSON.parse(listEvents(id)[0].payload);
    expect(payload.parse_error).toMatch(/destructive verb/i);
  });
});

describe("supervisor_evaluate — missing mission", () => {
  it("propagates the not-found error from BudgetEnforcer.check (LLM never called)", async () => {
    const fake = makeFakeLLM();
    const svc = new SupervisorService(fake.llm);
    await expect(
      svc.evaluate("does-not-exist", { kind: "task_observed" }),
    ).rejects.toThrow(/not found/);
    expect(fake.calls).toBe(0);
  });
});

// ─── Static contract: no plan-creation imports ───
//
// Parent slice §02 invariant: the supervisor PROPOSES — it never CREATES —
// entities. A future refactor that wires plan-store mutators into
// supervisor.ts must fail fast in CI rather than silently shipping. Grep
// the source verbatim (no transpilation, no module cache) so the check
// can't be bypassed by a clever indirection.

describe("supervisor_has_no_import_of_plan_generator_helpers", () => {
  const supervisorPath = join(
    __dirname,
    "..",
    "services",
    "missions",
    "supervisor.ts",
  );
  const source = readFileSync(supervisorPath, "utf-8");

  // The forbidden import targets, by module specifier suffix. We match
  // against the right-hand side of `from "..."` so renamed re-exports
  // through any wrapper module would still trip the check.
  const forbidden = [
    "routes/planning",
    "plan-store/milestones",
    "plan-store/slices",
    "plan-store/tasks",
  ];

  for (const target of forbidden) {
    it(`supervisor.ts does not import from '${target}'`, () => {
      // Match `from "...<target>..."` and `import "...<target>..."`
      // patterns. Tolerates the `.js` extension that ESM-style imports use.
      const re = new RegExp(
        `(?:from|import)\\s+["'][^"']*${target.replace(/[/.]/g, "\\$&")}[^"']*["']`,
      );
      expect(source).not.toMatch(re);
    });
  }

  it("supervisor.ts does not name any plan-creation helper symbols", () => {
    // Belt-and-braces check: even if someone re-exports a creator helper
    // through a neutral barrel, calling its conventional name in
    // supervisor.ts is a code smell worth catching at lint time.
    const forbiddenSymbols = [
      "createMilestone",
      "createSlice",
      "createTask",
      "insertMilestone",
      "insertSlice",
      "insertTask",
    ];
    for (const sym of forbiddenSymbols) {
      expect(source).not.toContain(sym);
    }
  });
});
