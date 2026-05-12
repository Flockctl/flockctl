import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { projects, tasks } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { buildTaskRunContext } from "../../services/task-executor/executor-setup.js";
import { finalizeSuccess } from "../../services/task-executor/executor-finalize.js";

/**
 * Integration coverage for the worktree-isolation branches in
 * `executor-setup.ts:buildTaskRunContext` (creation, persistence, silent
 * fallback) and `executor-finalize.ts:maybeCleanupTaskWorktree` (clean
 * removal, dirty preservation).
 *
 * These are the branches that the per-route tests can't reach because
 * they live below the HTTP layer; the worktree-manager unit tests
 * cover the git plumbing in isolation. This file exercises the wiring
 * between schema / setup / finalize.
 */

// Side-effect stubs so the executor's pre-context reconcile chain
// doesn't try to walk a non-existent .claude/skills/ directory while
// the test fixture's project lacks one.
vi.mock("../../services/git-context.js", () => ({
  buildCodebaseContext: vi.fn().mockResolvedValue(""),
}));

describe("task-executor isolation wiring", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let tmpBase: string;
  let projectPath: string;
  let projectId: number;

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Flockctl Test",
        GIT_AUTHOR_EMAIL: "test@flockctl.local",
        GIT_COMMITTER_NAME: "Flockctl Test",
        GIT_COMMITTER_EMAIL: "test@flockctl.local",
      },
    }).toString();
  }

  function initRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, "README.md"), "# fixture\n");
    git(dir, ["add", "README.md"]);
    git(dir, ["commit", "-q", "-m", "init"]);
  }

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    tmpBase = mkdtempSync(join(tmpdir(), "flockctl-exec-iso-"));
  });

  afterAll(() => {
    testDb.sqlite.close();
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  beforeEach(() => {
    testDb.sqlite.exec("DELETE FROM tasks; DELETE FROM projects;");
    projectPath = realpathSync(mkdtempSync(join(tmpBase, "proj-")));
    initRepo(projectPath);
    const inserted = testDb.db
      .insert(projects)
      .values({ name: `proj-${Date.now()}-${Math.random()}`, path: projectPath })
      .returning()
      .get();
    projectId = inserted!.id;
  });

  describe("buildTaskRunContext — isolation branch", () => {
    it("creates a worktree, rewrites workingDir, and persists path/branch on the row", async () => {
      const task = testDb.db
        .insert(tasks)
        .values({ projectId, prompt: "go", isolation: "worktree" })
        .returning()
        .get();

      const ctx = await buildTaskRunContext(task!, null);

      // Working dir rewritten to the per-task worktree.
      expect(ctx.workingDir).toBe(
        join(projectPath, ".flockctl/worktrees", `task-${task!.id}`),
      );
      expect(existsSync(ctx.workingDir)).toBe(true);

      // Row updated with both worktree fields.
      const refreshed = testDb.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, task!.id))
        .get();
      expect(refreshed?.worktreePath).toBe(ctx.workingDir);
      expect(refreshed?.worktreeBranch).toBe(`flockctl/task-${task!.id}`);
    });

    it("falls back silently when the project is not a git repo", async () => {
      // Replace the git fixture with a bare directory — same path, no .git/.
      rmSync(join(projectPath, ".git"), { recursive: true, force: true });

      const task = testDb.db
        .insert(tasks)
        .values({ projectId, prompt: "go", isolation: "worktree" })
        .returning()
        .get();

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const ctx = await buildTaskRunContext(task!, null);
        // Falls back to the project path itself, not a worktree.
        expect(ctx.workingDir).toBe(projectPath);
        // Row unchanged — no worktree was created.
        const refreshed = testDb.db
          .select()
          .from(tasks)
          .where(eq(tasks.id, task!.id))
          .get();
        expect(refreshed?.worktreePath).toBeNull();
        expect(refreshed?.worktreeBranch).toBeNull();
        // Warning surfaced for telemetry / forensics.
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("legacy task with isolation=null sees the project path unchanged", async () => {
      const task = testDb.db
        .insert(tasks)
        .values({ projectId, prompt: "go" })
        .returning()
        .get();

      const ctx = await buildTaskRunContext(task!, null);
      expect(ctx.workingDir).toBe(projectPath);

      const refreshed = testDb.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, task!.id))
        .get();
      expect(refreshed?.worktreePath).toBeNull();
    });
  });

  describe("finalizeSuccess — worktree cleanup", () => {
    it("removes a clean worktree and NULLs the columns on the row", async () => {
      const task = testDb.db
        .insert(tasks)
        .values({ projectId, prompt: "go", isolation: "worktree" })
        .returning()
        .get();

      // Run setup to materialise the worktree (covers the create branch).
      const ctx = await buildTaskRunContext(task!, null);

      finalizeSuccess({
        taskId: task!.id,
        workingDir: ctx.workingDir,
        gitCommitBefore: ctx.gitCommitBefore,
        fileEditJournal: { entries: [] },
        requiresApproval: false,
      });

      // Worktree dir gone, columns NULLed.
      expect(existsSync(ctx.workingDir)).toBe(false);
      const after = testDb.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, task!.id))
        .get();
      expect(after?.worktreePath).toBeNull();
      expect(after?.worktreeBranch).toBeNull();
      expect(after?.status).toBe("done");
    });

    it("preserves a dirty worktree and keeps the columns populated", async () => {
      const task = testDb.db
        .insert(tasks)
        .values({ projectId, prompt: "go", isolation: "worktree" })
        .returning()
        .get();
      const ctx = await buildTaskRunContext(task!, null);
      // Make the worktree dirty.
      writeFileSync(join(ctx.workingDir, "draft.txt"), "wip\n");

      finalizeSuccess({
        taskId: task!.id,
        workingDir: ctx.workingDir,
        gitCommitBefore: ctx.gitCommitBefore,
        fileEditJournal: { entries: [] },
        requiresApproval: false,
      });

      expect(existsSync(ctx.workingDir)).toBe(true);
      const after = testDb.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, task!.id))
        .get();
      expect(after?.worktreePath).toBe(ctx.workingDir);
      expect(after?.worktreeBranch).toBe(`flockctl/task-${task!.id}`);
    });

    it("non-isolated task: finalize is a no-op for worktree state", async () => {
      const task = testDb.db
        .insert(tasks)
        .values({ projectId, prompt: "go" })
        .returning()
        .get();
      const ctx = await buildTaskRunContext(task!, null);
      finalizeSuccess({
        taskId: task!.id,
        workingDir: ctx.workingDir,
        gitCommitBefore: ctx.gitCommitBefore,
        fileEditJournal: { entries: [] },
        requiresApproval: false,
      });
      const after = testDb.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, task!.id))
        .get();
      expect(after?.worktreePath).toBeNull();
      expect(after?.status).toBe("done");
    });
  });
});
