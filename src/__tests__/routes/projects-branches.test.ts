import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestDb, seedActiveKey } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { projects, workspaces, tasks, usageRecords } from "../../db/schema.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createMilestone, createSlice, createPlanTask } from "../../services/plan-store/index.js";

// Mock child_process to match sibling tests — git clone now uses execFileSync
// which we forward to the execSync mock impl so we can use string matching.
vi.mock("child_process", async () => {
  const actual = await vi.importActual<any>("child_process");
  return {
    ...actual,
    execSync: vi.fn(actual.execSync),
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
  tempDir = mkdtempSync(join(tmpdir(), "flockctl-projbr-"));
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

describe("POST /projects/scan", () => {
  it("422 when body has no path", async () => {
    const res = await app.request("/projects/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("422 when body is invalid JSON", async () => {
    const res = await app.request("/projects/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(422);
  });

  it("422 when path is whitespace only", async () => {
    const res = await app.request("/projects/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "   " }),
    });
    expect(res.status).toBe(422);
  });

  it("returns scan result for a real path", async () => {
    const p = mkdtempSync(join(tempDir, "scan-"));
    const res = await app.request("/projects/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // scanProjectPath returns at minimum { path, ... }
    expect(body).toBeTruthy();
  });
});

describe("POST /projects — git clone error fallbacks", () => {
  it("falls back to e.message when stderr is absent", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-fallback1-"));
    const ws = db.insert(workspaces).values({ name: "ws-fallback1", path: wsPath }).returning().get()!;
    (execSync as any).mockImplementation((cmd: string) => {
      if (cmd.startsWith("git clone")) {
        // No stderr — only message
        throw new Error("network unreachable");
      }
      return Buffer.from("");
    });
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "fallback-msg",
        workspaceId: ws.id,
        repoUrl: "https://example.com/x.git",
        allowedKeyIds: [keyId],
      }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("network unreachable");
  });

  it("falls back to 'unknown error' when stderr and message are missing", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-fallback2-"));
    const ws = db.insert(workspaces).values({ name: "ws-fallback2", path: wsPath }).returning().get()!;
    (execSync as any).mockImplementation((cmd: string) => {
      if (cmd.startsWith("git clone")) {
        // Throw a plain value with no message or stderr property
        // eslint-disable-next-line no-throw-literal
        throw { code: "ENOENT" };
      }
      return Buffer.from("");
    });
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "fallback-unk",
        workspaceId: ws.id,
        repoUrl: "https://example.com/x.git",
        allowedKeyIds: [keyId],
      }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("unknown error");
  });
});

describe("POST /projects — parseImportActions variants", () => {
  it("accepts importClaudeSkill with a name", async () => {
    const projPath = mkdtempSync(join(tempDir, "imp-skill-"));
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "imp-skill",
        path: projPath,
        allowedKeyIds: [keyId],
        importActions: [
          { kind: "importClaudeSkill", name: "my-skill" },
          { kind: "importClaudeSkill" }, // missing name → ignored
          { kind: "importClaudeSkill", name: "" }, // empty name → ignored
          { kind: "importClaudeSkill", name: 123 }, // wrong type → ignored
          { kind: "adoptAgentsMd" },
          { kind: "unknownKind" }, // ignored via default switch
          null, // falsy
          "string", // not an object
        ],
      }),
    });
    expect(res.status).toBe(201);
  });
});

