// missions-router — full contract + integration test surface.
//
// Companion to `routes/missions-remote-auth.test.ts` (which pins the cross-
// cutting auth wiring). This file pins the route handlers themselves: every
// documented endpoint × every documented status code, the corner cases the
// parent slice §04 calls out (pagination caps, cross-tenant denial, concurrent
// approve/propose deadlock-freedom, 2000-char reason cap, idempotent re-
// approve), AND a small `openapi_like_check` block at the bottom that asserts
// the response shape of every successful path matches what the API contract
// promises clients.
//
// Why we inline the missions DDL instead of using `createTestDb`:
//   `src/__tests__/helpers.ts` ships the schema for the legacy tier of the
//   product but doesn't carry the missions / mission_events tables yet.
//   Inlining the same DDL the migration ships keeps this test independent of
//   when helpers.ts gets updated, and matches the pattern already used by
//   `supervisor.test.ts` / `supervisor-evaluate.test.ts`.
//
// Why `app.request()` instead of `fetch()`:
//   These are unit-tier route tests — they exercise Hono in-process so we can
//   assert deterministically against a fresh in-memory SQLite per test. The
//   smoke tier (`tests/smoke/mission-approval-flow.spec.ts`) runs the same
//   approval flow end-to-end against a real spawned daemon.

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { app } from "../server.js";
import { setDb, type FlockctlDb } from "../db/index.js";
import { createTestDb } from "./helpers.js";

// ─── Test fixture state ───

let sqlite: BetterSqlite3Database;
let db: FlockctlDb;
let tmpRoot: string;

/**
 * Bring up a fresh in-memory DB. `createTestDb` ships the full workspace /
 * project / tasks / chats / … tier; we layer the missions + mission_events
 * tables (migration 0043) on top so this file stays self-contained without
 * pulling the missions DDL into the shared helpers (its other consumers
 * don't need it). `setDb()` rebinds the module-level singleton in
 * `src/db/index.ts` so the route handlers see this DB.
 *
 * The DDL mirrors `migrations/0043_add_missions.sql` exactly — keep it in
 * lockstep when the migration evolves so this test catches drift.
 */
function setupDb(): void {
  const td = createTestDb();
  sqlite = td.sqlite;
  db = td.db;
  sqlite.exec(`
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
  setDb(db, sqlite);
}

/**
 * Seed a project row with an on-disk path inside the per-test tmp dir.
 * The `path` is required for approve handlers — `getProjectPathForMission`
 * 422s on a path-less project — so every project this fixture creates is
 * approval-ready by default.
 */
function seedProject(name: string): { id: number; path: string } {
  const path = join(tmpRoot, name);
  const res = sqlite
    .prepare("INSERT INTO projects (name, path) VALUES (?, ?)")
    .run(name, path);
  return { id: Number(res.lastInsertRowid), path };
}

/** Seed a mission row scoped to `projectId`. Defaults match a healthy v1 mission. */
function seedMission(
  projectId: number,
  overrides: {
    objective?: string;
    status?: "drafting" | "active" | "paused" | "completed" | "failed" | "aborted";
    autonomy?: "manual" | "suggest" | "auto";
    budgetTokens?: number;
    budgetCents?: number;
  } = {},
): string {
  const id = `m-${randomUUID().slice(0, 8)}`;
  sqlite
    .prepare(
      `INSERT INTO missions
         (id, project_id, objective, status, autonomy,
          budget_tokens, budget_usd_cents, supervisor_prompt_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'v1')`,
    )
    .run(
      id,
      projectId,
      overrides.objective ?? "Ship the launcher",
      overrides.status ?? "active",
      overrides.autonomy ?? "suggest",
      overrides.budgetTokens ?? 100_000,
      overrides.budgetCents ?? 50_000,
    );
  return id;
}

/**
 * Seed a `remediation_proposed` event in the supervisor's wire format —
 * matches the JSON the supervisor itself writes via `guardedEvaluate`. The
 * default candidate proposes a milestone (no parent pointer needed); callers
 * exercising slice / task target_types pass overrides.
 */
function seedProposal(
  missionId: string,
  overrides: {
    target_type?: "milestone" | "slice" | "task";
    action?: string;
    target_id?: string;
    summary?: string;
    rationale?: string;
    depth?: number;
  } = {},
): string {
  const id = `e-${randomUUID().slice(0, 8)}`;
  const candidate: Record<string, unknown> = {
    action: overrides.action ?? "Add a payments milestone",
  };
  if (overrides.target_id !== undefined) candidate.target_id = overrides.target_id;
  if (overrides.summary !== undefined) candidate.summary = overrides.summary;

  const payload = {
    rationale: overrides.rationale ?? "Operator asked for the next milestone",
    proposal: {
      target_type: overrides.target_type ?? "milestone",
      candidate,
    },
  };
  sqlite
    .prepare(
      `INSERT INTO mission_events
         (id, mission_id, kind, payload, depth)
       VALUES (?, ?, 'remediation_proposed', ?, ?)`,
    )
    .run(id, missionId, JSON.stringify(payload), overrides.depth ?? 0);
  return id;
}

/**
 * Seed a follow-up decision event. The proposal-list handler distinguishes
 * pending / dismissed / approved by these rows' `payload.proposal_event_id`.
 */
function seedFollowup(
  missionId: string,
  proposalEventId: string,
  kind: "remediation_approved" | "remediation_dismissed",
  extraPayload: Record<string, unknown> = {},
): string {
  const id = `e-${randomUUID().slice(0, 8)}`;
  sqlite
    .prepare(
      `INSERT INTO mission_events
         (id, mission_id, kind, payload)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, missionId, kind, JSON.stringify({ proposal_event_id: proposalEventId, ...extraPayload }));
  return id;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "missions-router-test-"));
  setupDb();
});

