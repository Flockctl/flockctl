import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { taskExecutor } from "../../services/task-executor/index.js";
import { projects as projectsTable, tasks as tasksTable } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import {
  buildBranchName,
  buildWorktreePath,
  createWorktree,
} from "../../services/worktree-manager.js";

/**
 * End-to-end coverage of the per-task worktree isolation surface:
 *
 *   POST /tasks            — accepts `isolation: "worktree"` and stamps
 *                            the row.
 *   DELETE /tasks/:id/worktree — clean / dirty / force / not-found
 *                            paths.
 *
 * The executor is mocked so the route layer is the only thing under
 * test; worktree-manager.test.ts already covers the git plumbing.
 */

vi.spyOn(taskExecutor, "execute").mockImplementation(async () => {});

describe("Tasks API — worktree isolation", () => {
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

  function initProjectRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, "README.md"), "# fixture\n");
    git(dir, ["add", "README.md"]);
    git(dir, ["commit", "-q", "-m", "init"]);
  }

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    tmpBase = mkdtempSync(join(tmpdir(), "flockctl-tasks-iso-"));
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
    // Fresh project + git repo per test so worktree paths and branch
    // names don't bleed between cases.
    testDb.sqlite.exec("DELETE FROM tasks; DELETE FROM projects;");
    projectPath = realpathSync(mkdtempSync(join(tmpBase, "proj-")));
    initProjectRepo(projectPath);
    const inserted = testDb.db
      .insert(projectsTable)
      .values({ name: `proj-${Date.now()}-${Math.random()}`, path: projectPath })
      .returning()
      .get();
    projectId = inserted!.id;
  });

  describe("POST /tasks with isolation", () => {
    it("accepts isolation='worktree' and persists it", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "do the thing",
          projectId,
          isolation: "worktree",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: number; isolation: string };
      expect(body.isolation).toBe("worktree");
    });

    it("rejects an unknown isolation mode with 422", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "do the thing",
          projectId,
          isolation: "container",
        }),
      });
      expect(res.status).toBe(422);
    });

    it("rejects a non-string isolation value with 422", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "do the thing",
          projectId,
          isolation: 123,
        }),
      });
      expect(res.status).toBe(422);
    });

    it("treats null / omitted isolation as legacy behaviour", async () => {
      const res = await app.request("/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "do the thing",
          projectId,
          isolation: null,
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { isolation: string | null };
      expect(body.isolation).toBeNull();
    });
  });

  describe("DELETE /tasks/:id/worktree", () => {
    function insertIsolatedTask(): { taskId: number; worktreePath: string; branch: string } {
      const wt = createWorktree({
        projectPath,
        ownerKind: "task",
        ownerId: 1, // overwritten below — id assigned by autoincrement
      });
      const inserted = testDb.db
        .insert(tasksTable)
        .values({
          projectId,
          prompt: "do the thing",
          isolation: "worktree",
          worktreePath: wt.path,
          worktreeBranch: wt.branch,
          status: "done",
        })
        .returning()
        .get();
      return { taskId: inserted!.id, worktreePath: wt.path, branch: wt.branch };
    }

    it("404 when the task has no worktree recorded", async () => {
      const inserted = testDb.db
        .insert(tasksTable)
        .values({
          projectId,
          prompt: "do the thing",
          status: "done",
        })
        .returning()
        .get();
      const res = await app.request(`/tasks/${inserted!.id}/worktree`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    it("422 when the task has a worktree row but no project link", async () => {
      const inserted = testDb.db
        .insert(tasksTable)
        .values({
          prompt: "do the thing",
          status: "done",
          isolation: "worktree",
          worktreePath: "/tmp/orphan-task-wt",
          worktreeBranch: "flockctl/task-orphan",
        })
        .returning()
        .get();
      const res = await app.request(`/tasks/${inserted!.id}/worktree`, {
        method: "DELETE",
      });
      expect(res.status).toBe(422);
    });

    it("removes a clean worktree and NULLs the columns", async () => {
      const { taskId, worktreePath } = insertIsolatedTask();
      const res = await app.request(`/tasks/${taskId}/worktree`, { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { removed: boolean; reason: string };
      expect(body.removed).toBe(true);
      expect(body.reason).toBe("clean");

      const row = testDb.db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).get();
      expect(row?.worktreePath).toBeNull();
      expect(row?.worktreeBranch).toBeNull();
      // Path actually gone on disk.
      expect(() => execFileSync("test", ["-d", worktreePath])).toThrow();
    });

    it("returns 409 with structured body on a dirty worktree", async () => {
      const { taskId, worktreePath } = insertIsolatedTask();
      writeFileSync(join(worktreePath, "draft.txt"), "uncommitted\n");

      const res = await app.request(`/tasks/${taskId}/worktree`, { method: "DELETE" });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { details: { reason: string } };
      expect(body.details.reason).toBe("dirty");

      // Row's worktree fields preserved — operator can find it again.
      const row = testDb.db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).get();
      expect(row?.worktreePath).toBe(worktreePath);
    });

    it("force=true wipes a dirty worktree and clears the row", async () => {
      const { taskId, worktreePath } = insertIsolatedTask();
      writeFileSync(join(worktreePath, "draft.txt"), "uncommitted\n");

      const res = await app.request(`/tasks/${taskId}/worktree?force=true`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { removed: boolean; reason: string };
      expect(body.removed).toBe(true);
      expect(body.reason).toBe("forced");

      const row = testDb.db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).get();
      expect(row?.worktreePath).toBeNull();
      expect(row?.worktreeBranch).toBeNull();
    });
  });

  describe("rerun inherits isolation", () => {
    it("POST /tasks/:id/rerun copies the parent's isolation but not its worktree pointer", async () => {
      const inserted = testDb.db
        .insert(tasksTable)
        .values({
          projectId,
          prompt: "parent",
          isolation: "worktree",
          status: "failed",
          // Pretend the parent left a worktree behind.
          worktreePath: buildWorktreePath(projectPath, "task", 999),
          worktreeBranch: buildBranchName("task", 999),
        })
        .returning()
        .get();

      const res = await app.request(`/tasks/${inserted!.id}/rerun`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: number;
        isolation: string;
        worktree_path: string | null;
        worktreePath?: string | null;
      };
      expect(body.isolation).toBe("worktree");
      // The fresh retry must NOT inherit the parent's worktree pointer
      // — it gets its own when the executor materialises one.
      const child = testDb.db
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.id, body.id))
        .get();
      expect(child?.worktreePath).toBeNull();
      expect(child?.worktreeBranch).toBeNull();
    });
  });
});
