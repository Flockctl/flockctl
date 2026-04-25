import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestDb, seedActiveKey } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { workspaces, projects, tasks, usageRecords } from "../../db/schema.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
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
let keyId: number;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  tempDir = mkdtempSync(join(tmpdir(), "flockctl-wsfull-"));
  // POST /workspaces and POST /workspaces/:id/projects require at least one
  // active key in allowedKeyIds (see src/routes/_allowed-keys.ts).
  keyId = seedActiveKey(sqlite);
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

  it("GET /workspaces/:id/config reads from .flockctl/config.json", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-cfg-"));
    mkdirSync(join(wsPath, ".flockctl"), { recursive: true });
    writeFileSync(
      join(wsPath, ".flockctl", "config.json"),
      JSON.stringify({ permissionMode: "acceptEdits" }),
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
      join(wsPath, ".flockctl", "config.json"),
      JSON.stringify({
        permissionMode: "strict",
        disabledSkills: ["s1"],
        disabledMcpServers: ["m1"],
      }),
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

// NOTE: GET/PUT /workspaces/:id/agents-md coverage lives in
// src/__tests__/routes/agents-md.test.ts — the endpoint now returns a
// per-layer shape (`{layers: {"workspace-public", "workspace-private"}}`)
// and the PUT body takes a `{layer, content}` pair.

describe("workspaces — TODO.md endpoints", () => {
  it("POST /workspaces seeds TODO.md at workspace root", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-todo-seed-"));
    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ws-todo-seed", path: wsPath, allowedKeyIds: [keyId] }),
    });
    expect(res.status).toBe(201);
    const p = join(wsPath, "TODO.md");
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf-8")).toContain("# TODO");
  });

  it("POST /workspaces does not overwrite existing TODO.md", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-todo-keep-"));
    writeFileSync(join(wsPath, "TODO.md"), "keep me");
    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ws-todo-keep", path: wsPath, allowedKeyIds: [keyId] }),
    });
    expect(res.status).toBe(201);
    expect(readFileSync(join(wsPath, "TODO.md"), "utf-8")).toBe("keep me");
  });

  it("POST /workspaces/:id/projects seeds TODO.md in the nested project dir", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-nested-todo-"));
    const ws = db.insert(workspaces).values({ name: "ws-nested", path: wsPath }).returning().get()!;
    const res = await app.request(`/workspaces/${ws.id}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nested-proj", allowedKeyIds: [keyId] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(existsSync(join(body.path, "TODO.md"))).toBe(true);
  });

  it("GET /workspaces/:id/todo reads TODO.md", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-todo-read-"));
    writeFileSync(join(wsPath, "TODO.md"), "work stream");
    const ws = db.insert(workspaces).values({ name: "ws-todo-read", path: wsPath }).returning().get()!;
    const res = await app.request(`/workspaces/${ws.id}/todo`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("work stream");
    expect(body.path).toBe(join(wsPath, "TODO.md"));
  });

  it("GET /workspaces/:id/todo returns empty shape when workspace has no path", async () => {
    const ws = db.insert(workspaces).values({ name: "ws-todo-nopath", path: "" }).returning().get()!;
    const res = await app.request(`/workspaces/${ws.id}/todo`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("");
    expect(body.path).toBe("");
  });

  it("PUT /workspaces/:id/todo saves content and reads it back", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-todo-put-"));
    const ws = db.insert(workspaces).values({ name: "ws-todo-put", path: wsPath }).returning().get()!;
    const res = await app.request(`/workspaces/${ws.id}/todo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# WS TODO" }),
    });
    expect(res.status).toBe(200);
    expect(readFileSync(join(wsPath, "TODO.md"), "utf-8")).toBe("# WS TODO");
  });

  it("PUT /workspaces/:id/todo rejects oversized content", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-todo-big-"));
    const ws = db.insert(workspaces).values({ name: "ws-todo-big", path: wsPath }).returning().get()!;
    const res = await app.request(`/workspaces/${ws.id}/todo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x".repeat(300_000) }),
    });
    expect(res.status).toBe(422);
  });

  it("PUT /workspaces/:id/todo — non-string content coerced to ''", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-todo-nonstr-"));
    const ws = db.insert(workspaces).values({ name: "ws-todo-nonstr", path: wsPath }).returning().get()!;
    const res = await app.request(`/workspaces/${ws.id}/todo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: 7 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("");
  });

  it("PUT /workspaces/:id/todo 422 when workspace has no path", async () => {
    const ws = db.insert(workspaces).values({ name: "ws-todo-nopath-put", path: "" }).returning().get()!;
    const res = await app.request(`/workspaces/${ws.id}/todo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(422);
  });

  it("404 for unknown workspace on todo GET/PUT", async () => {
    const g = await app.request(`/workspaces/9999/todo`);
    expect(g.status).toBe(404);
    const p = await app.request(`/workspaces/9999/todo`, {
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
      body: JSON.stringify({ name: "existing-ws", path: wsPath, allowedKeyIds: [keyId] }),
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
      body: JSON.stringify({ name: "no-remote-ws", path: wsPath, allowedKeyIds: [keyId] }),
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
      body: JSON.stringify({ name: "no-git-ws", path: wsPath, allowedKeyIds: [keyId] }),
    });
    expect(res.status).toBe(201);
  });

  it("permissionMode in POST body gets persisted to config.json", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-pm-"));
    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "pm-ws", path: wsPath,
        permissionMode: "bypassPermissions",
        allowedKeyIds: [keyId],
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
