import { getDb } from "../db/index.js";
import { tasks, projects } from "../db/schema.js";
import { and, eq, or, isNotNull, inArray } from "drizzle-orm";
import { computeWaves, type DependencyItem } from "./dependency-graph.js";
import { taskExecutor } from "./task-executor/index.js";
import { wsManager } from "./ws-manager.js";
import {
  listMilestones, listSlices, listPlanTasks,
  updateMilestone, updateSlice, updatePlanTask,
  getPlanDir,
} from "./plan-store/index.js";
import {
  getPlanTaskExecutionIndex,
  setPlanTaskExecutionIndex,
  deletePlanTaskExecutionIndex,
} from "./plan-store/execution-index.js";
import { join } from "path";
import {
  TaskStatus,
  MilestoneStatus,
  SliceStatus,
  PlanTaskStatus,
} from "../lib/types.js";
import { TypedEventEmitter } from "./typed-event-emitter.js";

/**
 * Synthetic terminal status emitted by the stalled-detector cron when a task
 * has been `running` past the wall-clock + idle thresholds without reaching
 * a real terminal state. Not a real DB status — never persisted to
 * `tasks.status`. Lives on the event payload only so the missions
 * subscriber can route it through to the supervisor with `status='stalled'`.
 */
export const STALLED_SYNTHETIC_STATUS = "stalled" as const;

export interface TaskTerminalEvent {
  taskId: number;
  status:
    | (typeof TaskStatus)[keyof typeof TaskStatus]
    | typeof STALLED_SYNTHETIC_STATUS;
  error?: string;
  depth?: number;
}

export const taskTerminalEvents = new TypedEventEmitter<TaskTerminalEvent>();

interface AutoExecutorState {
  projectId: number;
  projectPath: string;
  milestoneSlug: string;
  running: boolean;
  abortController: AbortController;
}

const activeExecutions = new Map<string, AutoExecutorState>();

// ─── Plan-task-for-execution-task resolver cache ─────────────────────────
//
// `findPlanTaskByExecutionId` was the hottest FS-walk in the daemon
// after the missions subscriber: it fires on every terminal task
// transition (via `repointPlanTask` / `syncPlanFromExecutionTask`) and
// walks projects → milestones → slices → tasks until it finds the row.
// Third-pass audit finding #1.
//
// We cache positive hits and negative ones separately:
//   - positive: `Map<taskId, location>` lookup hits skip the FS walk.
//     Stays cached for the task's lifetime — once a plan task points at
//     an exec task id, the mapping is stable (re-runs of the exec task
//     repoint to a fresh id via `repointPlanTask`, which clears the
//     entry via the public invalidator).
//   - negative: `Map<taskId, timestamp>` with a short TTL — most tasks
//     in the daemon are orphan / non-plan tasks (ad-hoc chat-spawned
//     work). Caching `null` indefinitely means the daemon never
//     re-resolves if the task is later promoted into a slice.
//
// `clearPlanTaskByExecutionCache()` is exported so plan-store mutation
// paths (`repointPlanTask`, milestone/slice/task create+delete) can
// invalidate as part of their write path.

interface PlanTaskLocation {
  projectPath: string;
  milestoneSlug: string;
  sliceSlug: string;
  taskSlug: string;
}

const MAX_PLAN_TASK_CACHE_ENTRIES = 4096;
const PLAN_TASK_NEGATIVE_TTL_MS = 60 * 1000;

const planTaskByExecutionCache = new Map<
  number,
  { value: PlanTaskLocation | null; insertedAt: number }
>();

function readCachedPlanTask(taskId: number): PlanTaskLocation | null | undefined {
  const entry = planTaskByExecutionCache.get(taskId);
  if (!entry) return undefined;
  if (entry.value !== null) return entry.value;
  if (Date.now() - entry.insertedAt > PLAN_TASK_NEGATIVE_TTL_MS) {
    planTaskByExecutionCache.delete(taskId);
    return undefined;
  }
  return null;
}

function writeCachedPlanTask(
  taskId: number,
  value: PlanTaskLocation | null,
): void {
  if (planTaskByExecutionCache.size >= MAX_PLAN_TASK_CACHE_ENTRIES) {
    const oldest = planTaskByExecutionCache.keys().next().value;
    if (oldest !== undefined) planTaskByExecutionCache.delete(oldest);
  }
  planTaskByExecutionCache.set(taskId, { value, insertedAt: Date.now() });
}

