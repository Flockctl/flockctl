/**
 * Branch-coverage extras for `services/plan-store/{milestones,slices,tasks}.ts`.
 *
 * Fills the fallback expressions that fire when frontmatter keys are absent:
 *   - `fm.title ?? slug`, `fm.status ?? "pending"`, `fm.order ?? parseOrder(slug)`
 *   - `fm.spec_required` non-boolean → false
 *   - `m.description ?? null` etc. in *ToApi mappers
 *   - `data.title ?? "Untitled …"` create-path defaults
 *   - `data.order ?? nextOrder(...)` create-path defaults
 *   - `existsSync(mdPath) === false` branch in get* (returns null)
 *   - not-found throws in update-and-delete paths
 *   - `findMilestoneBySlice` miss (returns null)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  listMilestones,
  getMilestone,
  createMilestone,
  updateMilestone,
  deleteMilestone,
  findMilestoneBySlice,
  milestoneToApi,
  milestoneFromFile,
} from "../../services/plan-store/milestones.js";
import {
  listSlices,
  getSlice,
  createSlice,
  updateSlice,
  deleteSlice,
  sliceToApi,
  sliceFromFile,
} from "../../services/plan-store/slices.js";
import {
  listPlanTasks,
  getPlanTask,
  createPlanTask,
  updatePlanTask,
  deletePlanTask,
  taskToApi,
  taskFromFile,
} from "../../services/plan-store/tasks.js";

describe("plan-store — branch gaps (milestones)", () => {
  let projectPath: string;
  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), "plan-store-branches-"));
  });
  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  it("milestoneFromFile uses slug/pending/parseOrder fallbacks when fm empty", () => {
    const m = milestoneFromFile("03-foo", {}, "");
    expect(m.title).toBe("03-foo");
    expect(m.status).toBe("pending");
    expect(m.order).toBe(3);
    expect(m.description).toBeUndefined();
    expect(m.specRequired).toBe(false);
  });

  it("milestoneFromFile: spec_required non-boolean → false", () => {
    const m = milestoneFromFile("00-x", { spec_required: "yes" }, "body");
    expect(m.specRequired).toBe(false);
    expect(m.description).toBe("body");
  });

  it("milestoneToApi emits null for unset optional fields and '' for timestamps", () => {
    const api = milestoneToApi({
      slug: "00-m",
      title: "t",
      status: "pending",
      order: 0,
      specRequired: false,
    });
    expect(api.description).toBeNull();
    expect(api.vision).toBeNull();
    expect(api.success_criteria).toBeNull();
    expect(api.depends_on).toBeNull();
    expect(api.key_risks).toBeNull();
    expect(api.proof_strategy).toBeNull();
    expect(api.boundary_map_markdown).toBeNull();
    expect(api.definition_of_done).toBeNull();
    expect(api.created_at).toBe("");
    expect(api.updated_at).toBe("");
  });

  it("listMilestones skips dirs without milestone.md", () => {
    const planDir = join(projectPath, ".flockctl", "plan");
    mkdirSync(join(planDir, "00-ok"), { recursive: true });
    writeFileSync(
      join(planDir, "00-ok", "milestone.md"),
      "---\ntitle: OK\n---\n",
    );
    mkdirSync(join(planDir, "01-empty"), { recursive: true }); // no milestone.md
    const list = listMilestones(projectPath);
    expect(list.length).toBe(1);
    expect(list[0].slug).toBe("00-ok");
  });

  it("getMilestone returns null when md file does not exist", () => {
    expect(getMilestone(projectPath, "nope")).toBeNull();
  });

  it("createMilestone applies default title/status/order when unset", () => {
    const m = createMilestone(projectPath, {});
    expect(m.title).toBe("Untitled Milestone");
    expect(m.status).toBe("pending");
    expect(typeof m.order).toBe("number");
    expect(m.specRequired).toBe(true);
  });

  it("updateMilestone throws when the target doesn't exist", () => {
    expect(() => updateMilestone(projectPath, "nope", { title: "x" })).toThrow(
      /Milestone not found/,
    );
  });

  it("deleteMilestone throws when dir doesn't exist", () => {
    expect(() => deleteMilestone(projectPath, "nope")).toThrow(/Milestone not found/);
  });

  it("findMilestoneBySlice returns null when no milestone owns the slice", () => {
    createMilestone(projectPath, { title: "M1" });
    expect(findMilestoneBySlice(projectPath, "unknown-slice")).toBeNull();
  });
});

describe("plan-store — branch gaps (slices)", () => {
  let projectPath: string;
  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), "plan-store-slice-branches-"));
  });
  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  it("sliceFromFile uses slug/pending/parseOrder fallbacks", () => {
    const s = sliceFromFile("02-foo", "00-m", {}, "");
    expect(s.title).toBe("02-foo");
    expect(s.status).toBe("pending");
    expect(s.order).toBe(2);
    expect(s.description).toBeUndefined();
  });

  it("sliceToApi emits risk='medium' default and null optionals", () => {
    const api = sliceToApi({
      slug: "00-s",
      milestoneSlug: "00-m",
      title: "t",
      status: "pending",
      order: 0,
    });
    expect(api.risk).toBe("medium");
    expect(api.depends).toBeNull();
    expect(api.demo).toBeNull();
    expect(api.goal).toBeNull();
    expect(api.success_criteria).toBeNull();
    expect(api.description).toBeNull();
    expect(api.created_at).toBe("");
  });

  it("listSlices skips sub-dirs missing slice.md", () => {
    const m = createMilestone(projectPath, { title: "M1" });
    mkdirSync(join(projectPath, ".flockctl", "plan", m.slug, "01-empty"), { recursive: true });
    createSlice(projectPath, m.slug, { title: "real" });
    const list = listSlices(projectPath, m.slug);
    expect(list.length).toBe(1);
  });

  it("getSlice returns null when md file is missing", () => {
    const m = createMilestone(projectPath, { title: "M1" });
    expect(getSlice(projectPath, m.slug, "nope")).toBeNull();
  });

  it("createSlice throws when milestone.md is missing", () => {
    expect(() => createSlice(projectPath, "unknown-m", { title: "x" })).toThrow(
      /Milestone not found/,
    );
  });

  it("createSlice default title/status when unset", () => {
    const m = createMilestone(projectPath, { title: "M1" });
    const s = createSlice(projectPath, m.slug, {});
    expect(s.title).toBe("Untitled Slice");
    expect(s.status).toBe("pending");
  });

  it("updateSlice throws when slice doesn't exist", () => {
    const m = createMilestone(projectPath, { title: "M1" });
    expect(() => updateSlice(projectPath, m.slug, "nope", { title: "x" })).toThrow(
      /Slice not found/,
    );
  });

  it("deleteSlice throws when slice dir doesn't exist", () => {
    const m = createMilestone(projectPath, { title: "M1" });
    expect(() => deleteSlice(projectPath, m.slug, "nope")).toThrow(/Slice not found/);
  });
});

describe("plan-store — branch gaps (tasks)", () => {
  let projectPath: string;
  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), "plan-store-task-branches-"));
  });
  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  it("taskFromFile uses slug/pending/parseOrder fallbacks", () => {
    const t = taskFromFile("01-x", "00-m", "00-s", {}, "");
    expect(t.title).toBe("01-x");
    expect(t.status).toBe("pending");
    expect(t.order).toBe(1);
    expect(t.description).toBeUndefined();
  });

  it("taskToApi: summary string path parses JSON; null optionals → null", () => {
    const api1 = taskToApi({
      slug: "t",
      milestoneSlug: "m",
      sliceSlug: "s",
      title: "Title",
      status: "pending",
      order: 0,
      summary: JSON.stringify({ ok: true }),
    });
    expect(api1.summary).toEqual({ ok: true });

    const api2 = taskToApi({
      slug: "t",
      milestoneSlug: "m",
      sliceSlug: "s",
      title: "T",
      status: "pending",
      order: 0,
      // PlanTaskData declares `summary: string` but the md-io layer deserializes
      // JSON payloads into an object; taskToApi passes objects through untouched.
      summary: { already: "obj" } as unknown as string,
    });
    expect(api2.summary).toEqual({ already: "obj" });

    const api3 = taskToApi({
      slug: "t",
      milestoneSlug: "m",
      sliceSlug: "s",
      title: "T",
      status: "pending",
      order: 0,
    });
    expect(api3.summary).toBeNull();
    expect(api3.task_id).toBeNull();
    expect(api3.estimate).toBeNull();
    expect(api3.created_at).toBe("");
  });

  it("taskToApi: executionTaskId → task_id string via toString()", () => {
    const api = taskToApi({
      slug: "t",
      milestoneSlug: "m",
      sliceSlug: "s",
      title: "T",
      status: "pending",
      order: 0,
      executionTaskId: 42,
    });
    expect(api.task_id).toBe("42");
  });

  it("getPlanTask returns null when md missing", () => {
    const m = createMilestone(projectPath, { title: "M" });
    const s = createSlice(projectPath, m.slug, { title: "S" });
    expect(getPlanTask(projectPath, m.slug, s.slug, "nope")).toBeNull();
  });

  it("listPlanTasks returns [] when slice dir has no .md files", () => {
    const m = createMilestone(projectPath, { title: "M" });
    const s = createSlice(projectPath, m.slug, { title: "S" });
    const list = listPlanTasks(projectPath, m.slug, s.slug);
    // Slice dir has slice.md, which sortedMdFiles may or may not include; accept either
    // but at minimum no task entries yet.
    const nonSlice = list.filter((t) => t.slug !== "slice");
    expect(nonSlice).toEqual([]);
  });

  it("createPlanTask throws when slice is missing", () => {
    const m = createMilestone(projectPath, { title: "M" });
    expect(() => createPlanTask(projectPath, m.slug, "no-slice", {})).toThrow(
      /Slice not found/,
    );
  });

  it("createPlanTask default title/status when unset", () => {
    const m = createMilestone(projectPath, { title: "M" });
    const s = createSlice(projectPath, m.slug, { title: "S" });
    const t = createPlanTask(projectPath, m.slug, s.slug, {});
    expect(t.title).toBe("Untitled Task");
    expect(t.status).toBe("pending");
  });

  it("updatePlanTask throws when task missing", () => {
    const m = createMilestone(projectPath, { title: "M" });
    const s = createSlice(projectPath, m.slug, { title: "S" });
    expect(() => updatePlanTask(projectPath, m.slug, s.slug, "nope", { title: "x" })).toThrow(
      /Plan task not found/,
    );
  });

  it("deletePlanTask throws when task missing", () => {
    const m = createMilestone(projectPath, { title: "M" });
    const s = createSlice(projectPath, m.slug, { title: "S" });
    expect(() => deletePlanTask(projectPath, m.slug, s.slug, "nope")).toThrow(
      /Plan task not found/,
    );
  });
});
