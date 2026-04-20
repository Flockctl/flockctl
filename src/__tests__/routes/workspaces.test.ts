import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let db: FlockctlDb;
let sqlite: Database.Database;
let tempDir: string;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  tempDir = mkdtempSync(join(tmpdir(), "flockctl-ws-test-"));
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
