import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestDb, seedActiveKey } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { projects, workspaces } from "../../db/schema.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createMilestone, createSlice } from "../../services/plan-store/index.js";

vi.mock("child_process", async () => {
  const actual = await vi.importActual<any>("child_process");
  return {
    ...actual,
    execSync: vi.fn(actual.execSync),
    // `git clone` now uses execFileSync (no shell); tests still drive it
    // through the execSync mock by forwarding stubbed impls — matches the
    // prior behavior of asserting on the "clone" argv.
    execFileSync: vi.fn((file: string, args: readonly string[], opts: unknown) => {
      const fake = (execSync as unknown as { getMockImplementation?: () => (cmd: string) => unknown })
        .getMockImplementation?.();
      const rebuiltCmd = `${file} ${args.join(" ")}`;
      return fake ? fake(rebuiltCmd) : actual.execFileSync(file, args, opts);
    }),
  };
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
  tempDir = mkdtempSync(join(tmpdir(), "flockctl-projfull-"));
  // POST /projects requires a non-empty allowedKeyIds; seed once so every
  // test can reference the same key.
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

describe("projects — POST derives path from workspace", () => {
  it("uses <workspace>/slug when workspaceId provided and no path", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-derive-"));
    const ws = db.insert(workspaces).values({ name: "w", path: wsPath }).returning().get()!;

    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Derived Name", workspaceId: ws.id, allowedKeyIds: [keyId] }),
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
      body: JSON.stringify({ name: "Solo Project", allowedKeyIds: [keyId] }),
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
      body: JSON.stringify({ name: "proj-with-git", path: projPath, allowedKeyIds: [keyId] }),
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
      body: JSON.stringify({ name: "proj-no-origin", path: projPath, allowedKeyIds: [keyId] }),
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
      body: JSON.stringify({ name: "proj-no-git", path: projPath, allowedKeyIds: [keyId] }),
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
        allowedKeyIds: [keyId],
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
        allowedKeyIds: [keyId],
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
        allowedKeyIds: [keyId],
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
        allowedKeyIds: [keyId],
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

// NOTE: GET/PUT /projects/:id/agents-md coverage lives in
// src/__tests__/routes/agents-md.test.ts — the endpoint now returns a
// per-layer shape (`{layers: {"project-public", "project-private"}}`) and
// the PUT body takes a `{layer, content}` pair.

describe("projects — TODO.md endpoints", () => {
  it("POST /projects seeds a TODO.md at the project root", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-todo-seed-"));
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "todo-seed", path: projPath, allowedKeyIds: [keyId] }),
    });
    expect(res.status).toBe(201);
    const todoPath = join(projPath, "TODO.md");
    expect(existsSync(todoPath)).toBe(true);
    expect(readFileSync(todoPath, "utf-8")).toContain("# TODO");
  });

  it("POST /projects does not overwrite existing TODO.md", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-todo-keep-"));
    writeFileSync(join(projPath, "TODO.md"), "existing body");
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "todo-keep", path: projPath, allowedKeyIds: [keyId] }),
    });
    expect(res.status).toBe(201);
    expect(readFileSync(join(projPath, "TODO.md"), "utf-8")).toBe("existing body");
  });

  it("GET /projects/:id/todo returns empty shape when project has no path", async () => {
    const proj = db.insert(projects).values({ name: "todo-no-path" }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/todo`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("");
    expect(body.path).toBe("");
  });

  it("GET /projects/:id/todo reads TODO.md from disk", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-todo-read-"));
    writeFileSync(join(projPath, "TODO.md"), "- [ ] item one");
    const proj = db.insert(projects).values({ name: "todo-read", path: projPath }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/todo`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("- [ ] item one");
    expect(body.path).toBe(join(projPath, "TODO.md"));
  });

  it("GET /projects/:id/todo returns content:'' when file is absent", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-todo-absent-"));
    const proj = db.insert(projects).values({ name: "todo-absent", path: projPath }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/todo`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("");
    expect(body.path).toBe(join(projPath, "TODO.md"));
  });

  it("GET /projects/:id/todo 404 when project missing", async () => {
    const res = await app.request(`/projects/99999/todo`);
    expect(res.status).toBe(404);
  });

  it("PUT /projects/:id/todo writes content and returns fresh body", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-todo-put-"));
    const proj = db.insert(projects).values({ name: "todo-put", path: projPath }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/todo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# My TODO\n- [ ] a" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toContain("My TODO");
    expect(readFileSync(join(projPath, "TODO.md"), "utf-8")).toContain("My TODO");
  });

  it("PUT /projects/:id/todo coerces non-string content to ''", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-todo-nonstr-"));
    const proj = db.insert(projects).values({ name: "todo-nonstr", path: projPath }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/todo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: 42 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("");
  });

  it("PUT /projects/:id/todo rejects oversized content (>256KB)", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-todo-big-"));
    const proj = db.insert(projects).values({ name: "todo-big", path: projPath }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/todo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x".repeat(300_000) }),
    });
    expect(res.status).toBe(422);
  });

  it("PUT /projects/:id/todo 422 when project has no path", async () => {
    const proj = db.insert(projects).values({ name: "todo-no-path-put" }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/todo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(422);
  });

  it("PUT /projects/:id/todo 404 when project missing", async () => {
    const res = await app.request(`/projects/99999/todo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(404);
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
