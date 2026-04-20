import { getDb } from "../db/index.js";
import { tasks, projects } from "../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { computeWaves, type DependencyItem } from "./dependency-graph.js";
import { taskExecutor } from "./task-executor.js";
import { wsManager } from "./ws-manager.js";
import {
  listMilestones, listSlices, listPlanTasks,
  updateMilestone, updateSlice, updatePlanTask,
  getMilestone, getPlanDir,
} from "./plan-store.js";
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
    status: s.status ?? "pending",
  }));

  // Process slice waves
  const waves = computeWaves(sliceItems);

  for (const wave of waves) {
    if (!state.running) break;

    // Execute all slices in this wave in parallel
    const promises = wave.ids.map(sliceSlug => executeSlice(state, sliceSlug));
    const results = await Promise.allSettled(promises);

    for (const result of results) {
      if (result.status === "rejected") {
        /* v8 ignore next — defensive: executeSlice handles its own errors */
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
    status: t.status ?? "pending",
  }));

  // Process task waves
  const waves = computeWaves(taskItems);

  for (const wave of waves) {
    if (!state.running) break;

    const execPromises = wave.ids.map(taskSlug => executePlanTask(state, sliceSlug, taskSlug));
    const results = await Promise.allSettled(execPromises);

    for (const result of results) {
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
  if (!planTask) return;

  // Skip already completed/failed tasks
  if (planTask.status === "completed" || planTask.status === "failed") return;

  // Update plan task status
  updatePlanTask(state.projectPath, state.milestoneSlug, sliceSlug, taskSlug, { status: "active" });

  // Create an execution task in DB — reference the plan task file instead of copying content
  const promptFile = join(getPlanDir(state.projectPath), state.milestoneSlug, sliceSlug, `${taskSlug}.md`);
  const execTask = db.insert(tasks).values({
    projectId: state.projectId,
    promptFile,
    agent: "claude-code",
    taskType: "execution",
    label: `plan-task-${taskSlug}`,
    targetSliceSlug: sliceSlug,
    maxRetries: 1,
    workingDir: state.projectPath,
  }).returning().get();

  if (!execTask) throw new Error(`Failed to create execution task for plan task ${taskSlug}`);

  // Link plan task to execution task
  updatePlanTask(state.projectPath, state.milestoneSlug, sliceSlug, taskSlug, {
    executionTaskId: execTask.id,
  });

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
      } else if (t.status === "failed" || t.status === "cancelled" || t.status === "timed_out") {
        clearInterval(checkInterval);
        updatePlanTask(state.projectPath, state.milestoneSlug, sliceSlug, taskSlug, { status: "failed" });
        reject(new Error(`Task ${t.id} ${t.status}`));
      }
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
          } else if (execTask.status === "failed" || execTask.status === "cancelled" || execTask.status === "timed_out") {
            updatePlanTask(project.path, m.slug, s.slug, pt.slug, { status: "failed" });
            reconciled++;
          }
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
  if (!planTasks.length) return;
  const allCompleted = planTasks.every(t => t.status === "completed");
  const anyFailed = planTasks.some(t => t.status === "failed");
  const anyActive = planTasks.some(t => t.status === "active");
  const newStatus = allCompleted ? "completed"
    : anyActive ? "active"
    : anyFailed ? "failed"
    : "pending";
  const current = listSlices(projectPath, milestoneSlug).find(s => s.slug === sliceSlug);
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
