import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { workspaces, projects, tasks, usageRecords } from "../../db/schema.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("child_process", async () => {
  const actual = await vi.importActual<any>("child_process");
  return { ...actual, execSync: vi.fn(actual.execSync) };
});

import { app } from "../../server.js";
import { execSync } from "child_process";

let db: FlockctlDb;
let sqlite: Database.Database;
let tempDir: string;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  tempDir = mkdtempSync(join(tmpdir(), "flockctl-wsfull-"));
});

afterAll(() => {
  sqlite.close();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM usage_records;
    DELETE FROM tasks;
    DELETE FROM projects;
    DELETE FROM workspaces;
  `);
  (execSync as any).mockReset();
  (execSync as any).mockImplementation(() => Buffer.from(""));
});

describe("workspaces — config endpoints", () => {
  it("GET /workspaces/:id/config returns {} for workspace without path", async () => {
    const ws = db.insert(workspaces).values({
      name: "np", path: "/tmp/ws-nopath-" + Date.now(),
    }).returning().get()!;
    // Clear path to trigger empty-config branch
    sqlite.prepare("UPDATE workspaces SET path='' WHERE id=?").run(ws.id);

    const res = await app.request(`/workspaces/${ws.id}/config`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("GET /workspaces/:id/config reads from .flockctl/config.yaml", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-cfg-"));
    mkdirSync(join(wsPath, ".flockctl"), { recursive: true });
    writeFileSync(
      join(wsPath, ".flockctl", "config.yaml"),
      "permissionMode: acceptEdits\n",
    );
    const ws = db.insert(workspaces).values({
      name: "c1", path: wsPath,
    }).returning().get()!;

    const res = await app.request(`/workspaces/${ws.id}/config`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.permissionMode).toBe("acceptEdits");
  });

  it("PUT /workspaces/:id/config merges permissionMode and disabledSkills", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-put-cfg-"));
    mkdirSync(join(wsPath, ".flockctl"), { recursive: true });
    const ws = db.insert(workspaces).values({
      name: "c2", path: wsPath,
    }).returning().get()!;

    const res = await app.request(`/workspaces/${ws.id}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        permissionMode: "bypassPermissions",
        disabledSkills: ["s1", "s2"],
        disabledMcpServers: ["m1"],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.permissionMode).toBe("bypassPermissions");
    expect(body.disabledSkills).toEqual(["s1", "s2"]);
    expect(body.disabledMcpServers).toEqual(["m1"]);
  });

  it("PUT /workspaces/:id/config clears keys when body value is null/empty/[]", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-put-clear-"));
    mkdirSync(join(wsPath, ".flockctl"), { recursive: true });
    writeFileSync(
      join(wsPath, ".flockctl", "config.yaml"),
      "permissionMode: strict\ndisabledSkills:\n  - s1\ndisabledMcpServers:\n  - m1\n",
    );
    const ws = db.insert(workspaces).values({
      name: "c3", path: wsPath,
    }).returning().get()!;

    const res = await app.request(`/workspaces/${ws.id}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        permissionMode: null,
        disabledSkills: [],
        disabledMcpServers: "",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.permissionMode).toBeUndefined();
    expect(body.disabledSkills).toBeUndefined();
    expect(body.disabledMcpServers).toBeUndefined();
  });

  it("PUT /workspaces/:id/config requires workspace path", async () => {
    const ws = db.insert(workspaces).values({ name: "pp", path: "/tmp/p" }).returning().get()!;
    sqlite.prepare("UPDATE workspaces SET path='' WHERE id=?").run(ws.id);

    const res = await app.request(`/workspaces/${ws.id}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionMode: "acceptEdits" }),
    });
    expect(res.status).toBe(422);
  });

  it("GET/PUT /workspaces/:id/config — 404 when workspace missing", async () => {
    const g = await app.request(`/workspaces/99999/config`);
    expect(g.status).toBe(404);
    const p = await app.request(`/workspaces/99999/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(p.status).toBe(404);
  });
});

describe("workspaces — agents-md endpoints", () => {
  it("GET /workspaces/:id/agents-md returns blank source/effective initially", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-md-"));
    const ws = db.insert(workspaces).values({
      name: "md1", path: wsPath,
    }).returning().get()!;

    const res = await app.request(`/workspaces/${ws.id}/agents-md`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.source).toBe("string");
    expect(typeof body.effective).toBe("string");
  });

  it("GET /workspaces/:id/agents-md returns {source:'', effective:''} when no path", async () => {
    const ws = db.insert(workspaces).values({ name: "md-np", path: "/tmp" }).returning().get()!;
    sqlite.prepare("UPDATE workspaces SET path='' WHERE id=?").run(ws.id);

    const res = await app.request(`/workspaces/${ws.id}/agents-md`);
    const body = await res.json();
    expect(body.source).toBe("");
    expect(body.effective).toBe("");
  });

  it("PUT /workspaces/:id/agents-md saves source and returns both", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-md-put-"));
    const ws = db.insert(workspaces).values({
      name: "md2", path: wsPath,
    }).returning().get()!;

    const res = await app.request(`/workspaces/${ws.id}/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Header" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toContain("# Header");
  });

  it("PUT /workspaces/:id/agents-md rejects oversized content", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-md-big-"));
    const ws = db.insert(workspaces).values({
      name: "md3", path: wsPath,
    }).returning().get()!;

    const res = await app.request(`/workspaces/${ws.id}/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x".repeat(300_000) }),
    });
    expect(res.status).toBe(422);
  });

  it("PUT /workspaces/:id/agents-md — non-string content coerced to ''", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-md-non-"));
    const ws = db.insert(workspaces).values({
      name: "md4", path: wsPath,
    }).returning().get()!;

    const res = await app.request(`/workspaces/${ws.id}/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: 12345 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("");
  });

  it("PUT /workspaces/:id/agents-md — requires path", async () => {
    const ws = db.insert(workspaces).values({ name: "md-np", path: "/tmp" }).returning().get()!;
    sqlite.prepare("UPDATE workspaces SET path='' WHERE id=?").run(ws.id);

    const res = await app.request(`/workspaces/${ws.id}/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(422);
  });

  it("404 for unknown workspace on agents-md GET/PUT", async () => {
    const g = await app.request(`/workspaces/999/agents-md`);
    expect(g.status).toBe(404);
    const p = await app.request(`/workspaces/999/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(p.status).toBe(404);
  });
});

