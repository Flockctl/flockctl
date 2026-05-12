// ─── objective_met termination decision ───
//
// End-to-end coverage for the new `objective_met` supervisor decision
// added in supervisor-prompt v1.1.0:
//
//   • zod schema accepts `{kind: "objective_met", summary: ...}`
//   • SupervisorService.evaluate emits a `mission_events.kind='objective_met'`
//     row carrying the summary as payload
//   • The mission row transitions from `status='active'` to
//     `status='completed'` on success, idempotently
//   • The transition is gated on `WHERE status = 'active'` so the
//     supervisor cannot overwrite an operator-paused / aborted /
//     failed mission back into completed
//   • Schema rejects too-short / too-long summaries → degrades to
//     no_action with parse_error captured
//
// Plus a static prompt/schema consistency assertion that catches the
// pre-v1.1.0 drift bug: the rendered prompt MUST instruct the model in
// the same dialect the schema validates against. A change to one without
// the other will fail this test before it ever reaches a real LLM.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import Database from "better-sqlite3";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { setDb, type FlockctlDb } from "../db/index.js";
import {
  SupervisorService,
  type SupervisorLLM,
} from "../services/missions/supervisor.js";
import {
  buildSupervisorPrompt,
  SUPERVISOR_PROMPT_VERSION,
} from "../services/missions/supervisor-prompt.js";
import {
  supervisorOutputSchema,
  objectiveMetSchema,
} from "../services/missions/proposal-schema.js";

let sqlite: BetterSqlite3Database;
let db: FlockctlDb;

// Same inlined DDL used by `supervisor.test.ts` — kept in lockstep with
// `migrations/0043_add_missions.sql`.
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
      CONSTRAINT missions_budget_tokens_check CHECK (budget_tokens > 0),
      CONSTRAINT missions_budget_usd_cents_check CHECK (budget_usd_cents > 0)
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

function seedMission(status: "active" | "paused" = "active"): string {
  const id = `m-${Math.random().toString(36).slice(2, 10)}`;
  sqlite
    .prepare(
      `INSERT INTO missions
         (id, project_id, objective, status, autonomy,
          budget_tokens, budget_usd_cents,
          spent_tokens, spent_usd_cents,
          supervisor_prompt_version)
       VALUES (?, 1, 'objective text', ?, 'suggest', 100000, 50000, 0, 0, 'v1')`,
    )
    .run(id, status);
  return id;
}

function readMissionStatus(id: string): string {
  const row = sqlite
    .prepare("SELECT status FROM missions WHERE id = ?")
    .get(id) as { status: string } | undefined;
  if (!row) throw new Error("mission not found");
  return row.status;
}

interface EventRow {
  kind: string;
  payload: string;
  cost_tokens: number;
  cost_usd_cents: number;
}

function listEvents(missionId: string): EventRow[] {
  return sqlite
    .prepare(
      "SELECT kind, payload, cost_tokens, cost_usd_cents FROM mission_events WHERE mission_id = ? ORDER BY created_at, id",
    )
    .all(missionId) as EventRow[];
}

function makeFakeLLM(text: string, tokens = 7, cents = 1): SupervisorLLM {
  return {
    async complete() {
      return { text, cost: { tokens, cents } };
    },
  };
}

beforeAll(() => setupDb());
afterAll(() => sqlite.close());
beforeEach(() => {
  sqlite.exec("DELETE FROM mission_events; DELETE FROM missions;");
});

// ─────────────────────────────────────────────────────────────────────
// Schema-level coverage
// ─────────────────────────────────────────────────────────────────────

