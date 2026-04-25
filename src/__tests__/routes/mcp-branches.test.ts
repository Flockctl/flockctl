import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { workspaces, projects } from "../../db/schema.js";
import Database from "better-sqlite3";

let db: FlockctlDb;
let sqlite: Database.Database;
let homeBase: string;
let origEnv: string | undefined;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  origEnv = process.env.FLOCKCTL_HOME;
  homeBase = mkdtempSync(join(tmpdir(), "flockctl-mcp-branches-"));
  process.env.FLOCKCTL_HOME = homeBase;
});

afterAll(() => {
  sqlite.close();
  if (origEnv === undefined) delete process.env.FLOCKCTL_HOME;
  else process.env.FLOCKCTL_HOME = origEnv;
  try { rmSync(homeBase, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  sqlite.exec(`DELETE FROM projects; DELETE FROM workspaces;`);
});

describe("MCP routes — branch coverage gaps", () => {
  it("workspace POST disabled-mcp returns 422 on non-object body", async () => {
    const wsPath = mkdtempSync(join(tmpdir(), "mcp-ws-b-"));
    const ws = db.insert(workspaces).values({ name: `ws-b-${Date.now()}`, path: wsPath }).returning().get()!;
    const res = await app.request(`/mcp/workspaces/${ws.id}/disabled-mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(422);
  });

  it("workspace DELETE disabled-mcp with empty config returns empty list", async () => {
    const wsPath = mkdtempSync(join(tmpdir(), "mcp-ws-del-"));
    const ws = db.insert(workspaces).values({ name: `ws-del-${Date.now()}`, path: wsPath }).returning().get()!;
    // DELETE with nothing in cfg → exercises `cfg.disabledMcpServers ?? []` null-coalesce
    const res = await app.request(`/mcp/workspaces/${ws.id}/disabled-mcp`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "global" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disabledMcpServers).toEqual([]);
  });

  it("workspace GET disabled-mcp with workspace.path=null falls back to {} config", async () => {
    // Insert workspace row directly with empty path — routes skip the loadWorkspaceConfig branch
    sqlite.prepare("INSERT INTO workspaces (name, path) VALUES (?, ?)")
      .run(`ws-nopath-${Date.now()}`, "");
    const row = sqlite.prepare("SELECT id FROM workspaces ORDER BY id DESC LIMIT 1").get() as { id: number };
    const res = await app.request(`/mcp/workspaces/${row.id}/disabled-mcp`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disabledMcpServers).toEqual([]);
  });

  it("project DELETE disabled-mcp with empty cfg returns empty list", async () => {
    const projPath = mkdtempSync(join(tmpdir(), "mcp-proj-del-"));
    const p = db.insert(projects).values({ name: `p-del-${Date.now()}`, path: projPath }).returning().get()!;
    const res = await app.request(`/mcp/projects/${p.id}/disabled-mcp`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "project" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).disabledMcpServers).toEqual([]);
  });

  it("project GET disabled-mcp with null project.path falls back to {} config", async () => {
    const p = db.insert(projects).values({ name: `p-nopath-${Date.now()}` }).returning().get()!;
    const res = await app.request(`/mcp/projects/${p.id}/disabled-mcp`);
    expect(res.status).toBe(200);
    expect((await res.json()).disabledMcpServers).toEqual([]);
  });

  it("project POST disabled-mcp returns 422 when project has no path", async () => {
    const p = db.insert(projects).values({ name: `p-nopath-2-${Date.now()}` }).returning().get()!;
    const res = await app.request(`/mcp/projects/${p.id}/disabled-mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "global" }),
    });
    expect(res.status).toBe(422);
  });

  it("project DELETE disabled-mcp 404s for unknown project", async () => {
    const res = await app.request(`/mcp/projects/999999/disabled-mcp`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "project" }),
    });
    expect(res.status).toBe(404);
  });

  it("project DELETE disabled-mcp returns 422 when project has no path", async () => {
    const p = db.insert(projects).values({ name: `p-nopath-del-${Date.now()}` }).returning().get()!;
    const res = await app.request(`/mcp/projects/${p.id}/disabled-mcp`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "global" }),
    });
    expect(res.status).toBe(422);
  });

  it("GET /mcp/resolved with taskId but no project still returns array", async () => {
    const res = await app.request("/mcp/resolved?projectId=999999");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});
