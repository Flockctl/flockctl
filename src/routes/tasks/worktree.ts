import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { tasks } from "../../db/schema.js";
import { getProjectById, getTaskOrThrow } from "../../lib/db-helpers.js";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { parseIdParam } from "../../lib/route-params.js";
import {
  cleanupIfClean,
  removeWorktree,
} from "../../services/worktree-manager.js";

/**
 * DELETE /tasks/:id/worktree
 *
 * Manual cleanup endpoint for a per-task git worktree. Used when a task
 * finalised dirty (operator made changes the agent committed, or the
 * task hit FAILED / CANCELLED — both intentionally leave the worktree
 * behind for inspection) and the operator now wants to drop it.
 *
 * Behaviour mirrors `claude --worktree`'s exit prompt:
 *
 *   - clean worktree → removed unconditionally; columns NULLed.
 *   - dirty worktree → 409 unless the caller passed `?force=true`.
 *     With `force=true`, the worktree and its branch are nuked
 *     regardless of state. The 409 carries a structured body so the
 *     UI can show a "discard changes?" dialog without a second
 *     round-trip.
 *
 * Returns 200 with `{ removed, reason }` on success. 404 if no
 * worktree is recorded for this task (already cleaned up, or never had
 * one).
 */
export function registerTaskWorktreeCleanup(router: Hono): void {
  router.delete("/:id/worktree", (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const task = getTaskOrThrow(id);

    if (!task.worktreePath || !task.worktreeBranch) {
      throw new NotFoundError("Worktree");
    }
    if (!task.projectId) {
      throw new ValidationError("Task has no project — cannot resolve worktree owner");
    }
    const project = getProjectById(task.projectId);
    if (!project?.path) {
      throw new ValidationError(
        "Project path is missing — cannot operate on its worktrees",
      );
    }

    const force = c.req.query("force") === "true";

    if (force) {
      removeWorktree({
        projectPath: project.path,
        worktreePath: task.worktreePath,
        branch: task.worktreeBranch,
        force: true,
      });
      db.update(tasks)
        .set({ worktreePath: null, worktreeBranch: null })
        .where(eq(tasks.id, id))
        .run();
      return c.json({ removed: true, reason: "forced" });
    }

    const result = cleanupIfClean({
      projectPath: project.path,
      worktreePath: task.worktreePath,
      branch: task.worktreeBranch,
    });

    if (!result.removed) {
      // Reason is 'dirty' (uncommitted changes the operator might lose)
      // or 'not_a_git_repo' (project lost its .git/ — operator should
      // either restore the repo or call with force=true to clear the
      // DB pointer). Both surface as 409 so the UI can prompt before
      // re-issuing with `?force=true`.
      throw new ConflictError(
        result.reason === "dirty"
          ? "Worktree has uncommitted changes — pass ?force=true to discard"
          : "Worktree cannot be cleaned safely — pass ?force=true to override",
        { reason: result.reason, worktreePath: task.worktreePath, worktreeBranch: task.worktreeBranch },
      );
    }

    db.update(tasks)
      .set({ worktreePath: null, worktreeBranch: null })
      .where(eq(tasks.id, id))
      .run();

    return c.json({ removed: true, reason: result.reason });
  });
}
