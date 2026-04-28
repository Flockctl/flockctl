import { describe, it, expect, afterAll } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// Slice 11/00 task 03 — the "full constraint / perf / security" suite for
// the missions + mission_events migration (0043). Where the
// `db/missions-migration.test.ts` companion pins the structural contract
// (tables, indices, FK clauses, rollback, cascades), this file pins the
// runtime invariants the supervisor depends on once those tables are live:
//
//   - **NOT NULL**: `mission_events.mission_id` cannot be NULL — without a
//     mission anchor an event is unindexed orphan rows. The hot-path
//     reverse-chronological scan would not just be wrong, it would silently
//     return events for the wrong mission once the supervisor binary
//     attempts to dereference them.
//   - **CHECK / autonomy**: the `autonomy` enum is closed at the DB layer
//     so a stale supervisor binary cannot insert an unknown lifecycle value
//     and corrupt the state machine. We exercise the negative case
//     ('invalid') called out by the slice 03 negative_tests block.
//   - **CHECK / budget_tokens**: `budget_tokens > 0` (not just `NOT NULL`).
//     Zero or negative tokens would represent an "unbounded mission with no
//     stop condition" — representationally impossible at the DB layer per
//     the migration's threat-surface notes.
//   - **CHECK / budget_usd_cents**: same shape as tokens. The "security
//     CHECK" called out by slice 03 — without it, an attacker (or a buggy
//     code path) could create a mission with a zero-USD budget that runs
//     forever inside the supervisor's `spent_usd_cents < budget_usd_cents`
//     guard. The constraint kills that whole class of bug at the DB.
//   - **Perf / 10k**: the (mission_id, created_at DESC) compound index
//     exists specifically to satisfy "give me the latest N events for
//     mission X" without an extra sort step. We seed 10k events across two
//     missions, EXPLAIN-assert the index is being used, then time the
//     latest-N scan under 50ms (the threshold the migration's commentary
//     pins explicitly). 50ms is the budget; we expect single-digit ms in
//     practice — the slack is for slow CI runners.
//   - **Concurrent inserts**: two better-sqlite3 handles writing to the
//     same on-disk file under WAL mode must not deadlock. SQLite WAL
//     allows concurrent readers but serializes writers via a short-lived
//     lock — the contract this test pins is that the second writer
//     resolves rather than blocking forever or producing a corrupt state.
//     We use a real file (mkdtemp) because :memory: handles cannot share
//     a database between connections.
//
// All five sections share one in-memory fixture so the migration only
// loads off disk once. The concurrent-inserts case opens a fresh tempfile
// because :memory: cannot be shared between handles. Every fixture is
// cleaned in afterAll.

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(here, "..", "..", "migrations", "0043_add_missions.sql");

/**
 * Read the migration SQL and split on the drizzle statement-breakpoint
 * marker. We intentionally do not go through drizzle-kit's migrator: the
 * goal is to assert the file as it ships, including the CHECK predicates,
 * the FK clauses, and the (mission_id, created_at DESC) index — without
 * pulling in an unrelated journal entry that could mask a regression.
 */
