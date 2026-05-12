import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { chats } from "../../db/schema.js";
import { getChatOrThrow, getProjectById } from "../../lib/db-helpers.js";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { parseIdParam } from "../../lib/route-params.js";
import {
  applyWorktreeBranch,
  cleanupIfClean,
  removeWorktree,
  type ApplyWorktreeReason,
} from "../../services/worktree-manager.js";
import { chatExecutor } from "../../services/chat-executor.js";

/**
 * Chat-side worktree cleanup endpoints.
 *
 *   POST /chats/:id/end-session   — operator says "I'm done with this
 *                                   chat for now". Mirrors the prompt
 *                                   `claude --worktree` shows on
 *                                   session exit. Cleans the worktree
 *                                   iff it's clean; returns 409 with a
 *                                   structured body otherwise so the
 *                                   UI can show "discard / keep /
 *                                   merge" choices. The chat row stays
 *                                   alive — only the worktree is
 *                                   touched. Pass `?force=true` to
 *                                   nuke a dirty worktree.
 *
 *   DELETE /chats/:id/worktree    — synonym for the same operation,
 *                                   matching the task-side endpoint
 *                                   (DELETE /tasks/:id/worktree). Kept
 *                                   for symmetry; both routes share
 *                                   the same handler.
 *
 * Why TWO routes for the same thing? `POST /end-session` is the
 * verb-y, UI-friendly name surfaced as the "End session" button on
 * the chat detail page (matches `claude --worktree`'s prompt). The
 * RESTful `DELETE /worktree` is what CLI / scripting clients reach
 * for. Same code path, two ergonomic doors.
 */

interface CleanupArgs {
  chatId: number;
  force: boolean;
  /** When true, also tear down any in-flight chat session before
   *  cleaning the worktree (used by the dedicated end-session route
   *  but NOT by `DELETE …/worktree` which is purely a worktree op). */
  endSession: boolean;
}

function performCleanup(args: CleanupArgs): {
  removed: boolean;
  reason: string;
  worktreePath: string;
  worktreeBranch: string;
} {
  const { chatId, force, endSession } = args;
  const db = getDb();
  const chat = getChatOrThrow(chatId);

  if (!chat.worktreePath || !chat.worktreeBranch) {
    throw new NotFoundError("Worktree");
  }
  if (!chat.projectId) {
    throw new ValidationError("Chat has no project — cannot resolve worktree owner");
  }
  const project = getProjectById(chat.projectId);
  if (!project?.path) {
    throw new ValidationError(
      "Project path is missing — cannot operate on its worktrees",
    );
  }

  // For end-session semantics, abort any in-flight turn first. The
  // worktree may be locked by a running git operation otherwise; even
  // when it isn't, leaving a session writing to a worktree we're
  // about to remove is just sloppy.
  if (endSession && chatExecutor.isRunning(chatId)) {
    chatExecutor.cancel(chatId);
  }

  if (force) {
    removeWorktree({
      projectPath: project.path,
      worktreePath: chat.worktreePath,
      branch: chat.worktreeBranch,
      force: true,
    });
    db.update(chats)
      .set({ worktreePath: null, worktreeBranch: null })
      .where(eq(chats.id, chatId))
      .run();
    return {
      removed: true,
      reason: "forced",
      worktreePath: chat.worktreePath,
      worktreeBranch: chat.worktreeBranch,
    };
  }

  const result = cleanupIfClean({
    projectPath: project.path,
    worktreePath: chat.worktreePath,
    branch: chat.worktreeBranch,
  });

  if (!result.removed) {
    throw new ConflictError(
      result.reason === "dirty"
        ? "Worktree has uncommitted changes — pass ?force=true to discard, or commit/merge before ending the session"
        : "Worktree cannot be cleaned safely — pass ?force=true to override",
      {
        reason: result.reason,
        worktreePath: chat.worktreePath,
        worktreeBranch: chat.worktreeBranch,
      },
    );
  }

  db.update(chats)
    .set({ worktreePath: null, worktreeBranch: null })
    .where(eq(chats.id, chatId))
    .run();
  return {
    removed: true,
    reason: result.reason,
    worktreePath: chat.worktreePath,
    worktreeBranch: chat.worktreeBranch,
  };
}

