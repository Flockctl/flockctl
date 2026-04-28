// SupervisorService — service-level corner-case tests.
//
// The companion to `supervisor-evaluate.test.ts` (which pins the happy
// paths + guard short-circuits + broadcast envelope shape). This file
// focuses on the harder-to-reach corner cases parent slice §02 calls out
// explicitly:
//
//   • malformed_output_retry  — a malformed LLM reply downgrades to
//                               no_action AND does not poison the
//                               supervisor: a follow-up evaluate() with
//                               a well-formed reply succeeds normally.
//   • cold_start              — the very first evaluate() against a
//                               freshly-created mission (no prior
//                               events, spent=0) lands the right kinds
//                               of rows and a coherent post-budget snapshot.
//   • event_truncation_500    — after 500 prior mission_events rows, the
//                               supervisor still evaluates without
//                               replaying the timeline, AND the raw_reply
//                               capture is capped at 2000 chars so a
//                               hostile LLM cannot grow a single row to
//                               gigabytes by replying with junk.
//   • unknown_trigger         — a trigger.kind that is neither `heartbeat`
//                               nor a known kind still routes through the
//                               LLM (only `heartbeat` short-circuits) and
//                               surfaces the trigger_kind in the prompt
//                               + persisted event payload.
//
// Test seam: a fake `SupervisorLLM` adapter — parent slice.md §02
// "tested without mocking the LLM" means we drive at the SupervisorLLM
// boundary the production code already exposes for swap-ability, not
// vi.mock the global fetch. The fake records prompts + counts calls so
// the assertions can pin behavior end-to-end without a real provider.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import Database from "better-sqlite3";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { randomUUID } from "node:crypto";
import * as schema from "../db/schema.js";
import { setDb, type FlockctlDb } from "../db/index.js";
import {
  SupervisorService,
  type SupervisorLLM,
} from "../services/missions/supervisor.js";
import { wsManager } from "../services/ws-manager.js";

let sqlite: BetterSqlite3Database;
let db: FlockctlDb;

// DDL mirrors migrations/0043_add_missions.sql + the bare workspace /
// project tables the FK references require. Inlined (matching
// supervisor-evaluate.test.ts) so this file never depends on the broader
// helpers.ts schema, which doesn't carry the missions tier yet.
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
      overrides.budgetTokens ?? 100_000,
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

function eventCount(missionId: string): number {
  const row = sqlite
    .prepare("SELECT COUNT(*) AS n FROM mission_events WHERE mission_id = ?")
    .get(missionId) as { n: number };
  return row.n;
}

/**
 * Fake SupervisorLLM. Drives the supervisor end-to-end without a real
 * Anthropic round-trip. A queue of replies lets a single test run
 * multiple evaluate() calls back-to-back with different model behavior
 * (used by the malformed_output_retry test).
 */
function makeFakeLLM(): {
  llm: SupervisorLLM;
  calls: number;
  prompts: string[];
  enqueueReply: (text: string, cost?: { tokens: number; cents: number }) => void;
  setError: (err: Error | null) => void;
} {
  const queue: Array<{ text: string; cost: { tokens: number; cents: number } }> = [];
  let nextError: Error | null = null;
  const wrapper = {
    calls: 0,
    prompts: [] as string[],
    enqueueReply(
      text: string,
      cost: { tokens: number; cents: number } = { tokens: 5, cents: 1 },
    ) {
      queue.push({ text, cost });
    },
    setError(err: Error | null) {
      nextError = err;
    },
    llm: {
      async complete(prompt: string) {
        wrapper.calls += 1;
        wrapper.prompts.push(prompt);
        if (nextError) throw nextError;
        const reply = queue.shift();
        if (!reply) {
          throw new Error(
            "fake LLM was called but no reply was enqueued — supervisor may be calling LLM on a heartbeat or running more rounds than the test armed",
          );
        }
        return reply;
      },
    },
  };
  return wrapper;
}

function attachWsClient(): { send: ReturnType<typeof vi.fn>; readyState: number } {
  const ws = { send: vi.fn(), readyState: 1 };
  wsManager.addTaskClient(999_999, ws);
  return ws;
}

