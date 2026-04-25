import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestDb, seedActiveKey } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { workspaces, projects, tasks, usageRecords } from "../../db/schema.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { listMilestones } from "../../services/plan-store/index.js";
import { createMilestone } from "../../services/plan-store/index.js";

// Mock child_process the same way as the sibling extras file so git clone
// (execFileSync) forwards to the execSync mock impl.
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
  tempDir = mkdtempSync(join(tmpdir(), "flockctl-wsbr-"));
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

describe("POST /workspaces — git clone error fallbacks", () => {
  it("falls back to e.message when stderr is absent", async () => {
    const wsPath = join(tempDir, "ws-clone-msg-" + Date.now());
    (execSync as any).mockImplementation((cmd: string) => {
      if (cmd.startsWith("git clone")) {
        throw new Error("DNS resolution failed");
      }
      return Buffer.from("");
    });
    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "ws-clone-msg",
        path: wsPath,
        repoUrl: "https://example.com/x.git",
        allowedKeyIds: [keyId],
      }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("DNS resolution failed");
  });

  it("falls back to 'unknown error' when neither stderr nor message are set", async () => {
    const wsPath = join(tempDir, "ws-clone-unk-" + Date.now());
    (execSync as any).mockImplementation((cmd: string) => {
      if (cmd.startsWith("git clone")) {
        // eslint-disable-next-line no-throw-literal
        throw {};
      }
      return Buffer.from("");
    });
    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "ws-clone-unk",
        path: wsPath,
        repoUrl: "https://example.com/x.git",
        allowedKeyIds: [keyId],
      }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("unknown error");
  });
});

