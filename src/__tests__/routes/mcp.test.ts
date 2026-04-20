import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { workspaces, projects, tasks } from "../../db/schema.js";
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
  homeBase = mkdtempSync(join(tmpdir(), "flockctl-mcp-"));
  process.env.FLOCKCTL_HOME = homeBase;
});

afterAll(() => {
  sqlite.close();
  if (origEnv === undefined) delete process.env.FLOCKCTL_HOME;
  else process.env.FLOCKCTL_HOME = origEnv;
  try { rmSync(homeBase, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM tasks;
    DELETE FROM projects;
    DELETE FROM workspaces;
  `);
  // Reset global MCP dir each test
  const globalMcp = join(homeBase, "mcp");
  try { rmSync(globalMcp, { recursive: true, force: true }); } catch {}
});

describe("GET /mcp/global", () => {
  it("returns empty array when no global MCP servers", async () => {
    const res = await app.request("/mcp/global");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("lists global MCP servers", async () => {
    const globalMcp = join(homeBase, "mcp");
    mkdirSync(globalMcp, { recursive: true });
    writeFileSync(join(globalMcp, "server1.json"), JSON.stringify({ command: "echo" }));

    const res = await app.request("/mcp/global");
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("server1");
    expect(body[0].level).toBe("global");
  });
});

describe("POST /mcp/global", () => {
  it("creates a global MCP server file", async () => {
    const res = await app.request("/mcp/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "myserver", config: { command: "npx", args: ["foo"] } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("myserver");
    expect(body.level).toBe("global");
    expect(body.saved).toBe(true);

    // Verify file written
    const filePath = join(homeBase, "mcp", "myserver.json");
    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual({ command: "npx", args: ["foo"] });
  });

  it("returns 400 when name missing", async () => {
    const res = await app.request("/mcp/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: {} }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 400 when config missing", async () => {
    const res = await app.request("/mcp/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "a" }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects names with path separators", async () => {
    const res = await app.request("/mcp/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "../evil", config: {} }),
    });
    expect(res.status).toBe(422);
  });
});

describe("DELETE /mcp/global/:name", () => {
  it("deletes an existing global MCP server", async () => {
    const globalMcp = join(homeBase, "mcp");
    mkdirSync(globalMcp, { recursive: true });
    writeFileSync(join(globalMcp, "todelete.json"), "{}");

    const res = await app.request("/mcp/global/todelete", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(existsSync(join(globalMcp, "todelete.json"))).toBe(false);
  });

  it("returns 404 when server does not exist", async () => {
    const res = await app.request("/mcp/global/nothere", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("GET /mcp/resolved", () => {
  it("resolves servers with no projectId", async () => {
    const res = await app.request("/mcp/resolved");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("resolves servers for a valid projectId", async () => {
    const p = db.insert(projects).values({ name: "p" }).returning().get()!;
    const res = await app.request(`/mcp/resolved?projectId=${p.id}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("resolves servers for a valid taskId", async () => {
    const p = db.insert(projects).values({ name: "p" }).returning().get()!;
    const t = db.insert(tasks).values({ projectId: p.id } as any).returning().get()!;
    const res = await app.request(`/mcp/resolved?taskId=${t.id}`);
    expect(res.status).toBe(200);
  });
});

describe("Workspace MCP routes", () => {
  let wsId: number;
  let wsPath: string;

  beforeEach(() => {
    wsPath = mkdtempSync(join(tmpdir(), "ws-mcp-"));
    wsId = db.insert(workspaces).values({ name: `ws-${Date.now()}`, path: wsPath }).returning().get()!.id;
  });

  it("GET /mcp/workspaces/:id/servers returns 404 for unknown workspace", async () => {
    const res = await app.request("/mcp/workspaces/99999/servers");
    expect(res.status).toBe(404);
  });

  it("GET returns empty array for workspace with no servers", async () => {
    const res = await app.request(`/mcp/workspaces/${wsId}/servers`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("POST creates workspace MCP server", async () => {
    const res = await app.request(`/mcp/workspaces/${wsId}/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "srv", config: { command: "x" } }),
    });
    expect(res.status).toBe(201);
    expect(existsSync(join(wsPath, ".flockctl", "mcp", "srv.json"))).toBe(true);
  });

  it("POST returns 404 for unknown workspace", async () => {
    const res = await app.request("/mcp/workspaces/99999/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", config: {} }),
    });
    expect(res.status).toBe(404);
  });

  it("POST rejects invalid name", async () => {
    const res = await app.request(`/mcp/workspaces/${wsId}/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "../../etc/passwd", config: {} }),
    });
    expect(res.status).toBe(422);
  });

  it("DELETE removes workspace MCP server", async () => {
    mkdirSync(join(wsPath, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(join(wsPath, ".flockctl", "mcp", "kill.json"), "{}");
    const res = await app.request(`/mcp/workspaces/${wsId}/servers/kill`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(existsSync(join(wsPath, ".flockctl", "mcp", "kill.json"))).toBe(false);
  });

  it("DELETE returns 404 when not found", async () => {
    const res = await app.request(`/mcp/workspaces/${wsId}/servers/absent`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("disable/enable toggles workspace disabled list with {name, level}", async () => {
    const addRes = await app.request(`/mcp/workspaces/${wsId}/disabled-mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bad-server", level: "global" }),
    });
    expect(addRes.status).toBe(200);
    const addList = (await addRes.json()).disabledMcpServers;
    expect(addList).toContainEqual({ name: "bad-server", level: "global" });

    const listRes = await app.request(`/mcp/workspaces/${wsId}/disabled-mcp`);
    const list = (await listRes.json()).disabledMcpServers;
    expect(list).toContainEqual({ name: "bad-server", level: "global" });

    // Idempotent
    await app.request(`/mcp/workspaces/${wsId}/disabled-mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bad-server", level: "global" }),
    });
    const after = await app.request(`/mcp/workspaces/${wsId}/disabled-mcp`);
    const afterList = (await after.json()).disabledMcpServers;
    expect(afterList.filter((e: any) => e.name === "bad-server" && e.level === "global")).toHaveLength(1);

    const rmRes = await app.request(`/mcp/workspaces/${wsId}/disabled-mcp`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bad-server", level: "global" }),
    });
    expect(rmRes.status).toBe(200);
    expect((await rmRes.json()).disabledMcpServers).not.toContainEqual({ name: "bad-server", level: "global" });
  });

  it("disable POST returns 422 when name missing", async () => {
    const res = await app.request(`/mcp/workspaces/${wsId}/disabled-mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "global" }),
    });
    expect(res.status).toBe(422);
  });

  it("disable routes return 404 for unknown workspace", async () => {
    const getRes = await app.request("/mcp/workspaces/999/disabled-mcp");
    expect(getRes.status).toBe(404);

    const postRes = await app.request("/mcp/workspaces/999/disabled-mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "global" }),
    });
    expect(postRes.status).toBe(404);
  });
});

describe("Project MCP routes", () => {
  let pid: number;
  let projPath: string;

  beforeEach(() => {
    projPath = mkdtempSync(join(tmpdir(), "proj-mcp-"));
    pid = db.insert(projects).values({ name: `proj-${Date.now()}`, path: projPath }).returning().get()!.id;
  });

  it("GET /mcp/workspaces/:wid/projects/:pid/servers returns 404 when no project path", async () => {
    const noPathId = db.insert(projects).values({ name: "nopath" }).returning().get()!.id;
    const res = await app.request(`/mcp/workspaces/1/projects/${noPathId}/servers`);
    expect(res.status).toBe(404);
  });

  it("GET returns empty for project with no servers", async () => {
    const res = await app.request(`/mcp/workspaces/1/projects/${pid}/servers`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("POST creates project MCP server", async () => {
    const res = await app.request(`/mcp/workspaces/1/projects/${pid}/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "psrv", config: { command: "y" } }),
    });
    expect(res.status).toBe(201);
    expect(existsSync(join(projPath, ".flockctl", "mcp", "psrv.json"))).toBe(true);
  });

  it("POST returns 400 when config missing", async () => {
    const res = await app.request(`/mcp/workspaces/1/projects/${pid}/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "a" }),
    });
    expect(res.status).toBe(422);
  });

  it("DELETE removes project MCP server", async () => {
    mkdirSync(join(projPath, ".flockctl", "mcp"), { recursive: true });
    writeFileSync(join(projPath, ".flockctl", "mcp", "kill.json"), "{}");
    const res = await app.request(`/mcp/workspaces/1/projects/${pid}/servers/kill`, { method: "DELETE" });
    expect(res.status).toBe(200);
  });

  it("DELETE returns 404 when file missing", async () => {
    const res = await app.request(`/mcp/workspaces/1/projects/${pid}/servers/absent`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("disable/enable toggles project disabled list with {name, level}", async () => {
    await app.request(`/mcp/projects/${pid}/disabled-mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "srv-x", level: "project" }),
    });
    const list = await (await app.request(`/mcp/projects/${pid}/disabled-mcp`)).json();
    expect(list.disabledMcpServers).toContainEqual({ name: "srv-x", level: "project" });

    await app.request(`/mcp/projects/${pid}/disabled-mcp`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "srv-x", level: "project" }),
    });
    const after = await (await app.request(`/mcp/projects/${pid}/disabled-mcp`)).json();
    expect(after.disabledMcpServers).not.toContainEqual({ name: "srv-x", level: "project" });
  });

  it("disable routes return 404 for unknown project", async () => {
    const getRes = await app.request("/mcp/projects/999/disabled-mcp");
    expect(getRes.status).toBe(404);

    const postRes = await app.request("/mcp/projects/999/disabled-mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", level: "global" }),
    });
    expect(postRes.status).toBe(404);
  });

  it("disable POST returns 422 when level is invalid", async () => {
    const res = await app.request(`/mcp/projects/${pid}/disabled-mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "srv", level: "garbage" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error || body.message).toMatch(/level/i);
  });

  it("workspace disable POST returns 422 when level is 'project' (out of scope)", async () => {
    // workspace endpoint allows only global|workspace; project must be rejected
    const wsTmp = mkdtempSync(join(tmpdir(), "ws-mcp-scope-"));
    const wsScope = db.insert(workspaces).values({
      name: `ws-scope-${Date.now()}`,
      path: wsTmp,
    }).returning().get()!;
    const res = await app.request(`/mcp/workspaces/${wsScope.id}/disabled-mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "srv", level: "project" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error || body.message).toMatch(/scope|level/i);
  });
});

// Task-level MCP disable routes were removed — MCP disables only exist at
// workspace or project level in the new reconciler architecture.