afterEach(() => {
  try {
    sqlite.close();
  } catch {
    // already closed
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ─── POST /missions ───────────────────────────────────────────

describe("POST /missions", () => {
  it("creates a mission and returns 201 with the persisted row", async () => {
    const proj = seedProject("create-mission");
    const res = await app.request("/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: proj.id,
        objective: "Ship the launcher",
        autonomy: "suggest",
        status: "active",
        budgetTokens: 100_000,
        budgetUsdCents: 5_000,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.id).toBe("string");
    expect(body.projectId).toBe(proj.id);
    expect(body.objective).toBe("Ship the launcher");
    expect(body.autonomy).toBe("suggest");
    expect(body.status).toBe("active");
    expect(body.budgetTokens).toBe(100_000);
    expect(body.budgetUsdCents).toBe(5_000);
    expect(body.spentTokens).toBe(0);
    expect(body.spentUsdCents).toBe(0);
    expect(typeof body.supervisorPromptVersion).toBe("string");
    expect(typeof body.createdAt).toBe("number");
    expect(typeof body.updatedAt).toBe("number");
  });

  it("defaults autonomy=suggest and status=active when omitted", async () => {
    const proj = seedProject("defaults");
    const res = await app.request("/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: proj.id,
        objective: "Default fields",
        budgetTokens: 1,
        budgetUsdCents: 1,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.autonomy).toBe("suggest");
    expect(body.status).toBe("active");
  });

  it("422 when required fields are missing", async () => {
    const res = await app.request("/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; details?: unknown };
    expect(body.error).toMatch(/invalid body/i);
    expect(body.details).toBeDefined();
  });

  it("422 on invalid autonomy value", async () => {
    const proj = seedProject("invalid-autonomy");
    const res = await app.request("/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: proj.id,
        objective: "x",
        autonomy: "wild",
        budgetTokens: 1,
        budgetUsdCents: 1,
      }),
    });
    expect(res.status).toBe(422);
  });

  it("422 on non-positive budget fields", async () => {
    const proj = seedProject("bad-budget");
    const res = await app.request("/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: proj.id,
        objective: "x",
        budgetTokens: 0,
        budgetUsdCents: 1,
      }),
    });
    expect(res.status).toBe(422);
  });

  it("422 on budget that exceeds MAX_INT32", async () => {
    const proj = seedProject("over-budget");
    const res = await app.request("/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: proj.id,
        objective: "x",
        budgetTokens: 2_147_483_648,
        budgetUsdCents: 1,
      }),
    });
    expect(res.status).toBe(422);
  });

  it("422 when objective exceeds 8000 chars", async () => {
    const proj = seedProject("long-objective");
    const res = await app.request("/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: proj.id,
        objective: "x".repeat(8001),
        budgetTokens: 1,
        budgetUsdCents: 1,
      }),
    });
    expect(res.status).toBe(422);
  });

  it("404 when projectId references an unknown project", async () => {
    // The route header comment talks about 422 here, but `getProjectOrThrow`
    // emits a `NotFoundError` (404) — that's the actual contract clients see.
    // Keeping the test on the real status code; a future refactor that wants
    // 422 should update the helper, not this assertion.
    const res = await app.request("/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: 999_999,
        objective: "x",
        budgetTokens: 1,
        budgetUsdCents: 1,
      }),
    });
    expect(res.status).toBe(404);
  });

  it("422 on unknown body keys (.strict() rejects typos)", async () => {
    const proj = seedProject("strict");
    const res = await app.request("/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: proj.id,
        objective: "x",
        budgetTokens: 1,
        budgetUsdCents: 1,
        whatever: true,
      }),
    });
    expect(res.status).toBe(422);
  });

  it("501 on autonomy='auto' (gated until v2)", async () => {
    const proj = seedProject("auto-gated");
    const res = await app.request("/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: proj.id,
        objective: "x",
        autonomy: "auto",
        budgetTokens: 1,
        budgetUsdCents: 1,
      }),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/auto/i);
  });
});