export function registerChatEndSession(router: Hono): void {
  router.post("/:id/end-session", (c) => {
    const id = parseIdParam(c);
    const force = c.req.query("force") === "true";
    const result = performCleanup({ chatId: id, force, endSession: true });
    return c.json(result);
  });
}

export function registerChatWorktreeCleanup(router: Hono): void {
  router.delete("/:id/worktree", (c) => {
    const id = parseIdParam(c);
    const force = c.req.query("force") === "true";
    const result = performCleanup({ chatId: id, force, endSession: false });
    return c.json(result);
  });
}

/**
 * Map `ApplyWorktreeReason` (`worktree_dirty`, `project_dirty`,
 * `project_detached`, `conflict`, `not_a_git_repo`) onto an operator-facing
 * sentence the UI can surface verbatim. Kept here rather than on the service
 * layer so the service stays HTTP-agnostic.
 */
function applyFailureMessage(reason: ApplyWorktreeReason): string {
  switch (reason) {
    case "worktree_dirty":
      return "The chat's worktree has uncommitted changes — commit them in the chat before applying";
    case "project_dirty":
      return "The project's main directory has uncommitted changes — commit, stash, or discard them before applying";
    case "project_detached":
      return "The project is on a detached HEAD — checkout a branch before applying";
    case "conflict":
      return "Merge conflict — resolve in the project manually, or revert and ask the agent to rebase";
    case "not_a_git_repo":
      return "Project is not a git working tree";
    /* v8 ignore next 4 — `merged` / `already_merged` mean `applied: true`,
     * so the caller never asks for a failure message. The fallback is
     * defensive only. */
    default:
      return `Cannot apply worktree (${reason})`;
  }
}

/**
 * POST /chats/:id/worktree/apply — merge the chat's worktree branch
 * into whatever branch is currently checked out in the project's main
 * directory.
 *
 * Counterpart to `POST /chats/:id/end-session` (which destroys the
 * worktree's commits) — this endpoint LANDS them. The worktree itself
 * is not removed; the operator can keep iterating in the chat after
 * the merge, or hit "End session" separately to wipe it.
 *
 * Returns 200 with `{ applied: true, reason: "merged" | "already_merged",
 * sourceBranch, targetBranch, mergeCommit }` on success.
 *
 * Returns 409 with `{ details: { reason } }` for actionable failures
 * (`worktree_dirty`, `project_dirty`, `project_detached`, `conflict`,
 * `not_a_git_repo`) — the UI can surface the message and let the
 * operator fix it before retrying.
 */
export function registerChatWorktreeApply(router: Hono): void {
  router.post("/:id/worktree/apply", (c) => {
    const id = parseIdParam(c);
    const chat = getChatOrThrow(id);

    if (!chat.worktreePath || !chat.worktreeBranch) {
      throw new NotFoundError("Worktree");
    }
    if (!chat.projectId) {
      throw new ValidationError(
        "Chat has no project — cannot apply worktree changes",
      );
    }
    const project = getProjectById(chat.projectId);
    if (!project?.path) {
      throw new ValidationError(
        "Project path is missing — cannot apply worktree changes",
      );
    }

    const result = applyWorktreeBranch({
      projectPath: project.path,
      worktreePath: chat.worktreePath,
      branch: chat.worktreeBranch,
    });

    if (!result.applied) {
      throw new ConflictError(applyFailureMessage(result.reason), {
        reason: result.reason,
        sourceBranch: result.sourceBranch,
        targetBranch: result.targetBranch,
        ...(result.conflicts ? { conflicts: result.conflicts } : {}),
      });
    }

    // Sanity: if for some reason the executor stopped tracking the chat,
    // make sure the row still reflects worktree presence — the worktree
    // is NOT torn down by Apply (operator may keep working in it). We
    // still touch `updatedAt` so list-page metrics reflect activity.
    getDb()
      .update(chats)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(chats.id, id))
      .run();

    return c.json(result);
  });
}
