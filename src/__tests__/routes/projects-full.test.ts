import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { projects, workspaces } from "../../db/schema.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createMilestone, createSlice } from "../../services/plan-store.js";

vi.mock("child_process", async () => {
  const actual = await vi.importActual<any>("child_process");
  return {
    ...actual,
    execSync: vi.fn(actual.execSync),
  };
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
  tempDir = mkdtempSync(join(tmpdir(), "flockctl-projfull-"));
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

describe("projects — POST derives path from workspace", () => {
  it("uses <workspace>/slug when workspaceId provided and no path", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-derive-"));
    const ws = db.insert(workspaces).values({ name: "w", path: wsPath }).returning().get()!;

    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Derived Name", workspaceId: ws.id }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.path.startsWith(wsPath)).toBe(true);
    expect(body.path.endsWith("Derived_Name")).toBe(true);
  });

  it("falls back to homedir/flockctl/projects/<slug> when workspace has no path", async () => {
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Solo Project" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.path).toContain("Solo_Project");
  });
});

describe("projects — POST with existing directory", () => {
  it("reads existing 'origin' remote into repoUrl", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-with-git-"));
    mkdirSync(join(projPath, ".git"), { recursive: true });

    (execSync as any).mockImplementation((cmd: string) => {
      if (cmd.includes("git remote get-url")) return Buffer.from("git@host.com:a/b.git\n");
      return Buffer.from("");
    });

    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "proj-with-git", path: projPath }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.repoUrl).toBe("git@host.com:a/b.git");
  });

  it("leaves repoUrl null when 'origin' remote is absent", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-no-origin-"));
    mkdirSync(join(projPath, ".git"), { recursive: true });

    (execSync as any).mockImplementation(() => { throw new Error("no origin"); });

    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "proj-no-origin", path: projPath }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.repoUrl).toBeNull();
  });

  it("swallows 'git init' errors for non-git dirs", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-no-git-"));
    (execSync as any).mockImplementation((cmd: string) => {
      if (cmd.startsWith("git init")) throw new Error("no git");
      return Buffer.from("");
    });

    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "proj-no-git", path: projPath }),
    });
    expect(res.status).toBe(201);
  });

  it("persists permissionMode from POST body to config.json", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-pm-"));

    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "pm-proj", path: projPath,
        permissionMode: "bypassPermissions",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    const cfgRes = await app.request(`/projects/${body.id}/config`);
    const cfg = await cfgRes.json();
    expect(cfg.permissionMode).toBe("bypassPermissions");
  });
});

describe("projects — POST with repoUrl (git clone)", () => {
  it("422 when repoUrl points at an existing .git directory", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-clone-conflict-"));
    const ws = db.insert(workspaces).values({ name: "ws-clone", path: wsPath }).returning().get()!;
    const derived = join(wsPath, "Clash");
    mkdirSync(join(derived, ".git"), { recursive: true });

    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Clash",
        workspaceId: ws.id,
        repoUrl: "https://github.com/foo/bar.git",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("422 when git clone command fails (stderr)", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-clone-fail-"));
    const ws = db.insert(workspaces).values({ name: "ws-fail", path: wsPath }).returning().get()!;
    (execSync as any).mockImplementation((cmd: string) => {
      if (cmd.startsWith("git clone")) {
        const err: any = new Error("clone failed");
        err.stderr = Buffer.from("fatal: repository not found");
        throw err;
      }
      return Buffer.from("");
    });

    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "NotFound",
        workspaceId: ws.id,
        repoUrl: "https://example.com/missing.git",
      }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("fatal: repository not found");
  });

  it("succeeds when git clone runs cleanly", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-clone-ok-"));
    const ws = db.insert(workspaces).values({ name: "ws-ok", path: wsPath }).returning().get()!;

    (execSync as any).mockImplementation(() => Buffer.from(""));

    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Cloned",
        workspaceId: ws.id,
        repoUrl: "https://github.com/x/y.git",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.repoUrl).toBe("https://github.com/x/y.git");
  });
});

