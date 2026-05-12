import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../server.js";
import { createTestDb, seedActiveKey } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let db: FlockctlDb;
let sqlite: Database.Database;
let tempDir: string;
let keyId: number;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  tempDir = mkdtempSync(join(tmpdir(), "flockctl-ws-test-"));
  // POST /workspaces and POST /workspaces/:id/projects now require at
  // least one active AI-provider key in allowedKeyIds. See
  // src/routes/_allowed-keys.ts for the exact contract.
  keyId = seedActiveKey(sqlite);
});

afterAll(() => {
  sqlite.close();
  try { rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
});

describe("Workspaces routes", () => {
  it("GET /workspaces returns empty list", async () => {
    const res = await app.request("/workspaces");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  it("POST /workspaces creates a workspace", async () => {
    const wsPath = join(tempDir, "my-workspace");
    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test Workspace",
        description: "A test workspace",
        path: wsPath,
        allowedKeyIds: [keyId],
      }),
    });
    expect(res.status).toBe(201);
    const ws = await res.json();
    expect(ws.name).toBe("Test Workspace");
    expect(ws.path).toBe(wsPath);
  });

  it("GET /workspaces/:id returns workspace with projects", async () => {
    const res = await app.request("/workspaces/1");
    expect(res.status).toBe(200);
    const ws = await res.json();
    expect(ws.name).toBe("Test Workspace");
    expect(ws.projects).toEqual([]);
  });

  it("POST /workspaces/:id/projects adds project", async () => {
    const res = await app.request("/workspaces/1/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "my-project",
        description: "Test project",
        allowedKeyIds: [keyId],
      }),
    });
    expect(res.status).toBe(201);
    const proj = await res.json();
    expect(proj.name).toBe("my-project");
    expect(proj.workspaceId).toBe(1);
  });

  it("GET /workspaces/:id/dashboard returns stats", async () => {
    const res = await app.request("/workspaces/1/dashboard");
    expect(res.status).toBe(200);
    const dash = await res.json();
    expect(dash.project_count).toBe(1);
    expect(dash.active_tasks).toBe(0);
  });

  it("PATCH /workspaces/:id updates workspace", async () => {
    const res = await app.request("/workspaces/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated Workspace" }),
    });
    expect(res.status).toBe(200);
    const ws = await res.json();
    expect(ws.name).toBe("Updated Workspace");
  });

  it("DELETE /workspaces/:id/projects/:projectId removes project", async () => {
    const res = await app.request("/workspaces/1/projects/1", { method: "DELETE" });
    expect(res.status).toBe(200);
  });

  it("DELETE /workspaces/:id deletes workspace", async () => {
    const res = await app.request("/workspaces/1", { method: "DELETE" });
    expect(res.status).toBe(200);
    const getRes = await app.request("/workspaces/1");
    expect(getRes.status).toBe(404);
  });

  it("POST /workspaces requires name", async () => {
    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/test" }),
    });
    expect(res.status).toBe(422);
  });
});