function loadForwardStatements(): string[] {
  const raw = readFileSync(MIGRATION_PATH, "utf8");
  return raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Minimal parent-table fixture. Only `workspaces` + `projects` are needed
 * because nothing in this suite touches milestones — that's the
 * companion `missions-migration.test.ts` rollback case's job.
 */
function applyParentSchema(sqlite: Database.Database): void {
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
  `);
}

/**
 * Apply migration 0043 to `sqlite`, statement-by-statement.
 */
function applyMissionsMigration(sqlite: Database.Database): void {
  for (const stmt of loadForwardStatements()) {
    sqlite.exec(stmt);
  }
}

/**
 * Boot a fresh :memory: handle with FK enforcement on, parents created,
 * and the 0043 migration applied. One project row is seeded so callers
 * can immediately insert missions referencing project_id = 1.
 */
function bootInMemoryFixture(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyParentSchema(sqlite);
  applyMissionsMigration(sqlite);
  sqlite.prepare(`INSERT INTO workspaces (name, path) VALUES ('ws','/tmp/ws')`).run();
  sqlite.prepare(`INSERT INTO projects (workspace_id, name) VALUES (1, 'p')`).run();
  return sqlite;
}

describe("0043_add_missions — constraint / perf / security suite", () => {
  // Shared fixture for the constraint + perf cases. The concurrent-inserts
  // case can't use :memory: (two handles can't share an in-memory DB) so
  // it boots its own tempfile fixture and cleans up via the same afterAll.
  const sqlite = bootInMemoryFixture();
  let tmpDir: string | null = null;

  afterAll(() => {
    sqlite.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Constraint: NOT NULL ──────────────────────────────────────────────
  describe("NOT NULL", () => {
    it("rejects mission_event with NULL mission_id", () => {
      // Per migration 0043 line 68: `mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE`.
      // Without this guard, a row in mission_events with NULL mission_id
      // would be unanchored and the (mission_id, created_at DESC) index
      // would happily return it for any mission scan that happened to
      // group NULLs together.
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO mission_events (id, mission_id, kind, payload) VALUES ('e-null-mid', NULL, 'plan_proposed', '{}')`,
          )
          .run(),
      ).toThrow(/NOT NULL constraint failed: mission_events\.mission_id/);
    });

    it("rejects mission_event with omitted mission_id (no default)", () => {
      // Same guard reached via "column omitted from INSERT" rather than
      // explicit NULL — pins both wire shapes that a buggy ORM call could
      // take. There is no DEFAULT for mission_id, so the omission must
      // surface as a NOT NULL violation, not a silent DEFAULT NULL.
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO mission_events (id, kind, payload) VALUES ('e-no-mid', 'plan_proposed', '{}')`,
          )
          .run(),
      ).toThrow(/NOT NULL constraint failed: mission_events\.mission_id/);
    });
  });

  // ─── Constraint: CHECK / autonomy ──────────────────────────────────────
  describe("CHECK constraint: autonomy enum closed", () => {
    it("rejects autonomy='invalid'", () => {
      // Slice 03 negative_tests calls this case out by name. The closed
      // enum is what keeps a stale supervisor binary from inserting an
      // unknown autonomy value and silently breaking the state machine.
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO missions (id, project_id, objective, status, autonomy, budget_tokens, budget_usd_cents, supervisor_prompt_version)
             VALUES ('m-bad-autonomy', 1, 'o', 'active', 'invalid', 100, 100, 'v1')`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });

    it("accepts every documented autonomy value (manual / suggest / auto)", () => {
      // The positive companion: drift in either direction (column
      // dropped from the enum, or test pinned to a stale set) surfaces here.
      const accepted = ["manual", "suggest", "auto"] as const;
      for (const a of accepted) {
        sqlite
          .prepare(
            `INSERT INTO missions (id, project_id, objective, autonomy, budget_tokens, budget_usd_cents, supervisor_prompt_version)
             VALUES (?, 1, 'o', ?, 100, 100, 'v1')`,
          )
          .run(`m-autonomy-${a}`, a);
      }
      const rows = sqlite
        .prepare(`SELECT autonomy FROM missions WHERE id LIKE 'm-autonomy-%' ORDER BY autonomy`)
        .all() as { autonomy: string }[];
      expect(rows.map((r) => r.autonomy)).toEqual(["auto", "manual", "suggest"]);
    });
  });

  // ─── Constraint: CHECK / budget_tokens > 0 ─────────────────────────────
  describe("CHECK constraint: budget_tokens > 0", () => {
    it("rejects budget_tokens = 0", () => {
      // Zero tokens means "unbounded mission" — the supervisor's stop
      // condition `spent_tokens < budget_tokens` would never fire.
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO missions (id, project_id, objective, budget_tokens, budget_usd_cents, supervisor_prompt_version)
             VALUES ('m-zero-tokens', 1, 'o', 0, 100, 'v1')`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });

    it("rejects negative budget_tokens", () => {
      // SQLite stores INTEGER as signed 64-bit; without the CHECK, a
      // negative budget would represent "completed before it started".
      // Slice 03 negative_tests calls this out specifically.
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO missions (id, project_id, objective, budget_tokens, budget_usd_cents, supervisor_prompt_version)
             VALUES ('m-neg-tokens', 1, 'o', -1, 100, 'v1')`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });
  });

  // ─── Constraint: CHECK / budget_usd_cents > 0 (security) ───────────────
  describe("CHECK constraint: budget_usd_cents > 0 (security guard)", () => {
    it("rejects budget_usd_cents = 0", () => {
      // The "security CHECK" called out in the slice 03 deliverable list:
      // a zero-USD budget is the cheapest path to an unbounded mission
      // (the supervisor's USD guard `spent_usd_cents < budget_usd_cents`
      // would never trip if both sides start at 0). Stopping that at the
      // DB closes the entire class of bug — service-layer validation can
      // be bypassed; CHECK constraints cannot.
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO missions (id, project_id, objective, budget_tokens, budget_usd_cents, supervisor_prompt_version)
             VALUES ('m-zero-usd', 1, 'o', 100, 0, 'v1')`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });

    it("rejects negative budget_usd_cents", () => {
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO missions (id, project_id, objective, budget_tokens, budget_usd_cents, supervisor_prompt_version)
             VALUES ('m-neg-usd', 1, 'o', 100, -100, 'v1')`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });

    it("rejects UPDATE that would set budget_usd_cents to 0", () => {
      // CHECK constraints fire on UPDATE too, not just INSERT — this is
      // the gap a service-layer-only check would leave: the create call
      // validates, but a later "edit budget" PATCH could zero it out.
      // Pin the contract so the supervisor can rely on `budget_usd_cents
      // > 0` as a global invariant.
      sqlite
        .prepare(
          `INSERT INTO missions (id, project_id, objective, budget_tokens, budget_usd_cents, supervisor_prompt_version)
           VALUES ('m-edit-usd', 1, 'o', 100, 500, 'v1')`,
        )
        .run();
      expect(() =>
        sqlite.prepare(`UPDATE missions SET budget_usd_cents = 0 WHERE id = 'm-edit-usd'`).run(),
      ).toThrow(/CHECK constraint failed/);
    });
  });

  // ─── Perf: 10k events, latest-N scan under 50ms ────────────────────────
  describe("perf: (mission_id, created_at DESC) index pulls its weight", () => {
    it("seeds 10k events across two missions and scans latest 100 for one mission < 50ms", () => {
      // Two missions so the test exercises the index's discriminating
      // column (mission_id) — a single-mission fixture would mask a
      // regression where the index dropped its leading column.
      sqlite
        .prepare(
          `INSERT INTO missions (id, project_id, objective, budget_tokens, budget_usd_cents, supervisor_prompt_version)
           VALUES ('m-perf-1', 1, 'o', 10000, 10000, 'v1'), ('m-perf-2', 1, 'o', 10000, 10000, 'v1')`,
        )
        .run();

      // Bulk-insert 10k events — half against m-perf-1, half against
      // m-perf-2 — interleaved by created_at so the index has to do real
      // work. Wrap in a single transaction so we're not paying per-row
      // fsync cost; the cost we care about is read-side, not write-side.
      const insert = sqlite.prepare(
        `INSERT INTO mission_events (id, mission_id, kind, payload, created_at) VALUES (?, ?, 'task_observed', '{}', ?)`,
      );
      const tx = sqlite.transaction((rows: Array<[string, string, number]>) => {
        for (const r of rows) insert.run(r[0], r[1], r[2]);
      });
      const rows: Array<[string, string, number]> = [];
      const baseTime = 1_700_000_000; // arbitrary unix epoch base
      for (let i = 0; i < 10_000; i++) {
        const mission = i % 2 === 0 ? "m-perf-1" : "m-perf-2";
        rows.push([`e-${i}`, mission, baseTime + i]);
      }
      tx(rows);

      // Sanity-check the seed: 5k events per mission.
      const counts = sqlite
        .prepare(`SELECT mission_id, COUNT(*) as c FROM mission_events WHERE mission_id IN ('m-perf-1','m-perf-2') GROUP BY mission_id ORDER BY mission_id`)
        .all() as { mission_id: string; c: number }[];
      expect(counts).toEqual([
        { mission_id: "m-perf-1", c: 5000 },
        { mission_id: "m-perf-2", c: 5000 },
      ]);

      // Assert the index is what's getting used. EXPLAIN QUERY PLAN
      // returns one row per access path; we check for either the index
      // name or the SEARCH-by-USING-INDEX shape so the test is robust
      // to SQLite's plan-string formatting changes across versions.
      const plan = sqlite
        .prepare(
          `EXPLAIN QUERY PLAN SELECT id, created_at FROM mission_events WHERE mission_id = 'm-perf-1' ORDER BY created_at DESC LIMIT 100`,
        )
        .all() as Array<{ detail: string }>;
      const planText = plan.map((p) => p.detail).join(" | ");
      expect(planText).toMatch(/idx_mission_events_mission_created/);
      // ORDER BY-by-index means no separate sort step.
      expect(planText).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);

      // Time the actual query. 50ms is the budget the migration's
      // commentary pins; in-memory SQLite on any reasonable runner
      // returns this in single-digit ms. We do three runs to amortize
      // statement-prep overhead (the first run pays for query plan
      // resolution; we want to measure the steady-state cost the
      // supervisor will actually see).
      const stmt = sqlite.prepare(
        `SELECT id, created_at FROM mission_events WHERE mission_id = ? ORDER BY created_at DESC LIMIT 100`,
      );
      let lastResultLen = 0;
      let bestMs = Infinity;
      for (let run = 0; run < 3; run++) {
        const t0 = performance.now();
        const result = stmt.all("m-perf-1") as Array<{ id: string; created_at: number }>;
        const elapsed = performance.now() - t0;
        if (elapsed < bestMs) bestMs = elapsed;
        lastResultLen = result.length;
      }
      expect(lastResultLen).toBe(100);
      expect(bestMs).toBeLessThan(50);
    });
  });

  // ─── Concurrent inserts: two handles, same file, no deadlock ───────────
  describe("concurrent inserts: two handles against the same file", () => {
    it("interleaves writes from two better-sqlite3 connections without deadlock", () => {
      // :memory: handles cannot share a database — open a tempfile
      // instead. WAL mode is the project-wide default (set by the real
      // db boot path) and is required for the contract we're testing:
      // SQLite WAL allows concurrent readers + serializes writers
      // through a short-lived lock. The hazard a regression here would
      // catch is "writer A holds the reserved lock too long, writer B
      // times out". better-sqlite3's busy_timeout default is 5s, so a
      // deadlock would surface as a SQLITE_BUSY throw within seconds —
      // which is fine; the assertion is just that both handles complete.
      tmpDir = mkdtempSync(join(tmpdir(), "flockctl-mig0043-"));
      const dbPath = join(tmpDir, "missions-concurrent.sqlite");

      const a = new Database(dbPath);
      const b = new Database(dbPath);
      try {
        // Both handles share the same FK + WAL pragmas the production
        // db boot applies. WAL must be set on the first writer; the
        // second handle inherits the journal mode from the file.
        a.pragma("journal_mode = WAL");
        a.pragma("foreign_keys = ON");
        b.pragma("foreign_keys = ON");

        // Apply parents + migration through handle A. Handle B will see
        // the schema once it reads — both handles point at the same file.
        applyParentSchema(a);
        applyMissionsMigration(a);
        a.prepare(`INSERT INTO workspaces (name, path) VALUES ('ws','/tmp/ws')`).run();
        a.prepare(`INSERT INTO projects (workspace_id, name) VALUES (1, 'p')`).run();
        a
          .prepare(
            `INSERT INTO missions (id, project_id, objective, budget_tokens, budget_usd_cents, supervisor_prompt_version)
             VALUES ('m-cc', 1, 'o', 1000, 1000, 'v1')`,
          )
          .run();

        // Sanity: B sees the mission row inserted by A (same file).
        const seen = b.prepare(`SELECT id FROM missions WHERE id = 'm-cc'`).get();
        expect(seen).toEqual({ id: "m-cc" });

        // Interleave 200 writes from each handle. SQLite serializes
        // writers, so we expect each individual `run()` to complete
        // without throwing — the contract is "no deadlock, no
        // SQLITE_BUSY surfacing past the busy_timeout". better-sqlite3
        // is synchronous, so "interleave" here means alternating which
        // handle issues the next statement, not actual parallelism;
        // that's enough to exercise the lock-handoff path because each
        // statement acquires + releases the writer lock.
        const insertA = a.prepare(
          `INSERT INTO mission_events (id, mission_id, kind, payload) VALUES (?, 'm-cc', 'task_observed', '{}')`,
        );
        const insertB = b.prepare(
          `INSERT INTO mission_events (id, mission_id, kind, payload) VALUES (?, 'm-cc', 'heartbeat', '{}')`,
        );

        for (let i = 0; i < 200; i++) {
          insertA.run(`a-${i}`);
          insertB.run(`b-${i}`);
        }

        // Both handles see the full 400 rows: WAL gives B read-after-write
        // visibility once A's transaction has committed. Sort by id to make
        // the assertion shape stable regardless of insertion timing.
        const fromA = a
          .prepare(`SELECT COUNT(*) as c FROM mission_events WHERE mission_id = 'm-cc'`)
          .get() as { c: number };
        const fromB = b
          .prepare(`SELECT COUNT(*) as c FROM mission_events WHERE mission_id = 'm-cc'`)
          .get() as { c: number };
        expect(fromA.c).toBe(400);
        expect(fromB.c).toBe(400);

        // Spot-check the kind distribution: 200 task_observed (from A)
        // and 200 heartbeat (from B). Catches a regression where one
        // writer silently no-ops (e.g. a SQLITE_BUSY swallowed by a
        // wrapper) and the row count happens to land at 400 by accident.
        const byKind = a
          .prepare(`SELECT kind, COUNT(*) as c FROM mission_events WHERE mission_id = 'm-cc' GROUP BY kind ORDER BY kind`)
          .all() as { kind: string; c: number }[];
        expect(byKind).toEqual([
          { kind: "heartbeat", c: 200 },
          { kind: "task_observed", c: 200 },
        ]);
      } finally {
        a.close();
        b.close();
      }
    });
  });
});
