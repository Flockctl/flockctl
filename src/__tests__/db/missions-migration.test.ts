import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Migration 0043 introduces the supervisor's two persistence primitives —
// `missions` and `mission_events`. The four cases below each pin one half
// of the contract the migration ships under (test names match the verify
// grep in the task spec: drizzle_forward_migration | drizzle_rollback |
// fk_cascade | fk_set_null):
//
//   1. drizzle_forward_migration — both tables, both indices, all four
//      CHECK constraints, and both FK clauses materialize on a clean DB.
//   2. drizzle_rollback — the reverse DDL (drop in FK order: events first,
//      then missions) removes both tables and leaves milestones intact.
//      This is the safety the supervisor milestone trades on: rolling
//      back the missions migration must NOT cascade-delete user-authored
//      milestones, even though task 02 of this milestone wires
//      `milestones.mission_id` with ON DELETE SET NULL.
//   3. fk_cascade — deleting a mission cascades to mission_events (the
//      timeline travels with the mission; it is not a system audit log).
//   4. fk_set_null — deleting a mission leaves milestones intact with
//      mission_id NULL once task 02's column lands. We forward-simulate
//      that column locally so this test pins the behavior contract today
//      and the column-add task only has to validate the column itself.
//
// The migration SQL is loaded straight off disk and executed against an
// in-memory better-sqlite3 instance. We deliberately do NOT go through
// drizzle-kit's migrator here — the goal is to assert the SQL file as
// shipped, including statement-breakpoint splits, foreign_keys=ON
// behavior, and the CHECK predicates. Going through the migrator would
// also pull in unrelated journal entries.

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(here, "..", "..", "..", "migrations", "0043_add_missions.sql");

/**
 * Read 0043_add_missions.sql and split on the drizzle statement-breakpoint
 * marker. Mirrors what drizzle-orm's migrator does at runtime, but without
 * the journal coupling — so this test stays pinned to the exact SQL the
 * file ships, even if the migrator's internals shift.
 */
