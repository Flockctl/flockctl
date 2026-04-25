import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { projects, aiProviderKeys } from "../../db/schema.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock task executor so generate-plan doesn't spawn subprocess
vi.mock("../../services/task-executor/index", () => ({
  taskExecutor: {
    execute: vi.fn(),
    cancel: vi.fn(),
    getMetrics: vi.fn(() => null),
    isRunning: vi.fn(() => false),
    resolvePermission: vi.fn(() => true),
  },
}));

// Mock plan-prompt so we don't need to load real skill/codebase context
vi.mock("../../services/plan-prompt", () => ({
  buildPlanGenerationPrompt: vi.fn(
    async (_pid: number, projectPath: string, desc: string, mode: string) =>
      `PROMPT mode=${mode} desc=${desc} path=${projectPath}`,
  ),
}));

// Mock auto-executor so start/stop don't actually run
vi.mock("../../services/auto-executor", () => ({
  startAutoExecution: vi.fn(),
  stopAutoExecution: vi.fn(() => true),
  getAutoExecutionStatus: vi.fn(() => ({ running: false })),
}));

describe("Planning — extras", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let projectId: number;
  let projectPath: string;
  let noPathId: number;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);

    projectPath = mkdtempSync(join(tmpdir(), "planning-extra-"));
    const p = testDb.db
      .insert(projects)
      .values({ name: "Extra Plan", path: projectPath })
      .returning()
      .get()!;
    projectId = p.id;

    const noPath = testDb.db.insert(projects).values({ name: "No Path" }).returning().get()!;
    noPathId = noPath.id;

    testDb.db
      .insert(aiProviderKeys)
      .values({
        provider: "anthropic",
        providerType: "api",
        label: "test",
        keyValue: "sk-test",
        priority: 0,
      } as any)
      .run();
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(projectPath, { recursive: true, force: true });
  });

  describe("getProjectPath — error paths", () => {
    it("returns 404 for unknown project (milestones)", async () => {
      const res = await app.request("/projects/9999/milestones");
      expect(res.status).toBe(404);
    });

    it("returns 422 when project has no path (milestones)", async () => {
      const res = await app.request(`/projects/${noPathId}/milestones`);
      expect(res.status).toBe(422);
    });
  });

  describe("POST /projects/:pid/generate-plan", () => {
    it("rejects missing prompt", async () => {
      const res = await app.request(`/projects/${projectId}/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(422);
    });

    it("rejects invalid mode", async () => {
      const res = await app.request(`/projects/${projectId}/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Build something", mode: "bogus" }),
      });
      expect(res.status).toBe(422);
    });

    it("creates a plan-generation task and returns taskId", async () => {
      const res = await app.request(`/projects/${projectId}/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Build a login flow", mode: "quick" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.taskId).toBeGreaterThan(0);

      const { taskExecutor } = await import("../../services/task-executor/index.js");
      expect(taskExecutor.execute).toHaveBeenCalledWith(body.taskId);
    });

    it("accepts mode=deep", async () => {
      const res = await app.request(`/projects/${projectId}/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Complex plan", mode: "deep" }),
      });
      expect(res.status).toBe(201);
    });

    it("returns 422 when no AI keys available", async () => {
      // Deactivate all keys
      testDb.sqlite.exec("UPDATE ai_provider_keys SET is_active = 0;");
      const res = await app.request(`/projects/${projectId}/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Plan X", mode: "quick" }),
      });
      expect(res.status).toBe(422);
      testDb.sqlite.exec("UPDATE ai_provider_keys SET is_active = 1;");
    });

    // Optional UI-provided overrides: `aiProviderKeyId` pins the task to a
    // specific key (subject to the project/workspace whitelist) and `model`
    // pins the model string. Both are simply written onto the task row so
    // the executor picks them up without special-casing plan generation.
    it("persists aiProviderKeyId + model onto the generated task when provided", async () => {
      const keyRow = testDb.db
        .insert(aiProviderKeys)
        .values({
          provider: "claude_cli",
          providerType: "cli",
          label: "plan-key",
        } as any)
        .returning()
        .get()!;

      const res = await app.request(`/projects/${projectId}/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Build something",
          mode: "quick",
          aiProviderKeyId: keyRow.id,
          model: "claude-opus-4-7",
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();

      const row = testDb.sqlite
        .prepare("SELECT assigned_key_id, model FROM tasks WHERE id = ?")
        .get(body.taskId) as { assigned_key_id: number; model: string };
      expect(row.assigned_key_id).toBe(keyRow.id);
      expect(row.model).toBe("claude-opus-4-7");
    });

    it("rejects aiProviderKeyId that is not in the project whitelist", async () => {
      // Pick a key not in the whitelist, then restrict the project to a
      // different key — the API must 422 with a clear allow-list hint.
      const permitted = testDb.db
        .insert(aiProviderKeys)
        .values({ provider: "claude_cli", providerType: "cli", label: "permitted" } as any)
        .returning()
        .get()!;
      const forbidden = testDb.db
        .insert(aiProviderKeys)
        .values({ provider: "claude_cli", providerType: "cli", label: "forbidden" } as any)
        .returning()
        .get()!;
      testDb.sqlite
        .prepare("UPDATE projects SET allowed_key_ids = ? WHERE id = ?")
        .run(JSON.stringify([permitted.id]), projectId);

      const res = await app.request(`/projects/${projectId}/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Build something",
          mode: "quick",
          aiProviderKeyId: forbidden.id,
        }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(String(body.error ?? body.message ?? "")).toMatch(/allowed key list/i);

      // Clean up so later tests don't inherit the restriction.
      testDb.sqlite
        .prepare("UPDATE projects SET allowed_key_ids = NULL WHERE id = ?")
        .run(projectId);
    });

    it("rejects non-numeric aiProviderKeyId", async () => {
      const res = await app.request(`/projects/${projectId}/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Build something",
          mode: "quick",
          aiProviderKeyId: "not-a-number",
        }),
      });
      expect(res.status).toBe(422);
    });
  });

  describe("GET /projects/:pid/generate-plan/status", () => {
    it("reports generating=true while a plan-generate task is queued/running", async () => {
      // Mark the most recent plan-generate task as running so it shows up.
      testDb.sqlite.exec(
        `UPDATE tasks SET status = 'running'
          WHERE id = (
            SELECT id FROM tasks
             WHERE project_id = ${projectId}
               AND label LIKE 'plan-generate-%'
             ORDER BY created_at DESC LIMIT 1
          );`,
      );

      const res = await app.request(
        `/projects/${projectId}/generate-plan/status`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.generating).toBe(true);
      expect(body.task_id).toBeGreaterThan(0);
      expect(body.status).toBe("running");
      expect(["quick", "deep"]).toContain(body.mode);
    });

    it("reports generating=false once tasks are no longer queued/running", async () => {
      testDb.sqlite.exec(
        `UPDATE tasks SET status = 'completed'
          WHERE project_id = ${projectId}
            AND label LIKE 'plan-generate-%';`,
      );

      const res = await app.request(
        `/projects/${projectId}/generate-plan/status`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.generating).toBe(false);
    });
  });

  describe("POST /projects/:pid/auto-execute-all", () => {
    it("starts execution for all non-completed milestones", async () => {
      // Create two milestones via the real CRUD endpoint
      await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "M-auto-1" }),
      });
      await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "M-auto-2" }),
      });

      const res = await app.request(`/projects/${projectId}/auto-execute-all`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("started");
      expect(body.milestones.length).toBeGreaterThanOrEqual(2);

      const { startAutoExecution } = await import("../../services/auto-executor.js");
      expect(startAutoExecution).toHaveBeenCalled();
    });
  });

  describe("GET /projects/:pid/plan-file", () => {
    it("returns 404 for missing file", async () => {
      const res = await app.request(
        `/projects/${projectId}/plan-file?type=milestone&milestone=does-not-exist`,
      );
      expect(res.status).toBe(404);
    });

    it("returns 422 for invalid type", async () => {
      const res = await app.request(`/projects/${projectId}/plan-file?type=bogus`);
      expect(res.status).toBe(422);
    });

    it("reads milestone markdown", async () => {
      // Create milestone via real endpoint (creates planfile on disk)
      const mRes = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Read File Test" }),
      });
      const m = await mRes.json();

      const res = await app.request(
        `/projects/${projectId}/plan-file?type=milestone&milestone=${m.slug}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.content).toBe("string");
      expect(body.content.length).toBeGreaterThan(0);
      expect(body.path).toContain(m.slug);
    });

    it("reads slice markdown", async () => {
      const mRes = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Slice File Holder" }),
      });
      const m = await mRes.json();
      const sRes = await app.request(
        `/projects/${projectId}/milestones/${m.slug}/slices`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Slice Reader" }),
        },
      );
      const s = await sRes.json();

      const res = await app.request(
        `/projects/${projectId}/plan-file?type=slice&milestone=${m.slug}&slice=${s.slug}`,
      );
      expect(res.status).toBe(200);
    });
  });

  describe("GET /projects/:pid/milestones/:slug/readme", () => {
    it("returns 404 when README.md is absent", async () => {
      const mRes = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "No Readme Milestone" }),
      });
      const m = await mRes.json();

      const res = await app.request(
        `/projects/${projectId}/milestones/${m.slug}/readme`,
      );
      expect(res.status).toBe(404);
    });

    it("serves README.md when present", async () => {
      const mRes = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Has Readme" }),
      });
      const m = await mRes.json();

      const readmePath = join(projectPath, ".flockctl", "plan", m.slug, "README.md");
      writeFileSync(readmePath, "# Has Readme\n\nBody prose.\n", "utf-8");

      const res = await app.request(
        `/projects/${projectId}/milestones/${m.slug}/readme`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content).toContain("# Has Readme");
      expect(body.path).toContain("README.md");
    });
  });

  describe("PUT /projects/:pid/plan-file", () => {
    it("rejects missing content", async () => {
      const res = await app.request(`/projects/${projectId}/plan-file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "milestone", milestone: "x" }),
      });
      expect(res.status).toBe(422);
    });

    it("returns 404 when file doesn't exist", async () => {
      const res = await app.request(`/projects/${projectId}/plan-file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "milestone",
          milestone: "totally-missing",
          content: "---\ntitle: X\n---\n# body",
        }),
      });
      expect(res.status).toBe(404);
    });

    it("writes markdown with frontmatter", async () => {
      const mRes = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Writable Milestone" }),
      });
      const m = await mRes.json();

      const newContent = `---\ntitle: Writable Milestone\nstatus: active\norder: 0\n---\n\nUpdated body text\n`;
      const res = await app.request(`/projects/${projectId}/plan-file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "milestone",
          milestone: m.slug,
          content: newContent,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it("writes markdown WITHOUT frontmatter (falls back to empty fm)", async () => {
      const mRes = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Plain Body Milestone" }),
      });
      const m = await mRes.json();

      const res = await app.request(`/projects/${projectId}/plan-file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "milestone",
          milestone: m.slug,
          content: "Just a plain body with no frontmatter.",
        }),
      });
      expect(res.status).toBe(200);
    });
  });

});
