import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import {
  chats as chatsTable,
  projects as projectsTable,
  tasks as tasksTable,
} from "../../db/schema.js";
import { createWorktree } from "../../services/worktree-manager.js";

/**
 * Coverage for the `/worktrees` umbrella endpoint:
 *
 *   GET  /worktrees             — list all managed worktrees, optionally
 *                                 filtered by project_id; surfaces
 *                                 ownerless ("orphan") and disk-missing
 *                                 ("stale") rows distinctly.
 *   POST /worktrees/prune       — bulk cleanup-if-clean across DB-tracked
 *                                 worktrees, preserves dirty ones.
 *
 * Both endpoints share the project-scope routing, so the same fixture
 * is reused across describe blocks.
 */

describe("Worktrees API", () => {
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
    tmpBase = mkdtempSync(join(tmpdir(), "flockctl-worktrees-route-"));
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
    testDb.sqlite.exec(
      "DELETE FROM tasks; DELETE FROM chats; DELETE FROM projects;",
    );
    projectPath = realpathSync(mkdtempSync(join(tmpBase, "proj-")));
    initRepo(projectPath);
    const inserted = testDb.db
      .insert(projectsTable)
      .values({ name: `proj-${Date.now()}-${Math.random()}`, path: projectPath })
      .returning()
      .get();
    projectId = inserted!.id;
  });

  describe("GET /worktrees", () => {
    it("returns both task- and chat-owned worktrees with their owner annotation", async () => {
      // Materialise one task worktree and one chat worktree.
      const task = testDb.db
        .insert(tasksTable)
        .values({ projectId, prompt: "go", isolation: "worktree" })
        .returning()
        .get();
      const taskWt = createWorktree({ projectPath, ownerKind: "task", ownerId: task!.id });
      testDb.db
        .update(tasksTable)
        .set({ worktreePath: taskWt.path, worktreeBranch: taskWt.branch })
        .where((tasksTable as any).id === task!.id ? undefined : undefined);
      // The where helper above is gibberish — just rebind via execute SQL
      // to keep the test DB in sync without dragging Drizzle's eq into scope.
      testDb.sqlite.exec(
        `UPDATE tasks SET worktree_path = '${taskWt.path}', worktree_branch = '${taskWt.branch}' WHERE id = ${task!.id}`,
      );
      const chat = testDb.db
        .insert(chatsTable)
        .values({ projectId, isolation: "worktree" })
        .returning()
        .get();
      const chatWt = createWorktree({ projectPath, ownerKind: "chat", ownerId: chat!.id });
      testDb.sqlite.exec(
        `UPDATE chats SET worktree_path = '${chatWt.path}', worktree_branch = '${chatWt.branch}' WHERE id = ${chat!.id}`,
      );

      const res = await app.request(`/worktrees?project_id=${projectId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{
          path: string;
          branch: string | null;
          owner: { kind: "task" | "chat"; id: number } | null;
          managed: boolean;
        }>;
        total: number;
      };
      expect(body.total).toBe(2);
      const taskEntry = body.items.find((e) => e.path === taskWt.path);
      const chatEntry = body.items.find((e) => e.path === chatWt.path);
      expect(taskEntry?.owner).toEqual({ kind: "task", id: task!.id });
      expect(chatEntry?.owner).toEqual({ kind: "chat", id: chat!.id });
      expect(taskEntry?.managed).toBe(true);
      expect(chatEntry?.managed).toBe(true);
    });

    it("flags a stale row (DB has a worktree the disk doesn't) as managed=false", async () => {
      // A task row with a `worktree_path` that doesn't exist on disk.
      const task = testDb.db
        .insert(tasksTable)
        .values({
          projectId,
          prompt: "go",
          isolation: "worktree",
          worktreePath: join(projectPath, ".flockctl/worktrees/task-9999"),
          worktreeBranch: "flockctl/task-9999",
        })
        .returning()
        .get();

      const res = await app.request(`/worktrees?project_id=${projectId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ owner: { kind: string; id: number } | null; managed: boolean }>;
      };
      const taskEntry = body.items.find((e) => e.owner?.id === task!.id);
      expect(taskEntry).toBeDefined();
      expect(taskEntry?.managed).toBe(false);
    });

    it("returns 404 for a missing project", async () => {
      const res = await app.request("/worktrees?project_id=99999");
      expect(res.status).toBe(404);
    });

    it("works without the project_id filter (lists across all projects)", async () => {
      const res = await app.request("/worktrees");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[]; total: number };
      expect(Array.isArray(body.items)).toBe(true);
    });
  });

  describe("POST /worktrees/prune", () => {
    it("cleans every clean worktree and preserves dirty ones", async () => {
      // Two tasks: one clean, one dirty.
      const taskA = testDb.db
        .insert(tasksTable)
        .values({ projectId, prompt: "go", isolation: "worktree" })
        .returning()
        .get();
      const wtA = createWorktree({ projectPath, ownerKind: "task", ownerId: taskA!.id });
      testDb.sqlite.exec(
        `UPDATE tasks SET worktree_path = '${wtA.path}', worktree_branch = '${wtA.branch}' WHERE id = ${taskA!.id}`,
      );

      const taskB = testDb.db
        .insert(tasksTable)
        .values({ projectId, prompt: "go", isolation: "worktree" })
        .returning()
        .get();
      const wtB = createWorktree({ projectPath, ownerKind: "task", ownerId: taskB!.id });
      writeFileSync(join(wtB.path, "draft.txt"), "wip\n");
      testDb.sqlite.exec(
        `UPDATE tasks SET worktree_path = '${wtB.path}', worktree_branch = '${wtB.branch}' WHERE id = ${taskB!.id}`,
      );

      const res = await app.request(`/worktrees/prune?project_id=${projectId}`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        cleaned: number;
        preservedDirty: number;
        details: Array<{ owner: { id: number }; reason: string; removed: boolean }>;
      };
      expect(body.cleaned).toBe(1);
      expect(body.preservedDirty).toBe(1);
      const cleanDetail = body.details.find((d) => d.owner.id === taskA!.id);
      const dirtyDetail = body.details.find((d) => d.owner.id === taskB!.id);
      expect(cleanDetail?.reason).toBe("clean");
      expect(cleanDetail?.removed).toBe(true);
      expect(dirtyDetail?.reason).toBe("dirty");
      expect(dirtyDetail?.removed).toBe(false);
    });

    it("also prunes chat-owned worktrees", async () => {
      const chat = testDb.db
        .insert(chatsTable)
        .values({ projectId, isolation: "worktree" })
        .returning()
        .get();
      const wt = createWorktree({ projectPath, ownerKind: "chat", ownerId: chat!.id });
      testDb.sqlite.exec(
        `UPDATE chats SET worktree_path = '${wt.path}', worktree_branch = '${wt.branch}' WHERE id = ${chat!.id}`,
      );

      const res = await app.request(`/worktrees/prune?project_id=${projectId}`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { cleaned: number };
      expect(body.cleaned).toBe(1);
    });

    it("preserves a dirty chat-owned worktree", async () => {
      const chat = testDb.db
        .insert(chatsTable)
        .values({ projectId, isolation: "worktree" })
        .returning()
        .get();
      const wt = createWorktree({ projectPath, ownerKind: "chat", ownerId: chat!.id });
      writeFileSync(join(wt.path, "draft.txt"), "wip\n");
      testDb.sqlite.exec(
        `UPDATE chats SET worktree_path = '${wt.path}', worktree_branch = '${wt.branch}' WHERE id = ${chat!.id}`,
      );

      const res = await app.request(`/worktrees/prune?project_id=${projectId}`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { cleaned: number; preservedDirty: number };
      expect(body.cleaned).toBe(0);
      expect(body.preservedDirty).toBe(1);
    });

    it("returns 404 for a missing project", async () => {
      const res = await app.request("/worktrees/prune?project_id=99999", {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });

    it("works without project_id (sweeps every project)", async () => {
      const res = await app.request("/worktrees/prune", { method: "POST" });
      expect(res.status).toBe(200);
    });
  });
});