describe("workspaces — POST existing dir resolves remote url", () => {
  it("reads remote via git when dir already has .git", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-remote-"));
    mkdirSync(join(wsPath, ".git"), { recursive: true });
    (execSync as any).mockImplementation((cmd: string) => {
      if (cmd.startsWith("git remote get-url")) return Buffer.from("git@example.com:foo/bar.git\n");
      return Buffer.from("");
    });

    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "existing-ws", path: wsPath }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.repoUrl).toBe("git@example.com:foo/bar.git");
  });

  it("falls back to null repoUrl when 'origin' remote missing", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-no-origin-"));
    mkdirSync(join(wsPath, ".git"), { recursive: true });
    (execSync as any).mockImplementation(() => { throw new Error("no remote"); });

    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no-remote-ws", path: wsPath }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.repoUrl).toBeNull();
  });

  it("swallows 'git init' errors in non-git dirs", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-git-init-"));
    (execSync as any).mockImplementation((cmd: string) => {
      if (cmd.startsWith("git init")) throw new Error("git not installed");
      return Buffer.from("");
    });

    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no-git-ws", path: wsPath }),
    });
    expect(res.status).toBe(201);
  });

  it("permissionMode in POST body gets persisted to config.yaml", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-pm-"));
    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "pm-ws", path: wsPath,
        permissionMode: "bypassPermissions",
      }),
    });
    expect(res.status).toBe(201);

    const cfgRes = await app.request(`/workspaces/${(await res.json()).id}/config`);
    const cfg = await cfgRes.json();
    expect(cfg.permissionMode).toBe("bypassPermissions");
  });
});

describe("workspaces — PATCH permissionMode paths", () => {
  it("sets and unsets permissionMode via PATCH (null = delete)", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-patch-pm-"));
    const ws = db.insert(workspaces).values({
      name: "patch-pm", path: wsPath,
    }).returning().get()!;

    await app.request(`/workspaces/${ws.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionMode: "acceptEdits" }),
    });
    const g1 = await (await app.request(`/workspaces/${ws.id}/config`)).json();
    expect(g1.permissionMode).toBe("acceptEdits");

    await app.request(`/workspaces/${ws.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionMode: null }),
    });
    const g2 = await (await app.request(`/workspaces/${ws.id}/config`)).json();
    expect(g2.permissionMode).toBeUndefined();
  });
});

describe("workspaces — DELETE project 404 paths", () => {
  it("404 when workspace missing", async () => {
    const res = await app.request(`/workspaces/99/projects/1`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("404 when project not linked to workspace", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-del-"));
    const ws = db.insert(workspaces).values({ name: "d", path: wsPath }).returning().get()!;
    const other = db.insert(projects).values({ name: "p-other" }).returning().get()!;

    const res = await app.request(`/workspaces/${ws.id}/projects/${other.id}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("workspaces — dashboard with real data", () => {
  it("aggregates tasks, usage, and activity across projects", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-dash-"));
    const ws = db.insert(workspaces).values({ name: "dash", path: wsPath }).returning().get()!;
    const p1 = db.insert(projects).values({ name: "p1", workspaceId: ws.id, path: join(wsPath, "p1") }).returning().get()!;
    const p2 = db.insert(projects).values({ name: "p2", workspaceId: ws.id }).returning().get()!;

    db.insert(tasks).values([
      { projectId: p1.id, status: "running" } as any,
      { projectId: p1.id, status: "completed" } as any,
      { projectId: p2.id, status: "failed", completedAt: "2026-04-10T00:00:00Z" } as any,
      { projectId: p2.id, status: "completed", completedAt: "2026-04-11T00:00:00Z", label: "T-done" } as any,
    ]).run();

    db.insert(usageRecords).values([
      { projectId: p1.id, provider: "anthropic", model: "haiku", inputTokens: 100, outputTokens: 200, totalCostUsd: 0.5 } as any,
      { projectId: p2.id, provider: "anthropic", model: "sonnet", inputTokens: 50, outputTokens: 75, totalCostUsd: 1.25 } as any,
    ]).run();

    const res = await app.request(`/workspaces/${ws.id}/dashboard`);
    const dash = await res.json();

    expect(dash.project_count).toBe(2);
    expect(dash.active_tasks).toBe(1);
    expect(dash.failed_tasks).toBe(1);
    expect(dash.total_cost_usd).toBeCloseTo(1.75, 2);
    expect(dash.total_input_tokens).toBe(150);
    expect(dash.total_output_tokens).toBe(275);
    expect(dash.cost_by_project.length).toBe(2);
    expect(dash.recent_activity.length).toBeGreaterThan(0);
    expect(dash.project_summaries.length).toBe(2);
  });
});

// keep unused imports silent
void existsSync;