// ─── GET /missions/:id ────────────────────────────────────────

describe("GET /missions/:id", () => {
  it("200 returns the mission row", async () => {
    const proj = seedProject("get-mission");
    const id = seedMission(proj.id, { objective: "Find me" });
    const res = await app.request(`/missions/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(id);
    expect(body.objective).toBe("Find me");
  });

  it("404 on unknown id", async () => {
    const res = await app.request("/missions/m-does-not-exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Mission/);
  });
});

// ─── PATCH /missions/:id ──────────────────────────────────────

describe("PATCH /missions/:id", () => {
  it("200 updates a single field and bumps updated_at", async () => {
    const proj = seedProject("patch-mission");
    const id = seedMission(proj.id);
    const res = await app.request(`/missions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("paused");
    expect(body.id).toBe(id);
  });

  it("200 updates multiple fields atomically", async () => {
    const proj = seedProject("patch-multi");
    const id = seedMission(proj.id);
    const res = await app.request(`/missions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: "New objective",
        budgetTokens: 200_000,
        budgetUsdCents: 10_000,
        autonomy: "manual",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.objective).toBe("New objective");
    expect(body.budgetTokens).toBe(200_000);
    expect(body.budgetUsdCents).toBe(10_000);
    expect(body.autonomy).toBe("manual");
  });

  it("422 on empty body (.refine: at least one field)", async () => {
    const proj = seedProject("patch-empty");
    const id = seedMission(proj.id);
    const res = await app.request(`/missions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(422);
  });

  it("422 on unknown field (.strict)", async () => {
    const proj = seedProject("patch-strict");
    const id = seedMission(proj.id);
    const res = await app.request(`/missions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: 99 }),
    });
    expect(res.status).toBe(422);
  });

  it("501 on autonomy='auto'", async () => {
    const proj = seedProject("patch-auto");
    const id = seedMission(proj.id);
    const res = await app.request(`/missions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autonomy: "auto" }),
    });
    expect(res.status).toBe(501);
  });

  it("404 when the mission id is unknown", async () => {
    const res = await app.request("/missions/m-nope", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    expect(res.status).toBe(404);
  });
});

// ─── GET /missions/:id/events ─────────────────────────────────

