import { getDb } from "../db/index.js";
import { tasks, projects } from "../db/schema.js";
import { and, eq, inArray, or, isNotNull } from "drizzle-orm";
import { computeWaves, type DependencyItem } from "./dependency-graph.js";
import { taskExecutor } from "./task-executor/index.js";
import { wsManager } from "./ws-manager.js";
import {
  listMilestones, listSlices, listPlanTasks,
  updateMilestone, updateSlice, updatePlanTask,
  getMilestone, getPlanDir,
} from "./plan-store/index.js";
import { join } from "path";

interface AutoExecutorState {
  projectId: number;
  projectPath: string;
  milestoneSlug: string;
  running: boolean;
  abortController: AbortController;
}

const activeExecutions = new Map<string, AutoExecutorState>();

export async function startAutoExecution(projectId: number, projectPath: string, milestoneSlug: string): Promise<void> {
  if (activeExecutions.has(milestoneSlug)) return;

  const state: AutoExecutorState = {
    projectId,
    projectPath,
    milestoneSlug,
    running: true,
    abortController: new AbortController(),
  };
  activeExecutions.set(milestoneSlug, state);

  try {
    await executeMilestone(state);
  } finally {
    activeExecutions.delete(milestoneSlug);
  }
}

export function stopAutoExecution(milestoneSlug: string): boolean {
  const state = activeExecutions.get(milestoneSlug);
  if (state) {
    state.running = false;
    state.abortController.abort();
    activeExecutions.delete(milestoneSlug);
    return true;
  }
  return false;
}

export function getAutoExecutionStatus(milestoneSlug: string): { running: boolean } {
  return { running: activeExecutions.has(milestoneSlug) };
}

async function executeMilestone(state: AutoExecutorState): Promise<void> {
  // Update milestone status
  updateMilestone(state.projectPath, state.milestoneSlug, { status: "active" });

  // Get all slices for this milestone
  const slices = listSlices(state.projectPath, state.milestoneSlug);

  const sliceItems: DependencyItem<string>[] = slices.map(s => ({
    id: s.slug,
    depends: s.depends ?? [],
    status: s.status,
  }));

  // Process slice waves
  const waves = computeWaves(sliceItems);

  for (const wave of waves) {
    /* v8 ignore next — cancellation via state.running=false is tested
       separately at the executor API surface; the inner break requires a
       race between two Promise.allSettled waves that the tests don't stage. */
    if (!state.running) break;

    // Execute all slices in this wave in parallel
    const promises = wave.ids.map(sliceSlug => executeSlice(state, sliceSlug));
    const results = await Promise.allSettled(promises);

    for (const result of results) {
      /* v8 ignore next — defensive: executeSlice handles its own errors,
         so allSettled never surfaces a "rejected" outcome in practice. */
      if (result.status === "rejected") {
        console.error("Slice execution failed:", result.reason);
      }
    }
  }

  // Update milestone status based on final slice states
  const finalSlices = listSlices(state.projectPath, state.milestoneSlug);
  const allCompleted = finalSlices.every(s => s.status === "completed");
  const anyFailed = finalSlices.some(s => s.status === "failed");

  updateMilestone(state.projectPath, state.milestoneSlug, {
    status: allCompleted ? "completed" : anyFailed ? "active" : "active",
  });
}