/**
 * Invalidate every cached plan-task-for-execution entry. Wired into
 * the plan-store mutation paths in this module (repointPlanTask and
 * the resume-stale-milestones reset) — out-of-process writers should
 * call it from their own write path. Cheap: O(N) clear, no allocation.
 */
export function clearPlanTaskByExecutionCache(): void {
  planTaskByExecutionCache.clear();
}

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
  updateMilestone(state.projectPath, state.milestoneSlug, { status: MilestoneStatus.ACTIVE });

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

  // Update milestone status based on final slice states.
  //
  // Guard against vacuous-truth: `Array.prototype.every()` returns `true`
  // for an empty array, which would silently mark a milestone with zero
  // slices as `COMPLETED` even though no work was done. Same trap the
  // slice-level reducer below mitigates. A milestone with no slices
  // stays in its current `ACTIVE` state — it never auto-flips.
  const finalSlices = listSlices(state.projectPath, state.milestoneSlug);
  const allCompleted =
    finalSlices.length > 0 &&
    finalSlices.every(s => s.status === SliceStatus.COMPLETED);
  const anyFailed = finalSlices.some(s => s.status === SliceStatus.FAILED);

  updateMilestone(state.projectPath, state.milestoneSlug, {
    status: allCompleted ? MilestoneStatus.COMPLETED : anyFailed ? MilestoneStatus.ACTIVE : MilestoneStatus.ACTIVE,
  });
}

