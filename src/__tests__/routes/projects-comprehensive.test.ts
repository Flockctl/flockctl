import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createMilestone, createSlice, createPlanTask } from "../../services/plan-store.js";

describe("Projects API — comprehensive", () => {
  let testDb: ReturnType<typeof createTestDb>;
  const projectPath = mkdtempSync(join(tmpdir(), "flockctl-proj-comp-"));

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(projectPath, { recursive: true, force: true });
  });

  // ─── Create ─────────────────────

  describe("POST /projects", () => {
    it("creates a project with all fields", async () => {
      const res = await app.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "My Project",
          description: "A test project",
          path: projectPath,
          repoUrl: "https://github.com/test/repo",
          baseBranch: "develop",
          model: "claude-opus-4-7",
        }),
      });
      expect(res.status).toBe(201);
      const p = await res.json();
      expect(p.name).toBe("My Project");
      expect(p.description).toBe("A test project");
      expect(p.path).toBe(projectPath);
      expect(p.repoUrl).toBe("https://github.com/test/repo");

      // baseBranch and model now live in .flockctl/config.yaml, not DB
      const cfgRes = await app.request(`/projects/${p.id}/config`);
      const cfg = await cfgRes.json();
      expect(cfg.baseBranch).toBe("develop");
      expect(cfg.model).toBe("claude-opus-4-7");
    });

    it("creates a project with minimal fields", async () => {
      const res = await app.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Minimal Project" }),
      });
      expect(res.status).toBe(201);
      const p = await res.json();
      expect(p.name).toBe("Minimal Project");
      expect(p.description).toBeNull();
    });
  });

  // ─── List ─────────────────────

  describe("GET /projects", () => {
    it("returns paginated list", async () => {
      const res = await app.request("/projects");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBe(2);
      expect(body.total).toBe(2);
      expect(body.page).toBe(1);
    });

    it("supports pagination", async () => {
      const res = await app.request("/projects?page=1&per_page=1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBe(1);
    });
  });

  // ─── Get Single ─────────────────────

  describe("GET /projects/:id", () => {
    it("returns project with milestones", async () => {
      const res = await app.request("/projects/1");
      expect(res.status).toBe(200);
      const p = await res.json();
      expect(p.id).toBe(1);
      expect(p.name).toBe("My Project");
      expect(p.milestones).toEqual([]);
    });

    it("returns 404 for non-existent", async () => {
      const res = await app.request("/projects/999");
      expect(res.status).toBe(404);
    });
  });

  // ─── Update ─────────────────────

  describe("PATCH /projects/:id", () => {
    it("updates specific fields", async () => {
      const res = await app.request("/projects/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Updated Project",
          description: "Updated description",
        }),
      });
      expect(res.status).toBe(200);
      const p = await res.json();
      expect(p.name).toBe("Updated Project");
      expect(p.description).toBe("Updated description");
      // yaml-backed fields remain untouched
      const cfgRes = await app.request("/projects/1/config");
      const cfg = await cfgRes.json();
      expect(cfg.baseBranch).toBe("develop");
    });

    it("can update model (relayed to yaml)", async () => {
      const res = await app.request("/projects/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6" }),
      });
      expect(res.status).toBe(200);
      const cfgRes = await app.request("/projects/1/config");
      const cfg = await cfgRes.json();
      expect(cfg.model).toBe("claude-sonnet-4-6");
    });

    it("returns 404 for non-existent", async () => {
      const res = await app.request("/projects/999", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "nope" }),
      });
      expect(res.status).toBe(404);
    });
  });

  // ─── Tree ─────────────────────

  describe("GET /projects/:id/tree", () => {
    it("returns empty tree for project with no milestones", async () => {
      const res = await app.request("/projects/1/tree");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.project.id).toBe(1);
      expect(body.milestones).toEqual([]);
    });

    it("returns full tree with milestones/slices/tasks", async () => {
      // Create milestone → slice → task tree on filesystem
      const ms = createMilestone(projectPath, { title: "Tree Milestone" });
      const sl = createSlice(projectPath, ms.slug, { title: "Tree Slice" });
      createPlanTask(projectPath, ms.slug, sl.slug, { title: "Tree Task" });

      const res = await app.request("/projects/1/tree");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.milestones.length).toBe(1);
      expect(body.milestones[0].title).toBe("Tree Milestone");
      expect(body.milestones[0].slices.length).toBe(1);
      expect(body.milestones[0].slices[0].title).toBe("Tree Slice");
      expect(body.milestones[0].slices[0].tasks.length).toBe(1);
      expect(body.milestones[0].slices[0].tasks[0].title).toBe("Tree Task");
    });

    it("returns 404 for non-existent project", async () => {
      const res = await app.request("/projects/999/tree");
      expect(res.status).toBe(404);
    });
  });

  // ─── Delete ─────────────────────

  describe("DELETE /projects/:id", () => {
    it("deletes project and returns confirmed", async () => {
      const res = await app.request("/projects/2", { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);

      const getRes = await app.request("/projects/2");
      expect(getRes.status).toBe(404);
    });

    it("returns 404 for already deleted project", async () => {
      const res = await app.request("/projects/2", { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("returns 404 for non-existent", async () => {
      const res = await app.request("/projects/999", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  // ─── Schedules ─────────────────────

  describe("GET /projects/:id/schedules", () => {
    it("returns schedule list", async () => {
      const res = await app.request("/projects/1/schedules");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.items)).toBe(true);
    });
  });
});