beforeAll(() => setupDb());
afterAll(() => sqlite.close());
beforeEach(() => {
  sqlite.exec("DELETE FROM mission_events; DELETE FROM missions;");
  // @ts-expect-error — internal cleanup hook used by other supervisor tests too.
  wsManager.allClients?.clear?.();
});

// ─────────────────────────────────────────────────────────────────────
// supervisor_malformed_output_retry
// ─────────────────────────────────────────────────────────────────────
//
// First evaluate() gets a malformed reply → downgraded to no_action
// (cost still recorded, raw_reply captured). The supervisor must NOT
// be left in a broken state — a second evaluate() with a well-formed
// reply on the same mission must succeed normally and produce its own
// distinct event.
describe("supervisor — malformed output retry", () => {
  it("malformed reply downgrades to no_action; subsequent valid reply succeeds normally", async () => {
    const id = seedMission({ objective: "Land the dashboard" });
    attachWsClient();
    const fake = makeFakeLLM();

    // (1) Garbage reply → no_action with parse_error captured.
    fake.enqueueReply("clearly not JSON {{{", { tokens: 11, cents: 1 });
    // (2) Well-formed reply → genuine remediation_proposed.
    fake.enqueueReply(
      JSON.stringify({
        kind: "proposal",
        rationale: "second attempt parsed cleanly; recommend a retry",
        target_type: "task",
        candidate: { action: "retry the failing test" },
      }),
      { tokens: 22, cents: 2 },
    );

    const svc = new SupervisorService(fake.llm);

    const r1 = await svc.evaluate(id, {
      kind: "task_observed",
      payload: { task_output: "FAIL" },
    });
    if (!r1.allowed) throw new Error("expected first call allowed");
    expect(r1.eventKind).toBe("no_action");
    const ev1 = listEvents(id);
    expect(ev1).toHaveLength(1);
    expect(ev1[0].kind).toBe("no_action");
    const payload1 = JSON.parse(ev1[0].payload);
    expect(payload1.parse_error).toMatch(/JSON parse failed/i);
    // Cost from the failed parse is STILL charged — the call happened.
    expect(ev1[0].cost_tokens).toBe(11);

    const r2 = await svc.evaluate(id, {
      kind: "task_observed",
      payload: { task_output: "FAIL again" },
    });
    if (!r2.allowed) throw new Error("expected second call allowed");
    expect(r2.eventKind).toBe("remediation_proposed");

    // Two events recorded — distinct kinds + distinct cost rows. We
    // don't pin order: both writes land within the same SQL second
    // (`unixepoch()` has 1-second resolution) and the id-tiebreak in
    // listEvents() uses random UUIDs, so the row order is not stable.
    // What matters here is BOTH events are present and the cost split
    // is honoured.
    const ev2 = listEvents(id);
    expect(ev2).toHaveLength(2);
    const kinds = new Set(ev2.map((e) => e.kind));
    expect(kinds).toEqual(new Set(["no_action", "remediation_proposed"]));
    const proposed = ev2.find((e) => e.kind === "remediation_proposed");
    expect(proposed?.cost_tokens).toBe(22);
    const noAction = ev2.find((e) => e.kind === "no_action");
    expect(noAction?.cost_tokens).toBe(11);

    // The mission's running spend reflects BOTH calls — neither was free.
    const post = sqlite
      .prepare("SELECT spent_tokens, spent_usd_cents FROM missions WHERE id = ?")
      .get(id) as { spent_tokens: number; spent_usd_cents: number };
    expect(post.spent_tokens).toBe(33);
    expect(post.spent_usd_cents).toBe(3);
  });

  it("zod-failing JSON also downgrades and does not consume the next queued reply", async () => {
    // Belt-and-braces: the malformed branch covers (a) JSON.parse throws AND
    // (b) zod.safeParse rejects. Both must follow the same single-call,
    // no-retry-loop semantics — the supervisor never silently re-asks the LLM.
    const id = seedMission();
    attachWsClient();
    const fake = makeFakeLLM();
    fake.enqueueReply(
      JSON.stringify({ kind: "totally-unknown-kind", rationale: "x" }),
    );
    // This second reply MUST remain in the queue: the supervisor must not
    // re-call the LLM on its own to "fix" the bad first reply.
    fake.enqueueReply(JSON.stringify({ kind: "no_action", rationale: "fine" }));

    const svc = new SupervisorService(fake.llm);
    const r = await svc.evaluate(id, {
      kind: "task_observed",
      payload: { task_output: "..." },
    });
    if (!r.allowed) throw new Error("expected allowed");
    expect(r.eventKind).toBe("no_action");
    expect(fake.calls).toBe(1); // exactly one round-trip — no internal retry.
  });
});