// ─── active_task_count aggregate on GET /workspaces ─────────────────────────
//
// The list endpoint reports per-row `active_task_count` so the UI dashboard
// can show "N running" without a fan-out of follow-up requests. The count
// MUST come from a single aggregated query (no N+1) — the spec walks
// tasks → projects → workspace_id and only `status='running'` counts.
describe("GET /workspaces active_task_count", () => {
  let isolatedDb: FlockctlDb;
  let isolatedSqlite: Database.Database;
  let isolatedTempDir: string;
  let isolatedKeyId: number;

  beforeAll(() => {
    const t = createTestDb();
    isolatedDb = t.db;
    isolatedSqlite = t.sqlite;
    setDb(isolatedDb, isolatedSqlite);
    isolatedTempDir = mkdtempSync(join(tmpdir(), "flockctl-ws-active-"));
    isolatedKeyId = seedActiveKey(isolatedSqlite);
  });

  afterAll(() => {
    isolatedSqlite.close();
    try { rmSync(isolatedTempDir, { recursive: true }); } catch { /* ignore */ }
  });

  // Helpers —— bypass the /workspaces route to avoid the filesystem side-effects
  // (mkdir, git init, .flockctl scaffolding) the POST handler triggers. We're
  // only exercising the LIST query here, not creation, so direct SQL inserts
  // keep the test focused on the SELECT shape.
  const insertWorkspace = (name: string, path: string): number => {
    const res = isolatedSqlite
      .prepare(`INSERT INTO workspaces (name, path) VALUES (?, ?)`)
      .run(name, path);
    return Number(res.lastInsertRowid);
  };
  const insertProject = (workspaceId: number | null, name: string): number => {
    const res = isolatedSqlite
      .prepare(`INSERT INTO projects (workspace_id, name) VALUES (?, ?)`)
      .run(workspaceId, name);
    return Number(res.lastInsertRowid);
  };
  const insertTask = (projectId: number, status: string): number => {
    const res = isolatedSqlite
      .prepare(`INSERT INTO tasks (project_id, status) VALUES (?, ?)`)
      .run(projectId, status);
    return Number(res.lastInsertRowid);
  };

  it("returns 0 when the workspace has no projects", async () => {
    const wsId = insertWorkspace("ws-empty", join(isolatedTempDir, "ws-empty"));
    const res = await app.request("/workspaces");
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.items.find((w: { id: number }) => w.id === wsId);
    expect(row).toBeDefined();
    expect(row.active_task_count).toBe(0);
  });

  it("returns 0 when projects exist but no task is running", async () => {
    const wsId = insertWorkspace("ws-no-running", join(isolatedTempDir, "ws-no-running"));
    const pid = insertProject(wsId, `proj-no-running-${wsId}`);
    insertTask(pid, "queued");
    insertTask(pid, "completed");
    insertTask(pid, "failed");
    insertTask(pid, "cancelled");

    const res = await app.request("/workspaces");
    const body = await res.json();
    const row = body.items.find((w: { id: number }) => w.id === wsId);
    expect(row.active_task_count).toBe(0);
  });

  it("counts only status='running' tasks across multiple projects in the workspace", async () => {
    const wsId = insertWorkspace("ws-multi-running", join(isolatedTempDir, "ws-multi-running"));
    const pidA = insertProject(wsId, `proj-multi-a-${wsId}`);
    const pidB = insertProject(wsId, `proj-multi-b-${wsId}`);
    // 2 running on A
    insertTask(pidA, "running");
    insertTask(pidA, "running");
    // 1 running on B + 2 non-running on B
    insertTask(pidB, "running");
    insertTask(pidB, "completed");
    insertTask(pidB, "queued");

    const res = await app.request("/workspaces");
    const body = await res.json();
    const row = body.items.find((w: { id: number }) => w.id === wsId);
    expect(row.active_task_count).toBe(3);
  });

  it("excludes tasks from completed / cancelled / failed / queued / timed_out", async () => {
    const wsId = insertWorkspace("ws-status-mix", join(isolatedTempDir, "ws-status-mix"));
    const pid = insertProject(wsId, `proj-status-mix-${wsId}`);
    for (const s of ["completed", "cancelled", "failed", "queued", "timed_out", "assigned"]) {
      insertTask(pid, s);
    }
    insertTask(pid, "running"); // exactly one running mixed in

    const res = await app.request("/workspaces");
    const body = await res.json();
    const row = body.items.find((w: { id: number }) => w.id === wsId);
    expect(row.active_task_count).toBe(1);
  });

  it("scopes the count to the workspace — does not leak across tenants", async () => {
    // Two sibling workspaces, each with a running task. Each row's count
    // must reflect only its own running tasks.
    const wsA = insertWorkspace("ws-tenant-a", join(isolatedTempDir, "ws-tenant-a"));
    const wsB = insertWorkspace("ws-tenant-b", join(isolatedTempDir, "ws-tenant-b"));
    const pidA = insertProject(wsA, `proj-tenant-a-${wsA}`);
    const pidB = insertProject(wsB, `proj-tenant-b-${wsB}`);
    insertTask(pidA, "running");
    insertTask(pidA, "running");
    insertTask(pidA, "running");
    insertTask(pidB, "running");

    const res = await app.request("/workspaces");
    const body = await res.json();
    const rowA = body.items.find((w: { id: number }) => w.id === wsA);
    const rowB = body.items.find((w: { id: number }) => w.id === wsB);
    expect(rowA.active_task_count).toBe(3);
    expect(rowB.active_task_count).toBe(1);
  });

  it("does not count tasks from orphaned projects (workspace_id = NULL)", async () => {
    const wsId = insertWorkspace("ws-orphan-check", join(isolatedTempDir, "ws-orphan-check"));
    const ownPid = insertProject(wsId, `proj-own-${wsId}`);
    insertTask(ownPid, "running");

    // Orphaned project — not linked to any workspace; its running task must
    // not be attributed to anyone's count.
    const orphanPid = insertProject(null, `proj-orphan-${wsId}`);
    insertTask(orphanPid, "running");
    insertTask(orphanPid, "running");

    const res = await app.request("/workspaces");
    const body = await res.json();
    const row = body.items.find((w: { id: number }) => w.id === wsId);
    expect(row.active_task_count).toBe(1);
  });

  it("uses a single aggregated query — no N+1 fan-out per workspace row", async () => {
    // Drop a few extra workspaces in to make the regression detectable.
    insertWorkspace("ws-perf-1", join(isolatedTempDir, "ws-perf-1"));
    insertWorkspace("ws-perf-2", join(isolatedTempDir, "ws-perf-2"));
    insertWorkspace("ws-perf-3", join(isolatedTempDir, "ws-perf-3"));

    // Spy on better-sqlite3 prepare() — the listing path must hit prepare()
    // a small constant number of times regardless of how many workspaces
    // are returned. An N+1 implementation would prepare one count query
    // per row, blowing this assertion up linearly with workspace count.
    const realPrepare = isolatedSqlite.prepare.bind(isolatedSqlite);
    const calls: string[] = [];
    isolatedSqlite.prepare = ((sqlText: string) => {
      calls.push(sqlText);
      return realPrepare(sqlText);
    }) as typeof isolatedSqlite.prepare;

    try {
      const res = await app.request("/workspaces");
      expect(res.status).toBe(200);
      const body = await res.json();
      // Sanity: the listing paged in at least the rows we created above.
      expect(body.items.length).toBeGreaterThanOrEqual(3);

      // Drizzle prepares the SELECT once and the count(*) once. Anything
      // beyond a small constant means the count crept back into a per-row
      // loop. We allow up to 4 to absorb any incidental session prepares
      // (e.g. PRAGMA on connection warm-up).
      const listingPrepares = calls.filter(
        (s) => /from\s+"?workspaces"?/i.test(s),
      );
      expect(listingPrepares.length).toBeLessThanOrEqual(4);
    } finally {
      isolatedSqlite.prepare = realPrepare;
    }
  });
});
