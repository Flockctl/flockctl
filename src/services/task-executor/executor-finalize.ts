import { execFileSync } from "child_process";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { projects, tasks } from "../../db/schema.js";
import { TaskStatus, type TerminalErrorTaskStatus } from "../../lib/types.js";
import { emitAttentionChanged } from "../attention.js";
import { wsManager } from "../ws-manager.js";
import {
  serializeJournal,
  summarizeJournal,
  type FileEditJournal,
} from "../file-edit-journal.js";
import { cleanupIfClean } from "../worktree-manager.js";
import { syncPlan, repointPlan } from "./helpers.js";

export interface FinalizeSuccessArgs {
  taskId: number;
  workingDir: string;
  gitCommitBefore: string | null;
  fileEditJournal: FileEditJournal;
  requiresApproval: boolean;
}

/**
 * Persist success state, compute file-edit diff summary, and broadcast the
 * final status. Returns early if the task was already CANCELLED by the
 * cancel endpoint mid-run — we don't want to stomp that state.
 */
export function finalizeSuccess(args: FinalizeSuccessArgs): void {
  const { taskId, workingDir, gitCommitBefore, fileEditJournal, requiresApproval } = args;
  const db = getDb();

  // Still capture `gitCommitAfter` for legacy bookkeeping (metrics.ts
  // counts "tasks that produced a commit" off this column), but the
  // user-visible diff summary now comes from the file-edit journal so
  // it is isolated from any pre-existing working-tree dirt and from
  // parallel sessions running in the same project.
  let gitCommitAfter: string | null = null;
  if (gitCommitBefore && workingDir) {
    try {
      gitCommitAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workingDir, encoding: "utf-8" }).trim();
    } catch { /* git error — skip */ }
  }
  const journalSummary = summarizeJournal(fileEditJournal);
  const diffSummaryText = journalSummary?.text ?? null;

  const finalStatus = requiresApproval ? TaskStatus.PENDING_APPROVAL : TaskStatus.DONE;
  // Don't overwrite if task was already cancelled via the cancel endpoint
  const currentTask = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (currentTask?.status === TaskStatus.CANCELLED) return;
  db.update(tasks)
    .set({
      status: finalStatus,
      exitCode: requiresApproval ? undefined : 0,
      gitCommitAfter,
      gitDiffSummary: diffSummaryText,
      fileEdits: fileEditJournal.entries.length > 0 ? serializeJournal(fileEditJournal) : null,
      completedAt: new Date().toISOString(),
    })
    .where(eq(tasks.id, taskId))
    .run();
  wsManager.broadcastTaskStatus(taskId, finalStatus);
  // Pending-approval tasks appear in GET /attention; notify clients so
  // they can re-fetch without waiting for the next poll.
  if (finalStatus === TaskStatus.PENDING_APPROVAL) {
    emitAttentionChanged(wsManager);
  }
  syncPlan(taskId);
  // Cleanup-if-clean for isolated tasks. Mirrors `claude --worktree`'s
  // "auto-remove iff no changes were made" behaviour. Only runs on
  // success-like terminal states (DONE / PENDING_APPROVAL) — error
  // states (FAILED / TIMED_OUT / CANCELLED) intentionally leave the
  // worktree behind so the operator can inspect what the agent did
  // before things went wrong. `flockctl worktree prune` cleans those
  // up later.
  maybeCleanupTaskWorktree(taskId);
}

/**
 * Cleanup-if-clean entry point used by `finalizeSuccess` (DONE /
 * PENDING_APPROVAL terminals). Re-fetches the row to pick up the
 * worktree fields written during setup, sweeps the worktree iff
 * `git status --porcelain` is empty, and NULLs the `worktree_path` /
 * `worktree_branch` columns on success so the row reflects ground
 * truth. A dirty worktree leaves the columns untouched — the operator
 * can find the path via the DB row, review/merge, then call
 * `DELETE /tasks/:id/worktree` to manually finish cleanup.
 *
 * Best-effort: any error during cleanup (git not available, worktree
 * directory raced into nonexistence, …) is logged and swallowed — the
 * task itself has already finalised, so a cleanup failure must not
 * convert a successful task into a visible error.
 */