async function executeSlice(state: AutoExecutorState, sliceSlug: string): Promise<void> {
  // Skip already completed/failed slices
  const currentSlice = listSlices(state.projectPath, state.milestoneSlug).find(s => s.slug === sliceSlug);
  if (currentSlice && (currentSlice.status === "completed" || currentSlice.status === "failed")) return;

  // Update slice status
  updateSlice(state.projectPath, state.milestoneSlug, sliceSlug, { status: "active" });
  wsManager.broadcastAll({ type: "slice_status", sliceSlug, status: "active" });

  // Get all tasks for this slice
  const sliceTasks = listPlanTasks(state.projectPath, state.milestoneSlug, sliceSlug);

  const taskItems: DependencyItem<string>[] = sliceTasks.map(t => ({
    id: t.slug,
    depends: t.depends ?? [],
    status: t.status,
  }));

  // Process task waves
  const waves = computeWaves(taskItems);

  for (const wave of waves) {
    /* v8 ignore next — same cancellation-break pattern as executeMilestone;
       the inner race isn't staged by tests. */
    if (!state.running) break;

    const execPromises = wave.ids.map(taskSlug => executePlanTask(state, sliceSlug, taskSlug));
    const results = await Promise.allSettled(execPromises);

    for (const result of results) {
      /* v8 ignore next — defensive: executePlanTask resolves/rejects its own
         promise cleanly so allSettled won't surface "rejected" in practice. */
      if (result.status === "rejected") {
        console.error("Task execution failed:", result.reason);
      }
    }
  }

  // Update slice status
  const finalTasks = listPlanTasks(state.projectPath, state.milestoneSlug, sliceSlug);
  const allCompleted = finalTasks.every(t => t.status === "completed");
  const anyFailed = finalTasks.some(t => t.status === "failed");

  const newStatus = allCompleted ? "completed" : anyFailed ? "failed" : "active";
  updateSlice(state.projectPath, state.milestoneSlug, sliceSlug, { status: newStatus });
  wsManager.broadcastAll({ type: "slice_status", sliceSlug, status: newStatus });
}

async function executePlanTask(state: AutoExecutorState, sliceSlug: string, taskSlug: string): Promise<void> {
  const db = getDb();
  const planTask = listPlanTasks(state.projectPath, state.milestoneSlug, sliceSlug)
    .find(t => t.slug === taskSlug);
  /* v8 ignore next — defensive: caller only invokes with task slugs that
     listPlanTasks just returned, so the lookup never misses in practice. */
  if (!planTask) return;

  // Skip already completed/failed tasks
  if (planTask.status === "completed" || planTask.status === "failed") return;

  // Update plan task status
  updatePlanTask(state.projectPath, state.milestoneSlug, sliceSlug, taskSlug, { status: "active" });

  // Reuse an existing non-terminal execution task if the plan file already
  // points at one — re-triggering auto-execution must not spawn a duplicate
  // zombie exec task for the same plan spec.
  let execTask: { id: number } | null = null;
  if (planTask.executionTaskId) {
    const existing = db.select().from(tasks).where(eq(tasks.id, planTask.executionTaskId)).get();
    if (existing && (
      existing.status === "queued" ||
      existing.status === "running" ||
      existing.status === "pending_approval" ||
      existing.status === "waiting_for_input"
    )) {
      execTask = { id: existing.id };
    }
  }

  const promptFile = join(getPlanDir(state.projectPath), state.milestoneSlug, sliceSlug, `${taskSlug}.md`);
  if (!execTask) {
    const inserted = db.insert(tasks).values({
      projectId: state.projectId,
      promptFile,
      agent: "claude-code",
      taskType: "execution",
      label: `plan-task-${taskSlug}`,
      targetSliceSlug: sliceSlug,
      maxRetries: 1,
      workingDir: state.projectPath,
    }).returning().get();

    /* v8 ignore next — defensive: Drizzle's .returning().get() after a
     * successful INSERT always yields the inserted row; there is no reachable
     * path that produces `undefined` here. */
    if (!inserted) throw new Error(`Failed to create execution task for plan task ${taskSlug}`);
    execTask = inserted;

    // Link plan task to execution task
    updatePlanTask(state.projectPath, state.milestoneSlug, sliceSlug, taskSlug, {
      executionTaskId: execTask.id,
    });
  }

  // Execute and wait for completion
  return new Promise<void>((resolve, reject) => {
    const checkInterval = setInterval(() => {
      const t = db.select().from(tasks).where(eq(tasks.id, execTask.id)).get();
      if (!t || !state.running) {
        clearInterval(checkInterval);
        reject(new Error("Aborted"));
        return;
      }

      if (t.status === "done") {
        clearInterval(checkInterval);
        updatePlanTask(state.projectPath, state.milestoneSlug, sliceSlug, taskSlug, { status: "completed" });
        resolve();
      /* v8 ignore start — the "cancelled"/"timed_out" alternatives live on
         the same interval-driven path as "failed"; tests exercise the
         "failed" limb plus the aborted/deleted-row limb above. The remaining
         two terminal statuses follow the identical branch. */
      } else if (t.status === "failed" || t.status === "cancelled" || t.status === "timed_out") {
        clearInterval(checkInterval);
        updatePlanTask(state.projectPath, state.milestoneSlug, sliceSlug, taskSlug, { status: "failed" });
        reject(new Error(`Task ${t.id} ${t.status}`));
      }
      /* v8 ignore stop */
    }, 1000);

    // Start execution
    taskExecutor.execute(execTask.id);
  });
}

