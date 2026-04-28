// ─── daemon_reboot_reregisters — integration test ───
//
// Pins the slice 11/04 §"daemon reboot re-registration" contract:
//
//   When the daemon process exits with N active missions in the DB and
//   restarts, the boot path's `registerHeartbeats()` call MUST scan the
//   mission table and re-install one heartbeat per active mission. The
//   in-memory cron handles from the previous process are gone, so without
//   this re-registration ALL active missions would silently lose their
//   liveness pings until the user manually re-activated them.
//
// This test exercises the REAL DB-backed `readActiveMissionIds` reader —
// not the test-injected fake — so it pins the SQL predicate AND the
// boot-time wiring. We do still inject the scheduler (so the test
// finishes synchronously without spinning a real cron) and override
// `readMissionStatus` is left at its default to also exercise the
// rogue-tick check against real DB rows.
//
// Setup mirrors `supervisor.test.ts`: an in-memory better-sqlite3 with
// the migration-0043 missions DDL inlined. helpers.ts doesn't carry the
// missions tier yet (its DDL stops at chats/usage/budget).

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import Database from "better-sqlite3";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import {
  registerHeartbeats,
  __getHeartbeatMissionIds,
  __resetHeartbeats,
  type HeartbeatScheduler,
} from "../../services/missions/heartbeat.js";

// ─────────────────────────────────────────────────────────────────────
// DB scaffold
// ─────────────────────────────────────────────────────────────────────

let sqlite: BetterSqlite3Database;
let db: FlockctlDb;

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
  `);
  sqlite.prepare("INSERT INTO workspaces (name, path) VALUES ('ws','/tmp/ws')").run();
  sqlite.prepare("INSERT INTO projects (workspace_id, name) VALUES (1,'p')").run();

  db = drizzle(sqlite, { schema });
  setDb(db, sqlite);
}

function seedMission(id: string, status: string): void {
  sqlite
    .prepare(
      `INSERT INTO missions
         (id, project_id, objective, status, autonomy,
          budget_tokens, budget_usd_cents, supervisor_prompt_version)
       VALUES (?, 1, 'obj', ?, 'suggest', 1000, 100, 'v1')`,
    )
    .run(id, status);
}

interface FakeScheduler extends HeartbeatScheduler {
  jobs: Array<{ expression: string; fn: () => void; stopped: boolean }>;
}

function makeFakeScheduler(): FakeScheduler {
  const jobs: FakeScheduler["jobs"] = [];
  return {
    jobs,
    schedule(expression, fn) {
      const entry = { expression, fn, stopped: false };
      jobs.push(entry);
      return {
        stop: () => {
          entry.stopped = true;
        },
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────────────

beforeAll(() => {
  setupDb();
});

afterAll(() => {
  sqlite.close();
});

beforeEach(() => {
  __resetHeartbeats();
  sqlite.exec("DELETE FROM missions;");
});

afterEach(() => {
  __resetHeartbeats();
});

// ─────────────────────────────────────────────────────────────────────
// daemon_reboot_reregisters — boot reads active missions from the DB
// ─────────────────────────────────────────────────────────────────────

describe("daemon_reboot_reregisters", () => {
  it("re-registers a heartbeat for every active mission in the DB on boot", () => {
    seedMission("m-active-1", "active");
    seedMission("m-active-2", "active");
    seedMission("m-paused", "paused");
    seedMission("m-completed", "completed");
    seedMission("m-aborted", "aborted");

    const fake = makeFakeScheduler();
    const calls: string[] = [];
    const result = registerHeartbeats((id) => {
      calls.push(id);
    }, {
      scheduler: fake,
      // readActiveMissionIds is intentionally OMITTED here so the
      // production DB-backed reader runs against the in-memory missions
      // table — that's the contract this test pins.
      readMissionStatus: undefined,
    });

    // Only the two `active` missions should attract a handle. Set
    // semantics — ordering is whatever the DB returns; assert by sort.
    expect(result.registered.sort()).toEqual(["m-active-1", "m-active-2"]);
    expect(__getHeartbeatMissionIds().sort()).toEqual([
      "m-active-1",
      "m-active-2",
    ]);
    expect(fake.jobs).toHaveLength(2);
  });

  it("after reboot, ticks fire for the re-registered missions", () => {
    seedMission("m-1", "active");
    seedMission("m-2", "active");

    const fake = makeFakeScheduler();
    const calls: string[] = [];
    registerHeartbeats((id) => {
      calls.push(id);
    }, { scheduler: fake });

    // Simulate a cron firing for each handle.
    for (const j of fake.jobs) j.fn();
    expect(calls.sort()).toEqual(["m-1", "m-2"]);
  });

  it("a tick after reboot whose mission has since been paused (rogue race) self-unregisters", () => {
    seedMission("m-1", "active");
    const fake = makeFakeScheduler();
    const calls: string[] = [];
    registerHeartbeats((id) => {
      calls.push(id);
    }, { scheduler: fake });
    expect(__getHeartbeatMissionIds()).toEqual(["m-1"]);

    // Status flip happens AFTER reboot but BEFORE the tick — exactly
    // the rogue-tick race the supervisor depends on us catching.
    sqlite.prepare("UPDATE missions SET status='paused' WHERE id=?").run("m-1");
    fake.jobs[0].fn();

    expect(calls).toEqual([]);
    expect(__getHeartbeatMissionIds()).toEqual([]);
  });

  it("boot with NO missions in the DB installs nothing (clean install)", () => {
    const fake = makeFakeScheduler();
    const result = registerHeartbeats(() => undefined, { scheduler: fake });
    expect(result.registered).toEqual([]);
    expect(fake.jobs).toEqual([]);
  });

  it("two consecutive registerHeartbeats calls (HMR re-boot) do NOT double-schedule", () => {
    seedMission("m-1", "active");
    seedMission("m-2", "active");

    const fake = makeFakeScheduler();
    registerHeartbeats(() => undefined, { scheduler: fake });
    expect(fake.jobs).toHaveLength(2);

    // Second boot WITHOUT a teardown — same as a tsx watch HMR cycle.
    // The map is intentionally NOT reset between calls; idempotency
    // is the contract.
    const result = registerHeartbeats(() => undefined, { scheduler: fake });
    expect(result.registered).toEqual([]);
    expect(result.alreadyActive.sort()).toEqual(["m-1", "m-2"]);
    expect(fake.jobs).toHaveLength(2); // still 2, not 4
  });
});