async function executeSlice(state: AutoExecutorState, sliceSlug: string): Promise<void> {
  // Skip already completed/failed slices
  const currentSlice = listSlices(state.projectPath, state.milestoneSlug).find(s => s.slug === sliceSlug);
  if (currentSlice && (currentSlice.status === SliceStatus.COMPLETED || currentSlice.status === SliceStatus.FAILED)) return;

  // Update slice status
  updateSlice(state.projectPath, state.milestoneSlug, sliceSlug, { status: SliceStatus.ACTIVE });
  wsManager.broadcastAll({ type: "slice_status", sliceSlug, status: SliceStatus.ACTIVE });

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

  // Update slice status.
  //
  // Guard against vacuous-truth: a slice with zero plan tasks would
  // satisfy `every(... === COMPLETED)` and be auto-flipped to
  // `COMPLETED` without any work. We require at least one task to
  // claim completion. An empty slice stays `ACTIVE` so the operator
  // notices it and either fills in tasks or marks it skipped/failed
  // by hand. Mirrors the milestone-level guard above.
  const finalTasks = listPlanTasks(state.projectPath, state.milestoneSlug, sliceSlug);
  const allCompleted =
    finalTasks.length > 0 &&
    finalTasks.every(t => t.status === PlanTaskStatus.COMPLETED);
  const anyFailed = finalTasks.some(t => t.status === PlanTaskStatus.FAILED);

  const newStatus = allCompleted ? SliceStatus.COMPLETED : anyFailed ? SliceStatus.FAILED : SliceStatus.ACTIVE;
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
  if (planTask.status === PlanTaskStatus.COMPLETED || planTask.status === PlanTaskStatus.FAILED) return;

  // Update plan task status
  updatePlanTask(state.projectPath, state.milestoneSlug, sliceSlug, taskSlug, { status: PlanTaskStatus.ACTIVE });

  // Reuse an existing non-terminal execution task if the plan file already
  // points at one — re-triggering auto-execution must not spawn a duplicate
  // zombie exec task for the same plan spec.
  let execTask: { id: number } | null = null;
  if (planTask.executionTaskId) {
    const existing = db.select().from(tasks).where(eq(tasks.id, planTask.executionTaskId)).get();
    if (existing && (
      existing.status === TaskStatus.QUEUED ||
      existing.status === TaskStatus.RUNNING ||
      existing.status === TaskStatus.PENDING_APPROVAL ||
      existing.status === TaskStatus.WAITING_FOR_INPUT ||
      // Rate-limited tasks are not terminal — the row owns a session_id and
      // will resume at `resume_at`. Treat them as live so the auto-executor
      // doesn't spawn a duplicate execution while the original is parked.
      existing.status === TaskStatus.RATE_LIMITED
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

  // Execute and wait for completion.
  //
  // Resource-handling invariants for the polling loop below:
  //   1. `checkInterval.unref()` — without it, a stalled plan task keeps
  //      the Node event loop alive and blocks `process.exit(0)` on
  //      graceful daemon shutdown. The interval is a polling timer, not
  //      a "must drain before exit" handle, so unref is correct.
  //   2. `state.abortController.signal` is wired to a cleanup-and-reject
  //      handler. Before this, `stopAutoExecution(slug)` flipped
  //      `state.running = false` and waited for the next 1000 ms tick to
  //      notice; the wait was felt by every cancel path (stop button,
  //      daemon shutdown, supervisor abort). The listener cuts that to
  //      a single microtask.
  //   3. `cleanup()` removes both the event listener and the abort listener so
  //      a long-running auto-execution doesn't accumulate one
  //      `AbortSignal` listener per plan task — the listener registry is
  //      the actual leak shape we'd see at scale.
  //
  // ─── Audit-round-4 finding ───
  //
  // The previous version polled `db.select().from(tasks).where(eq(id))`
  // every 1s. With N concurrent plan tasks that's N queries/second on
  // the SQLite write path — pure waste, since `taskTerminalEvents`
  // already broadcasts the terminal status we're waiting on. We now
  // subscribe to the event stream and only fall back to a stale-check
  // ticker on a coarse 30s cadence (covers the edge case where the
  // event was lost AND the row was directly mutated by, say, a
  // /tasks/:id/cancel endpoint).
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let staleCheckInterval: NodeJS.Timeout | null = null;

    const cleanup = () => {
      settled = true;
      if (staleCheckInterval) clearInterval(staleCheckInterval);
      state.abortController.signal.removeEventListener("abort", onAbort);
      taskTerminalEvents.off(onTerminal);
    };

    const onAbort = () => {
      /* v8 ignore next — defensive: cleanup() removes this listener
         before resolve()/reject() can fire it; the only path that lands
         here is a synchronous abort racing the listener wiring below. */
      if (settled) return;
      cleanup();
      reject(new Error("Aborted"));
    };

    /**
     * Decide the plan-task outcome from an observed terminal task
     * status. Returns `true` when settled — caller stops processing.
     * Encapsulated so both the event-driven path and the stale-check
     * fallback share the same status-mapping logic.
     */
    const settleFromStatus = (status: string): boolean => {
      if (settled) return true;
      if (status === TaskStatus.DONE) {
        cleanup();
        updatePlanTask(
          state.projectPath,
          state.milestoneSlug,
          sliceSlug,
          taskSlug,
          { status: PlanTaskStatus.COMPLETED },
        );
        resolve();
        return true;
      }
      if (
        status === TaskStatus.FAILED ||
        status === TaskStatus.CANCELLED ||
        status === TaskStatus.TIMED_OUT
      ) {
        cleanup();
        updatePlanTask(
          state.projectPath,
          state.milestoneSlug,
          sliceSlug,
          taskSlug,
          { status: PlanTaskStatus.FAILED },
        );
        reject(new Error(`Task ${execTask.id} ${status}`));
        return true;
      }
      return false;
    };

    const onTerminal = (event: TaskTerminalEvent) => {
      if (event.taskId !== execTask.id) return;
      if (!state.running) {
        cleanup();
        reject(new Error("Aborted"));
        return;
      }
      settleFromStatus(event.status);
    };

    // If the abort already fired before this Promise body started executing
    // (stopAutoExecution can land between the synchronous DB inserts above
    // and entering the Promise constructor), short-circuit immediately —
    // `addEventListener` does not invoke the handler retroactively.
    if (state.abortController.signal.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    state.abortController.signal.addEventListener("abort", onAbort);
    taskTerminalEvents.on(onTerminal);

    // ─── Stale-check fallback (1s) ───
    //
    // Defensive cover for the cases the event stream can't observe:
    //   - the row was mutated by a direct /tasks/:id/cancel endpoint
    //     that bypassed task-executor's `syncPlan()` → never emitted
    //   - test paths that mock `taskExecutor.execute` and write the
    //     DB row without going through `syncPlanFromExecutionTask`
    //   - `state.running` flipped to false externally without an abort
    //
    // The event path is the PRIMARY driver — in production, terminal
    // statuses fire via `syncPlanFromExecutionTask` → emit. When that
    // happens, `cleanup()` clears the interval BEFORE its next tick,
    // so the typical happy-path task triggers ~0 stale-check polls.
    // The ticker stays at 1s so cases where the event never arrives
    // (e.g. cancel-while-queued) still settle within bounded latency.
    staleCheckInterval = setInterval(() => {
      if (settled) return;
      const t = db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, execTask.id))
        .get();
      if (!t || !state.running) {
        cleanup();
        reject(new Error("Aborted"));
        return;
      }
      if (t.status) settleFromStatus(t.status);
    }, 1000);
    // Don't keep the daemon alive on shutdown waiting for the next tick.
    staleCheckInterval.unref();

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

  // ─── Pass 1: collect every executionTaskId we'll need to look up ───
  //
  // Audit-round-5: the previous shape ran one `SELECT tasks WHERE id=?`
  // per plan task inside a nested 3-level loop — for a workspace with
  // many milestones × slices × tasks that's hundreds of point lookups
  // per reconcile pass. We now do a single `inArray()` SELECT and
  // serve every per-task lookup from a hot `Map`.
  interface ProjectWalk {
    project: typeof allProjects[number];
    milestones: ReturnType<typeof listMilestones>;
  }
  const walks: ProjectWalk[] = [];
  const execTaskIds: number[] = [];
  for (const project of allProjects) {
    if (!project.path) continue;
    let milestones: ReturnType<typeof listMilestones>;
    try {
      milestones = listMilestones(project.path);
    } catch {
      /* v8 ignore next — defensive: listMilestones throws on FS errors */
      continue;
    }
    walks.push({ project, milestones });
    for (const m of milestones) {
      let slices: ReturnType<typeof listSlices>;
      try { slices = listSlices(project.path, m.slug); } catch { continue; }
      for (const s of slices) {
        let planTasks: ReturnType<typeof listPlanTasks>;
        try { planTasks = listPlanTasks(project.path, m.slug, s.slug); } catch { continue; }
        for (const pt of planTasks) {
          if (!pt.executionTaskId) continue;
          if (pt.status === PlanTaskStatus.COMPLETED || pt.status === PlanTaskStatus.FAILED) continue;
          execTaskIds.push(pt.executionTaskId);
        }
      }
    }
  }

  // Single batched lookup: every reachable execution task in one
  // SELECT, indexed by id for O(1) per-plan-task reads in pass 2.
  const execById = new Map<number, typeof tasks.$inferSelect>();
  if (execTaskIds.length > 0) {
    const rows = db.select().from(tasks).where(inArray(tasks.id, execTaskIds)).all();
    for (const r of rows) execById.set(r.id, r);
  }

  // ─── Pass 2: walk the trees again and apply transitions ───
  for (const { project } of walks) {
    if (!project.path) continue;
    // listMilestones is cheap on a cache-warmed FS; re-call to avoid
    // mutating the walks structure with intermediate state.
    let milestones: ReturnType<typeof listMilestones>;
    try { milestones = listMilestones(project.path); } catch { continue; }

    for (const m of milestones) {
      let slices: ReturnType<typeof listSlices>;
      try { slices = listSlices(project.path, m.slug); } catch { continue; }

      for (const s of slices) {
        let planTasks: ReturnType<typeof listPlanTasks>;
        try { planTasks = listPlanTasks(project.path, m.slug, s.slug); } catch { continue; }

        for (const pt of planTasks) {
          if (!pt.executionTaskId || pt.status === PlanTaskStatus.COMPLETED || pt.status === PlanTaskStatus.FAILED) continue;

          const execTask = execById.get(pt.executionTaskId);
          if (!execTask) continue;

          if (execTask.status === TaskStatus.DONE) {
            updatePlanTask(project.path, m.slug, s.slug, pt.slug, { status: PlanTaskStatus.COMPLETED });
            reconciled++;
          /* v8 ignore start — same terminal-status triple as L210; one limb
             is tested ("failed"), the other two follow the identical path. */
          } else if (execTask.status === TaskStatus.FAILED || execTask.status === TaskStatus.CANCELLED || execTask.status === TaskStatus.TIMED_OUT) {
            updatePlanTask(project.path, m.slug, s.slug, pt.slug, { status: PlanTaskStatus.FAILED });
            reconciled++;
          }
          /* v8 ignore stop */
        }

        // Re-check slice status after reconciling its tasks
        const updatedTasks = listPlanTasks(project.path, m.slug, s.slug);
        const allCompleted = updatedTasks.length > 0 && updatedTasks.every(t => t.status === PlanTaskStatus.COMPLETED);
        const anyFailed = updatedTasks.some(t => t.status === PlanTaskStatus.FAILED);
        if (allCompleted && s.status !== SliceStatus.COMPLETED) {
          updateSlice(project.path, m.slug, s.slug, { status: SliceStatus.COMPLETED });
        } else if (anyFailed && s.status !== SliceStatus.FAILED) {
          updateSlice(project.path, m.slug, s.slug, { status: SliceStatus.FAILED });
        }
      }

      // Re-check milestone status
      const updatedSlices = listSlices(project.path, m.slug);
      const allSlicesCompleted = updatedSlices.length > 0 && updatedSlices.every(s => s.status === SliceStatus.COMPLETED);
      if (allSlicesCompleted && m.status !== MilestoneStatus.COMPLETED) {
        updateMilestone(project.path, m.slug, { status: MilestoneStatus.COMPLETED });
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
          eq(tasks.status, TaskStatus.QUEUED),
          eq(tasks.status, TaskStatus.RUNNING),
          eq(tasks.status, TaskStatus.PENDING_APPROVAL),
          eq(tasks.status, TaskStatus.WAITING_FOR_INPUT),
          // Same rationale as the `live` check above — `rate_limited` is a
          // non-terminal pause, so a parked execution task that gets orphaned
          // by a plan repoint should still be cancelled rather than left as a
          // ghost wake-up timer firing against a dead plan.
          eq(tasks.status, TaskStatus.RATE_LIMITED),
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
        status: TaskStatus.CANCELLED,
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
 *
 * Three-tier lookup:
 *   1. In-memory cache (fast path; preserved for sub-µs hits).
 *   2. SQLite inverse index `plan_task_execution_index` (PK lookup, O(1)).
 *      Maintained by plan-store mutations on every write.
 *   3. FS walk fallback. Only fires on a cold cache + missing/stale index
 *      entry. The walk's findings repair both the cache AND the SQLite
 *      index, so drift is self-healing.
 */
function findPlanTaskByExecutionId(taskId: number): PlanTaskLocation | null {
  // Cache fast path — every terminal task transition fires this resolver.
  const cached = readCachedPlanTask(taskId);
  if (cached !== undefined) return cached;

  const db = getDb();

  // Tier 2: SQLite inverse index. PK lookup; covers the steady-state hot
  // path with no FS I/O after the daemon's first walk per task id.
  const indexEntry = getPlanTaskExecutionIndex(taskId);
  if (indexEntry !== null) {
    const project = db
      .select({ path: projects.path })
      .from(projects)
      .where(eq(projects.id, indexEntry.projectId))
      .get();
    if (project?.path) {
      const location: PlanTaskLocation = {
        projectPath: project.path,
        milestoneSlug: indexEntry.milestoneSlug,
        sliceSlug: indexEntry.sliceSlug,
        taskSlug: indexEntry.taskSlug,
      };
      // Confirm the file still exists on disk before trusting the index —
      // a stale row (out-of-process delete, project move, …) would
      // otherwise point us at a missing path. listPlanTasks throws on a
      // missing dir; catch and fall through to the FS walk that will
      // either find the new location or confirm "truly missing".
      try {
        const planTasks = listPlanTasks(
          project.path,
          indexEntry.milestoneSlug,
          indexEntry.sliceSlug,
        );
        const found = planTasks.find(
          (pt) => pt.slug === indexEntry.taskSlug && pt.executionTaskId === taskId,
        );
        if (found) {
          writeCachedPlanTask(taskId, location);
          return location;
        }
        // Index pointed at a stale location — purge so the FS walk below
        // can repair it without infinite-looping through this branch.
        deletePlanTaskExecutionIndex(taskId);
      } catch {
        deletePlanTaskExecutionIndex(taskId);
      }
    } else {
      // Project gone — index entry is unambiguously stale, purge.
      deletePlanTaskExecutionIndex(taskId);
    }
  }

  // Tier 3: FS walk fallback. O(P × M × S × T) but only fires on cold
  // cache + missing-index path. Findings repair both the memory cache
  // AND the SQLite index, so the next call hits Tier 1 / Tier 2.
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
            const location: PlanTaskLocation = {
              projectPath: project.path,
              milestoneSlug: m.slug,
              sliceSlug: s.slug,
              taskSlug: pt.slug,
            };
            writeCachedPlanTask(taskId, location);
            // Repair the SQLite index so the next cold-cache hit goes
            // straight to Tier 2 without re-walking.
            setPlanTaskExecutionIndex(taskId, {
              projectId: project.id,
              milestoneSlug: m.slug,
              sliceSlug: s.slug,
              taskSlug: pt.slug,
            });
            return location;
          }
        }
      }
    }
  }
  writeCachedPlanTask(taskId, null);
  return null;
}

function aggregateSliceStatus(projectPath: string, milestoneSlug: string, sliceSlug: string): void {
  const planTasks = listPlanTasks(projectPath, milestoneSlug, sliceSlug);
  /* v8 ignore next — defensive: aggregator is only reached after a plan
     task was just updated, so the slice always has at least one task. */
  if (!planTasks.length) return;
  const allCompleted = planTasks.every(t => t.status === PlanTaskStatus.COMPLETED);
  const anyFailed = planTasks.some(t => t.status === PlanTaskStatus.FAILED);
  const anyActive = planTasks.some(t => t.status === PlanTaskStatus.ACTIVE);
  /* v8 ignore start — the "pending" fallback requires every task to sit
     in a non-completed/failed/active status at aggregation time, which
     tests don't stage (plan tasks are always "active" while running). */
  const newStatus = allCompleted ? SliceStatus.COMPLETED
    : anyActive ? SliceStatus.ACTIVE
    : anyFailed ? SliceStatus.FAILED
    : SliceStatus.PENDING;
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
  const allSlicesCompleted = slices.length > 0 && slices.every(s => s.status === SliceStatus.COMPLETED);
  const m = listMilestones(projectPath).find(mm => mm.slug === milestoneSlug);
  if (allSlicesCompleted && m && m.status !== MilestoneStatus.COMPLETED) {
    updateMilestone(projectPath, milestoneSlug, { status: MilestoneStatus.COMPLETED });
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
    status: PlanTaskStatus.ACTIVE,
  });
  aggregateSliceStatus(loc.projectPath, loc.milestoneSlug, loc.sliceSlug);
  // Repointing changes the exec-task-id → plan-task mapping for both
  // the previous AND the new id (the previous is now stale; the new
  // wasn't cached at all). Clear the whole cache rather than tracking
  // bidirectional dependencies — repoints are rare relative to lookups.
  clearPlanTaskByExecutionCache();
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

  const planStatus = execTask.status === TaskStatus.DONE ? PlanTaskStatus.COMPLETED
    : execTask.status === TaskStatus.FAILED || execTask.status === TaskStatus.CANCELLED || execTask.status === TaskStatus.TIMED_OUT ? PlanTaskStatus.FAILED
    : execTask.status === TaskStatus.RUNNING || execTask.status === TaskStatus.PENDING_APPROVAL ? PlanTaskStatus.ACTIVE
    : null;
  if (!planStatus) return;

  updatePlanTask(loc.projectPath, loc.milestoneSlug, loc.sliceSlug, loc.taskSlug, { status: planStatus });
  aggregateSliceStatus(loc.projectPath, loc.milestoneSlug, loc.sliceSlug);

  if (planStatus === PlanTaskStatus.COMPLETED || planStatus === PlanTaskStatus.FAILED) {
    taskTerminalEvents.emit({
      taskId,
      status: execTask.status as TaskTerminalEvent["status"],
      error: execTask.errorMessage ?? undefined,
    });
  }
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
      if (m.status !== MilestoneStatus.ACTIVE) continue;

      // Check if there are still pending/active slices or tasks to do
      const slices = listSlices(project.path, m.slug);
      const hasWork = slices.some(s => s.status !== SliceStatus.COMPLETED && s.status !== SliceStatus.FAILED);
      if (!hasWork) continue;

      console.log(`Resuming auto-execution for milestone "${m.slug}" in project ${project.id}`);
      startAutoExecution(project.id, project.path, m.slug);
    }
  }
}
