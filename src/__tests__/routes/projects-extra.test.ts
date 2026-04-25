import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { app } from "../../server.js";
import { createTestDb, seedActiveKey } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { projects, tasks, schedules, usageRecords, workspaces, aiProviderKeys } from "../../db/schema.js";

describe("Projects API — extra coverage", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const projPath = mkdtempSync(join(tmpdir(), "flockctl-proj-extra-"));
  let projectId: number;
  let keyId: number;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    // POST /projects requires allowedKeyIds — seed one active key.
    keyId = seedActiveKey(testDb.sqlite);
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

    // ─── allowedKeyIds is mandatory on create ─────────────────────
    // See src/routes/_allowed-keys.ts — create requires a non-empty
    // array of existing, active key IDs. Every failure mode returns 422
    // so the UI form can surface a single error path.
    it("rejects missing allowedKeyIds", async () => {
      const res = await app.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "needs-keys" }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(String(body.error ?? body.detail ?? "")).toMatch(/allowedKeyIds/);
    });

    it("rejects empty allowedKeyIds array", async () => {
      const res = await app.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "empty-keys", allowedKeyIds: [] }),
      });
      expect(res.status).toBe(422);
    });

    it("rejects unknown key ID", async () => {
      const res = await app.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "bad-key", allowedKeyIds: [99999] }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(String(body.error ?? body.detail ?? "")).toMatch(/unknown key/);
    });

    it("rejects inactive key ID", async () => {
      // Seed an inactive key and prove POST rejects it. Can't reuse
      // the module-level active `keyId` — we need a second row flagged
      // is_active=0 so the validator's active-check branch is exercised.
      const inactiveId = Number(
        testDb.sqlite.prepare(
          `INSERT INTO ai_provider_keys (provider, provider_type, label, is_active) VALUES ('anthropic', 'api-key', 'inactive', 0)`,
        ).run().lastInsertRowid,
      );
      const res = await app.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "inactive-key", allowedKeyIds: [inactiveId] }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(String(body.error ?? body.detail ?? "")).toMatch(/inactive/);
    });

    it("accepts a valid active key and persists allowedKeyIds", async () => {
      const path = mkdtempSync(join(tmpdir(), "flockctl-proj-keyok-"));
      try {
        const res = await app.request("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "ok-key", path, allowedKeyIds: [keyId] }),
        });
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.allowedKeyIds).toBe(JSON.stringify([keyId]));
      } finally {
        rmSync(path, { recursive: true, force: true });
      }
    });

    it("auto-derives path from name when path is omitted", async () => {
      const tmpHome = mkdtempSync(join(tmpdir(), "home-autopath-"));
      const originalHome = process.env.HOME;
      process.env.HOME = tmpHome;

      try {
        const res = await app.request("/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Auto Path Proj", allowedKeyIds: [keyId] }),
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

    it("lists schedules referencing this project by templateProjectId", async () => {
      // templates live on disk now; the route filters schedules directly by
      // `templateProjectId` so we don't need an actual template file to verify
      // the SQL predicate — a bare row with the right scope + id is enough.
      testDb.db.insert(schedules).values({
        templateScope: "project",
        templateName: "T",
        templateProjectId: projectId,
        scheduleType: "cron",
        cronExpression: "* * * * *",
        status: "active",
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
          allowedKeyIds: [keyId],
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
      expect(JSON.parse(p.allowedKeyIds)).toEqual([keyId]);

      const cfgRes = await app.request(`/projects/${projectId}/config`);
      const cfg = await cfgRes.json();
      expect(cfg.allowedProviders).toContain("anthropic");
      expect(cfg.env).toEqual({ FOO: "bar" });
      expect(cfg.maxConcurrentTasks).toBe(5);
      expect(cfg.requiresApproval).toBe(true);
    });

    // providerFallbackChain still supports null-clearing; allowedKeyIds
    // does NOT (see parseRequiredAllowedKeyIdsOnUpdate) — clearing the
    // key allow-list would let a user bypass the create-time mandatory-
    // keys gate one PATCH later.
    it("clears providerFallbackChain by passing null", async () => {
      const res = await app.request(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerFallbackChain: null }),
      });
      expect(res.status).toBe(200);
      const p = await res.json();
      expect(p.providerFallbackChain).toBeNull();
    });

    it("rejects clearing allowedKeyIds with null", async () => {
      const res = await app.request(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedKeyIds: null }),
      });
      expect(res.status).toBe(422);
    });

    it("rejects clearing allowedKeyIds with empty array", async () => {
      const res = await app.request(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedKeyIds: [] }),
      });
      expect(res.status).toBe(422);
    });

    it("rejects unknown key ID on PATCH", async () => {
      const res = await app.request(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedKeyIds: [99999] }),
      });
      expect(res.status).toBe(422);
    });

    it("leaves allowedKeyIds untouched when omitted", async () => {
      // Seed a known value, then PATCH something unrelated.
      await app.request(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedKeyIds: [keyId] }),
      });
      const res = await app.request(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "renamed only" }),
      });
      expect(res.status).toBe(200);
      const p = await res.json();
      expect(JSON.parse(p.allowedKeyIds)).toEqual([keyId]);
      expect(p.description).toBe("renamed only");
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
            allowedKeyIds: [keyId],
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
            allowedKeyIds: [keyId],
            importActions: "not-an-array",
          }),
        });
        expect(res.status).toBe(201);
      } finally {
        rmSync(path, { recursive: true, force: true });
      }
    });

    // Intentional gap: GET /projects/:id/allowed-keys coverage lives in its
    // own describe block below.

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
            allowedKeyIds: [keyId],
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

  // ─────────────────────────────────────────────────────────────────────
  // GET /projects/:id/allowed-keys — resolved allow-list with inheritance
  //
  // Exercises every branch of the resolver:
  //   - no whitelist anywhere     → source="none",     ids=null
  //   - whitelist only on project → source="project",  ids=project ids
  //   - whitelist only on workspace→ source="workspace",ids=workspace ids
  //   - whitelist on both         → project wins (no merge)
  // ─────────────────────────────────────────────────────────────────────
  describe("GET /projects/:id/allowed-keys — inheritance", () => {
    let keyA: number;
    let keyB: number;
    let wsId: number;
    let pidRestricted: number;
    let pidWorkspaceOnly: number;
    let pidNoRestriction: number;
    let pidBoth: number;
    let wsPath: string;
    let pathA: string;
    let pathB: string;
    let pathC: string;
    let pathD: string;

    beforeAll(() => {
      // Two keys we can reference from allow-lists.
      keyA = testDb.db.insert(aiProviderKeys).values({
        provider: "claude_cli", providerType: "cli", label: "A",
      }).returning().get()!.id;
      keyB = testDb.db.insert(aiProviderKeys).values({
        provider: "github_copilot", providerType: "copilot-sdk", label: "B", keyValue: "ghp_x",
      }).returning().get()!.id;

      wsPath = mkdtempSync(join(tmpdir(), "flockctl-ws-allowkeys-"));
      wsId = testDb.db.insert(workspaces).values({
        name: "allow-keys-ws",
        path: wsPath,
        allowedKeyIds: JSON.stringify([keyB]),
      }).returning().get()!.id;

      pathA = mkdtempSync(join(tmpdir(), "flockctl-proj-allowkeys-a-"));
      pathB = mkdtempSync(join(tmpdir(), "flockctl-proj-allowkeys-b-"));
      pathC = mkdtempSync(join(tmpdir(), "flockctl-proj-allowkeys-c-"));
      pathD = mkdtempSync(join(tmpdir(), "flockctl-proj-allowkeys-d-"));

      pidRestricted = testDb.db.insert(projects).values({
        name: "proj-restricted", path: pathA,
        allowedKeyIds: JSON.stringify([keyA]),
      }).returning().get()!.id;

      pidWorkspaceOnly = testDb.db.insert(projects).values({
        name: "proj-workspace-only", path: pathB, workspaceId: wsId,
      }).returning().get()!.id;

      pidNoRestriction = testDb.db.insert(projects).values({
        name: "proj-no-restriction", path: pathC,
      }).returning().get()!.id;

      pidBoth = testDb.db.insert(projects).values({
        name: "proj-both", path: pathD, workspaceId: wsId,
        allowedKeyIds: JSON.stringify([keyA]),
      }).returning().get()!.id;
    });

    afterAll(() => {
      for (const p of [pathA, pathB, pathC, pathD, wsPath]) {
        rmSync(p, { recursive: true, force: true });
      }
    });

    it("returns project-level allow-list when set", async () => {
      const res = await app.request(`/projects/${pidRestricted}/allowed-keys`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe("project");
      expect(body.allowedKeyIds).toEqual([keyA]);
    });

    it("falls back to workspace allow-list when project has none", async () => {
      const res = await app.request(`/projects/${pidWorkspaceOnly}/allowed-keys`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe("workspace");
      expect(body.allowedKeyIds).toEqual([keyB]);
    });

    it("returns null when no restriction is configured anywhere", async () => {
      const res = await app.request(`/projects/${pidNoRestriction}/allowed-keys`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe("none");
      expect(body.allowedKeyIds).toBeNull();
    });

    it("project overrides workspace (no merge)", async () => {
      const res = await app.request(`/projects/${pidBoth}/allowed-keys`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe("project");
      expect(body.allowedKeyIds).toEqual([keyA]);
    });

    it("404 for unknown project", async () => {
      const res = await app.request("/projects/9999/allowed-keys");
      expect(res.status).toBe(404);
    });
  });
});
