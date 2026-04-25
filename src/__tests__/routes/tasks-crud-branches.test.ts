import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { taskExecutor } from "../../services/task-executor/index.js";
import { tasks as tasksTable, projects } from "../../db/schema.js";
import Database from "better-sqlite3";

vi.spyOn(taskExecutor, "execute").mockImplementation(async () => {});
vi.spyOn(taskExecutor, "cancel").mockImplementation(() => true);

let db: FlockctlDb;
let sqlite: Database.Database;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
});

afterAll(() => {
  sqlite.close();
});

beforeEach(() => {
  sqlite.exec(`DELETE FROM tasks; DELETE FROM projects;`);
});

describe("tasks/crud — branch coverage gaps", () => {
  it("POST /tasks accepts acceptanceCriteria=null (clears field)", async () => {
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "hi",
        acceptanceCriteria: null,
        decisionTable: null,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeGreaterThan(0);
  });

  it("POST /tasks rejects body with disabledSkills (removed)", async () => {
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "x", disabledSkills: [] }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /tasks rejects body with disabledMcpServers (removed)", async () => {
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "x", disabledMcpServers: [] }),
    });
    expect(res.status).toBe(422);
  });

  it("PUT /tasks/:id accepts explicit null to clear decisionTable", async () => {
    const t = db.insert(tasksTable).values({ prompt: "x", acceptanceCriteria: JSON.stringify(["a"]), decisionTable: JSON.stringify([{ condition: "c", action: "a" }]) } as any).returning().get()!;
    const res = await app.request(`/tasks/${t.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acceptanceCriteria: null, decisionTable: null }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.acceptanceCriteria).toBeNull();
    expect(body.decisionTable).toBeNull();
  });

  it("PUT /tasks/:id returns 404 for missing task", async () => {
    const res = await app.request(`/tasks/999999`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("PUT /tasks/:id with malformed body (non-JSON) is treated as empty", async () => {
    const t = db.insert(tasksTable).values({ prompt: "x" } as any).returning().get()!;
    const res = await app.request(`/tasks/${t.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(200);
  });

  it("POST /tasks/:id/cancel rejects already-done task", async () => {
    const t = db.insert(tasksTable).values({ prompt: "x", status: "done" } as any).returning().get()!;
    const res = await app.request(`/tasks/${t.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(422);
  });

  it("POST /tasks/:id/cancel 404s for missing task", async () => {
    const res = await app.request(`/tasks/999999/cancel`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST /tasks/:id/approve rejects task with no pending_approval status", async () => {
    const t = db.insert(tasksTable).values({ prompt: "x", status: "done" } as any).returning().get()!;
    const res = await app.request(`/tasks/${t.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "ok" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /tasks/:id/approve 404s for missing task", async () => {
    const res = await app.request(`/tasks/999999/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("POST /tasks/:id/approve accepts malformed body (empty note)", async () => {
    const t = db.insert(tasksTable).values({ prompt: "x", status: "pending_approval" } as any).returning().get()!;
    const res = await app.request(`/tasks/${t.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(200);
  });

  it("POST /tasks/:id/reject 404s for missing task", async () => {
    const res = await app.request(`/tasks/999999/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("POST /tasks/:id/reject writes 'Rejected: no reason' when note missing", async () => {
    const t = db.insert(tasksTable).values({
      prompt: "x",
      status: "pending_approval",
    } as any).returning().get()!;
    const res = await app.request(`/tasks/${t.id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(200);
    const row = sqlite.prepare("SELECT error_message FROM tasks WHERE id = ?").get(t.id) as { error_message: string };
    expect(row.error_message).toBe("Rejected: no reason");
  });

  it("POST /tasks/:id/reject rejects task not in pending_approval", async () => {
    const t = db.insert(tasksTable).values({ prompt: "x", status: "done" } as any).returning().get()!;
    const res = await app.request(`/tasks/${t.id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "bad" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /tasks/:id/rerun 404s for missing task", async () => {
    const res = await app.request(`/tasks/999999/rerun`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST /tasks/:id/rerun with original.label=null produces 'rerun-<id>' label", async () => {
    const t = db.insert(tasksTable).values({ prompt: "x", label: null } as any).returning().get()!;
    const res = await app.request(`/tasks/${t.id}/rerun`, { method: "POST" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.label).toBe(`rerun-${t.id}`);
  });

  it("POST /tasks/:id/rerun preserves 'rerun-<original>' label when set", async () => {
    const t = db.insert(tasksTable).values({ prompt: "x", label: "my-label" } as any).returning().get()!;
    const res = await app.request(`/tasks/${t.id}/rerun`, { method: "POST" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.label).toBe("rerun-my-label");
  });

  it("GET /tasks/:id 404s for missing task", async () => {
    const res = await app.request(`/tasks/999999`);
    expect(res.status).toBe(404);
  });

  it("GET /tasks/stats returns zero/null when no tasks", async () => {
    const res = await app.request(`/tasks/stats`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(0);
    expect(body.failedRerun).toBe(0);
    expect(body.supersededFailures).toBe(0);
    expect(body.buildAfterRerun).toBe(0);
    expect(body.avgDurationSeconds).toBeNull();
  });

  it("GET /tasks/stats includes failedRerun, supersededFailures, buildAfterRerun", async () => {
    const parent = db.insert(tasksTable).values({ prompt: "parent", status: "failed" } as any).returning().get()!;
    db.insert(tasksTable).values({ prompt: "child-done", status: "done", parentTaskId: parent.id } as any).run();
    // An un-superseded failure
    db.insert(tasksTable).values({ prompt: "lonely-fail", status: "failed" } as any).run();

    const res = await app.request(`/tasks/stats`);
    const body = await res.json();
    // parent is failed AND has a child row
    expect(body.failedRerun).toBeGreaterThanOrEqual(1);
    // parent is failed with a done child → superseded
    expect(body.supersededFailures).toBeGreaterThanOrEqual(1);
    // child is done AND has parentTaskId → buildAfterRerun
    expect(body.buildAfterRerun).toBeGreaterThanOrEqual(1);
  });

  it("GET /tasks?include_superseded=true returns superseded failures", async () => {
    const parent = db.insert(tasksTable).values({ prompt: "p", status: "failed" } as any).returning().get()!;
    db.insert(tasksTable).values({ prompt: "c", status: "done", parentTaskId: parent.id } as any).run();
    const listDefault = await (await app.request(`/tasks`)).json();
    const listAll = await (await app.request(`/tasks?include_superseded=true`)).json();
    expect(listAll.total).toBeGreaterThanOrEqual(listDefault.total);
  });

  it("PATCH /tasks/:id 404s for missing task", async () => {
    const res = await app.request(`/tasks/999999`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});