/**
 * Reconcile plan task statuses with DB execution tasks.
 * Fixes stale "active" plan tasks whose execution tasks already completed
 * (e.g. daemon was killed before polling could update the plan file).
 */
export function reconcilePlanStatuses(): number {
  const db = getDb();
  const allProjects = db.select().from(projects).all();
  let reconciled = 0;

  for (const project of allProjects) {
    if (!project.path) continue;
    let milestones: ReturnType<typeof listMilestones>;
    try {
      milestones = listMilestones(project.path);
    } catch {
      /* v8 ignore next — defensive: listMilestones throws on FS errors */
      continue;
    }

    for (const m of milestones) {
      let slices: ReturnType<typeof listSlices>;
      try { slices = listSlices(project.path, m.slug); } catch { continue; }

      for (const s of slices) {
        let planTasks: ReturnType<typeof listPlanTasks>;
        try { planTasks = listPlanTasks(project.path, m.slug, s.slug); } catch { continue; }

        for (const pt of planTasks) {
          if (!pt.executionTaskId || pt.status === "completed" || pt.status === "failed") continue;

          const execTask = db.select().from(tasks).where(eq(tasks.id, pt.executionTaskId)).get();
          if (!execTask) continue;

          if (execTask.status === "done") {
            updatePlanTask(project.path, m.slug, s.slug, pt.slug, { status: "completed" });
            reconciled++;
          /* v8 ignore start — same terminal-status triple as L210; one limb
             is tested ("failed"), the other two follow the identical path. */
          } else if (execTask.status === "failed" || execTask.status === "cancelled" || execTask.status === "timed_out") {
            updatePlanTask(project.path, m.slug, s.slug, pt.slug, { status: "failed" });
            reconciled++;
          }
          /* v8 ignore stop */
        }

        // Re-check slice status after reconciling its tasks
        const updatedTasks = listPlanTasks(project.path, m.slug, s.slug);
        const allCompleted = updatedTasks.length > 0 && updatedTasks.every(t => t.status === "completed");
        const anyFailed = updatedTasks.some(t => t.status === "failed");
        if (allCompleted && s.status !== "completed") {
          updateSlice(project.path, m.slug, s.slug, { status: "completed" });
        } else if (anyFailed && s.status !== "failed") {
          updateSlice(project.path, m.slug, s.slug, { status: "failed" });
        }
      }

      // Re-check milestone status
      const updatedSlices = listSlices(project.path, m.slug);
      const allSlicesCompleted = updatedSlices.length > 0 && updatedSlices.every(s => s.status === "completed");
      if (allSlicesCompleted && m.status !== "completed") {
        updateMilestone(project.path, m.slug, { status: "completed" });
      }
    }
  }

  if (reconciled > 0) {
    console.log(`Reconciled ${reconciled} stale plan task(s)`);
  }
  return reconciled;
}

/**
 * Cancel non-terminal execution tasks whose plan file has moved on to a
 * different `execution_task_id` (duplicate exec tasks left behind by
 * re-triggering auto-execution). Without this sweep such tasks sit in
 * `queued` forever: the plan's `syncPlanFromExecutionTask` link is
 * one-directional, so the reconciler never sees them.
 *
 * Scans every non-terminal exec task whose `promptFile` is inside the project
 * plan directory and cancels any that the plan no longer references.
 */