describe("projects — stats with filesystem data", () => {
  it("aggregates milestone/slice status counts from plan-store", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-stats-"));
    const proj = db.insert(projects).values({ name: "stats-proj", path: projPath }).returning().get()!;

    const m1 = createMilestone(projPath, { title: "M1", status: "active" });
    createMilestone(projPath, { title: "M2", status: "completed" });
    createMilestone(projPath, { title: "M3", status: "failed" });
    createSlice(projPath, m1.slug, { title: "s1", status: "active" });
    createSlice(projPath, m1.slug, { title: "s2", status: "completed" });
    createSlice(projPath, m1.slug, { title: "s3", status: "skipped" });

    const res = await app.request(`/projects/${proj.id}/stats`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.milestones.total).toBe(3);
    expect(body.milestones.active).toBe(1);
    expect(body.milestones.completed).toBe(1);
    expect(body.milestones.failed).toBe(1);
    expect(body.slices.total).toBe(3);
    expect(body.slices.active).toBe(1);
    expect(body.slices.completed).toBe(1);
    expect(body.slices.skipped).toBe(1);
  });
});

describe("projects — agents-md endpoints", () => {
  it("GET returns {source:'', effective:''} when project has no path", async () => {
    const proj = db.insert(projects).values({ name: "no-path-proj" }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/agents-md`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("");
    expect(body.effective).toBe("");
  });

  it("GET reads .flockctl/AGENTS.md and root AGENTS.md", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-md-"));
    mkdirSync(join(projPath, ".flockctl"), { recursive: true });
    writeFileSync(join(projPath, ".flockctl", "AGENTS.md"), "source body");
    writeFileSync(join(projPath, "AGENTS.md"), "effective body");
    const proj = db.insert(projects).values({ name: "md-proj", path: projPath }).returning().get()!;

    const res = await app.request(`/projects/${proj.id}/agents-md`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toContain("source body");
    expect(body.effective).toContain("effective body");
  });

  it("GET 404 when project missing", async () => {
    const res = await app.request(`/projects/99999/agents-md`);
    expect(res.status).toBe(404);
  });

  it("PUT saves content and returns fresh source/effective", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-md-put-"));
    const proj = db.insert(projects).values({ name: "md-put-proj", path: projPath }).returning().get()!;

    const res = await app.request(`/projects/${proj.id}/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# My Project Agents" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toContain("# My Project Agents");
  });

  it("PUT coerces non-string content to ''", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-md-nonstr-"));
    const proj = db.insert(projects).values({ name: "md-nonstr", path: projPath }).returning().get()!;

    const res = await app.request(`/projects/${proj.id}/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: 42 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("");
  });

  it("PUT rejects oversized content (>256KB)", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-md-big-"));
    const proj = db.insert(projects).values({ name: "md-big", path: projPath }).returning().get()!;

    const res = await app.request(`/projects/${proj.id}/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x".repeat(300_000) }),
    });
    expect(res.status).toBe(422);
  });

  it("PUT 404 when project missing", async () => {
    const res = await app.request(`/projects/99999/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("PUT 422 when project has no path", async () => {
    const proj = db.insert(projects).values({ name: "md-no-path" }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(422);
  });
});

describe("projects — PATCH permissionMode", () => {
  it("sets and clears permissionMode through PATCH (null = delete)", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-patch-pm-"));
    const proj = db.insert(projects).values({ name: "patch-pm", path: projPath }).returning().get()!;

    await app.request(`/projects/${proj.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionMode: "acceptEdits" }),
    });
    const g1 = await (await app.request(`/projects/${proj.id}/config`)).json();
    expect(g1.permissionMode).toBe("acceptEdits");

    await app.request(`/projects/${proj.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionMode: null }),
    });
    const g2 = await (await app.request(`/projects/${proj.id}/config`)).json();
    expect(g2.permissionMode).toBeUndefined();
  });
});
