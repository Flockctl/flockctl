/**
 * Plan-store sync helpers fired from the task-executor lifecycle. Lazy-loaded
 * via dynamic `import()` to break a circular dependency between the executor
 * and the plan-mirror code (the auto-executor pulls task data, the plan
 * mirror writes back into the same task tables).
 *
 * Failure policy:
 *   - The plan mirror is *informational* — it powers the UI's plan tree but
 *     never blocks task execution. Every other call site that mutates plan
 *     state goes through `auto-executor` directly, so a one-shot failure here
 *     just means a single task row is briefly out of sync until the next
 *     event triggers a re-run.
 *   - We deliberately do NOT rethrow: an exception here would propagate
 *     through the executor and abort an unrelated task. But silently
 *     dropping the error obscures bugs that only surface in production.
 *     Compromise: log a warning with the task id so any forensics search
 *     can correlate a missing plan-tree update with the underlying cause.
 */

function logSyncFailure(scope: string, err: unknown): void {
  // Console-warn rather than throw — see policy comment above.
  // We include the scope tag and the bare error so the daemon log shows
  // both the operation and the underlying message; structured logging
  // is intentionally not used (this is a fire-and-forget side channel).
  console.warn(`[task-executor:${scope}]`, err);
}

export function syncPlan(taskId: number): void {
  import("../auto-executor.js")
    .then((m) => m.syncPlanFromExecutionTask(taskId))
    .catch((err) => logSyncFailure(`syncPlan(${taskId})`, err));
}

export function repointPlan(previousTaskId: number, newTaskId: number): void {
  import("../auto-executor.js")
    .then((m) => m.repointPlanTask(previousTaskId, newTaskId))
    .catch((err) =>
      logSyncFailure(`repointPlan(${previousTaskId}->${newTaskId})`, err),
    );
}