describe("PATCH /projects/:id — field fan-out", () => {
  it("updates path, repoUrl, and all three gitignore toggles", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-patch-all-"));
    const proj = db.insert(projects).values({ name: "patch-all", path: projPath }).returning().get()!;

    const newPath = mkdtempSync(join(tempDir, "proj-patch-all-new-"));
    const res = await app.request(`/projects/${proj.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: newPath,
        repoUrl: "https://example.com/r.git",
        gitignoreFlockctl: true,
        gitignoreTodo: true,
        gitignoreAgentsMd: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe(newPath);
    expect(body.repoUrl).toBe("https://example.com/r.git");
    expect(body.gitignoreFlockctl).toBeTruthy();
    expect(body.gitignoreTodo).toBeTruthy();
    expect(body.gitignoreAgentsMd).toBeTruthy();
  });

  it("rejects non-boolean gitignore toggle via PATCH", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-patch-bad-"));
    const proj = db.insert(projects).values({ name: "patch-bad", path: projPath }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gitignoreFlockctl: "yes" }),
    });
    expect(res.status).toBe(422);
  });

  it("no-op PATCH does not queue reconcile (project without path skipped)", async () => {
    // Project with null path hits the `if (updated?.path)` false branch.
    const proj = db.insert(projects).values({ name: "patch-nopath" }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed-nopath" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("renamed-nopath");
    expect(body.path).toBeNull();
  });
});

describe("GET /projects/:id/tree — enrichment", () => {
  it("merges duration_ms and total_cost_usd into plan task summary", async () => {
    const projPath = mkdtempSync(join(tempDir, "tree-enrich-"));
    const proj = db.insert(projects).values({ name: "tree-enrich", path: projPath }).returning().get()!;

    const m = createMilestone(projPath, { title: "M1" });
    const s = createSlice(projPath, m.slug, { title: "S1" });

    const execTask = db.insert(tasks).values({
      projectId: proj.id,
      prompt: "do",
      status: "completed",
      startedAt: "2024-01-01T00:00:00Z",
      completedAt: "2024-01-01T00:00:05Z",
    }).returning().get()!;

    db.insert(usageRecords).values({
      taskId: execTask.id,
      projectId: proj.id,
      provider: "anthropic",
      model: "claude-opus-4",
      inputTokens: 1, outputTokens: 2,
      totalCostUsd: 0.42,
    }).run();

    // Use the plan-store service to create a plan task referencing the exec task.
    createPlanTask(projPath, m.slug, s.slug, {
      title: "Task One",
      status: "completed",
      executionTaskId: execTask.id,
      // summary's declared type is `string`, but at runtime the route reads and
      // merges any JSON shape the plan-store has persisted. Cast to exercise
      // the object-merge branch in the route handler.
      summary: { note: "keep" } as unknown as string,
    });

    const res = await app.request(`/projects/${proj.id}/tree`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const task = body.milestones[0]?.slices?.[0]?.tasks?.[0];
    expect(task).toBeTruthy();
    expect(task.summary).toBeTruthy();
    expect(typeof task.summary).toBe("object");
    // 5s gap → ~5000 ms. Allow some slack across platforms.
    expect(task.summary.duration_ms).toBeGreaterThanOrEqual(4000);
    expect(task.summary.total_cost_usd).toBeCloseTo(0.42, 2);
    // Existing summary fields preserved.
    expect(task.summary.note).toBe("keep");
  });

  it("returns empty milestones when project has no path", async () => {
    const proj = db.insert(projects).values({ name: "tree-nopath" }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/tree`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.milestones).toEqual([]);
  });
});