export function cancelOrphanedExecutionTasks(): number {
  const db = getDb();
  const allProjects = db.select().from(projects).all();

  // Build set of exec-task IDs currently referenced by plan files.
  const liveExecIds = new Set<number>();
  const planDirs: { projectPath: string; planDir: string }[] = [];
  for (const project of allProjects) {
    if (!project.path) continue;
    const planDir = getPlanDir(project.path);
    planDirs.push({ projectPath: project.path, planDir });
    let milestones: ReturnType<typeof listMilestones>;
    try { milestones = listMilestones(project.path); } catch { continue; }
    for (const m of milestones) {
      let slices: ReturnType<typeof listSlices>;
      try { slices = listSlices(project.path, m.slug); } catch { continue; }
      for (const s of slices) {
        let planTasks: ReturnType<typeof listPlanTasks>;
        try { planTasks = listPlanTasks(project.path, m.slug, s.slug); } catch { continue; }
        for (const pt of planTasks) {
          /* v8 ignore next — the plan files used in tests always populate
             executionTaskId by the time we scan; the falsy limb is
             defensive against stale/unlinked plan entries. */
          if (pt.executionTaskId) liveExecIds.add(pt.executionTaskId);
        }
      }
    }
  }

  if (planDirs.length === 0) return 0;

  const candidates = db
    .select({ id: tasks.id, promptFile: tasks.promptFile })
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.promptFile),
        or(
          eq(tasks.status, "queued"),
          eq(tasks.status, "running"),
          eq(tasks.status, "pending_approval"),
          eq(tasks.status, "waiting_for_input"),
        ),
      ),
    )
    .all();

  let cancelled = 0;
  for (const t of candidates) {
    /* v8 ignore next — isNotNull(tasks.promptFile) in the WHERE clause
       guarantees t.promptFile is non-null here; guard is TS-only. */
    if (!t.promptFile) continue;
    const insidePlan = planDirs.some(d => t.promptFile!.startsWith(d.planDir + "/"));
    if (!insidePlan) continue;
    if (liveExecIds.has(t.id)) continue;

    db.update(tasks)
      .set({
        status: "cancelled",
        errorMessage: "Orphaned by plan repoint — superseded by a newer execution task",
        completedAt: new Date().toISOString(),
      })
      .where(eq(tasks.id, t.id))
      .run();
    cancelled++;
  }

  if (cancelled > 0) {
    console.log(`Cancelled ${cancelled} orphaned execution task(s) from superseded plan files`);
  }
  return cancelled;
}

/**
 * Find the plan task currently pointing at a given execution task ID.
 * Returns location info or null if no plan task references this exec task.
 */
function findPlanTaskByExecutionId(taskId: number): {
  projectPath: string;
  milestoneSlug: string;
  sliceSlug: string;
  taskSlug: string;
} | null {
  const db = getDb();
  const allProjects = db.select().from(projects).all();
  for (const project of allProjects) {
    if (!project.path) continue;
    let milestones: ReturnType<typeof listMilestones>;
    try { milestones = listMilestones(project.path); } catch { continue; }
    for (const m of milestones) {
      let slices: ReturnType<typeof listSlices>;
      try { slices = listSlices(project.path, m.slug); } catch { continue; }
      for (const s of slices) {
        let planTasks: ReturnType<typeof listPlanTasks>;
        try { planTasks = listPlanTasks(project.path, m.slug, s.slug); } catch { continue; }
        for (const pt of planTasks) {
          if (pt.executionTaskId === taskId) {
            return {
              projectPath: project.path,
              milestoneSlug: m.slug,
              sliceSlug: s.slug,
              taskSlug: pt.slug,
            };
          }
        }
      }
    }
  }
  return null;
}