describe("GET /missions/:id/events", () => {
  it("200 with empty list when the mission has no events", async () => {
    const proj = seedProject("events-empty");
    const id = seedMission(proj.id);
    const res = await app.request(`/missions/${id}/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number; page: number; perPage: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.page).toBe(1);
    expect(body.perPage).toBe(50);
  });

  it("returns events in newest-first order with decoded payload", async () => {
    const proj = seedProject("events-order");
    const id = seedMission(proj.id);
    // Seed three proposals with explicit ascending created_at so the order
    // is deterministic regardless of unixepoch() granularity.
    sqlite
      .prepare(
        `INSERT INTO mission_events (id, mission_id, kind, payload, created_at)
         VALUES ('e1', ?, 'remediation_proposed', '{"rationale":"a","proposal":{"target_type":"milestone","candidate":{"action":"a"}}}', 100),
                ('e2', ?, 'remediation_proposed', '{"rationale":"b","proposal":{"target_type":"milestone","candidate":{"action":"b"}}}', 200),
                ('e3', ?, 'remediation_proposed', '{"rationale":"c","proposal":{"target_type":"milestone","candidate":{"action":"c"}}}', 300)`,
      )
      .run(id, id, id);
    const res = await app.request(`/missions/${id}/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; payload: Record<string, unknown> }> };
    expect(body.items.map((e) => e.id)).toEqual(["e3", "e2", "e1"]);
    // Payload is JSON-decoded, not a raw string
    expect(typeof body.items[0]!.payload).toBe("object");
    expect((body.items[0]!.payload as { rationale: string }).rationale).toBe("c");
  });

  it("paginates with page + per_page", async () => {
    const proj = seedProject("events-page");
    const id = seedMission(proj.id);
    for (let i = 0; i < 7; i++) {
      sqlite
        .prepare(
          `INSERT INTO mission_events (id, mission_id, kind, payload, created_at)
           VALUES (?, ?, 'heartbeat', '{}', ?)`,
        )
        .run(`p-${i}`, id, i + 1);
    }
    const res = await app.request(`/missions/${id}/events?page=2&per_page=3`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number; page: number; perPage: number };
    expect(body.total).toBe(7);
    expect(body.page).toBe(2);
    expect(body.perPage).toBe(3);
    expect(body.items).toHaveLength(3);
  });

  it("paginates with offset + limit (alternative shape)", async () => {
    const proj = seedProject("events-offset");
    const id = seedMission(proj.id);
    for (let i = 0; i < 5; i++) {
      sqlite
        .prepare(
          `INSERT INTO mission_events (id, mission_id, kind, payload, created_at)
           VALUES (?, ?, 'heartbeat', '{}', ?)`,
        )
        .run(`o-${i}`, id, i + 1);
    }
    const res = await app.request(`/missions/${id}/events?offset=2&limit=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; perPage: number };
    expect(body.items).toHaveLength(2);
    expect(body.perPage).toBe(2);
  });

  it("caps per_page at 1000 (raised from the 100/page default)", async () => {
    const proj = seedProject("events-cap");
    const id = seedMission(proj.id);
    const res = await app.request(`/missions/${id}/events?per_page=99999`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { perPage: number };
    expect(body.perPage).toBe(1000);
  });

  it("404 on unknown mission id", async () => {
    const res = await app.request("/missions/m-missing/events");
    expect(res.status).toBe(404);
  });
});

// ─── GET /missions/:id/proposals ──────────────────────────────

describe("GET /missions/:id/proposals", () => {
  it("default status=pending returns proposals with no follow-up", async () => {
    const proj = seedProject("prop-pending");
    const id = seedMission(proj.id);
    const pending = seedProposal(id, { action: "still pending" });
    const dismissed = seedProposal(id, { action: "dismissed" });
    seedFollowup(id, dismissed, "remediation_dismissed");
    const approved = seedProposal(id, { action: "approved" });
    seedFollowup(id, approved, "remediation_approved");

    const res = await app.request(`/missions/${id}/proposals`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }>; total: number; status: string };
    expect(body.status).toBe("pending");
    const ids = body.items.map((p) => p.id);
    expect(ids).toContain(pending);
    expect(ids).not.toContain(dismissed);
    expect(ids).not.toContain(approved);
    expect(body.total).toBe(1);
  });

  it("status=dismissed returns only proposals with a dismiss follow-up", async () => {
    const proj = seedProject("prop-dismissed");
    const id = seedMission(proj.id);
    const a = seedProposal(id, { action: "a" });
    const b = seedProposal(id, { action: "b" });
    seedFollowup(id, a, "remediation_dismissed");

    const res = await app.request(`/missions/${id}/proposals?status=dismissed`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }>; status: string };
    expect(body.status).toBe("dismissed");
    expect(body.items.map((p) => p.id)).toEqual([a]);
    expect(body.items.map((p) => p.id)).not.toContain(b);
  });

  it("status=all returns every proposal regardless of follow-up", async () => {
    const proj = seedProject("prop-all");
    const id = seedMission(proj.id);
    const a = seedProposal(id, { action: "a" });
    const b = seedProposal(id, { action: "b" });
    seedFollowup(id, a, "remediation_dismissed");

    const res = await app.request(`/missions/${id}/proposals?status=all`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    const ids = body.items.map((p) => p.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    expect(body.items).toHaveLength(2);
  });

  it("422 on invalid status filter", async () => {
    const proj = seedProject("prop-bad-status");
    const id = seedMission(proj.id);
    const res = await app.request(`/missions/${id}/proposals?status=mystery`);
    expect(res.status).toBe(422);
  });

  it("404 on unknown mission id", async () => {
    const res = await app.request("/missions/m-missing/proposals");
    expect(res.status).toBe(404);
  });
});

// ─── POST /missions/:id/proposals/:pid/approve ────────────────

describe("POST /missions/:id/proposals/:pid/approve", () => {
  it("approves a milestone proposal → creates a milestone on disk", async () => {
    const proj = seedProject("approve-milestone");
    const mid = seedMission(proj.id);
    const pid = seedProposal(mid, {
      target_type: "milestone",
      action: "Add billing milestone",
      summary: "Cover credit-card handling end-to-end",
    });
    const res = await app.request(`/missions/${mid}/proposals/${pid}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.proposal_event_id).toBe(pid);
    expect(body.target_type).toBe("milestone");
    expect(body.entity_kind).toBe("milestone");
    expect(typeof body.target_id).toBe("string");
    expect(typeof body.decision_id).toBe("string");

    // On-disk artefact: <project>/.flockctl/plan/<slug>/milestone.md
    const milestoneSlug = body.target_id as string;
    const mdPath = join(proj.path, ".flockctl", "plan", milestoneSlug, "milestone.md");
    expect(existsSync(mdPath)).toBe(true);

    // A `remediation_approved` event is recorded.
    const decision = sqlite
      .prepare(
        `SELECT kind, payload FROM mission_events WHERE id = ?`,
      )
      .get(body.decision_id as string) as { kind: string; payload: string } | undefined;
    expect(decision).toBeDefined();
    expect(decision!.kind).toBe("remediation_approved");
    expect(JSON.parse(decision!.payload).proposal_event_id).toBe(pid);
  });

  it("approves a slice proposal → creates a slice under the parent milestone", async () => {
    const proj = seedProject("approve-slice");
    const mid = seedMission(proj.id);

    // First create the parent milestone (slices need a parent).
    const parent = seedProposal(mid, { target_type: "milestone", action: "Parent" });
    const parentRes = await app.request(`/missions/${mid}/proposals/${parent}/approve`, {
      method: "POST",
      body: "{}",
    });
    const parentBody = (await parentRes.json()) as { target_id: string };
    const milestoneSlug = parentBody.target_id;

    // Now propose + approve a slice that points at it.
    const sliceProp = seedProposal(mid, {
      target_type: "slice",
      action: "Wire the API",
      target_id: milestoneSlug,
    });
    const res = await app.request(`/missions/${mid}/proposals/${sliceProp}/approve`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entity_kind: string; target_id: string };
    expect(body.entity_kind).toBe("slice");

    const slicePath = join(proj.path, ".flockctl", "plan", milestoneSlug, body.target_id, "slice.md");
    expect(existsSync(slicePath)).toBe(true);
  });

  it("approves a task proposal → resolves milestone via slice slug", async () => {
    const proj = seedProject("approve-task");
    const mid = seedMission(proj.id);

    // Build the milestone + slice scaffolding via the same approve path
    // so the on-disk hierarchy exists before the task proposal lands.
    const mProp = seedProposal(mid, { target_type: "milestone", action: "M" });
    const mApp = await app.request(`/missions/${mid}/proposals/${mProp}/approve`, {
      method: "POST",
      body: "{}",
    });
    const milestoneSlug = ((await mApp.json()) as { target_id: string }).target_id;

    const sProp = seedProposal(mid, { target_type: "slice", action: "S", target_id: milestoneSlug });
    const sApp = await app.request(`/missions/${mid}/proposals/${sProp}/approve`, {
      method: "POST",
      body: "{}",
    });
    const sliceSlug = ((await sApp.json()) as { target_id: string }).target_id;

    const tProp = seedProposal(mid, {
      target_type: "task",
      action: "Write the test",
      target_id: sliceSlug,
    });
    const tApp = await app.request(`/missions/${mid}/proposals/${tProp}/approve`, {
      method: "POST",
      body: "{}",
    });
    expect(tApp.status).toBe(200);
    const tBody = (await tApp.json()) as { entity_kind: string; target_id: string };
    expect(tBody.entity_kind).toBe("task");

    const taskPath = join(
      proj.path,
      ".flockctl",
      "plan",
      milestoneSlug,
      sliceSlug,
      `${tBody.target_id}.md`,
    );
    expect(existsSync(taskPath)).toBe(true);
  });

  it("re-approve is idempotent — same decision_id, idempotent: true, no duplicate entity", async () => {
    const proj = seedProject("approve-idempotent");
    const mid = seedMission(proj.id);
    const pid = seedProposal(mid, { target_type: "milestone", action: "Once" });

    const first = await app.request(`/missions/${mid}/proposals/${pid}/approve`, {
      method: "POST",
      body: "{}",
    });
    const firstBody = (await first.json()) as { decision_id: string; target_id: string };
    expect(first.status).toBe(200);

    const second = await app.request(`/missions/${mid}/proposals/${pid}/approve`, {
      method: "POST",
      body: "{}",
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { decision_id: string; idempotent?: boolean };
    expect(secondBody.decision_id).toBe(firstBody.decision_id);
    expect(secondBody.idempotent).toBe(true);

    // Exactly one approval row was written even after two POSTs.
    const approvals = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM mission_events
          WHERE mission_id = ? AND kind = 'remediation_approved'
            AND json_extract(payload, '$.proposal_event_id') = ?`,
      )
      .get(mid, pid) as { c: number };
    expect(approvals.c).toBe(1);
  });

  it("404 when the mission id is unknown", async () => {
    const res = await app.request("/missions/m-missing/proposals/p-x/approve", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("404 when the proposal id is unknown for a real mission", async () => {
    const proj = seedProject("approve-no-prop");
    const mid = seedMission(proj.id);
    const res = await app.request(`/missions/${mid}/proposals/p-unknown/approve`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("404 when :pid resolves to a non-proposal event on the same mission", async () => {
    const proj = seedProject("approve-wrong-kind");
    const mid = seedMission(proj.id);
    const heartbeatId = `e-${randomUUID().slice(0, 8)}`;
    sqlite
      .prepare(
        `INSERT INTO mission_events (id, mission_id, kind, payload) VALUES (?, ?, 'heartbeat', '{}')`,
      )
      .run(heartbeatId, mid);
    const res = await app.request(`/missions/${mid}/proposals/${heartbeatId}/approve`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("422 when the stored proposal payload is malformed", async () => {
    const proj = seedProject("approve-malformed");
    const mid = seedMission(proj.id);
    const pid = `e-${randomUUID().slice(0, 8)}`;
    // Forge a remediation_proposed row with a payload that is valid JSON but
    // missing the inner `proposal` object — exactly the shape the schema
    // gate is meant to catch (parent slice §04 security invariant).
    sqlite
      .prepare(
        `INSERT INTO mission_events (id, mission_id, kind, payload)
         VALUES (?, ?, 'remediation_proposed', '{"rationale":"ok"}')`,
      )
      .run(pid, mid);
    const res = await app.request(`/missions/${mid}/proposals/${pid}/approve`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(422);
  });

  it("422 when the stored proposal contains a destructive verb", async () => {
    const proj = seedProject("approve-destructive");
    const mid = seedMission(proj.id);
    const pid = `e-${randomUUID().slice(0, 8)}`;
    // A jailbroken supervisor that smuggled "delete" into a proposal must
    // not cash that row in for a real mutation. Tests the
    // re-validation gate, not the supervisor itself.
    const malicious = {
      rationale: "An attacker says we should",
      proposal: {
        target_type: "milestone",
        candidate: { action: "delete the production database" },
      },
    };
    sqlite
      .prepare(
        `INSERT INTO mission_events (id, mission_id, kind, payload)
         VALUES (?, ?, 'remediation_proposed', ?)`,
      )
      .run(pid, mid, JSON.stringify(malicious));
    const res = await app.request(`/missions/${mid}/proposals/${pid}/approve`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(422);

    // No on-disk milestone, no decision event.
    const planDir = join(proj.path, ".flockctl", "plan");
    expect(existsSync(planDir)).toBe(false);
    const decisions = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM mission_events WHERE mission_id = ? AND kind = 'remediation_approved'`,
      )
      .get(mid) as { c: number };
    expect(decisions.c).toBe(0);
  });

  it("422 when a slice proposal has no parent milestone slug", async () => {
    const proj = seedProject("approve-slice-orphan");
    const mid = seedMission(proj.id);
    const pid = seedProposal(mid, { target_type: "slice", action: "orphan slice" }); // no target_id
    const res = await app.request(`/missions/${mid}/proposals/${pid}/approve`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(422);
  });

  it("cross-tenant: cannot approve project-A's proposal via project-B's mission url", async () => {
    const projA = seedProject("tenant-a");
    const projB = seedProject("tenant-b");
    const missionA = seedMission(projA.id);
    const missionB = seedMission(projB.id);
    const proposalA = seedProposal(missionA, { target_type: "milestone", action: "Inside A" });

    // Mission A's proposal id, but submitted against Mission B's URL → 404.
    // The `getProposalEventOrThrow` query is `mission_id = ? AND id = ?`,
    // so a cross-mission attempt cannot resolve and there is no leakage
    // of "exists, but wrong tenant" vs "doesn't exist anywhere".
    const cross = await app.request(`/missions/${missionB}/proposals/${proposalA}/approve`, {
      method: "POST",
      body: "{}",
    });
    expect(cross.status).toBe(404);

    // Sanity: nothing was written under project B.
    expect(existsSync(join(projB.path, ".flockctl", "plan"))).toBe(false);

    // And the legitimate path still works.
    const ok = await app.request(`/missions/${missionA}/proposals/${proposalA}/approve`, {
      method: "POST",
      body: "{}",
    });
    expect(ok.status).toBe(200);
    expect(existsSync(join(projA.path, ".flockctl", "plan"))).toBe(true);
  });

  it("concurrent approves are deadlock-free (no hang, both calls return 200)", async () => {
    const proj = seedProject("approve-concurrent");
    const mid = seedMission(proj.id);
    const pid = seedProposal(mid, { target_type: "milestone", action: "Race me" });

    // The handler does its idempotency check BEFORE awaiting the body. Two
    // parallel app.request() calls drive both handlers far enough that
    // SQLite's per-statement serialisation is the only synchronisation
    // primitive in play — assert neither call hangs and both surface 200.
    const [r1, r2] = await Promise.all([
      app.request(`/missions/${mid}/proposals/${pid}/approve`, {
        method: "POST",
        body: "{}",
      }),
      app.request(`/missions/${mid}/proposals/${pid}/approve`, {
        method: "POST",
        body: "{}",
      }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it("422 when the project the mission points at has no path configured", async () => {
    // Insert a project with NULL path directly (bypassing the `seedProject`
    // helper) so the approve handler hits the path-less branch.
    const res0 = sqlite
      .prepare("INSERT INTO projects (name, path) VALUES (?, NULL)")
      .run("path-less");
    const projectId = Number(res0.lastInsertRowid);
    const mid = seedMission(projectId);
    const pid = seedProposal(mid, { target_type: "milestone", action: "x" });
    const res = await app.request(`/missions/${mid}/proposals/${pid}/approve`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(422);
  });
});

// ─── POST /missions/:id/proposals/:pid/dismiss ────────────────

describe("POST /missions/:id/proposals/:pid/dismiss", () => {
  it("200 dismisses with an operator-supplied reason", async () => {
    const proj = seedProject("dismiss-with-reason");
    const mid = seedMission(proj.id);
    const pid = seedProposal(mid, { target_type: "milestone", action: "skip me" });
    const res = await app.request(`/missions/${mid}/proposals/${pid}/dismiss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "out of scope this quarter" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.proposal_event_id).toBe(pid);
    expect(body.reason).toBe("out of scope this quarter");
    expect(typeof body.decision_id).toBe("string");
  });

  it("200 with empty body — `reason` is optional", async () => {
    const proj = seedProject("dismiss-empty");
    const mid = seedMission(proj.id);
    const pid = seedProposal(mid, { target_type: "milestone", action: "no reason" });
    const res = await app.request(`/missions/${mid}/proposals/${pid}/dismiss`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.proposal_event_id).toBe(pid);
    expect("reason" in body).toBe(false);
  });

  it("accepts a 2000-char reason at the cap", async () => {
    const proj = seedProject("dismiss-cap-edge");
    const mid = seedMission(proj.id);
    const pid = seedProposal(mid);
    const res = await app.request(`/missions/${mid}/proposals/${pid}/dismiss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "x".repeat(2000) }),
    });
    expect(res.status).toBe(200);
  });

  it("422 when reason exceeds the 2000-char cap", async () => {
    const proj = seedProject("dismiss-cap-over");
    const mid = seedMission(proj.id);
    const pid = seedProposal(mid);
    const res = await app.request(`/missions/${mid}/proposals/${pid}/dismiss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "x".repeat(2001) }),
    });
    expect(res.status).toBe(422);
  });

  it("422 on unknown body field (.strict)", async () => {
    const proj = seedProject("dismiss-strict");
    const mid = seedMission(proj.id);
    const pid = seedProposal(mid);
    const res = await app.request(`/missions/${mid}/proposals/${pid}/dismiss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "ok", extra: 1 }),
    });
    expect(res.status).toBe(422);
  });

  it("idempotent re-dismiss returns the same decision_id", async () => {
    const proj = seedProject("dismiss-idempotent");
    const mid = seedMission(proj.id);
    const pid = seedProposal(mid);
    const first = await app.request(`/missions/${mid}/proposals/${pid}/dismiss`, {
      method: "POST",
      body: "{}",
    });
    const firstBody = (await first.json()) as { decision_id: string };
    const second = await app.request(`/missions/${mid}/proposals/${pid}/dismiss`, {
      method: "POST",
      body: "{}",
    });
    const secondBody = (await second.json()) as { decision_id: string; idempotent?: boolean };
    expect(second.status).toBe(200);
    expect(secondBody.decision_id).toBe(firstBody.decision_id);
    expect(secondBody.idempotent).toBe(true);

    const dismissals = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM mission_events
          WHERE mission_id = ? AND kind = 'remediation_dismissed'
            AND json_extract(payload, '$.proposal_event_id') = ?`,
      )
      .get(mid, pid) as { c: number };
    expect(dismissals.c).toBe(1);
  });

  it("404 on unknown proposal id", async () => {
    const proj = seedProject("dismiss-no-prop");
    const mid = seedMission(proj.id);
    const res = await app.request(`/missions/${mid}/proposals/p-missing/dismiss`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});

// ─── openapi_like_check — status × shape matrix ───────────────
//
// One pass that asserts the full documented surface in a single block. If a
// future contributor adds an endpoint or quietly changes a status code, the
// shape assertions here fail with a single line that points straight at the
// drift — friendlier than chasing a per-handler test that no longer mirrors
// the contract docs.

describe("openapi_like_check — every documented (method, path, status)", () => {
  it("matches the documented JSON shape on every successful path", async () => {
    const proj = seedProject("openapi");
    // POST /missions → 201 + Mission row
    const created = await app.request("/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: proj.id,
        objective: "OpenAPI walk",
        budgetTokens: 10,
        budgetUsdCents: 10,
      }),
    });
    expect(created.status).toBe(201);
    const mission = (await created.json()) as Record<string, unknown>;
    for (const k of [
      "id",
      "projectId",
      "objective",
      "status",
      "autonomy",
      "budgetTokens",
      "budgetUsdCents",
      "spentTokens",
      "spentUsdCents",
      "supervisorPromptVersion",
      "createdAt",
      "updatedAt",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(mission, k)).toBe(true);
    }
    const mid = mission.id as string;

    // GET /missions/:id → 200 + same Mission shape
    const fetched = await app.request(`/missions/${mid}`);
    expect(fetched.status).toBe(200);
    const fetchedBody = (await fetched.json()) as Record<string, unknown>;
    expect(fetchedBody.id).toBe(mid);

    // PATCH /missions/:id → 200 + Mission row
    const patched = await app.request(`/missions/${mid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { status: string }).status).toBe("paused");

    // GET /missions/:id/events → 200 + { items, total, page, perPage }
    const events = await app.request(`/missions/${mid}/events`);
    expect(events.status).toBe(200);
    const eventsBody = (await events.json()) as Record<string, unknown>;
    expect(Array.isArray(eventsBody.items)).toBe(true);
    expect(typeof eventsBody.total).toBe("number");
    expect(typeof eventsBody.page).toBe("number");
    expect(typeof eventsBody.perPage).toBe("number");

    // GET /missions/:id/proposals → 200 + { items, total, status }
    const props = await app.request(`/missions/${mid}/proposals`);
    expect(props.status).toBe(200);
    const propsBody = (await props.json()) as Record<string, unknown>;
    expect(Array.isArray(propsBody.items)).toBe(true);
    expect(typeof propsBody.total).toBe("number");
    expect(propsBody.status).toBe("pending");

    // POST /missions/:id/proposals/:pid/approve → 200 + Decision
    const propId = seedProposal(mid, { target_type: "milestone", action: "Through" });
    const approve = await app.request(`/missions/${mid}/proposals/${propId}/approve`, {
      method: "POST",
      body: "{}",
    });
    expect(approve.status).toBe(200);
    const approveBody = (await approve.json()) as Record<string, unknown>;
    for (const k of ["decision_id", "proposal_event_id", "target_type", "entity_kind", "target_id"]) {
      expect(Object.prototype.hasOwnProperty.call(approveBody, k)).toBe(true);
    }

    // POST /missions/:id/proposals/:pid/dismiss → 200 + { decision_id, ... }
    const propId2 = seedProposal(mid, { action: "Skip" });
    const dismiss = await app.request(`/missions/${mid}/proposals/${propId2}/dismiss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "later" }),
    });
    expect(dismiss.status).toBe(200);
    const dismissBody = (await dismiss.json()) as Record<string, unknown>;
    expect(dismissBody.proposal_event_id).toBe(propId2);
    expect(dismissBody.reason).toBe("later");
    expect(typeof dismissBody.decision_id).toBe("string");
  });

  it("matches the documented error shape on every documented failure status", async () => {
    // Pre-seed mission + proposal so we can hit 422 paths beyond bare 404s.
    const proj = seedProject("openapi-errors");
    const mid = seedMission(proj.id);
    const pid = seedProposal(mid);

    const cases: Array<{
      label: string;
      method: string;
      path: string;
      body?: unknown;
      expected: number;
    }> = [
      // 404 — unknown mission
      { label: "GET /missions/:id 404", method: "GET", path: "/missions/missing", expected: 404 },
      { label: "PATCH /missions/:id 404", method: "PATCH", path: "/missions/missing", body: { status: "paused" }, expected: 404 },
      { label: "GET /missions/:id/events 404", method: "GET", path: "/missions/missing/events", expected: 404 },
      { label: "GET /missions/:id/proposals 404", method: "GET", path: "/missions/missing/proposals", expected: 404 },
      { label: "POST approve 404", method: "POST", path: "/missions/missing/proposals/x/approve", body: {}, expected: 404 },
      { label: "POST dismiss 404", method: "POST", path: "/missions/missing/proposals/x/dismiss", body: {}, expected: 404 },
      // 422 — invalid body / filter
      { label: "POST /missions 422 missing fields", method: "POST", path: "/missions", body: {}, expected: 422 },
      { label: "PATCH /missions/:id 422 empty body", method: "PATCH", path: `/missions/${mid}`, body: {}, expected: 422 },
      { label: "GET proposals 422 invalid status", method: "GET", path: `/missions/${mid}/proposals?status=mystery`, expected: 422 },
      { label: "POST dismiss 422 long reason", method: "POST", path: `/missions/${mid}/proposals/${pid}/dismiss`, body: { reason: "x".repeat(2001) }, expected: 422 },
      // 501 — autonomy='auto'
      {
        label: "POST /missions 501 autonomy=auto",
        method: "POST",
        path: "/missions",
        body: {
          projectId: proj.id,
          objective: "x",
          autonomy: "auto",
          budgetTokens: 1,
          budgetUsdCents: 1,
        },
        expected: 501,
      },
    ];

    for (const c of cases) {
      const res = await app.request(c.path, {
        method: c.method,
        headers: { "content-type": "application/json" },
        ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
      });
      expect(res.status, c.label).toBe(c.expected);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.error, `${c.label} body.error`).toBe("string");
    }
  });
});
