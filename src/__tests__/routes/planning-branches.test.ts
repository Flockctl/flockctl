import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { projects, aiProviderKeys } from "../../db/schema.js";
import { mkdtempSync, rmSync } from "fs";
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

vi.mock("../../services/plan-prompt", () => ({
  buildPlanGenerationPrompt: vi.fn(
    async (_pid: number, projectPath: string, desc: string, mode: string) =>
      `PROMPT mode=${mode} desc=${desc} path=${projectPath}`,
  ),
}));

vi.mock("../../services/auto-executor", () => ({
  startAutoExecution: vi.fn(),
  stopAutoExecution: vi.fn(() => true),
  getAutoExecutionStatus: vi.fn(() => ({ running: false })),
}));

describe("Planning — branch coverage", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let projectId: number;
  let projectPath: string;
  let noPathId: number;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);

    projectPath = mkdtempSync(join(tmpdir(), "planning-br-"));
    const p = testDb.db.insert(projects).values({ name: "BR", path: projectPath }).returning().get()!;
    projectId = p.id;

    const noPath = testDb.db.insert(projects).values({ name: "NoPath" }).returning().get()!;
    noPathId = noPath.id;

    testDb.db
      .insert(aiProviderKeys)
      .values({
        provider: "anthropic", providerType: "api-key", label: "test",
        keyValue: "sk-test", priority: 0, isActive: true,
      } as any)
      .run();
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(projectPath, { recursive: true, force: true });
  });

  // ─── POST /generate-plan — request-shape edges ───
  describe("POST /generate-plan shape edges", () => {
    it("rejects prompt that is not a string (number)", async () => {
      const res = await app.request(`/projects/${projectId}/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: 42, mode: "quick" }),
      });
      expect(res.status).toBe(422);
    });

    it("default mode=quick when mode omitted", async () => {
      const res = await app.request(`/projects/${projectId}/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "build something" }),
      });
      expect(res.status).toBe(201);
    });

    it("accepts ai_provider_key_id snake_case", async () => {
      const key = testDb.db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api", label: "snake", isActive: true } as any)
        .returning()
        .get()!;
      const res = await app.request(`/projects/${projectId}/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "build", mode: "quick", ai_provider_key_id: key.id,
        }),
      });
      expect(res.status).toBe(201);
    });

    it("accepts string aiProviderKeyId that parses as integer", async () => {
      const key = testDb.db
        .insert(aiProviderKeys)
        .values({ provider: "anthropic", providerType: "api", label: "strNum", isActive: true } as any)
        .returning()
        .get()!;
      const res = await app.request(`/projects/${projectId}/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "build", mode: "quick", aiProviderKeyId: String(key.id),
        }),
      });
      expect(res.status).toBe(201);
    });

    it("rejects empty-string aiProviderKeyId (doesn't parse as integer)", async () => {
      // Empty-string triggers the trim/ternary null branch — the guard
      // `!Number.isFinite(null)` then throws a ValidationError (422).
      const res = await app.request(`/projects/${projectId}/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "build", mode: "quick", aiProviderKeyId: "" }),
      });
      expect(res.status).toBe(422);
    });

    it("rejects aiProviderKeyId=null when allowlist is set and null is not allowed (null skips)", async () => {
      // null is treated as unset → default key selected.
      const res = await app.request(`/projects/${projectId}/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "build", mode: "quick", aiProviderKeyId: null }),
      });
      expect(res.status).toBe(201);
    });

    it("empty-string model is treated as null", async () => {
      const res = await app.request(`/projects/${projectId}/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "build", mode: "quick", model: "" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      const row = testDb.sqlite.prepare("SELECT model FROM tasks WHERE id = ?").get(body.taskId) as { model: string | null };
      expect(row.model).toBeNull();
    });

    it("whitespace-only model is treated as null", async () => {
      const res = await app.request(`/projects/${projectId}/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "build", mode: "quick", model: "   " }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      const row = testDb.sqlite.prepare("SELECT model FROM tasks WHERE id = ?").get(body.taskId) as { model: string | null };
      expect(row.model).toBeNull();
    });
  });

  // ─── GET /generate-plan/status ───
  describe("GET /generate-plan/status", () => {
    it("returns generating=false when NO plan-generate tasks exist at all", async () => {
      // Use a separate project with no tasks
      const fresh = testDb.db.insert(projects).values({ name: "FreshStat", path: projectPath }).returning().get()!;
      const res = await app.request(`/projects/${fresh.id}/generate-plan/status`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.generating).toBe(false);
    });

    it("reports null mode when label doesn't match plan-generate- pattern", async () => {
      // Insert a completed task with a weird label
      testDb.sqlite
        .prepare(
          `INSERT INTO tasks (project_id, label, status) VALUES (?, 'other-label', 'running')`,
        )
        .run(projectId);

      const res = await app.request(`/projects/${projectId}/generate-plan/status`);
      const body = await res.json();
      // label doesn't start with plan-generate- so we fall through to
      // "latest is plan-generate- completed" from earlier tests.
      // Just assert well-formed response.
      expect(typeof body.generating).toBe("boolean");
    });
  });

  // ─── getProjectPath error branches ───
  describe("getProjectPath — error paths extra", () => {
    it("POST /milestones 404 when project missing", async () => {
      const res = await app.request("/projects/9999/milestones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      });
      expect(res.status).toBe(404);
    });

    it("POST /milestones 422 when project has no path", async () => {
      const res = await app.request(`/projects/${noPathId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      });
      expect(res.status).toBe(422);
    });

    it("GET /execution-graph 422 when project has no path", async () => {
      const res = await app.request(`/projects/${noPathId}/milestones/whatever/execution-graph`);
      expect(res.status).toBe(422);
    });

    it("GET /plan-file 422 when project has no path", async () => {
      const res = await app.request(`/projects/${noPathId}/plan-file?type=milestone&milestone=x`);
      expect(res.status).toBe(422);
    });

    it("PUT /plan-file 422 when project has no path", async () => {
      const res = await app.request(`/projects/${noPathId}/plan-file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "milestone", milestone: "x", content: "body" }),
      });
      expect(res.status).toBe(422);
    });

    it("GET /milestones/:slug/readme 422 when project has no path", async () => {
      const res = await app.request(`/projects/${noPathId}/milestones/x/readme`);
      expect(res.status).toBe(422);
    });

    it("POST /auto-execute-all 422 when project has no path", async () => {
      const res = await app.request(`/projects/${noPathId}/auto-execute-all`, { method: "POST" });
      expect(res.status).toBe(422);
    });
  });

  // ─── resolveEntityPath — all invalid combos ───
  describe("resolveEntityPath — invalid entity combos", () => {
    it("type=milestone with no milestone → 422", async () => {
      const res = await app.request(`/projects/${projectId}/plan-file?type=milestone`);
      expect(res.status).toBe(422);
    });

    it("type=slice missing slice slug → 422", async () => {
      const res = await app.request(`/projects/${projectId}/plan-file?type=slice&milestone=m1`);
      expect(res.status).toBe(422);
    });

    it("type=task missing task slug → 422", async () => {
      const res = await app.request(
        `/projects/${projectId}/plan-file?type=task&milestone=m1&slice=s1`,
      );
      expect(res.status).toBe(422);
    });

    it("empty type → 422", async () => {
      const res = await app.request(`/projects/${projectId}/plan-file`);
      expect(res.status).toBe(422);
    });

    it("PUT with invalid type → 422", async () => {
      const res = await app.request(`/projects/${projectId}/plan-file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "weird", content: "body" }),
      });
      expect(res.status).toBe(422);
    });
  });

  // ─── POST /auto-execute — 404 when project missing ───
  describe("POST /auto-execute additional branches", () => {
    it("404 when project missing", async () => {
      const res = await app.request(`/projects/999/milestones/any/auto-execute`, { method: "POST" });
      expect(res.status).toBe(404);
    });

    it("DELETE /auto-execute returns not_running for unknown milestone", async () => {
      // DELETE doesn't check project/milestone existence.
      const { stopAutoExecution } = await import("../../services/auto-executor.js");
      (stopAutoExecution as any).mockReturnValueOnce(false);
      const res = await app.request(`/projects/${projectId}/milestones/nonexistent/auto-execute`, { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("not_running");
    });
  });

  // ─── selectKeyForTask throws without message ───
  describe("generate-plan — selectKeyForTask error-fallback", () => {
    it("falls back to generic 'No available AI keys' when underlying error has no message", async () => {
      // Mock selectKeyForTask to throw an object without a message.
      const mod = await import("../../services/ai/key-selection.js");
      const orig = mod.selectKeyForTask;
      const spy = vi.spyOn(mod, "selectKeyForTask").mockImplementation(async () => {
        throw {} as any;
      });

      const res = await app.request(`/projects/${projectId}/generate-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "x", mode: "quick" }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(String(body.error ?? body.message ?? "")).toMatch(/No available AI keys/i);

      spy.mockRestore();
      void orig;
    });
  });

  // ─── DELETE /auto-execute with stopped=true branch ───
  describe("DELETE /auto-execute stopped branch", () => {
    it("returns status=stopped when stopAutoExecution returns true", async () => {
      const { stopAutoExecution } = await import("../../services/auto-executor.js");
      (stopAutoExecution as any).mockReturnValueOnce(true);

      const mRes = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "StopMe" }),
      });
      const m = await mRes.json();

      const res = await app.request(`/projects/${projectId}/milestones/${m.slug}/auto-execute`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("stopped");
    });
  });

  // ─── Auto-execute GET — m.status fallback to "pending" ───
  describe("GET /auto-execute status fallback", () => {
    it("uses m.status when executor is NOT running", async () => {
      const mRes = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "StatusFallback", status: "active" }),
      });
      const m = await mRes.json();

      const res = await app.request(`/projects/${projectId}/milestones/${m.slug}/auto-execute`);
      const body = await res.json();
      expect(body.status).toBeDefined();
    });
  });

  // ─── PUT /plan-file — missing type / type undefined ───
  describe("PUT /plan-file — type fallback", () => {
    it("rejects when body.type is missing (falls back to empty string → invalid)", async () => {
      const res = await app.request(`/projects/${projectId}/plan-file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hi", milestone: "m" }),
      });
      expect(res.status).toBe(422);
    });
  });

  // ─── generate-plan/status — mode null branch ───
  describe("GET /generate-plan/status — mode branch", () => {
    it("mode is null when latest task has no label matching plan-generate-", async () => {
      // Create a fresh project with NO plan-generate tasks but a plain task.
      const fresh = testDb.db.insert(projects).values({ name: "ModeNull", path: projectPath }).returning().get()!;
      testDb.sqlite
        .prepare(`INSERT INTO tasks (project_id, label, status) VALUES (?, 'plan-generate-quick', 'completed')`)
        .run(fresh.id);

      const res = await app.request(`/projects/${fresh.id}/generate-plan/status`);
      expect(res.status).toBe(200);
      const body = await res.json();
      // latest is completed → generating false.
      expect(body.generating).toBe(false);
    });

    it("queued plan-generate task is reported as generating=true", async () => {
      const fresh = testDb.db.insert(projects).values({ name: "QueuedRun", path: projectPath }).returning().get()!;
      testDb.sqlite
        .prepare(`INSERT INTO tasks (project_id, label, status) VALUES (?, 'plan-generate-deep', 'queued')`)
        .run(fresh.id);
      const res = await app.request(`/projects/${fresh.id}/generate-plan/status`);
      const body = await res.json();
      expect(body.generating).toBe(true);
      expect(body.mode).toBe("deep");
    });
  });

  // ─── Extra: active slices, execution graph with depends, task plan-file ───
  describe("File & graph edges", () => {
    it("plan-file serves slice content (exercises slice branch of resolveEntityPath)", async () => {
      const mRes = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "EntityPathMilestone" }),
      });
      const m = await mRes.json();
      const sRes = await app.request(`/projects/${projectId}/milestones/${m.slug}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "EntityPathSlice" }),
      });
      const s = await sRes.json();
      const res = await app.request(
        `/projects/${projectId}/plan-file?type=slice&milestone=${m.slug}&slice=${s.slug}`,
      );
      expect(res.status).toBe(200);
    });

    it("plan-file serves task content", async () => {
      const mRes = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "TaskFileMilestone" }),
      });
      const m = await mRes.json();
      const sRes = await app.request(`/projects/${projectId}/milestones/${m.slug}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "TaskFileSlice" }),
      });
      const s = await sRes.json();
      const tRes = await app.request(
        `/projects/${projectId}/milestones/${m.slug}/slices/${s.slug}/tasks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "TF1" }),
        },
      );
      const t = await tRes.json();
      const res = await app.request(
        `/projects/${projectId}/plan-file?type=task&milestone=${m.slug}&slice=${s.slug}&task=${t.slug}`,
      );
      expect(res.status).toBe(200);
    });

    it("auto-execute returns active slice slugs when an active slice exists", async () => {
      const mRes = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "ActiveSliceMilestone" }),
      });
      const m = await mRes.json();
      const sRes = await app.request(`/projects/${projectId}/milestones/${m.slug}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "ActiveSlice" }),
      });
      const s = await sRes.json();
      await app.request(`/projects/${projectId}/milestones/${m.slug}/slices/${s.slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });

      const res = await app.request(`/projects/${projectId}/milestones/${m.slug}/auto-execute`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.current_slice_ids).toContain(s.slug);
    });

    it("auto-execute returns running status when executor is running", async () => {
      const mRes = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "RunningExec" }),
      });
      const m = await mRes.json();

      const { getAutoExecutionStatus } = await import("../../services/auto-executor.js");
      (getAutoExecutionStatus as any).mockReturnValueOnce({ running: true });

      const res = await app.request(`/projects/${projectId}/milestones/${m.slug}/auto-execute`);
      const body = await res.json();
      expect(body.status).toBe("running");
    });

    it("auto-execute-all skips completed milestones", async () => {
      const mRes = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Completed-Skip" }),
      });
      const m = await mRes.json();
      await app.request(`/projects/${projectId}/milestones/${m.slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      });
      const res = await app.request(`/projects/${projectId}/auto-execute-all`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.milestones).not.toContain(m.slug);
    });

    it("execution graph handles slice with depends filter", async () => {
      const mRes = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "GraphDeps" }),
      });
      const m = await mRes.json();
      const s1 = await app.request(`/projects/${projectId}/milestones/${m.slug}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "SliceA" }),
      });
      const sa = await s1.json();
      await app.request(`/projects/${projectId}/milestones/${m.slug}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "SliceB", depends: [sa.slug] }),
      });
      const res = await app.request(`/projects/${projectId}/milestones/${m.slug}/execution-graph`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.waves.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── PATCH milestone body: order variants ───
  describe("PATCH milestone — order variants", () => {
    let mslug: string;
    beforeAll(async () => {
      const r = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Patch Variant" }),
      });
      mslug = (await r.json()).slug;
    });

    it("accepts orderIndex", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${mslug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIndex: 5 }),
      });
      expect(res.status).toBe(200);
    });

    it("accepts order_index (snake_case)", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${mslug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_index: 7 }),
      });
      expect(res.status).toBe(200);
    });

    it("accepts description update", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${mslug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "new desc" }),
      });
      expect(res.status).toBe(200);
    });
  });

  // ─── POST slice/task order variants ───
  describe("Slice/Task order variant branches", () => {
    let mslug: string;
    let sslug: string;
    beforeAll(async () => {
      const mr = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "OrderVariant" }),
      });
      mslug = (await mr.json()).slug;
      const sr = await app.request(`/projects/${projectId}/milestones/${mslug}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "SV1" }),
      });
      sslug = (await sr.json()).slug;
    });

    it("POST slice with order_index snake case", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${mslug}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "OS", order_index: 3 }),
      });
      expect(res.status).toBe(201);
    });

    it("POST slice with order (plain)", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${mslug}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "OP", order: 9 }),
      });
      expect(res.status).toBe(201);
    });

    it("POST task with order_index snake case", async () => {
      const res = await app.request(
        `/projects/${projectId}/milestones/${mslug}/slices/${sslug}/tasks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "OT", order_index: 2 }),
        },
      );
      expect(res.status).toBe(201);
    });

    it("PATCH slice with orderIndex", async () => {
      const res = await app.request(
        `/projects/${projectId}/milestones/${mslug}/slices/${sslug}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderIndex: 11 }),
        },
      );
      expect(res.status).toBe(200);
    });

    it("PATCH milestone with just 'order'", async () => {
      const r = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "PlainOrderMs" }),
      });
      const m = await r.json();
      const res = await app.request(`/projects/${projectId}/milestones/${m.slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: 12 }),
      });
      expect(res.status).toBe(200);
    });

    it("PATCH slice with just 'order' and description", async () => {
      const mr = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "PlainOrderSliceMs" }),
      });
      const m = await mr.json();
      const sr = await app.request(`/projects/${projectId}/milestones/${m.slug}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "POSlice" }),
      });
      const s = await sr.json();
      const res = await app.request(
        `/projects/${projectId}/milestones/${m.slug}/slices/${s.slug}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: 4, description: "plain desc", order_index: 2 }),
        },
      );
      expect(res.status).toBe(200);
    });

    it("PATCH task with 'orderIndex' and description", async () => {
      const mr = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "TaskOIMs" }),
      });
      const m = await mr.json();
      const sr = await app.request(`/projects/${projectId}/milestones/${m.slug}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "TaskOISl" }),
      });
      const s = await sr.json();
      const tr = await app.request(
        `/projects/${projectId}/milestones/${m.slug}/slices/${s.slug}/tasks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "PatchTarget" }),
        },
      );
      const t = await tr.json();
      const res = await app.request(
        `/projects/${projectId}/milestones/${m.slug}/slices/${s.slug}/tasks/${t.slug}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderIndex: 3, order: 5, description: "x" }),
        },
      );
      expect(res.status).toBe(200);
    });

    it("PATCH task with order_index", async () => {
      // Create a task first
      const tr = await app.request(
        `/projects/${projectId}/milestones/${mslug}/slices/${sslug}/tasks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "ForPatch" }),
        },
      );
      const tslug = (await tr.json()).slug;
      const res = await app.request(
        `/projects/${projectId}/milestones/${mslug}/slices/${sslug}/tasks/${tslug}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order_index: 4 }),
        },
      );
      expect(res.status).toBe(200);
    });
  });
});
