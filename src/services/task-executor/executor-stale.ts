import { getDb } from "../../db/index.js";
import { tasks } from "../../db/schema.js";
import { eq, or } from "drizzle-orm";
import { TaskStatus } from "../../lib/types.js";

/**
 * Re-queue tasks left as "running" OR "queued" by a previous daemon instance
 * so they actually get dispatched. The in-memory queue is lost on restart,
 * so a task persisted as "queued" in DB has no one to pick it up — adopting
 * both statuses here is what keeps the queue durable across restarts.
 *
 * Tasks in `waiting_for_input` are INTENTIONALLY skipped — their Claude Code
 * session state is persisted via `claudeSessionId` and they will resume on
 * demand when the user answers the open question (see `answerQuestion` cold
 * path). Touching them here would silently discard the block and send the
 * agent back to the top of the turn.
 */
export function resetStaleTasks(activeTaskIds: Set<number>): number[] {
  const db = getDb();
  const stale = db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(or(eq(tasks.status, TaskStatus.RUNNING), eq(tasks.status, TaskStatus.QUEUED)))
    .all();

  const requeued: number[] = [];
  let runningReset = 0;
  let queuedAdopted = 0;
  for (const t of stale) {
    if (activeTaskIds.has(t.id)) continue;
    if (t.status === TaskStatus.RUNNING) {
      db.update(tasks)
        .set({
          status: TaskStatus.QUEUED,
          exitCode: null,
          errorMessage: null,
          startedAt: null,
          completedAt: null,
        })
        .where(eq(tasks.id, t.id))
        .run();
      runningReset++;
    } else {
      queuedAdopted++;
    }
    requeued.push(t.id);
  }

  if (runningReset > 0) {
    console.log(`Re-queued ${runningReset} stale running task(s) from previous daemon`);
  }
  if (queuedAdopted > 0) {
    console.log(`Adopted ${queuedAdopted} orphaned queued task(s) left by previous daemon`);
  }

  // Sanity-count parked tasks so ops can see them in the startup log.
  const waiting = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.status, TaskStatus.WAITING_FOR_INPUT))
    .all();
  if (waiting.length > 0) {
    console.log(`Left ${waiting.length} task(s) parked in waiting_for_input — will resume on answer`);
  }

  return requeued;
}
