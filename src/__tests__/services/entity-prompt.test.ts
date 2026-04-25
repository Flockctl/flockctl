/**
 * Unit tests for `services/entity-prompt.ts`.
 *
 * Covers both the entity-file resolver (`resolveEntityFilePath`) and the two
 * prompt builders. Focuses on the branch gaps left uncovered by the
 * chat-route integration tests (null/missing args, no `.flockctl/plan` dir,
 * walk-the-plan-dir fallback for slices/tasks without a parent milestone or
 * slice slug, project-name fallback, workspace with projects missing paths).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  resolveEntityFilePath,
  buildEntityAwareSystemPrompt,
  buildWorkspaceSystemPrompt,
} from "../../services/entity-prompt.js";

let projectPath: string;

beforeEach(() => {
  projectPath = join(
    tmpdir(),
    `flockctl-entity-prompt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(projectPath, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(projectPath, { recursive: true, force: true });
  } catch {}
});

describe("resolveEntityFilePath — guards", () => {
  it("returns null when projectPath is empty", () => {
    expect(resolveEntityFilePath("", { entityType: "milestone", entityId: "m1" })).toBeNull();
  });

  it("returns null when entityType is missing", () => {
    expect(resolveEntityFilePath(projectPath, { entityType: null, entityId: "m1" })).toBeNull();
  });

  it("returns null when entityId is missing", () => {
    expect(resolveEntityFilePath(projectPath, { entityType: "milestone", entityId: "" })).toBeNull();
  });

  it("returns null when .flockctl/plan dir does not exist", () => {
    expect(
      resolveEntityFilePath(projectPath, { entityType: "milestone", entityId: "m1" }),
    ).toBeNull();
  });
});

describe("resolveEntityFilePath — milestone / slice / task paths", () => {
  it("returns milestone.md path directly (no walk needed)", () => {
    const planDir = join(projectPath, ".flockctl", "plan");
    mkdirSync(join(planDir, "00-setup"), { recursive: true });
    writeFileSync(join(planDir, "00-setup", "milestone.md"), "# m");
    const p = resolveEntityFilePath(projectPath, {
      entityType: "milestone",
      entityId: "00-setup",
    });
    expect(p).toBe(join(planDir, "00-setup", "milestone.md"));
  });

  it("slice with milestoneId skips the walk", () => {
    const planDir = join(projectPath, ".flockctl", "plan");
    mkdirSync(join(planDir, "00-m", "00-s"), { recursive: true });
    const p = resolveEntityFilePath(projectPath, {
      entityType: "slice",
      entityId: "00-s",
      milestoneId: "00-m",
    });
    expect(p).toBe(join(planDir, "00-m", "00-s", "slice.md"));
  });

  it("slice without milestoneId walks plan dir to locate the slice", () => {
    const planDir = join(projectPath, ".flockctl", "plan");
    mkdirSync(join(planDir, "00-m"), { recursive: true });
    mkdirSync(join(planDir, "01-m2", "target-slice"), { recursive: true });
    writeFileSync(join(planDir, "01-m2", "target-slice", "slice.md"), "# s");
    // Also add a stray file under plan root to exercise the `ms.isDirectory()` guard.
    writeFileSync(join(planDir, "README.md"), "ignored");

    const p = resolveEntityFilePath(projectPath, {
      entityType: "slice",
      entityId: "target-slice",
    });
    expect(p).toBe(join(planDir, "01-m2", "target-slice", "slice.md"));
  });

  it("slice walk returns null when no matching slice.md exists anywhere", () => {
    const planDir = join(projectPath, ".flockctl", "plan");
    mkdirSync(join(planDir, "00-m"), { recursive: true });
    expect(
      resolveEntityFilePath(projectPath, { entityType: "slice", entityId: "nope" }),
    ).toBeNull();
  });

  it("task with both parent slugs resolves directly without walking", () => {
    const planDir = join(projectPath, ".flockctl", "plan");
    mkdirSync(join(planDir, "00-m", "00-s"), { recursive: true });
    const p = resolveEntityFilePath(projectPath, {
      entityType: "task",
      entityId: "t1",
      milestoneId: "00-m",
      sliceId: "00-s",
    });
    expect(p).toBe(join(planDir, "00-m", "00-s", "t1.md"));
  });

  it("task without parent slugs walks milestone × slice to find the .md file", () => {
    const planDir = join(projectPath, ".flockctl", "plan");
    mkdirSync(join(planDir, "00-m", "00-s"), { recursive: true });
    mkdirSync(join(planDir, "01-m2", "02-s2"), { recursive: true });
    writeFileSync(join(planDir, "01-m2", "02-s2", "target-task.md"), "# t");
    // Add a non-directory entry in the slice dir to exercise `sl.isDirectory()`.
    writeFileSync(join(planDir, "01-m2", "NOTES.txt"), "ignored");

    const p = resolveEntityFilePath(projectPath, {
      entityType: "task",
      entityId: "target-task",
    });
    expect(p).toBe(join(planDir, "01-m2", "02-s2", "target-task.md"));
  });

  it("task walk returns null when no matching task.md exists", () => {
    const planDir = join(projectPath, ".flockctl", "plan");
    mkdirSync(join(planDir, "00-m", "00-s"), { recursive: true });
    expect(
      resolveEntityFilePath(projectPath, { entityType: "task", entityId: "nope" }),
    ).toBeNull();
  });

  it("returns null for an unrecognised entityType", () => {
    const planDir = join(projectPath, ".flockctl", "plan");
    mkdirSync(planDir, { recursive: true });
    expect(
      resolveEntityFilePath(projectPath, {
        entityType: "bogus",
        entityId: "x",
      }),
    ).toBeNull();
  });
});

describe("buildEntityAwareSystemPrompt", () => {
  it("returns undefined when entity is missing", () => {
    expect(buildEntityAwareSystemPrompt({ entityType: null, entityId: null }, projectPath)).toBeUndefined();
  });

  it("returns undefined when projectPath is empty", () => {
    expect(buildEntityAwareSystemPrompt({ entityType: "milestone", entityId: "m" }, "")).toBeUndefined();
  });

  it("falls back to 'this project' when projectName is omitted (branch: projectName ??)", () => {
    const out = buildEntityAwareSystemPrompt(
      { entityType: "milestone", entityId: "m1" },
      projectPath,
    )!;
    expect(out).toContain('"this project"');
    expect(out).toContain('milestone: "m1"');
    // No entity file → no markdown fence.
    expect(out).not.toContain("```markdown");
  });

  it("uses provided projectName and injects entity file content when present", () => {
    const planDir = join(projectPath, ".flockctl", "plan");
    mkdirSync(join(planDir, "00-m"), { recursive: true });
    writeFileSync(join(planDir, "00-m", "milestone.md"), "# Title\n\nBody.");

    const out = buildEntityAwareSystemPrompt(
      { entityType: "milestone", entityId: "00-m" },
      projectPath,
      "my-project",
    )!;
    expect(out).toContain('"my-project"');
    expect(out).toContain("```markdown");
    expect(out).toContain("# Title");
    expect(out).toContain("Body.");
  });
});

describe("buildWorkspaceSystemPrompt", () => {
  it("returns undefined when workspaceName is empty", () => {
    expect(buildWorkspaceSystemPrompt("", "/some/path", [])).toBeUndefined();
  });

  it("returns undefined when workspacePath is empty", () => {
    expect(buildWorkspaceSystemPrompt("ws", "", [])).toBeUndefined();
  });

  it("emits the no-projects fallback when every project is missing a path", () => {
    const out = buildWorkspaceSystemPrompt("ws", "/tmp/ws", [
      { name: "p1", path: null },
      { name: "p2", path: null },
    ])!;
    expect(out).toContain("no projects with known paths");
    expect(out).not.toMatch(/\(\/.*?\)/); // no "(path)" listing
  });

  it("lists each project with a path and includes the optional description", () => {
    const out = buildWorkspaceSystemPrompt("ws", "/tmp/ws", [
      { name: "p1", path: "/tmp/ws/p1", description: "first one" },
      { name: "p2", path: "/tmp/ws/p2" }, // no description → no " — " suffix branch
      { name: "p3", path: null }, // dropped by the filter
    ])!;
    expect(out).toContain("2 project(s)");
    expect(out).toContain("p1 (/tmp/ws/p1) — first one");
    expect(out).toContain("p2 (/tmp/ws/p2)");
    expect(out).not.toContain("p3");
  });
});