describe("objective_met schema", () => {
  it("accepts a well-formed objective_met reply", () => {
    const result = supervisorOutputSchema.safeParse({
      kind: "objective_met",
      summary: "All audit criteria satisfied; no duplicates remain in src/",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a summary shorter than 10 chars", () => {
    const result = objectiveMetSchema.safeParse({
      kind: "objective_met",
      summary: "too short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a summary longer than 4000 chars", () => {
    const result = objectiveMetSchema.safeParse({
      kind: "objective_met",
      summary: "x".repeat(4001),
    });
    expect(result.success).toBe(false);
  });

  it("supervisorOutputSchema discriminates objective_met from no_action / proposal", () => {
    const ok = supervisorOutputSchema.safeParse({
      kind: "objective_met",
      summary: "objective is satisfied per the audit",
    });
    if (!ok.success) throw new Error("expected parse to succeed");
    expect(ok.data.kind).toBe("objective_met");
  });
});

// ─────────────────────────────────────────────────────────────────────
// SupervisorService end-to-end
// ─────────────────────────────────────────────────────────────────────

describe("SupervisorService — objective_met", () => {
  it("emits objective_met event AND transitions mission to completed", async () => {
    const id = seedMission("active");
    const fake = makeFakeLLM(
      JSON.stringify({
        kind: "objective_met",
        summary: "all duplicates resolved; audit reports zero matches",
      }),
      42,
      3,
    );
    const svc = new SupervisorService(fake);

    const r = await svc.evaluate(id, {
      kind: "task_observed",
      payload: { task_output: "audit clean" },
    });

    if (!r.allowed) throw new Error("expected allowed");
    expect(r.eventKind).toBe("objective_met");

    const events = listEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("objective_met");
    expect(events[0].cost_tokens).toBe(42);
    expect(events[0].cost_usd_cents).toBe(3);
    const payload = JSON.parse(events[0].payload);
    expect(payload.summary).toBe(
      "all duplicates resolved; audit reports zero matches",
    );

    expect(readMissionStatus(id)).toBe("completed");
  });

  it("does NOT mutate status if the mission is no longer active when the UPDATE runs", async () => {
    // Setup a small race against the WHERE status='active' guard. We can't
    // truly race a single-threaded SQLite transaction, but we CAN seed a
    // paused mission and feed an objective_met reply: BudgetEnforcer.check
    // denies up front so the LLM call never happens. The reply queue stays
    // primed but no UPDATE fires — status stays 'paused'. This pins the
    // kill-switch + WHERE-status guard interaction.
    const id = seedMission("paused");
    const fake = makeFakeLLM(
      JSON.stringify({
        kind: "objective_met",
        summary: "should never be observed because mission is paused",
      }),
    );
    const svc = new SupervisorService(fake);

    const r = await svc.evaluate(id, {
      kind: "task_observed",
      payload: { task_output: "anything" },
    });

    expect(r.allowed).toBe(false);
    if (r.allowed) throw new Error("unreachable");
    expect(r.reason).toBe("paused");
    expect(readMissionStatus(id)).toBe("paused"); // unchanged
    expect(listEvents(id)).toHaveLength(0); // no objective_met row written
  });

  it("a too-short summary degrades to no_action with parse_error captured", async () => {
    const id = seedMission("active");
    const fake = makeFakeLLM(
      JSON.stringify({ kind: "objective_met", summary: "too short" }),
    );
    const svc = new SupervisorService(fake);

    const r = await svc.evaluate(id, {
      kind: "task_observed",
      payload: { task_output: "noise" },
    });

    if (!r.allowed) throw new Error("expected allowed");
    expect(r.eventKind).toBe("no_action");
    expect(readMissionStatus(id)).toBe("active"); // schema reject → no transition

    const events = listEvents(id);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload);
    expect(payload.parse_error).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Prompt ↔ schema consistency
// ─────────────────────────────────────────────────────────────────────
//
// Pins the dialect drift bug fixed in v1.1.0: the rendered prompt MUST
// describe the same JSON shape that `supervisorOutputSchema` validates.
// A future edit to either side that breaks parity should fail HERE before
// hitting a real-LLM round-trip and degrading every reply to no_action.

describe("supervisor prompt v1.1.0 — schema dialect parity", () => {
  const prompt = buildSupervisorPrompt({
    missionId: "00000000-0000-0000-0000-000000000000",
    missionObjective: "OBJ",
    triggerKind: "task_observed",
    taskOutput: "OUT",
  });

  it("renders the active prompt version inline", () => {
    expect(prompt).toContain(SUPERVISOR_PROMPT_VERSION);
  });

  it("instructs the model in the schema's dialect (kind / rationale / target_type / candidate)", () => {
    expect(prompt).toContain('"kind"');
    expect(prompt).toContain('"rationale"');
    expect(prompt).toContain('"target_type"');
    expect(prompt).toContain('"candidate"');
  });

  it("names the three schema variants (proposal / no_action / objective_met)", () => {
    expect(prompt).toContain('"proposal"');
    expect(prompt).toContain('"no_action"');
    expect(prompt).toContain('"objective_met"');
  });

  it("does NOT use the pre-v1.1.0 `decision` field name (would fail schema parse)", () => {
    // Note: `decision` could legitimately appear inside the mission objective
    // text. The check is on the *instruction line* — the rendered prompt
    // must not have `"decision"` as a JSON-style instruction key.
    expect(prompt).not.toContain('"decision"');
  });

  it("warns the model that destructive verbs in candidate.action are rejected", () => {
    expect(prompt.toLowerCase()).toContain("destructive");
  });
});
