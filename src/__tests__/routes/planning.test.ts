import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { projects } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Planning API", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let projectId: number;
  let projectPath: string;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);

    projectPath = mkdtempSync(join(tmpdir(), "planning-test-"));
    const p = testDb.db.insert(projects).values({
      name: "Test Project",
      description: "For planning tests",
      path: projectPath,
    }).returning().get();
    projectId = p!.id;
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(projectPath, { recursive: true, force: true });
  });

  // ─── Milestones ─────────────────────────────────

  describe("Milestones CRUD", () => {
    let milestoneSlug: string;
    let milestone3Slug: string;

    it("POST /projects/:pid/milestones creates a milestone", async () => {
      const res = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Phase 1: Foundation",
          description: "Build the base layer",
          vision: "Solid foundation for the project",
          successCriteria: ["Tests pass", "CI green"],
          orderIndex: 0,
        }),
      });
      expect(res.status).toBe(201);
      const m = await res.json();
      expect(m.description).toBe("Build the base layer");
      expect(m.status).toBe("pending");
      expect(m.order).toBe(0);
      expect(m.slug).toBeDefined();
      milestoneSlug = m.slug;
    });

    it("POST /projects/:pid/milestones with minimal fields", async () => {
      const res = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Phase 2: Core" }),
      });
      expect(res.status).toBe(201);
      const m = await res.json();
      expect(m.title).toBe("Phase 2: Core");
      expect(m.status).toBe("pending");
    });

    it("POST /projects/:pid/milestones with deep plan fields", async () => {
      const res = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Phase 3: Advanced",
          keyRisks: [{ risk: "API stability", whyItMatters: "Breaking changes" }],
          proofStrategy: [{ riskOrUnknown: "perf", retireIn: "Phase 3", whatWillBeProven: "Low latency" }],
          boundaryMapMarkdown: "## Boundaries\n- Module A ↔ Module B",
          definitionOfDone: ["All tests pass", "Docs updated"],
        }),
      });
      expect(res.status).toBe(201);
      const m = await res.json();
      expect(m.title).toBe("Phase 3: Advanced");
      expect(m.keyRisks).toBeTruthy();
      milestone3Slug = m.slug;
    });

    it("GET /projects/:pid/milestones lists all milestones ordered", async () => {
      const res = await app.request(`/projects/${projectId}/milestones`);
      expect(res.status).toBe(200);
      const items = await res.json();
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBeGreaterThanOrEqual(3);
      expect(items[0].title).toBe("Phase 1: Foundation");
    });

    it("GET /projects/:pid/milestones/:slug returns single milestone", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}`);
      expect(res.status).toBe(200);
      const m = await res.json();
      expect(m.slug).toBe(milestoneSlug);
      expect(m.title).toBe("Phase 1: Foundation");
    });

    it("GET /projects/:pid/milestones/:slug returns 404 for missing", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/nonexistent`);
      expect(res.status).toBe(404);
    });

    it("PATCH /projects/:pid/milestones/:slug updates fields", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Phase 1: Updated Foundation",
          status: "active",
        }),
      });
      expect(res.status).toBe(200);
      const m = await res.json();
      expect(m.title).toBe("Phase 1: Updated Foundation");
      expect(m.status).toBe("active");
    });

    it("PATCH /projects/:pid/milestones/:slug returns 404 for missing", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/nonexistent`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "nope" }),
      });
      expect(res.status).toBe(404);
    });

    it("DELETE /projects/:pid/milestones/:slug deletes milestone", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestone3Slug}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);

      // Verify it's gone
      const getRes = await app.request(`/projects/${projectId}/milestones/${milestone3Slug}`);
      expect(getRes.status).toBe(404);
    });

    it("DELETE /projects/:pid/milestones/:slug returns 404 for missing", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/nonexistent`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    it("POST /projects/999/milestones returns 404 for missing project", async () => {
      const res = await app.request(`/projects/999/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Orphan" }),
      });
      expect(res.status).toBe(404);
    });
  });

  // ─── Slices ─────────────────────────────────

  describe("Slices CRUD", () => {
    let milestoneSlug: string;
    let sliceSlug: string;

    beforeAll(async () => {
      // Create a milestone for slice tests
      const res = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Slice Test Milestone" }),
      });
      const m = await res.json();
      milestoneSlug = m.slug;
    });

    it("POST .../slices creates a slice", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Setup database",
          description: "Create schema and migrations",
          risk: "high",
          goal: "Working DB",
          demo: "Query succeeds",
          successCriteria: "All tables created",
          depends: [],
          orderIndex: 0,
        }),
      });
      expect(res.status).toBe(201);
      const s = await res.json();
      expect(s.title).toBe("Setup database");
      expect(s.risk).toBe("high");
      expect(s.status).toBe("pending");
      expect(s.slug).toBeDefined();
      sliceSlug = s.slug;
    });

    it("POST .../slices with minimal fields", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Add API routes" }),
      });
      expect(res.status).toBe(201);
      const s = await res.json();
      expect(s.title).toBe("Add API routes");
    });

    it("POST .../slices with deep plan fields", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Auth slice",
          proofLevel: "integration",
          integrationClosure: "JWT verified end-to-end",
          observabilityImpact: "Auth failures logged",
          threatSurface: "Token theft via XSS",
        }),
      });
      expect(res.status).toBe(201);
      const s = await res.json();
      expect(s.proofLevel).toBe("integration");
      expect(s.threatSurface).toBe("Token theft via XSS");
    });

    it("POST .../slices with depends", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Integration tests",
          depends: [sliceSlug],
          orderIndex: 3,
        }),
      });
      expect(res.status).toBe(201);
    });

    it("GET .../slices lists slices", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices`);
      expect(res.status).toBe(200);
      const items = await res.json();
      expect(items.length).toBe(4);
    });

    it("GET .../slices/:slug returns single slice", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/${sliceSlug}`);
      expect(res.status).toBe(200);
      const s = await res.json();
      expect(s.slug).toBe(sliceSlug);
    });

    it("GET .../slices/:slug returns 404 for missing", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/nonexistent`);
      expect(res.status).toBe(404);
    });

    it("PATCH .../slices/:slug updates fields", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/${sliceSlug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Updated DB slice", status: "active" }),
      });
      expect(res.status).toBe(200);
      const s = await res.json();
      expect(s.title).toBe("Updated DB slice");
      expect(s.status).toBe("active");
    });

    it("PATCH .../slices/:slug returns 404 for missing", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/nonexistent`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "nope" }),
      });
      expect(res.status).toBe(404);
    });

    it("DELETE .../slices/:slug deletes", async () => {
      // Delete the last one (integration tests)
      const list = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices`);
      const items = await list.json();
      const lastSlug = items[items.length - 1].slug;

      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/${lastSlug}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
    });

    it("DELETE .../slices/:slug returns 404 for missing", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/nonexistent`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    it("POST .../slices with missing milestone returns 404", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/nonexistent/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Orphan" }),
      });
      expect(res.status).toBe(404);
    });
  });

  // ─── Plan Tasks ─────────────────────────────────

  describe("Plan Tasks CRUD", () => {
    let milestoneSlug: string;
    let sliceSlug: string;
    let taskSlug: string;

    beforeAll(async () => {
      // Create a milestone and slice for task tests
      const mRes = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Task Test Milestone" }),
      });
      const m = await mRes.json();
      milestoneSlug = m.slug;

      const sRes = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Task Test Slice" }),
      });
      const s = await sRes.json();
      sliceSlug = s.slug;
    });

    it("POST .../tasks creates a plan task", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/${sliceSlug}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Create schema.ts",
          description: "Define all 14 tables in Drizzle",
          model: "claude-opus-4-20250514",
          estimate: "30 min",
          files: ["src/db/schema.ts"],
          verify: "npx vitest run src/__tests__/schema.test.ts",
          depends: [],
          orderIndex: 0,
        }),
      });
      expect(res.status).toBe(201);
      const t = await res.json();
      expect(t.title).toBe("Create schema.ts");
      expect(t.model).toBe("claude-opus-4-20250514");
      expect(t.status).toBe("pending");
      expect(t.slug).toBeDefined();
      taskSlug = t.slug;
    });

    it("POST .../tasks with minimal fields", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/${sliceSlug}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Write tests" }),
      });
      expect(res.status).toBe(201);
      const t = await res.json();
      expect(t.title).toBe("Write tests");
    });

    it("POST .../tasks with deep plan fields", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/${sliceSlug}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Handle errors",
          description: "Add error handling",
          inputs: ["Request body", "Headers"],
          expectedOutput: ["422 on bad input", "401 on no auth"],
          failureModes: [{ depFails: "DB down", taskBehavior: "Return 503" }],
          negativeTests: ["Empty body", "Missing required field"],
          observabilityImpact: "Error counters in metrics",
          depends: [taskSlug],
        }),
      });
      expect(res.status).toBe(201);
    });

    it("GET .../tasks lists tasks", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/${sliceSlug}/tasks`);
      expect(res.status).toBe(200);
      const items = await res.json();
      expect(items.length).toBe(3);
    });

    it("GET .../tasks/:slug returns single task", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/${sliceSlug}/tasks/${taskSlug}`);
      expect(res.status).toBe(200);
      const t = await res.json();
      expect(t.slug).toBe(taskSlug);
    });

    it("GET .../tasks/:slug returns 404 for missing", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/${sliceSlug}/tasks/nonexistent`);
      expect(res.status).toBe(404);
    });

    it("PATCH .../tasks/:slug updates fields", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/${sliceSlug}/tasks/${taskSlug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Create schema.ts (updated)",
          status: "completed",
        }),
      });
      expect(res.status).toBe(200);
      const t = await res.json();
      expect(t.title).toBe("Create schema.ts (updated)");
      expect(t.status).toBe("completed");
    });

    it("PATCH .../tasks/:slug returns 404 for missing", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/${sliceSlug}/tasks/nonexistent`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "nope" }),
      });
      expect(res.status).toBe(404);
    });

    it("DELETE .../tasks/:slug deletes plan task", async () => {
      // Delete the last one
      const list = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/${sliceSlug}/tasks`);
      const items = await list.json();
      const lastSlug = items[items.length - 1].slug;

      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/${sliceSlug}/tasks/${lastSlug}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
    });

    it("DELETE .../tasks/:slug returns 404 for missing", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/${sliceSlug}/tasks/nonexistent`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    it("POST .../tasks with missing slice returns 404", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/slices/nonexistent/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Orphan" }),
      });
      expect(res.status).toBe(404);
    });
  });

  // ─── Execution Graph ─────────────────────────────

  describe("Execution Graph", () => {
    let milestoneSlug: string;

    beforeAll(async () => {
      // Create a milestone to test against
      const createRes = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Graph Test Milestone" }),
      });
      const m = await createRes.json();
      milestoneSlug = m.slug;
    });

    it("GET .../execution-graph returns wave computation with correct field names", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/execution-graph`);
      expect(res.status).toBe(200);
      const graph = await res.json();
      // Must use milestoneId (not milestoneSlug) — frontend expects milestone_id after camel→snake conversion
      expect(graph.milestoneId).toBe(milestoneSlug);
      expect(graph.milestoneSlug).toBeUndefined();
      expect(Array.isArray(graph.waves)).toBe(true);
      expect(Array.isArray(graph.errors)).toBe(true);
      expect(typeof graph.parallelismFactor).toBe("number");
      // Each wave must have sliceIds (not slugs)
      for (const wave of graph.waves) {
        expect(Array.isArray(wave.sliceIds)).toBe(true);
        expect(wave.slugs).toBeUndefined();
        expect(typeof wave.waveIndex).toBe("number");
      }
    });

    it("GET .../execution-graph returns 404 for missing milestone", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/nonexistent/execution-graph`);
      expect(res.status).toBe(404);
    });
  });

  // ─── Auto-Execution Status ─────────────────────────────

  describe("Auto-Execution endpoints", () => {
    let milestoneSlug: string;

    beforeAll(async () => {
      // Create a milestone to test against
      const createRes = await app.request(`/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "AutoExec Test Milestone" }),
      });
      const m = await createRes.json();
      milestoneSlug = m.slug;
    });

    it("GET .../auto-execute returns status with correct field names", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/auto-execute`);
      expect(res.status).toBe(200);
      const status = await res.json();
      expect(status.status).toBeDefined();
      // Must use milestone_id (not milestone_slug) — matches frontend AutoExecuteStatusResponse
      expect(status.milestone_id).toBe(milestoneSlug);
      expect(status.milestone_slug).toBeUndefined();
      // Must use current_slice_ids (not current_slice_slugs)
      expect(Array.isArray(status.current_slice_ids)).toBe(true);
      expect(status.current_slice_slugs).toBeUndefined();
      expect(typeof status.total_slices).toBe("number");
      expect(typeof status.completed_slices).toBe("number");
      expect(status).toHaveProperty("started_at");
    });

    it("GET .../auto-execute returns 404 for missing milestone", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/nonexistent/auto-execute`);
      expect(res.status).toBe(404);
    });

    it("DELETE .../auto-execute returns correct field names", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/auto-execute`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("not_running");
      // Must use milestone_id and current_slice_ids — matches frontend types
      expect(body.milestone_id).toBe(milestoneSlug);
      expect(body.milestone_slug).toBeUndefined();
      expect(Array.isArray(body.current_slice_ids)).toBe(true);
      expect(body.current_slice_slugs).toBeUndefined();
    });

    it("POST .../auto-execute returns 404 for missing project", async () => {
      const res = await app.request(`/projects/999/milestones/${milestoneSlug}/auto-execute`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });

    it("POST .../auto-execute returns 404 for missing milestone", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/nonexistent/auto-execute`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });

    it("POST .../auto-execute returns correct field names", async () => {
      const res = await app.request(`/projects/${projectId}/milestones/${milestoneSlug}/auto-execute`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("started");
      // Must use milestone_id and current_slice_ids — matches frontend types
      expect(body.milestone_id).toBe(milestoneSlug);
      expect(body.milestone_slug).toBeUndefined();
      expect(Array.isArray(body.current_slice_ids)).toBe(true);
      expect(body.current_slice_slugs).toBeUndefined();
    });
  });
});