// ─────────────────────────────────────────────────────────────────────
// supervisor_cold_start
// ─────────────────────────────────────────────────────────────────────
//
// First evaluate() against a freshly-seeded mission. Verifies:
//   - the LLM sees the mission objective + id verbatim in the prompt
//     (cold start means there's no prior context to lean on)
//   - the resulting event lands as the first row in the timeline
//   - the post-call budget snapshot reports the right `remaining`
describe("supervisor — cold start", () => {
  it("first evaluate against a fresh mission produces a coherent first event", async () => {
    const id = seedMission({
      id: "cold-start-mission",
      objective: "Ship v1.0 of the API",
      budgetTokens: 1_000,
      budgetCents: 500,
    });
    attachWsClient();

    // No prior events on the timeline — that's what "cold start" means.
    expect(eventCount(id)).toBe(0);

    const fake = makeFakeLLM();
    fake.enqueueReply(
      JSON.stringify({
        kind: "no_action",
        rationale: "first signal looks clean; no remediation needed yet",
      }),
      { tokens: 50, cents: 3 },
    );

    const svc = new SupervisorService(fake.llm);
    const r = await svc.evaluate(id, {
      kind: "task_observed",
      payload: { task_output: "PASS — clean run" },
    });

    if (!r.allowed) throw new Error("expected cold-start to be allowed");
    expect(r.depth).toBe(0);
    expect(r.eventKind).toBe("no_action");
    // Post-budget reports remaining = budget - spent (1000-50, 500-3).
    expect(r.budget.remaining).toEqual({ tokens: 950, cents: 497 });

    // Exactly one row landed — the cold-start event itself.
    const events = listEvents(id);
    expect(events).toHaveLength(1);

    // Trusted context made it into the prompt (cold-start has no other
    // signal source — the supervisor must lean on the objective).
    const prompt = fake.prompts[0];
    expect(prompt).toContain("cold-start-mission");
    expect(prompt).toContain("Ship v1.0 of the API");
    expect(prompt).toContain("task_observed");
  });
});

// ─────────────────────────────────────────────────────────────────────
// supervisor_event_truncation_500
// ─────────────────────────────────────────────────────────────────────
//
// Two distinct truncation contracts collapsed into one suite:
//
//   (a) After 500 prior mission_events rows, evaluate() must NOT replay
//       the timeline back into the prompt. The supervisor's design
//       (supervisor-prompt.ts) only forwards the trusted context + the
//       trigger's task_output — a 500-event timeline must not bloat
//       prompt size or call latency.
//
//   (b) raw_reply captured on parse_error is sliced to ≤ 2000 chars so
//       a hostile LLM cannot turn a single mission_events row into a
//       gigabyte payload by replying with junk.
describe("supervisor — 500-event truncation", () => {
  it("evaluate against a mission with 500 prior events does not replay the timeline into the prompt", async () => {
    const id = seedMission({ objective: "Stabilize the build" });
    attachWsClient();

    // Pre-load 500 prior mission_events rows — synthetic but realistic
    // shape (no_action is on the kind allowlist).
    const insert = sqlite.prepare(
      `INSERT INTO mission_events (id, mission_id, kind, payload, cost_tokens, cost_usd_cents, depth)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const inflate = sqlite.transaction(() => {
      for (let i = 0; i < 500; i += 1) {
        insert.run(
          randomUUID(),
          id,
          "no_action",
          JSON.stringify({ rationale: `prior event #${i}`, marker: `EVT-${i}` }),
          0,
          0,
          0,
        );
      }
    });
    inflate();
    expect(eventCount(id)).toBe(500);

    const fake = makeFakeLLM();
    fake.enqueueReply(
      JSON.stringify({ kind: "no_action", rationale: "still on objective" }),
      { tokens: 7, cents: 0 },
    );

    const svc = new SupervisorService(fake.llm);
    const r = await svc.evaluate(id, {
      kind: "task_observed",
      payload: { task_output: "PASS" },
    });
    if (!r.allowed) throw new Error("expected allowed");

    // The prompt must NOT carry any of the 500 prior event markers — the
    // supervisor's prompt builder only sees the current trigger.
    const prompt = fake.prompts[0];
    expect(prompt).not.toMatch(/EVT-0\b/);
    expect(prompt).not.toMatch(/EVT-499\b/);
    // Sanity: the prompt is not pathologically large (well under 10 KB
    // for a single trigger). This is a soft signal — the real point is
    // that the timeline rows do not appear at all.
    expect(prompt.length).toBeLessThan(10_000);

    // Timeline grew by exactly one — the new evaluate's no_action.
    expect(eventCount(id)).toBe(501);
  });

  it("raw_reply is capped at 2000 chars on parse_error to defend against junk-reply bloat", async () => {
    const id = seedMission();
    attachWsClient();

    // 5000 chars of garbage → not JSON → captured into payload.raw_reply
    // by the supervisor. The cap is 2000.
    const giant = "x".repeat(5000);
    const fake = makeFakeLLM();
    fake.enqueueReply(giant, { tokens: 1, cents: 0 });

    const svc = new SupervisorService(fake.llm);
    const r = await svc.evaluate(id, {
      kind: "task_observed",
      payload: { task_output: "PASS" },
    });
    if (!r.allowed) throw new Error("expected allowed");
    expect(r.eventKind).toBe("no_action");

    const events = listEvents(id);
    const payload = JSON.parse(events[0].payload);
    expect(typeof payload.raw_reply).toBe("string");
    expect(payload.raw_reply.length).toBeLessThanOrEqual(2000);
    expect(payload.raw_reply).toBe(giant.slice(0, 2000));
  });
});

