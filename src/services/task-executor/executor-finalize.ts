import { execFileSync } from "child_process";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { tasks } from "../../db/schema.js";
import { TaskStatus, type TerminalErrorTaskStatus } from "../../lib/types.js";
import { emitAttentionChanged } from "../attention.js";
import { wsManager } from "../ws-manager.js";
import {
  serializeJournal,
  summarizeJournal,
  type FileEditJournal,
} from "../file-edit-journal.js";
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
  wsManager.broadcastAll({ type: "task_status", taskId, status: finalStatus });
  // Pending-approval tasks appear in GET /attention; notify clients so
  // they can re-fetch without waiting for the next poll.
  if (finalStatus === TaskStatus.PENDING_APPROVAL) {
    emitAttentionChanged(wsManager);
  }
  syncPlan(taskId);
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
    wsManager.broadcastAll({ type: "task_status", taskId, status });
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
  }).returning().get();
  if (!newTask) return null;
  repointPlan(failedTaskId, newTask.id);
  return newTask.id;
}
