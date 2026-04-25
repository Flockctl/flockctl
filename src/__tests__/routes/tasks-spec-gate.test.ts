import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { projects, tasks } from "../../db/schema.js";
import {
  createMilestone,
  createSlice,
  updateMilestone,
  getMilestone,
} from "../../services/plan-store/index.js";
import { taskExecutor } from "../../services/task-executor/index.js";

// POST /tasks would try to launch Claude — keep this test purely about the
// authoring gate on PUT, no task execution needed.
vi.spyOn(taskExecutor, "execute").mockImplementation(async () => {});

describe("Tasks spec-required gate (PUT /tasks/:id)", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let projectPath: string;
  let projectId: number;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);

    projectPath = mkdtempSync(join(tmpdir(), "tasks-spec-gate-"));
    const p = testDb.db
      .insert(projects)
      .values({ name: "Spec Gate Project", path: projectPath })
      .returning()
      .get();
    projectId = p!.id;
  });

  afterAll(() => {
    testDb.sqlite.close();
    rmSync(projectPath, { recursive: true, force: true });
  });

  /** Seed a milestone + slice and return their slugs. */
  function seedPlan(opts: { specRequired?: boolean; label: string }): {
    milestoneSlug: string;
    sliceSlug: string;
  } {
    const m = createMilestone(projectPath, {
      title: `${opts.label} milestone`,
      ...(opts.specRequired !== undefined && { specRequired: opts.specRequired }),
    });
    const s = createSlice(projectPath, m.slug, {
      title: `${opts.label} slice`,
    });
    return { milestoneSlug: m.slug, sliceSlug: s.slug };
  }

  /** Insert an execution task row wired to the given slice slug. */
  function insertTask(opts: {
    sliceSlug: string;
    acceptanceCriteria?: string[] | null;
  }): number {
    const row = testDb.db
      .insert(tasks)
      .values({
        projectId,
        prompt: "do the thing",
        agent: "claude-code",
        taskType: "execution",
        targetSliceSlug: opts.sliceSlug,
        workingDir: projectPath,
        acceptanceCriteria:
          opts.acceptanceCriteria == null
            ? null
            : JSON.stringify(opts.acceptanceCriteria),
      })
      .returning()
      .get();
    return row!.id;
  }

  describe("new plans default to spec_required=true", () => {
    it("createMilestone stores spec_required: true by default", () => {
      const m = createMilestone(projectPath, { title: "Default plan" });
      expect(m.specRequired).toBe(true);

      // Re-read from disk to confirm the flag was persisted, not just held
      // in memory from the create call.
      const reloaded = getMilestone(projectPath, m.slug);
      expect(reloaded?.specRequired).toBe(true);
    });

    it("createMilestone honors an explicit specRequired: false override", () => {
      const m = createMilestone(projectPath, {
        title: "Lenient plan",
        specRequired: false,
      });
      expect(m.specRequired).toBe(false);
      expect(getMilestone(projectPath, m.slug)?.specRequired).toBe(false);
    });
  });

  describe("gate refuses state='ready' when spec is empty", () => {
    it("returns 400 {error: 'spec_required'} for empty acceptance_criteria", async () => {
      const { sliceSlug } = seedPlan({ specRequired: true, label: "strict-1" });
      const taskId = insertTask({ sliceSlug, acceptanceCriteria: null });

      const res = await app.request(`/tasks/${taskId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "ready" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("spec_required");
    });

    it("treats an empty array the same as NULL", async () => {
      const { sliceSlug } = seedPlan({ specRequired: true, label: "strict-2" });
      const taskId = insertTask({ sliceSlug, acceptanceCriteria: [] });

      const res = await app.request(`/tasks/${taskId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "ready" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("spec_required");
    });

    it("treats a PUT that also clears acceptance_criteria as empty", async () => {
      const { sliceSlug } = seedPlan({ specRequired: true, label: "strict-3" });
      const taskId = insertTask({
        sliceSlug,
        acceptanceCriteria: ["pre-existing"],
      });

      // Same request tries to null-out the criteria AND mark ready — the
      // post-merge value is empty, so the gate must still fire.
      const res = await app.request(`/tasks/${taskId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          state: "ready",
          acceptanceCriteria: null,
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("spec_required");
    });
  });

  describe("gate lets the transition through when criteria are present", () => {
    it("returns 200 after adding a criterion in a separate PUT", async () => {
      const { sliceSlug } = seedPlan({ specRequired: true, label: "pass-1" });
      const taskId = insertTask({ sliceSlug, acceptanceCriteria: null });

      // First, attach a criterion without touching state.
      const addRes = await app.request(`/tasks/${taskId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          acceptanceCriteria: ["Endpoint returns 200 on happy path"],
        }),
      });
      expect(addRes.status).toBe(200);

      // Now the ready transition must succeed.
      const readyRes = await app.request(`/tasks/${taskId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "ready" }),
      });
      expect(readyRes.status).toBe(200);
    });

    it("returns 200 when criteria are attached in the same request", async () => {
      const { sliceSlug } = seedPlan({ specRequired: true, label: "pass-2" });
      const taskId = insertTask({ sliceSlug, acceptanceCriteria: null });

      const res = await app.request(`/tasks/${taskId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          state: "ready",
          acceptanceCriteria: ["Ships a user-visible thing"],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.acceptanceCriteria).toEqual(["Ships a user-visible thing"]);
    });
  });

  describe("gate is inert when the plan does not require specs", () => {
    it("allows state='ready' for a plan with spec_required=false", async () => {
      const { sliceSlug } = seedPlan({ specRequired: false, label: "lenient" });
      const taskId = insertTask({ sliceSlug, acceptanceCriteria: null });

      const res = await app.request(`/tasks/${taskId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "ready" }),
      });

      expect(res.status).toBe(200);
    });

    it("allows state='ready' for a task with no targetSliceSlug", async () => {
      // No plan to look up → gate cannot fire even if we requested ready.
      const row = testDb.db
        .insert(tasks)
        .values({
          projectId,
          prompt: "standalone task",
          agent: "claude-code",
          workingDir: projectPath,
        })
        .returning()
        .get();
      const taskId = row!.id;

      const res = await app.request(`/tasks/${taskId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "ready" }),
      });

      expect(res.status).toBe(200);
    });

    it("treats a flipped-off plan (spec_required=true→false via update) as lenient", async () => {
      const { milestoneSlug, sliceSlug } = seedPlan({
        specRequired: true,
        label: "flipped",
      });
      const taskId = insertTask({ sliceSlug, acceptanceCriteria: null });

      // Author flips the plan flag off before the ready transition.
      updateMilestone(projectPath, milestoneSlug, { specRequired: false });

      const res = await app.request(`/tasks/${taskId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "ready" }),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("existing plans (no spec_required field) default to lenient", () => {
    it("allows state='ready' when the plan YAML omits spec_required", async () => {
      // Pre-feature milestones had no spec_required key at all. Simulate that
      // by creating the milestone, then stripping the field from disk.
      const { milestoneSlug, sliceSlug } = seedPlan({
        specRequired: true,
        label: "legacy",
      });
      // `updateMilestone` filters out `undefined`, so the straightforward path
      // is to write the file directly via plan-store's own writer.
      const { writeMd, parseMd, getPlanDir } = await import(
        "../../services/plan-store/index.js"
      );
      const mdPath = join(getPlanDir(projectPath), milestoneSlug, "milestone.md");
      const { frontmatter, body } = parseMd(mdPath);
      delete frontmatter.spec_required;
      writeMd(mdPath, frontmatter, body);

      // Confirm the migration default resolved to `false`.
      expect(getMilestone(projectPath, milestoneSlug)?.specRequired).toBe(false);

      const taskId = insertTask({ sliceSlug, acceptanceCriteria: null });
      const res = await app.request(`/tasks/${taskId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "ready" }),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("gate does not interfere with non-ready PUTs", () => {
    it("ignores state values other than 'ready'", async () => {
      const { sliceSlug } = seedPlan({ specRequired: true, label: "non-ready" });
      const taskId = insertTask({ sliceSlug, acceptanceCriteria: null });

      const res = await app.request(`/tasks/${taskId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "draft" }),
      });

      expect(res.status).toBe(200);
    });

    it("ignores PUTs with no state field at all", async () => {
      const { sliceSlug } = seedPlan({ specRequired: true, label: "no-state" });
      const taskId = insertTask({ sliceSlug, acceptanceCriteria: null });

      const res = await app.request(`/tasks/${taskId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptanceCriteria: ["noop"] }),
      });

      expect(res.status).toBe(200);
    });
  });
});