function maybeCleanupTaskWorktree(taskId: number): void {
  const db = getDb();
  const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!row || !row.worktreePath || !row.worktreeBranch || !row.projectId) return;

  const project = db.select().from(projects).where(eq(projects.id, row.projectId)).get();
  if (!project?.path) return;

  try {
    const result = cleanupIfClean({
      projectPath: project.path,
      worktreePath: row.worktreePath,
      branch: row.worktreeBranch,
    });
    if (result.removed) {
      db.update(tasks)
        .set({ worktreePath: null, worktreeBranch: null })
        .where(eq(tasks.id, taskId))
        .run();
    }
  } catch (err) {
    /* v8 ignore next 4 — defensive: cleanupIfClean catches its own
     * errors internally; reaching this branch implies a programming
     * bug elsewhere. We log + continue so finalize doesn't propagate. */
    console.error(`[task-executor] worktree cleanup failed for task ${taskId}:`, err);
  }
}

/**
 * Classify the terminal status for an error thrown by AgentSession.run().
 * TimeoutError and AbortError map to dedicated states so the UI can render
 * them distinctly from a generic failure.
 */
export function classifyRunError(err: { name?: string }): TerminalErrorTaskStatus {
  if (err.name === "TimeoutError") return TaskStatus.TIMED_OUT;
  if (err.name === "AbortError") return TaskStatus.CANCELLED;
  return TaskStatus.FAILED;
}

export interface FinalizeErrorArgs {
  taskId: number;
  status: TerminalErrorTaskStatus;
  errorMessage: string;
}

/** Persist the error-state transition unless the task was already CANCELLED. */
export function finalizeError(args: FinalizeErrorArgs): void {
  const { taskId, status, errorMessage } = args;
  const db = getDb();
  const currentTask = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (currentTask?.status !== TaskStatus.CANCELLED) {
    db.update(tasks)
      .set({ status, exitCode: 1, errorMessage, completedAt: new Date().toISOString() })
      .where(eq(tasks.id, taskId))
      .run();
    wsManager.broadcastTaskStatus(taskId, status);
  }
  syncPlan(taskId);
}

/**
 * Create a retry task cloned from the failed one, repoint the plan onto the
 * new task id, and return the new task id. Returns null if no retry is
 * possible (no maxRetries, budget exhausted, or missing row).
 *
 * Caller is responsible for kicking the new task off the event loop.
 */
export function scheduleRetry(failedTaskId: number): number | null {
  const db = getDb();
  const updated = db.select().from(tasks).where(eq(tasks.id, failedTaskId)).get();
  if (!updated || !updated.maxRetries || updated.retryCount === null || updated.retryCount >= updated.maxRetries) {
    return null;
  }
  const newTask = db.insert(tasks).values({
    projectId: updated.projectId,
    prompt: updated.prompt,
    promptFile: updated.promptFile,
    agent: updated.agent,
    model: updated.model,
    taskType: updated.taskType,
    label: `retry-${failedTaskId}-${(updated.retryCount ?? 0) + 1}`,
    maxRetries: updated.maxRetries,
    retryCount: (updated.retryCount ?? 0) + 1,
    parentTaskId: failedTaskId,
    workingDir: updated.workingDir,
    timeoutSeconds: updated.timeoutSeconds,
    targetSliceSlug: updated.targetSliceSlug,
    permissionMode: updated.permissionMode,
    envVars: updated.envVars,
    requiresApproval: updated.requiresApproval,
    // Inherit isolation intent — a retry of a worktree-isolated task
    // should also run isolated. The retry gets its OWN worktree
    // (different task id ⇒ different branch / path); we don't copy
    // `worktreePath` / `worktreeBranch` because those name the parent's
    // worktree, not the retry's.
    isolation: updated.isolation,
  }).returning().get();
  if (!newTask) return null;
  repointPlan(failedTaskId, newTask.id);
  return newTask.id;
}
