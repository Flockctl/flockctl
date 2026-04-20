import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { workspaces, projects } from "../../db/schema.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock child_process.execSync to simulate git clone outcomes
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
  tempDir = mkdtempSync(join(tmpdir(), "flockctl-wsx-"));
});

afterAll(() => {
  sqlite.close();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  sqlite.exec(`DELETE FROM projects; DELETE FROM workspaces;`);
  (execSync as any).mockClear();
});

describe("Workspaces — git clone path", () => {
  it("clones repo when repoUrl is provided", async () => {
    const wsPath = join(tempDir, "clone-target-" + Date.now());
    // Mock execSync — create the directory on "clone" to simulate success
    (execSync as any).mockImplementation((cmd: string) => {
      if (cmd.startsWith("git clone")) {
        mkdirSync(wsPath, { recursive: true });
        mkdirSync(join(wsPath, ".git"));
        return Buffer.from("");
      }
      return Buffer.from("");
    });

    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "cloned-ws",
        path: wsPath,
        repoUrl: "https://example.com/repo.git",
      }),
    });

    expect(res.status).toBe(201);
    expect(execSync).toHaveBeenCalled();
    const cloneCall = (execSync as any).mock.calls.find((c: any[]) => c[0].includes("git clone"));
    expect(cloneCall).toBeTruthy();
  });

  it("errors when target directory already contains git repo", async () => {
    const wsPath = join(tempDir, "existing-" + Date.now());
    mkdirSync(wsPath, { recursive: true });
    mkdirSync(join(wsPath, ".git"));

    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "dup-ws",
        path: wsPath,
        repoUrl: "https://example.com/repo.git",
      }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("already contains a git repository");
  });

  it("wraps git clone failure as 422", async () => {
    const wsPath = join(tempDir, "fail-" + Date.now());
    (execSync as any).mockImplementation(() => {
      const e: any = new Error("clone failed");
      e.stderr = Buffer.from("Could not resolve host");
      throw e;
    });

    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "bad-ws",
        path: wsPath,
        repoUrl: "https://invalid.example/repo.git",
      }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("Git clone failed");
  });
});

describe("Workspaces — link existing project", () => {
  it("POST /workspaces/:id/projects?project_id=X links existing project", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-link-"));
    const ws = db.insert(workspaces).values({
      name: "ws-link", path: wsPath,
    }).returning().get()!;

    const proj = db.insert(projects).values({
      name: "standalone", path: join(tempDir, "stand-" + Date.now()),
    }).returning().get()!;

    const res = await app.request(
      `/workspaces/${ws.id}/projects?project_id=${proj.id}`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaceId).toBe(ws.id);
  });

  it("returns 404 if project_id points to missing project", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-link2-"));
    const ws = db.insert(workspaces).values({
      name: "ws-link2", path: wsPath,
    }).returning().get()!;

    const res = await app.request(
      `/workspaces/${ws.id}/projects?project_id=99999`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });
});

describe("Workspaces — dashboard with no projects", () => {
  it("returns zero-filled dashboard for empty workspace", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-empty-"));
    const ws = db.insert(workspaces).values({
      name: "empty-ws", path: wsPath,
    }).returning().get()!;

    const res = await app.request(`/workspaces/${ws.id}/dashboard`);
    expect(res.status).toBe(200);
    const dash = await res.json();
    expect(dash.project_count).toBe(0);
    expect(dash.active_tasks).toBe(0);
    expect(dash.cost_by_project).toEqual([]);
    expect(dash.recent_activity).toEqual([]);
    expect(dash.project_summaries).toEqual([]);
  });
});

describe("Workspaces — PATCH allowedKeyIds", () => {
  it("serializes array to JSON on PATCH, nulls when empty/null", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-keys-"));
    const ws = db.insert(workspaces).values({
      name: "keys-ws", path: wsPath,
    }).returning().get()!;

    const res = await app.request(`/workspaces/${ws.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedKeyIds: [1, 2, 3] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.allowedKeyIds).toBe("[1,2,3]");

    const res2 = await app.request(`/workspaces/${ws.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedKeyIds: null }),
    });
    const body2 = await res2.json();
    expect(body2.allowedKeyIds).toBeNull();
  });
});

// Keep existsSync reference to satisfy unused check
void existsSync;