describe("GET /projects/:id/stats — coverage fills", () => {
  it("aggregates task status counts and usage", async () => {
    const projPath = mkdtempSync(join(tempDir, "stats-rich-"));
    const proj = db.insert(projects).values({ name: "stats-rich", path: projPath }).returning().get()!;

    // Create tasks in different statuses to hit the loop body assignments.
    db.insert(tasks).values({ projectId: proj.id, prompt: "a", status: "completed" }).run();
    db.insert(tasks).values({ projectId: proj.id, prompt: "b", status: "failed" }).run();
    db.insert(tasks).values({
      projectId: proj.id, prompt: "c", status: "completed",
      startedAt: "2024-01-01T00:00:00Z",
      completedAt: "2024-01-01T00:00:10Z",
    }).run();

    db.insert(usageRecords).values({
      projectId: proj.id, provider: "anthropic", model: "m",
      inputTokens: 5, outputTokens: 7, totalCostUsd: 1.25,
    }).run();

    // One milestone (pending default) + slice (pending default) to exercise
    // the `m.status ?? "pending"` and `s.status ?? "pending"` fallbacks.
    const m = createMilestone(projPath, { title: "NoStatus" });
    createSlice(projPath, m.slug, { title: "SNoStatus" });

    const res = await app.request(`/projects/${proj.id}/stats`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks.completed).toBe(2);
    expect(body.tasks.failed).toBe(1);
    expect(body.tasks.total).toBe(3);
    expect(body.usage.totalCostUsd).toBe(1.25);
    expect(body.usage.totalInputTokens).toBe(5);
    expect(body.usage.totalOutputTokens).toBe(7);
    expect(body.milestones.total).toBeGreaterThanOrEqual(1);
    expect(body.slices.total).toBeGreaterThanOrEqual(1);
  });

  it("returns empty aggregations when project has no path (no milestones/slices)", async () => {
    const proj = db.insert(projects).values({ name: "stats-nopath" }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/stats`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.milestones.total).toBe(0);
    expect(body.slices.total).toBe(0);
  });
});

describe("GET /projects/:id/allowed-keys — allow-list parsing edges", () => {
  it("coerces string numeric entries in the stored JSON and filters non-finite", async () => {
    const projPath = mkdtempSync(join(tempDir, "akeys-coerce-"));
    // Store a mix of number, numeric-string, and bogus entries. The route
    // should parse numeric-strings via parseInt, drop "abc", and return the
    // numeric ids with source "project".
    const proj = db.insert(projects).values({
      name: "akeys-coerce",
      path: projPath,
      allowedKeyIds: JSON.stringify([keyId, String(keyId), "abc"]),
    }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/allowed-keys`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("project");
    expect(body.allowedKeyIds).toContain(keyId);
  });

  it("returns null source when stored JSON is malformed", async () => {
    const projPath = mkdtempSync(join(tempDir, "akeys-bad-"));
    const proj = db.insert(projects).values({
      name: "akeys-bad",
      path: projPath,
      allowedKeyIds: "{not json",
    }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/allowed-keys`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("none");
    expect(body.allowedKeyIds).toBeNull();
  });

  it("returns null source when stored JSON is a non-array value", async () => {
    const projPath = mkdtempSync(join(tempDir, "akeys-obj-"));
    const proj = db.insert(projects).values({
      name: "akeys-obj",
      path: projPath,
      allowedKeyIds: JSON.stringify({ some: "object" }),
    }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/allowed-keys`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("none");
  });
});

describe("GET /projects/:id/agents-md/effective — path resolution", () => {
  it("returns result even when project has no path", async () => {
    const proj = db.insert(projects).values({ name: "eff-nopath" }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/agents-md/effective`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeTruthy();
    // Should include merged/ layers shape from loadAgentGuidance.
    expect(typeof body).toBe("object");
  });

  it("includes workspace path in resolution when project has a linked workspace with path", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-eff-"));
    const ws = db.insert(workspaces).values({ name: "ws-eff", path: wsPath }).returning().get()!;
    const projPath = mkdtempSync(join(tempDir, "proj-eff-"));
    const proj = db.insert(projects).values({ name: "proj-eff", path: projPath, workspaceId: ws.id }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/agents-md/effective`);
    expect(res.status).toBe(200);
  });

  it("handles workspace without path (ws.path = null/undefined)", async () => {
    // Create a workspace row with an empty path using drizzle (bypass NOT NULL
    // by giving it a space). Actually schema requires path NOT NULL UNIQUE,
    // so insert with minimal valid value.
    const wsPath = mkdtempSync(join(tempDir, "ws-eff-np-"));
    const ws = db.insert(workspaces).values({ name: "ws-eff-np", path: wsPath }).returning().get()!;
    // Now clear the workspace path to exercise `ws?.path ?? null`
    sqlite.prepare(`UPDATE workspaces SET path = '' WHERE id = ?`).run(ws.id);
    const projPath = mkdtempSync(join(tempDir, "proj-eff-np-"));
    const proj = db.insert(projects).values({ name: "proj-eff-np", path: projPath, workspaceId: ws.id }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/agents-md/effective`);
    expect(res.status).toBe(200);
  });

  it("404 when project missing", async () => {
    const res = await app.request(`/projects/99999/agents-md/effective`);
    expect(res.status).toBe(404);
  });
});

describe("GET /projects pagination total fallback", () => {
  it("returns total: 0 with no rows", async () => {
    const res = await app.request("/projects");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(0);
  });
});

describe("PUT /projects/:id/agents-md", () => {
  it("writes content and sets present=true", async () => {
    const projPath = mkdtempSync(join(tempDir, "agents-wri-"));
    const proj = db.insert(projects).values({ name: "agw", path: projPath }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# AGENTS\nhello" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.present).toBe(true);
    expect(body.bytes).toBeGreaterThan(0);
    expect(existsSync(join(projPath, "AGENTS.md"))).toBe(true);
  });

  it("empty content marks layer as absent", async () => {
    const projPath = mkdtempSync(join(tempDir, "agents-wri-empty-"));
    writeFileSync(join(projPath, "AGENTS.md"), "stale");
    const proj = db.insert(projects).values({ name: "agw-empty", path: projPath }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.present).toBe(false);
  });

  it("coerces non-string content to empty string", async () => {
    const projPath = mkdtempSync(join(tempDir, "agents-wri-nonstr-"));
    const proj = db.insert(projects).values({ name: "agw-nonstr", path: projPath }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: 12345 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.present).toBe(false);
    expect(body.bytes).toBe(0);
  });

  it("treats invalid JSON body as empty content", async () => {
    const projPath = mkdtempSync(join(tempDir, "agents-wri-bad-"));
    const proj = db.insert(projects).values({ name: "agw-bad", path: projPath }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.present).toBe(false);
  });

  it("422 when project has no path", async () => {
    const proj = db.insert(projects).values({ name: "agw-nopath" }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(422);
  });

  it("404 when project missing", async () => {
    const res = await app.request(`/projects/99999/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /projects/:id/agents-md — no-path branch", () => {
  it("returns empty layers when project has no path", async () => {
    const proj = db.insert(projects).values({ name: "am-nopath" }).returning().get()!;
    const res = await app.request(`/projects/${proj.id}/agents-md`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.layers["project-public"].present).toBe(false);
  });
});

describe("POST /projects — path derivation branches", () => {
  it("falls back to homedir when workspaceId resolves but workspace has no path", async () => {
    // Seed a workspace row then null out path to exercise `if (ws?.path)` false.
    const wsPath = mkdtempSync(join(tempDir, "ws-nopath-"));
    const ws = db
      .insert(workspaces)
      .values({ name: "ws-nullpath", path: wsPath })
      .returning()
      .get()!;
    sqlite.prepare(`UPDATE workspaces SET path = '' WHERE id = ?`).run(ws.id);
    // Now POST without a path, with workspaceId pointing at it — `ws?.path` is
    // falsy → derivation falls through to `homedir()/flockctl/projects/...`.
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "proj-fallback-home",
        workspaceId: ws.id,
        allowedKeyIds: [keyId],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.path).toContain("flockctl/projects");
  });

  it("preserves origin remote URL when creating into an existing git repo (no clone)", async () => {
    // Prepare a real directory that looks like an existing git repo so the
    // `else if (!resolvedRepoUrl)` branch fires — body has no repoUrl.
    const projPath = mkdtempSync(join(tempDir, "existing-git-"));
    mkdirSync(join(projPath, ".git"));
    // Our execSync mock returns an empty Buffer for `git remote get-url origin`
    // — we want a non-empty remote to trigger `resolvedRepoUrl = remoteUrl`.
    (execSync as any).mockImplementation((cmd: string) => {
      if (cmd.startsWith("git remote get-url")) {
        return Buffer.from("https://example.com/adopted.git\n");
      }
      return Buffer.from("");
    });
    const res = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "proj-existing-git",
        path: projPath,
        allowedKeyIds: [keyId],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.repoUrl).toBe("https://example.com/adopted.git");
  });
});

describe("GET /projects/:id/allowed-keys — workspace inheritance", () => {
  it("falls back to workspace allowedKeyIds when project list is empty", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-inherit-"));
    const ws = db
      .insert(workspaces)
      .values({
        name: "ws-inherit",
        path: wsPath,
        allowedKeyIds: JSON.stringify([keyId]),
      })
      .returning()
      .get()!;
    const projPath = mkdtempSync(join(tempDir, "proj-inherit-"));
    const proj = db
      .insert(projects)
      .values({
        name: "proj-inherit",
        path: projPath,
        workspaceId: ws.id,
      })
      .returning()
      .get()!;
    const res = await app.request(`/projects/${proj.id}/allowed-keys`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("workspace");
    expect(body.allowedKeyIds).toContain(keyId);
  });

  it("returns none when workspace exists but has no stored allowedKeyIds", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-nokeys-"));
    const ws = db
      .insert(workspaces)
      .values({ name: "ws-nokeys", path: wsPath })
      .returning()
      .get()!;
    const projPath = mkdtempSync(join(tempDir, "proj-nokeys-"));
    const proj = db
      .insert(projects)
      .values({ name: "proj-nokeys", path: projPath, workspaceId: ws.id })
      .returning()
      .get()!;
    const res = await app.request(`/projects/${proj.id}/allowed-keys`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("none");
  });
});

describe("GET /projects/:id/config — no-path branch", () => {
  it("returns empty object when project has no path", async () => {
    const proj = db
      .insert(projects)
      .values({ name: "conf-nopath" })
      .returning()
      .get()!;
    const res = await app.request(`/projects/${proj.id}/config`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({});
  });

  it("404 when project missing (GET /config)", async () => {
    const res = await app.request("/projects/99999/config");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /projects/:id — cascades", () => {
  it("cascades to tasks via schema ON DELETE CASCADE", async () => {
    const projPath = mkdtempSync(join(tempDir, "del-cascade-"));
    const proj = db.insert(projects).values({ name: "del", path: projPath }).returning().get()!;
    db.insert(tasks).values({ projectId: proj.id, prompt: "p", status: "queued" }).run();

    const res = await app.request(`/projects/${proj.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    // Verify tasks were cascaded.
    const remaining = sqlite.prepare(`SELECT count(*) AS c FROM tasks WHERE project_id = ?`).get(proj.id) as { c: number };
    expect(remaining.c).toBe(0);
  });
});