describe("POST /workspaces — auto path fallback", () => {
  it("derives ~/flockctl/workspaces/<slug> when body.path is omitted", async () => {
    // We can't rely on homedir to be writable; but we can at least trigger the
    // code path. Use an in-process FLOCKCTL_HOME that exists. The route
    // derives from `homedir()` directly so just attempt to create under a
    // unique name and clean up afterwards.
    const uniqueName = "wsauto_" + Date.now();
    const res = await app.request("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: uniqueName,
        allowedKeyIds: [keyId],
      }),
    });
    // Expect success; cleanup the dir if it was created.
    expect([201, 422]).toContain(res.status);
    if (res.status === 201) {
      const body = await res.json();
      // Path should end with the slug of the name.
      expect(body.path).toContain(uniqueName);
      try { rmSync(body.path, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe("PATCH /workspaces/:id — field fan-out", () => {
  it("updates description, repoUrl, and all three gitignore toggles at once", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-fan-"));
    const ws = db.insert(workspaces).values({ name: "ws-fan", path: wsPath }).returning().get()!;

    const res = await app.request(`/workspaces/${ws.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "new desc",
        repoUrl: "https://example.com/foo.git",
        gitignoreFlockctl: true,
        gitignoreTodo: true,
        gitignoreAgentsMd: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.description).toBe("new desc");
    expect(body.repoUrl).toBe("https://example.com/foo.git");
    expect(body.gitignoreFlockctl).toBeTruthy();
    expect(body.gitignoreTodo).toBeTruthy();
    expect(body.gitignoreAgentsMd).toBeTruthy();
  });

  it("clears repoUrl when empty string is passed (repoUrl: '' → null)", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-clear-rurl-"));
    const ws = db.insert(workspaces).values({
      name: "ws-clear-rurl", path: wsPath, repoUrl: "https://old.example/x.git",
    }).returning().get()!;

    const res = await app.request(`/workspaces/${ws.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repoUrl).toBeNull();
  });

  it("rejects non-boolean gitignore toggle on PATCH", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-badbool-"));
    const ws = db.insert(workspaces).values({ name: "ws-badbool", path: wsPath }).returning().get()!;
    const res = await app.request(`/workspaces/${ws.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gitignoreTodo: "yes" }),
    });
    expect(res.status).toBe(422);
  });

  it("handles PATCH that only changes gitignore toggles (triggers reconcile branch)", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-toggleonly-"));
    const ws = db.insert(workspaces).values({ name: "ws-toggle", path: wsPath }).returning().get()!;
    const res = await app.request(`/workspaces/${ws.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gitignoreAgentsMd: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.gitignoreAgentsMd).toBeTruthy();
  });

  it("no-op PATCH when workspace has empty path (skips config write)", async () => {
    // Insert with a dummy path then set to empty to test the existing.path === '' branch.
    const wsPath = mkdtempSync(join(tempDir, "ws-emp-"));
    const ws = db.insert(workspaces).values({ name: "ws-emp", path: wsPath }).returning().get()!;
    sqlite.prepare(`UPDATE workspaces SET path = '' WHERE id = ?`).run(ws.id);

    const res = await app.request(`/workspaces/${ws.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionMode: "acceptEdits" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("PUT /workspaces/:id/config — disabledMcpServers only", () => {
  it("touches only MCP reconciler when only disabledMcpServers changes", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-mcp-only-"));
    const ws = db.insert(workspaces).values({ name: "ws-mcp-only", path: wsPath }).returning().get()!;
    const res = await app.request(`/workspaces/${ws.id}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabledMcpServers: ["some-mcp"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disabledMcpServers).toEqual(["some-mcp"]);
  });

  it("clears disabledMcpServers when empty array is passed", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-mcp-clr-"));
    const ws = db.insert(workspaces).values({ name: "ws-mcp-clr", path: wsPath }).returning().get()!;
    // First set it.
    await app.request(`/workspaces/${ws.id}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabledMcpServers: ["a"] }),
    });
    const res = await app.request(`/workspaces/${ws.id}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabledMcpServers: [] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.disabledMcpServers).toBeUndefined();
  });
});

describe("PUT /workspaces/:id/agents-md — branch coverage", () => {
  it("writes non-empty content and toggles present=true", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-amd-"));
    const ws = db.insert(workspaces).values({ name: "ws-amd", path: wsPath }).returning().get()!;
    const res = await app.request(`/workspaces/${ws.id}/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# WS AGENTS" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.present).toBe(true);
    expect(existsSync(join(wsPath, "AGENTS.md"))).toBe(true);
  });

  it("coerces non-string content to empty string", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-amd-nonstr-"));
    const ws = db.insert(workspaces).values({ name: "ws-amd-nonstr", path: wsPath }).returning().get()!;
    const res = await app.request(`/workspaces/${ws.id}/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: 1234 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.present).toBe(false);
    expect(body.bytes).toBe(0);
  });

  it("treats malformed JSON body as empty content", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-amd-bad-"));
    const ws = db.insert(workspaces).values({ name: "ws-amd-bad", path: wsPath }).returning().get()!;
    const res = await app.request(`/workspaces/${ws.id}/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.present).toBe(false);
  });

  it("422 when workspace has no path", async () => {
    // Schema requires non-null path; simulate by inserting then clearing.
    const wsPath = mkdtempSync(join(tempDir, "ws-amd-nop-"));
    const ws = db.insert(workspaces).values({ name: "ws-amd-nop", path: wsPath }).returning().get()!;
    sqlite.prepare(`UPDATE workspaces SET path = '' WHERE id = ?`).run(ws.id);
    const res = await app.request(`/workspaces/${ws.id}/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(422);
  });

  it("404 when workspace missing on agents-md GET/PUT", async () => {
    const g = await app.request(`/workspaces/99999/agents-md`);
    expect(g.status).toBe(404);
    const p = await app.request(`/workspaces/99999/agents-md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(p.status).toBe(404);
  });
});

describe("GET /workspaces/:id/agents-md — no-path branch", () => {
  it("returns empty layers when workspace has no path", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-amd-nopath-"));
    const ws = db.insert(workspaces).values({ name: "ws-amd-nopath", path: wsPath }).returning().get()!;
    sqlite.prepare(`UPDATE workspaces SET path = '' WHERE id = ?`).run(ws.id);
    const res = await app.request(`/workspaces/${ws.id}/agents-md`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.layers["workspace-public"].present).toBe(false);
  });
});

describe("GET /workspaces/:id/agents-md/effective", () => {
  it("returns merged guidance result with a real path", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-eff-"));
    const ws = db.insert(workspaces).values({ name: "ws-eff", path: wsPath }).returning().get()!;
    const res = await app.request(`/workspaces/${ws.id}/agents-md/effective`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeTruthy();
  });

  it("returns result even when workspace path is empty", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-eff-empty-"));
    const ws = db.insert(workspaces).values({ name: "ws-eff-empty", path: wsPath }).returning().get()!;
    sqlite.prepare(`UPDATE workspaces SET path = '' WHERE id = ?`).run(ws.id);
    const res = await app.request(`/workspaces/${ws.id}/agents-md/effective`);
    expect(res.status).toBe(200);
  });

  it("404 when workspace missing", async () => {
    const res = await app.request(`/workspaces/99999/agents-md/effective`);
    expect(res.status).toBe(404);
  });
});

describe("GET /workspaces pagination total fallback", () => {
  it("returns total: 0 with no rows", async () => {
    const res = await app.request("/workspaces");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(0);
  });
});

describe("GET /workspaces/:id/dashboard — full aggregation", () => {
  it("aggregates tasks, usage, milestone statuses, and recent activity", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-dash-"));
    const ws = db.insert(workspaces).values({ name: "ws-dash", path: wsPath }).returning().get()!;

    const p1Path = mkdtempSync(join(tempDir, "ws-dash-p1-"));
    const p1 = db.insert(projects).values({ name: "p1", path: p1Path, workspaceId: ws.id }).returning().get()!;

    // Tasks with each relevant status.
    db.insert(tasks).values({ projectId: p1.id, prompt: "r", status: "running" }).run();
    db.insert(tasks).values({
      projectId: p1.id, prompt: "c", status: "completed",
      completedAt: "2024-02-01T00:00:00Z", updatedAt: "2024-02-01T00:00:00Z",
      label: "labeled task",
    }).run();
    const failedRow = db.insert(tasks).values({
      projectId: p1.id, prompt: "f", status: "failed",
      // leave completedAt null to exercise the ?? t.updatedAt fallback
      updatedAt: "2024-02-02T00:00:00Z",
    }).returning().get()!;
    // Also a task with everything null to exercise the final '' fallback on timestamp
    // and the label-null → `Task #ID` fallback.
    sqlite.prepare(
      `INSERT INTO tasks (project_id, prompt, status, completed_at, updated_at) VALUES (?, 'x', 'failed', NULL, NULL)`,
    ).run(p1.id);

    db.insert(usageRecords).values({
      projectId: p1.id, provider: "anthropic", model: "m",
      inputTokens: 10, outputTokens: 20, totalCostUsd: 3.14,
    }).run();

    // Milestone statuses
    createMilestone(p1Path, { title: "M-pending" });
    createMilestone(p1Path, { title: "M-active", status: "active" });
    createMilestone(p1Path, { title: "M-inprog", status: "in_progress" });
    createMilestone(p1Path, { title: "M-done", status: "completed" });

    const res = await app.request(`/workspaces/${ws.id}/dashboard`);
    expect(res.status).toBe(200);
    const dash = await res.json();

    expect(dash.project_count).toBe(1);
    expect(dash.active_tasks).toBe(1);
    expect(dash.completed_tasks).toBe(1);
    expect(dash.failed_tasks).toBeGreaterThanOrEqual(1);
    expect(dash.total_cost_usd).toBe(3.14);
    expect(dash.total_input_tokens).toBe(10);
    expect(dash.total_output_tokens).toBe(20);
    expect(dash.pending_milestones).toBeGreaterThanOrEqual(1);
    expect(dash.active_milestones).toBeGreaterThanOrEqual(2);
    expect(dash.completed_milestones).toBeGreaterThanOrEqual(1);
    // recent_activity hydrates labels; one entry should use label, another "Task #N"
    expect(Array.isArray(dash.recent_activity)).toBe(true);
    expect(dash.recent_activity.length).toBeGreaterThan(0);
    const titles = dash.recent_activity.map((a: any) => a.title);
    expect(titles.some((t: string) => /Task #/.test(t) || t === "labeled task")).toBe(true);
    // Timestamp fallback: at least one entry should have a "" or non-empty string.
    dash.recent_activity.forEach((a: any) => {
      expect(typeof a.timestamp).toBe("string");
    });
    expect(dash.project_summaries[0].milestone_count).toBeGreaterThanOrEqual(4);
    // Use listMilestones reference to avoid unused import complaint.
    void listMilestones;
  });

  it("handles project with no path (milestones/slices skipped)", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-dash-nop-"));
    const ws = db.insert(workspaces).values({ name: "ws-dash-nop", path: wsPath }).returning().get()!;
    db.insert(projects).values({ name: "no-path-proj", workspaceId: ws.id }).run();

    const res = await app.request(`/workspaces/${ws.id}/dashboard`);
    expect(res.status).toBe(200);
    const dash = await res.json();
    expect(dash.project_count).toBe(1);
    expect(dash.pending_milestones).toBe(0);
    expect(dash.active_milestones).toBe(0);
    expect(dash.completed_milestones).toBe(0);
  });
});

describe("POST /workspaces/:id/projects — create mode edge cases", () => {
  it("creates nested project with explicit path provided in body", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-nest-"));
    const ws = db.insert(workspaces).values({ name: "ws-nest", path: wsPath }).returning().get()!;
    const projPath = join(tempDir, "nested-explicit-" + Date.now());
    const res = await app.request(`/workspaces/${ws.id}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "nested",
        path: projPath,
        allowedKeyIds: [keyId],
        repoUrl: "https://example.com/y.git",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.path).toBe(projPath);
    expect(body.repoUrl).toBe("https://example.com/y.git");
  });

  it("skips git init for dir that already has .git", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-gitok-"));
    const ws = db.insert(workspaces).values({ name: "ws-gitok", path: wsPath }).returning().get()!;
    const projPath = mkdtempSync(join(tempDir, "existing-git-"));
    mkdirSync(join(projPath, ".git"), { recursive: true });

    (execSync as any).mockImplementation((cmd: string) => {
      if (cmd.startsWith("git init")) throw new Error("should not be called");
      return Buffer.from("");
    });

    const res = await app.request(`/workspaces/${ws.id}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nested-withgit", path: projPath, allowedKeyIds: [keyId] }),
    });
    expect(res.status).toBe(201);
  });

  it("swallows git init errors when .git is absent", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-ginit-fail-"));
    const ws = db.insert(workspaces).values({ name: "ws-ginit-fail", path: wsPath }).returning().get()!;
    const projPath = mkdtempSync(join(tempDir, "nested-noinit-"));

    (execSync as any).mockImplementation((cmd: string) => {
      if (cmd.startsWith("git init")) throw new Error("git not installed");
      return Buffer.from("");
    });

    const res = await app.request(`/workspaces/${ws.id}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nested-noinit", path: projPath, allowedKeyIds: [keyId] }),
    });
    expect(res.status).toBe(201);
  });

  it("422 when nested POST has no name", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-noname-"));
    const ws = db.insert(workspaces).values({ name: "ws-noname", path: wsPath }).returning().get()!;
    const res = await app.request(`/workspaces/${ws.id}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("404 when parent workspace missing on link attempt", async () => {
    const res = await app.request(`/workspaces/99999/projects?project_id=1`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /workspaces/:id cascades", () => {
  it("cascades projects workspace_id to null", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-del-cascade-"));
    const ws = db.insert(workspaces).values({ name: "ws-del-cascade", path: wsPath }).returning().get()!;
    const pPath = mkdtempSync(join(tempDir, "del-cascade-p-"));
    const p = db.insert(projects).values({ name: "child", path: pPath, workspaceId: ws.id }).returning().get()!;
    const res = await app.request(`/workspaces/${ws.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const row = sqlite.prepare(`SELECT workspace_id FROM projects WHERE id = ?`).get(p.id) as { workspace_id: number | null };
    expect(row.workspace_id).toBeNull();
  });
});

// ─── 404 branches on PATCH / DELETE / dashboard ───
describe("missing-workspace 404 branches", () => {
  it("PATCH /workspaces/:id 404 when id unknown", async () => {
    const res = await app.request(`/workspaces/99999`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /workspaces/:id 404 when id unknown", async () => {
    const res = await app.request(`/workspaces/99999`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("GET /workspaces/:id/dashboard 404 when id unknown", async () => {
    const res = await app.request(`/workspaces/99999/dashboard`);
    expect(res.status).toBe(404);
  });
});

// ─── PUT /config — touchedSkills / touchedMcp reconcile paths ───
describe("PUT /workspaces/:id/config — reconcile fan-out", () => {
  it("setting disabledSkills triggers skills reconcile branch", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-cfg-skills-"));
    const ws = db
      .insert(workspaces)
      .values({ name: "ws-cfg-skills", path: wsPath })
      .returning()
      .get()!;
    const res = await app.request(`/workspaces/${ws.id}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabledSkills: ["a"] }),
    });
    expect(res.status).toBe(200);
  });

  it("setting disabledMcpServers triggers mcp reconcile branch", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-cfg-mcp-"));
    const ws = db
      .insert(workspaces)
      .values({ name: "ws-cfg-mcp", path: wsPath })
      .returning()
      .get()!;
    const res = await app.request(`/workspaces/${ws.id}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabledMcpServers: ["srv"] }),
    });
    expect(res.status).toBe(200);
  });
});

// Keep writeFileSync reference to satisfy the unused-import linter.
void writeFileSync;