function loadForwardStatements(): string[] {
  const raw = readFileSync(MIGRATION_PATH, "utf8");
  return raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Open a fresh :memory: DB with FK enforcement on, run only the parent
 * tables that missions/mission_events reference (workspaces, projects,
 * milestones), and return the handle. Keeps the fixture surface small
 * so a schema drift in an unrelated table can't break this test.
 */
function freshFixtureDb(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");

  // Minimal parent rows used by the FK clauses + the rollback case.
  // `milestones.mission_id` is added inline here to forward-simulate
  // task 02's column-add migration so fk_set_null can pin the contract
  // today; production schema gets the column via its own migration.
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
    CREATE TABLE milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL
    );
  `);

  return sqlite;
}

/**
 * Apply the forward migration to `sqlite`. Splits on statement-breakpoint
 * and runs each chunk in order. Returns nothing — failure throws and the
 * vitest case fails with the SQLite error.
 */
function applyForwardMigration(sqlite: Database.Database): void {
  for (const stmt of loadForwardStatements()) {
    sqlite.exec(stmt);
  }
}

/**
 * Reverse DDL: drop in FK-child-first order so the FK constraint check
 * doesn't reject the parent drop. The two indices fall with their tables
 * automatically — SQLite drops contained indices on DROP TABLE.
 */
function applyRollback(sqlite: Database.Database): void {
  sqlite.exec(`DROP TABLE IF EXISTS mission_events;`);
  sqlite.exec(`DROP TABLE IF EXISTS missions;`);
}

describe("0043_add_missions migration", () => {
  it("drizzle_forward_migration: creates both tables, both indices, all CHECK + FK clauses", () => {
    const sqlite = freshFixtureDb();
    applyForwardMigration(sqlite);

    // Both tables visible in sqlite_master.
    const tables = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('missions','mission_events') ORDER BY name`)
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(["mission_events", "missions"]);

    // Both indices visible.
    const indices = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_missions_project','idx_mission_events_mission_created') ORDER BY name`)
      .all() as { name: string }[];
    expect(indices.map((i) => i.name)).toEqual([
      "idx_mission_events_mission_created",
      "idx_missions_project",
    ]);

    // FK clauses are present on both tables. PRAGMA foreign_key_list returns
    // one row per FK, with `table` = referenced parent.
    const missionsFks = sqlite.prepare(`PRAGMA foreign_key_list("missions")`).all() as Array<{ table: string; on_delete: string }>;
    expect(missionsFks).toHaveLength(1);
    expect(missionsFks[0].table).toBe("projects");
    expect(missionsFks[0].on_delete).toBe("CASCADE");

    const eventsFks = sqlite.prepare(`PRAGMA foreign_key_list("mission_events")`).all() as Array<{ table: string; on_delete: string }>;
    expect(eventsFks).toHaveLength(1);
    expect(eventsFks[0].table).toBe("missions");
    expect(eventsFks[0].on_delete).toBe("CASCADE");

    // Seed parents so we can probe CHECK constraints.
    sqlite.prepare(`INSERT INTO workspaces (name, path) VALUES ('ws','/tmp/ws')`).run();
    sqlite.prepare(`INSERT INTO projects (workspace_id, name) VALUES (1, 'p')`).run();

    // CHECK: status enum closed.
    expect(() => sqlite
      .prepare(`INSERT INTO missions (id, project_id, objective, status, autonomy, budget_tokens, budget_usd_cents, supervisor_prompt_version) VALUES ('m-bad-status', 1, 'o', 'bogus', 'suggest', 100, 100, 'v1')`)
      .run()).toThrow(/CHECK constraint failed/);

    // CHECK: autonomy enum closed.
    expect(() => sqlite
      .prepare(`INSERT INTO missions (id, project_id, objective, status, autonomy, budget_tokens, budget_usd_cents, supervisor_prompt_version) VALUES ('m-bad-auto', 1, 'o', 'active', 'turbo', 100, 100, 'v1')`)
      .run()).toThrow(/CHECK constraint failed/);

    // CHECK: budget_tokens > 0.
    expect(() => sqlite
      .prepare(`INSERT INTO missions (id, project_id, objective, status, autonomy, budget_tokens, budget_usd_cents, supervisor_prompt_version) VALUES ('m-zero-tokens', 1, 'o', 'active', 'suggest', 0, 100, 'v1')`)
      .run()).toThrow(/CHECK constraint failed/);

    // CHECK: budget_usd_cents > 0.
    expect(() => sqlite
      .prepare(`INSERT INTO missions (id, project_id, objective, status, autonomy, budget_tokens, budget_usd_cents, supervisor_prompt_version) VALUES ('m-zero-cents', 1, 'o', 'active', 'suggest', 100, 0, 'v1')`)
      .run()).toThrow(/CHECK constraint failed/);

    // Happy-path insert: defaults for status/autonomy/spent/timestamps fill in.
    sqlite
      .prepare(`INSERT INTO missions (id, project_id, objective, budget_tokens, budget_usd_cents, supervisor_prompt_version) VALUES ('m-1', 1, 'ship it', 1000, 5000, 'v1')`)
      .run();
    const m = sqlite.prepare(`SELECT * FROM missions WHERE id = 'm-1'`).get() as Record<string, unknown>;
    expect(m.status).toBe("active");
    expect(m.autonomy).toBe("suggest");
    expect(m.spent_tokens).toBe(0);
    expect(m.spent_usd_cents).toBe(0);
    expect(typeof m.created_at).toBe("number"); // INTEGER unixepoch(), not TEXT.

    // CHECK: mission_events.kind enum closed.
    expect(() => sqlite
      .prepare(`INSERT INTO mission_events (id, mission_id, kind, payload) VALUES ('e-bad', 'm-1', 'bogus_kind', '{}')`)
      .run()).toThrow(/CHECK constraint failed/);

    // Happy-path event insert.
    sqlite
      .prepare(`INSERT INTO mission_events (id, mission_id, kind, payload) VALUES ('e-1', 'm-1', 'plan_proposed', '{}')`)
      .run();
    const e = sqlite.prepare(`SELECT * FROM mission_events WHERE id = 'e-1'`).get() as Record<string, unknown>;
    expect(e.kind).toBe("plan_proposed");
    expect(e.depth).toBe(0);

    sqlite.close();
  });

  it("drizzle_rollback: dropping mission tables leaves milestones intact", () => {
    const sqlite = freshFixtureDb();
    applyForwardMigration(sqlite);

    // Populate a fixture: project → mission → milestone (with mission_id) →
    // mission_event. The milestone is the row we expect to survive rollback.
    sqlite.prepare(`INSERT INTO workspaces (name, path) VALUES ('ws','/tmp/ws')`).run();
    sqlite.prepare(`INSERT INTO projects (workspace_id, name) VALUES (1, 'p')`).run();
    sqlite
      .prepare(`INSERT INTO missions (id, project_id, objective, budget_tokens, budget_usd_cents, supervisor_prompt_version) VALUES ('m-1', 1, 'objective', 1000, 5000, 'v1')`)
      .run();
    sqlite
      .prepare(`INSERT INTO milestones (project_id, title, mission_id) VALUES (1, 'M1: foundation', 'm-1')`)
      .run();
    sqlite
      .prepare(`INSERT INTO mission_events (id, mission_id, kind, payload) VALUES ('e-1', 'm-1', 'plan_proposed', '{}')`)
      .run();

    expect(sqlite.prepare(`SELECT COUNT(*) as c FROM milestones`).get()).toEqual({ c: 1 });

    // Reverse DDL.
    applyRollback(sqlite);

    // Both mission tables are gone …
    const stillThere = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('missions','mission_events')`)
      .all();
    expect(stillThere).toEqual([]);

    // … but the milestone row survives. `mission_id` still holds the now-orphan
    // text value — that's intentional: rollback removes the FK target table,
    // not the column that referenced it. Task 02 owns the column drop if a full
    // schema rollback is ever needed.
    const milestones = sqlite.prepare(`SELECT id, title, mission_id FROM milestones`).all() as Array<{ id: number; title: string; mission_id: string | null }>;
    expect(milestones).toHaveLength(1);
    expect(milestones[0].title).toBe("M1: foundation");

    sqlite.close();
  });

  it("fk_cascade: deleting a mission cascades to mission_events", () => {
    const sqlite = freshFixtureDb();
    applyForwardMigration(sqlite);

    sqlite.prepare(`INSERT INTO workspaces (name, path) VALUES ('ws','/tmp/ws')`).run();
    sqlite.prepare(`INSERT INTO projects (workspace_id, name) VALUES (1, 'p')`).run();
    sqlite
      .prepare(`INSERT INTO missions (id, project_id, objective, budget_tokens, budget_usd_cents, supervisor_prompt_version) VALUES ('m-1', 1, 'o', 1000, 5000, 'v1')`)
      .run();
    sqlite
      .prepare(`INSERT INTO missions (id, project_id, objective, budget_tokens, budget_usd_cents, supervisor_prompt_version) VALUES ('m-2', 1, 'o2', 1000, 5000, 'v1')`)
      .run();
    sqlite
      .prepare(`INSERT INTO mission_events (id, mission_id, kind, payload) VALUES ('e-1', 'm-1', 'plan_proposed', '{}'), ('e-2', 'm-1', 'task_observed', '{}'), ('e-3', 'm-2', 'plan_proposed', '{}')`)
      .run();

    expect(sqlite.prepare(`SELECT COUNT(*) as c FROM mission_events`).get()).toEqual({ c: 3 });

    // Delete m-1. Its two events should disappear; m-2's event should remain.
    sqlite.prepare(`DELETE FROM missions WHERE id = 'm-1'`).run();

    const remaining = sqlite.prepare(`SELECT id, mission_id FROM mission_events ORDER BY id`).all();
    expect(remaining).toEqual([{ id: "e-3", mission_id: "m-2" }]);

    // Project-level cascade: deleting the project should drop m-2 (and via the
    // FK, e-3) too. Pins the chained-cascade behavior the supervisor depends on
    // when a project is removed.
    sqlite.prepare(`DELETE FROM projects WHERE id = 1`).run();
    expect(sqlite.prepare(`SELECT COUNT(*) as c FROM missions`).get()).toEqual({ c: 0 });
    expect(sqlite.prepare(`SELECT COUNT(*) as c FROM mission_events`).get()).toEqual({ c: 0 });

    sqlite.close();
  });

  it("fk_set_null: deleting a mission leaves milestones with mission_id NULL", () => {
    const sqlite = freshFixtureDb();
    applyForwardMigration(sqlite);

    sqlite.prepare(`INSERT INTO workspaces (name, path) VALUES ('ws','/tmp/ws')`).run();
    sqlite.prepare(`INSERT INTO projects (workspace_id, name) VALUES (1, 'p')`).run();
    sqlite
      .prepare(`INSERT INTO missions (id, project_id, objective, budget_tokens, budget_usd_cents, supervisor_prompt_version) VALUES ('m-1', 1, 'o', 1000, 5000, 'v1')`)
      .run();
    sqlite
      .prepare(`INSERT INTO milestones (project_id, title, mission_id) VALUES (1, 'M1', 'm-1')`)
      .run();

    sqlite.prepare(`DELETE FROM missions WHERE id = 'm-1'`).run();

    const m = sqlite.prepare(`SELECT id, title, mission_id FROM milestones WHERE id = 1`).get() as { id: number; title: string; mission_id: string | null };
    expect(m.title).toBe("M1");
    expect(m.mission_id).toBeNull();

    sqlite.close();
  });
});
