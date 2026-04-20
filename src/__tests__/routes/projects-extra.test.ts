import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { projects, tasks, taskTemplates, schedules, usageRecords } from "../../db/schema.js";

describe("Projects API — extra coverage", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const projPath = mkdtempSync(join(tmpdir(), "flockctl-proj-extra-"));
  let projectId: number;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    const p = testDb.db.insert(projects).values({
      name: "ExtraProj",
      path: projPath,
    }).returning().get()!;
    projectId = p.id;
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(projPath, { recursive: true, force: true });
  });

  describe("POST /projects validation", () => {
    it("rejects missing name", async () => {
      const res = await app.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(422);
    });

    it("auto-derives path from name when path is omitted", async () => {
      const tmpHome = mkdtempSync(join(tmpdir(), "home-autopath-"));
      const originalHome = process.env.HOME;
      process.env.HOME = tmpHome;

      try {
        const res = await app.request("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Auto Path Proj" }),
        });
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.path).toBeTruthy();
        // Cleanup created dir
        if (body.path && existsSync(body.path)) {
          rmSync(body.path, { recursive: true, force: true });
        }
      } finally {
        if (originalHome) process.env.HOME = originalHome;
        else delete process.env.HOME;
        rmSync(tmpHome, { recursive: true, force: true });
      }
    });
  });

  describe("GET /projects/:id/stats", () => {
    beforeEach(() => {
      testDb.sqlite.exec(`
        DELETE FROM tasks;
        DELETE FROM usage_records;
        DELETE FROM schedules;
        DELETE FROM task_templates;
      `);
    });

    it("returns empty stats for new project", async () => {
      const res = await app.request(`/projects/${projectId}/stats`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tasks.total).toBe(0);
      expect(body.milestones.total).toBe(0);
      expect(body.slices.total).toBe(0);
      expect(body.usage.totalCostUsd).toBe(0);
    });

    it("aggregates task + usage stats", async () => {
      testDb.db.insert(tasks).values([
        { projectId, status: "done", startedAt: "2025-01-01T10:00:00Z", completedAt: "2025-01-01T10:01:00Z" },
        { projectId, status: "done" },
        { projectId, status: "failed" },
      ] as any).run();

      testDb.db.insert(usageRecords).values([
        { projectId, provider: "anthropic", model: "m", inputTokens: 100, outputTokens: 50, totalCostUsd: 0.5 },
      ] as any).run();

      const res = await app.request(`/projects/${projectId}/stats`);
      const body = await res.json();
      expect(body.tasks.total).toBe(3);
      expect(body.tasks.done).toBe(2);
      expect(body.tasks.failed).toBe(1);
      expect(body.usage.totalCostUsd).toBeCloseTo(0.5, 2);
      expect(body.usage.totalInputTokens).toBe(100);
    });

    it("returns 404 for unknown project stats", async () => {
      const res = await app.request("/projects/9999/stats");
      expect(res.status).toBe(404);
    });
  });

  describe("GET/PUT /projects/:id/config", () => {
    it("GET returns empty for fresh project", async () => {
      const res = await app.request(`/projects/${projectId}/config`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body).toBe("object");
    });

    it("PUT saves then GET reads back", async () => {
      const payload = {
        model: "claude-opus-4-7",
        baseBranch: "develop",
        testCommand: "npm test",
        budgetDailyUsd: 10,
      };
      const res = await app.request(`/projects/${projectId}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(200);
      const saved = await res.json();
      expect(saved.model).toBe("claude-opus-4-7");
      expect(saved.baseBranch).toBe("develop");

      const getRes = await app.request(`/projects/${projectId}/config`);
      const loaded = await getRes.json();
      expect(loaded.model).toBe("claude-opus-4-7");
      expect(loaded.testCommand).toBe("npm test");
    });

    it("PUT removes empty/null/empty-array values", async () => {
      const res = await app.request(`/projects/${projectId}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: null,
          testCommand: "",
          allowedProviders: [],
        }),
      });
      expect(res.status).toBe(200);
      const saved = await res.json();
      expect(saved.model).toBeUndefined();
      expect(saved.testCommand).toBeUndefined();
      expect(saved.allowedProviders).toBeUndefined();
    });

    it("GET returns {} if project has no path", async () => {
      const noPath = testDb.db.insert(projects).values({ name: "No Path" }).returning().get()!;
      const res = await app.request(`/projects/${noPath.id}/config`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({});
    });

    it("PUT fails if project has no path", async () => {
      const noPath = testDb.db.insert(projects).values({ name: "No Path 2" }).returning().get()!;
      const res = await app.request(`/projects/${noPath.id}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "x" }),
      });
      expect(res.status).toBe(422);
    });

    it("GET 404 for unknown project", async () => {
      const res = await app.request("/projects/9999/config");
      expect(res.status).toBe(404);
    });

    it("PUT 404 for unknown project", async () => {
      const res = await app.request("/projects/9999/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /projects/:id/schedules", () => {
    it("returns 404 for unknown project", async () => {
      const res = await app.request("/projects/9999/schedules");
      expect(res.status).toBe(404);
    });

    it("lists schedules linked via templates", async () => {
      const tpl = testDb.db.insert(taskTemplates).values({ projectId, name: "T" }).returning().get()!;
      testDb.db.insert(schedules).values({
        templateId: tpl.id, scheduleType: "cron", cronExpression: "* * * * *", status: "active",
      } as any).run();

      const res = await app.request(`/projects/${projectId}/schedules`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.items.length).toBe(1);
    });
  });

  describe("PATCH /projects/:id with many fields", () => {
    it("relays yaml-backed fields to .flockctl/config.yaml", async () => {
      const res = await app.request(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerFallbackChain: ["anthropic", "openai"],
          allowedKeyIds: [1, 2],
          allowedProviders: ["anthropic", "openai"],
          env: { FOO: "bar" },
          maxConcurrentTasks: 5,
          budgetDailyUsd: 20,
          requiresApproval: true,
        }),
      });
      expect(res.status).toBe(200);
      const p = await res.json();
      expect(p.providerFallbackChain).toContain("anthropic");
      expect(JSON.parse(p.allowedKeyIds)).toEqual([1, 2]);

      const cfgRes = await app.request(`/projects/${projectId}/config`);
      const cfg = await cfgRes.json();
      expect(cfg.allowedProviders).toContain("anthropic");
      expect(cfg.env).toEqual({ FOO: "bar" });
      expect(cfg.maxConcurrentTasks).toBe(5);
      expect(cfg.requiresApproval).toBe(true);
    });

    it("clears DB arrays by passing null", async () => {
      const res = await app.request(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allowedKeyIds: null,
          providerFallbackChain: null,
        }),
      });
      expect(res.status).toBe(200);
      const p = await res.json();
      expect(p.allowedKeyIds).toBeNull();
      expect(p.providerFallbackChain).toBeNull();
    });
  });

  describe("POST /projects with importActions", () => {
    it("accepts every valid kind and ignores unknown / malformed entries", async () => {
      const path = mkdtempSync(join(tmpdir(), "flockctl-proj-import-"));
      try {
        const res = await app.request("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Import Variety",
            path,
            importActions: [
              { kind: "adoptAgentsMd" },
              { kind: "mergeClaudeMd" },
              { kind: "importMcpJson" },
              { kind: "importClaudeSkill", name: "valid-skill" },
              { kind: "importClaudeSkill", name: "" },
              { kind: "importClaudeSkill" },
              { kind: "unknown-kind" },
              null,
              "scalar-not-object",
            ],
          }),
        });
        expect(res.status).toBe(201);
      } finally {
        rmSync(path, { recursive: true, force: true });
      }
    });

    it("ignores importActions when not an array", async () => {
      const path = mkdtempSync(join(tmpdir(), "flockctl-proj-import-na-"));
      try {
        const res = await app.request("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Import Not Array",
            path,
            importActions: "not-an-array",
          }),
        });
        expect(res.status).toBe(201);
      } finally {
        rmSync(path, { recursive: true, force: true });
      }
    });

    it("logs and continues when applyImportActions throws (e.g. unsafe skill name)", async () => {
      const path = mkdtempSync(join(tmpdir(), "flockctl-proj-import-throw-"));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await app.request("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Import Throws",
            path,
            importActions: [{ kind: "importClaudeSkill", name: "../traversal" }],
          }),
        });
        expect(res.status).toBe(201);
        expect(errSpy).toHaveBeenCalled();
      } finally {
        errSpy.mockRestore();
        rmSync(path, { recursive: true, force: true });
      }
    });
  });
});