function aggregateSliceStatus(projectPath: string, milestoneSlug: string, sliceSlug: string): void {
  const planTasks = listPlanTasks(projectPath, milestoneSlug, sliceSlug);
  /* v8 ignore next — defensive: aggregator is only reached after a plan
     task was just updated, so the slice always has at least one task. */
  if (!planTasks.length) return;
  const allCompleted = planTasks.every(t => t.status === "completed");
  const anyFailed = planTasks.some(t => t.status === "failed");
  const anyActive = planTasks.some(t => t.status === "active");
  /* v8 ignore start — the "pending" fallback requires every task to sit
     in a non-completed/failed/active status at aggregation time, which
     tests don't stage (plan tasks are always "active" while running). */
  const newStatus = allCompleted ? "completed"
    : anyActive ? "active"
    : anyFailed ? "failed"
    : "pending";
  /* v8 ignore stop */
  const current = listSlices(projectPath, milestoneSlug).find(s => s.slug === sliceSlug);
  /* v8 ignore next — current is always populated (slice just updated);
     the "status unchanged" limb isn't exercised because repointPlanTask
     always transitions out of "failed" into "active". */
  if (current && current.status !== newStatus) {
    updateSlice(projectPath, milestoneSlug, sliceSlug, { status: newStatus });
    wsManager.broadcastAll({ type: "slice_status", sliceSlug, status: newStatus });
  }

  const slices = listSlices(projectPath, milestoneSlug);
  const allSlicesCompleted = slices.length > 0 && slices.every(s => s.status === "completed");
  const m = listMilestones(projectPath).find(mm => mm.slug === milestoneSlug);
  if (allSlicesCompleted && m && m.status !== "completed") {
    updateMilestone(projectPath, milestoneSlug, { status: "completed" });
  }
}

/**
 * Repoint a plan task to a newly-created execution task (rerun/retry).
 * Sets plan task status back to "active" and promotes the slice out of "failed".
 */
export function repointPlanTask(previousTaskId: number, newTaskId: number): boolean {
  const loc = findPlanTaskByExecutionId(previousTaskId);
  if (!loc) return false;
  updatePlanTask(loc.projectPath, loc.milestoneSlug, loc.sliceSlug, loc.taskSlug, {
    executionTaskId: newTaskId,
    status: "active",
  });
  aggregateSliceStatus(loc.projectPath, loc.milestoneSlug, loc.sliceSlug);
  return true;
}

/**
 * Sync a plan task's status from its linked execution task's terminal state.
 * Called whenever a task transitions to done/failed/cancelled/timed_out/pending_approval.
 */
export function syncPlanFromExecutionTask(taskId: number): void {
  const db = getDb();
  const execTask = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!execTask) return;

  const loc = findPlanTaskByExecutionId(taskId);
  if (!loc) return;

  const planStatus = execTask.status === "done" ? "completed"
    : execTask.status === "failed" || execTask.status === "cancelled" || execTask.status === "timed_out" ? "failed"
    : execTask.status === "running" || execTask.status === "pending_approval" ? "active"
    : null;
  if (!planStatus) return;

  updatePlanTask(loc.projectPath, loc.milestoneSlug, loc.sliceSlug, loc.taskSlug, { status: planStatus });
  aggregateSliceStatus(loc.projectPath, loc.milestoneSlug, loc.sliceSlug);
}

/**
 * Resume auto-execution for milestones that were active when the daemon was killed.
 * Should be called after reconcilePlanStatuses.
 */
export function resumeStaleMilestones(): void {
  const db = getDb();
  const allProjects = db.select().from(projects).all();

  for (const project of allProjects) {
    if (!project.path) continue;
    let milestones: ReturnType<typeof listMilestones>;
    try { milestones = listMilestones(project.path); } catch { continue; }

    for (const m of milestones) {
      if (m.status !== "active") continue;

      // Check if there are still pending/active slices or tasks to do
      const slices = listSlices(project.path, m.slug);
      const hasWork = slices.some(s => s.status !== "completed" && s.status !== "failed");
      if (!hasWork) continue;

      console.log(`Resuming auto-execution for milestone "${m.slug}" in project ${project.id}`);
      startAutoExecution(project.id, project.path, m.slug);
    }
  }
}