// ─────────────────────────────────────────────────────────────────────
// supervisor_unknown_trigger
// ─────────────────────────────────────────────────────────────────────
//
// The supervisor's trigger.kind is an open set (see MissionTrigger
// definition — `kind: string`). Only `heartbeat` short-circuits. Any
// other kind — known (`task_observed`, `remediation`) or unknown
// (anything else) — must route through the LLM and surface the
// trigger_kind in both the prompt context and the persisted event
// payload, so an operator scanning the timeline can tell what woke
// the supervisor up.
describe("supervisor — unknown trigger kind", () => {
  it("an unknown trigger kind still calls the LLM and records trigger_kind on the event", async () => {
    const id = seedMission();
    attachWsClient();
    const fake = makeFakeLLM();
    fake.enqueueReply(
      JSON.stringify({
        kind: "no_action",
        rationale: "unknown trigger received; choosing to wait",
      }),
    );

    const svc = new SupervisorService(fake.llm);
    const r = await svc.evaluate(id, {
      kind: "operator_signalled_unusual_thing",
      payload: { task_output: "manual nudge" },
    });
    if (!r.allowed) throw new Error("expected allowed");
    expect(fake.calls).toBe(1);
    expect(r.eventKind).toBe("no_action");

    // trigger_kind threaded into both the prompt and the persisted event.
    expect(fake.prompts[0]).toContain("operator_signalled_unusual_thing");

    const events = listEvents(id);
    const payload = JSON.parse(events[0].payload);
    expect(payload.trigger_kind).toBe("operator_signalled_unusual_thing");
  });

  it("an unknown trigger that omits payload entirely still routes through the LLM", async () => {
    // Defensive: the prompt builder must not crash when payload is
    // absent — readTaskOutput coerces a missing `task_output` to an
    // empty string. Pin that behavior here so a future refactor that
    // tightens the trigger contract has to update this test.
    const id = seedMission();
    attachWsClient();
    const fake = makeFakeLLM();
    fake.enqueueReply(
      JSON.stringify({ kind: "no_action", rationale: "no payload supplied" }),
    );

    const svc = new SupervisorService(fake.llm);
    const r = await svc.evaluate(id, { kind: "tab_closed_by_user" });
    if (!r.allowed) throw new Error("expected allowed");
    expect(r.eventKind).toBe("no_action");

    // Empty fenced data block still rendered (the prompt structure is
    // preserved even when task_output is empty).
    expect(fake.prompts[0]).toContain("```data\n\n```");
  });
});
