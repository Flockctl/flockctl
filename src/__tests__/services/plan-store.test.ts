import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseMd, writeMd, toSlug, parseOrder, getPlanDir,
  listMilestones, getMilestone, createMilestone, updateMilestone, deleteMilestone,
  listSlices, getSlice, createSlice, updateSlice, deleteSlice,
  listPlanTasks, getPlanTask, createPlanTask, updatePlanTask, deletePlanTask,
  getProjectTree,
} from "../../services/plan-store/index.js";

describe("plan-store", () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), "plan-store-test-"));
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  // ─── Helpers ───

  describe("toSlug", () => {
    it("generates order-prefixed slug", () => {
      expect(toSlug(0, "Setup database")).toBe("00-Setup_database");
      expect(toSlug(1, "Add API routes")).toBe("01-Add_API_routes");
      expect(toSlug(12, "Final cleanup")).toBe("12-Final_cleanup");
    });
  });

  describe("parseOrder", () => {
    it("extracts number from slug", () => {
      expect(parseOrder("00-setup-db")).toBe(0);
      expect(parseOrder("05-auth")).toBe(5);
      expect(parseOrder("12-final")).toBe(12);
    });

    it("returns 0 for non-matching slug", () => {
      expect(parseOrder("no-number")).toBe(0);
    });
  });

  describe("parseMd / writeMd", () => {
    it("round-trips frontmatter and body", () => {
      const filePath = join(projectPath, "test.md");
      const fm = { title: "Hello", status: "pending", tags: ["a", "b"] };
      const body = "Some description here.";

      writeMd(filePath, fm, body);
      const result = parseMd(filePath);

      expect(result.frontmatter.title).toBe("Hello");
      expect(result.frontmatter.status).toBe("pending");
      expect(result.frontmatter.tags).toEqual(["a", "b"]);
      expect(result.body).toBe("Some description here.");
    });

    it("handles empty body", () => {
      const filePath = join(projectPath, "empty.md");
      writeMd(filePath, { title: "No body" }, "");
      const result = parseMd(filePath);
      expect(result.frontmatter.title).toBe("No body");
      expect(result.body).toBe("");
    });

    it("strips undefined values from frontmatter", () => {
      const filePath = join(projectPath, "undef.md");
      writeMd(filePath, { title: "Test", missing: undefined }, "");
      const content = readFileSync(filePath, "utf-8");
      expect(content).not.toContain("missing");
    });

    it("recovers from invalid backslash escapes in double-quoted YAML", () => {
      // Agents sometimes produce strings like `@Environment(\.modelContext)`
      // in double-quoted YAML — `\.` is not a valid escape and would normally
      // throw. parseMd should sanitize and still return the content.
      const filePath = join(projectPath, "bad.md");
      const content = [
        "---",
        'title: "SwiftData note"',
        'description: "uses @Environment(\\.modelContext) for mutations"',
        "status: pending",
        "---",
        "",
        "Body text.",
      ].join("\n");
      require("fs").writeFileSync(filePath, content, "utf-8");

      const result = parseMd(filePath);
      expect(result.frontmatter.title).toBe("SwiftData note");
      expect(result.frontmatter.status).toBe("pending");
      expect(result.frontmatter.description).toContain("@Environment");
      expect(result.body).toBe("Body text.");
    });
  });

  // ─── Milestones ───

  describe("Milestones", () => {
    it("listMilestones returns empty for missing dir", () => {
      expect(listMilestones(projectPath)).toEqual([]);
    });

    it("createMilestone creates directory and milestone.md", () => {
      const m = createMilestone(projectPath, {
        title: "Phase 1",
        vision: "Build foundation",
        successCriteria: ["Tests pass"],
      });

      expect(m.slug).toMatch(/^00-Phase_1/);
      expect(m.title).toBe("Phase 1");
      expect(m.status).toBe("pending");
      expect(m.vision).toBe("Build foundation");
      expect(m.successCriteria).toEqual(["Tests pass"]);
      expect(m.createdAt).toBeDefined();

      const dir = join(getPlanDir(projectPath), m.slug);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, "milestone.md"))).toBe(true);
    });

    it("getMilestone reads back created milestone", () => {
      const created = createMilestone(projectPath, { title: "Read me back" });
      const read = getMilestone(projectPath, created.slug);
      expect(read).not.toBeNull();
      expect(read!.title).toBe("Read me back");
      expect(read!.slug).toBe(created.slug);
    });

    it("listMilestones returns ordered results", () => {
      createMilestone(projectPath, { title: "Second", order: 1 });
      createMilestone(projectPath, { title: "First", order: 0 });
      createMilestone(projectPath, { title: "Third", order: 2 });

      const list = listMilestones(projectPath);
      expect(list).toHaveLength(3);
      expect(list[0].title).toBe("First");
      expect(list[1].title).toBe("Second");
      expect(list[2].title).toBe("Third");
    });

    it("updateMilestone modifies frontmatter", () => {
      const m = createMilestone(projectPath, { title: "Original" });
      const updated = updateMilestone(projectPath, m.slug, {
        title: "Updated",
        status: "active",
      });

      expect(updated.title).toBe("Updated");
      expect(updated.status).toBe("active");
      expect(updated.updatedAt).toBeDefined();

      // Verify on disk
      const fromDisk = getMilestone(projectPath, m.slug);
      expect(fromDisk!.title).toBe("Updated");
      expect(fromDisk!.status).toBe("active");
    });

    it("deleteMilestone removes directory", () => {
      const m = createMilestone(projectPath, { title: "To delete" });
      const dir = join(getPlanDir(projectPath), m.slug);
      expect(existsSync(dir)).toBe(true);

      deleteMilestone(projectPath, m.slug);
      expect(existsSync(dir)).toBe(false);
    });

    it("getMilestone returns null for missing", () => {
      expect(getMilestone(projectPath, "nonexistent")).toBeNull();
    });

    it("deduplicates slugs", () => {
      const m1 = createMilestone(projectPath, { title: "Same", order: 0 });
      const m2 = createMilestone(projectPath, { title: "Same", order: 0 });
      expect(m1.slug).not.toBe(m2.slug);
    });

    it("preserves description in body", () => {
      const m = createMilestone(projectPath, {
        title: "With desc",
        description: "This is the body text.",
      });
      const read = getMilestone(projectPath, m.slug);
      expect(read!.description).toBe("This is the body text.");
    });
  });

  // ─── Slices ───

  describe("Slices", () => {
    let milestoneSlug: string;

    beforeEach(() => {
      const m = createMilestone(projectPath, { title: "Parent Milestone" });
      milestoneSlug = m.slug;
    });

    it("createSlice creates dir with slice.md", () => {
      const s = createSlice(projectPath, milestoneSlug, {
        title: "Setup DB",
        risk: "high",
        goal: "Working database",
      });

      expect(s.slug).toMatch(/^00-Setup_DB/);
      expect(s.title).toBe("Setup DB");
      expect(s.risk).toBe("high");
      expect(s.milestoneSlug).toBe(milestoneSlug);

      const dir = join(getPlanDir(projectPath), milestoneSlug, s.slug);
      expect(existsSync(join(dir, "slice.md"))).toBe(true);
    });

    it("listSlices returns ordered slices", () => {
      createSlice(projectPath, milestoneSlug, { title: "B", order: 1 });
      createSlice(projectPath, milestoneSlug, { title: "A", order: 0 });

      const list = listSlices(projectPath, milestoneSlug);
      expect(list).toHaveLength(2);
      expect(list[0].title).toBe("A");
      expect(list[1].title).toBe("B");
    });

    it("getSlice reads back slice", () => {
      const created = createSlice(projectPath, milestoneSlug, { title: "Read me" });
      const read = getSlice(projectPath, milestoneSlug, created.slug);
      expect(read!.title).toBe("Read me");
    });

    it("updateSlice modifies fields", () => {
      const s = createSlice(projectPath, milestoneSlug, { title: "Original" });
      const updated = updateSlice(projectPath, milestoneSlug, s.slug, {
        status: "active",
        risk: "low",
      });
      expect(updated.status).toBe("active");
      expect(updated.risk).toBe("low");
    });

    it("deleteSlice removes directory", () => {
      const s = createSlice(projectPath, milestoneSlug, { title: "To delete" });
      deleteSlice(projectPath, milestoneSlug, s.slug);
      expect(getSlice(projectPath, milestoneSlug, s.slug)).toBeNull();
    });

    it("createSlice throws for missing milestone", () => {
      expect(() => createSlice(projectPath, "nonexistent", { title: "X" }))
        .toThrow("Milestone not found");
    });

    it("handles depends as slug array", () => {
      const s1 = createSlice(projectPath, milestoneSlug, { title: "First" });
      const s2 = createSlice(projectPath, milestoneSlug, {
        title: "Second",
        depends: [s1.slug],
      });

      const read = getSlice(projectPath, milestoneSlug, s2.slug);
      expect(read!.depends).toEqual([s1.slug]);
    });
  });

  // ─── Plan Tasks ───

  describe("Plan Tasks", () => {
    let milestoneSlug: string;
    let sliceSlug: string;

    beforeEach(() => {
      const m = createMilestone(projectPath, { title: "M1" });
      milestoneSlug = m.slug;
      const s = createSlice(projectPath, milestoneSlug, { title: "S1" });
      sliceSlug = s.slug;
    });

    it("createPlanTask creates .md file", () => {
      const t = createPlanTask(projectPath, milestoneSlug, sliceSlug, {
        title: "Create schema",
        model: "claude-opus-4-7",
        files: ["src/db/schema.ts"],
        verify: "npm test",
      });

      expect(t.slug).toMatch(/^00-Create_schema/);
      expect(t.title).toBe("Create schema");
      expect(t.model).toBe("claude-opus-4-7");
      expect(t.files).toEqual(["src/db/schema.ts"]);

      const mdPath = join(getPlanDir(projectPath), milestoneSlug, sliceSlug, `${t.slug}.md`);
      expect(existsSync(mdPath)).toBe(true);
    });

    it("listPlanTasks returns ordered tasks", () => {
      createPlanTask(projectPath, milestoneSlug, sliceSlug, { title: "B", order: 1 });
      createPlanTask(projectPath, milestoneSlug, sliceSlug, { title: "A", order: 0 });

      const list = listPlanTasks(projectPath, milestoneSlug, sliceSlug);
      expect(list).toHaveLength(2);
      expect(list[0].title).toBe("A");
      expect(list[1].title).toBe("B");
    });

    it("getPlanTask reads back task", () => {
      const created = createPlanTask(projectPath, milestoneSlug, sliceSlug, { title: "Read me" });
      const read = getPlanTask(projectPath, milestoneSlug, sliceSlug, created.slug);
      expect(read!.title).toBe("Read me");
      expect(read!.milestoneSlug).toBe(milestoneSlug);
      expect(read!.sliceSlug).toBe(sliceSlug);
    });

    it("updatePlanTask modifies fields", () => {
      const t = createPlanTask(projectPath, milestoneSlug, sliceSlug, { title: "Task" });
      const updated = updatePlanTask(projectPath, milestoneSlug, sliceSlug, t.slug, {
        status: "completed",
        executionTaskId: 42,
        verificationPassed: true,
      });
      expect(updated.status).toBe("completed");
      expect(updated.executionTaskId).toBe(42);
      expect(updated.verificationPassed).toBe(true);
    });

    it("deletePlanTask removes file", () => {
      const t = createPlanTask(projectPath, milestoneSlug, sliceSlug, { title: "Delete me" });
      deletePlanTask(projectPath, milestoneSlug, sliceSlug, t.slug);
      expect(getPlanTask(projectPath, milestoneSlug, sliceSlug, t.slug)).toBeNull();
    });

    it("createPlanTask throws for missing slice", () => {
      expect(() => createPlanTask(projectPath, milestoneSlug, "nope", { title: "X" }))
        .toThrow("Slice not found");
    });

    it("handles depends as slug array", () => {
      const t1 = createPlanTask(projectPath, milestoneSlug, sliceSlug, { title: "First" });
      const t2 = createPlanTask(projectPath, milestoneSlug, sliceSlug, {
        title: "Second",
        depends: [t1.slug],
      });
      const read = getPlanTask(projectPath, milestoneSlug, sliceSlug, t2.slug);
      expect(read!.depends).toEqual([t1.slug]);
    });

    it("stores deep plan fields", () => {
      const t = createPlanTask(projectPath, milestoneSlug, sliceSlug, {
        title: "Deep task",
        inputs: ["Request body"],
        expectedOutput: ["200 OK"],
        failureModes: [{ depFails: "DB down", taskBehavior: "Return 503" }],
        negativeTests: ["Empty body", "Missing field"],
        observabilityImpact: "Error counters",
      });

      const read = getPlanTask(projectPath, milestoneSlug, sliceSlug, t.slug);
      expect(read!.inputs).toEqual(["Request body"]);
      expect(read!.expectedOutput).toEqual(["200 OK"]);
      expect(read!.failureModes).toEqual([{ depFails: "DB down", taskBehavior: "Return 503" }]);
      expect(read!.negativeTests).toEqual(["Empty body", "Missing field"]);
    });
  });

  // ─── Tree ───

  describe("getProjectTree", () => {
    it("returns full hierarchy", () => {
      const m = createMilestone(projectPath, { title: "M1" });
      const s = createSlice(projectPath, m.slug, { title: "S1" });
      createPlanTask(projectPath, m.slug, s.slug, { title: "T1" });
      createPlanTask(projectPath, m.slug, s.slug, { title: "T2" });

      const tree = getProjectTree(projectPath);
      expect(tree.milestones).toHaveLength(1);
      expect(tree.milestones[0].slices).toHaveLength(1);
      expect(tree.milestones[0].slices[0].tasks).toHaveLength(2);
    });

    it("returns empty for project without plan", () => {
      const tree = getProjectTree(projectPath);
      expect(tree.milestones).toEqual([]);
    });
  });
});
