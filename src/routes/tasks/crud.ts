import type { Hono } from "hono";
import { getDb } from "../../db/index.js";
import { tasks, aiProviderKeys, projects } from "../../db/schema.js";
import { eq, and, sql, desc, gte, lte, like } from "drizzle-orm";
import { paginationParams } from "../../lib/pagination.js";
import { validateTaskTransition, TaskStatus } from "../../lib/types.js";
import { AppError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { parseIdParam } from "../../lib/route-params.js";
import { taskExecutor } from "../../services/task-executor/index.js";
import { wsManager } from "../../services/ws-manager.js";
import { emitAttentionChanged } from "../../services/attention.js";
import { findMilestoneBySlice } from "../../services/plan-store/index.js";
import { execFileSync } from "child_process";
import { parsePermissionModeBody } from "../_permission-mode.js";
import {
  parseSpecFieldsOrThrow,
  parseJsonOrNull,
  serializeSpec,
} from "./helpers.js";

export function registerTaskList(router: Hono): void {
  // GET /tasks — list with filters
  router.get("/", (c) => {
    const db = getDb();
    const { page, perPage, offset } = paginationParams(c);

    const conditions: any[] = [];
    const status = c.req.query("status");
    const projectId = c.req.query("project_id");
    const taskType = c.req.query("task_type");
    const label = c.req.query("label");
    const createdAfter = c.req.query("created_after");
    const createdBefore = c.req.query("created_before");
    // `include_superseded` — when false (default) a failed/timed_out task is
    // hidden if it already has a child (manual /rerun or auto-retry) whose
    // status is `done` or `completed`. The build effectively succeeded, so
    // the red row is noise. Operators who *need* to audit the full history
    // flip the toggle in the UI to get every row back.
    const includeSuperseded = c.req.query("include_superseded") === "true";

    if (status) conditions.push(eq(tasks.status, status));
    if (projectId) conditions.push(eq(tasks.projectId, parseInt(projectId)));
    if (taskType) conditions.push(eq(tasks.taskType, taskType));
    if (label) conditions.push(like(tasks.label, `%${label}%`));
    if (createdAfter) conditions.push(gte(tasks.createdAt, createdAfter));
    if (createdBefore) conditions.push(lte(tasks.createdAt, createdBefore));
    if (!includeSuperseded) {
      // A failure is "superseded" when at least one child task (any generation
      // of rerun or auto-retry that points back via parent_task_id) reached a
      // successful terminal state. If the explicit `status` filter is asking
      // for failed/timed_out rows anyway, keep the exclusion so the counts
      // stay consistent with the default view — the toggle is the single
      // escape hatch for seeing superseded rows.
      conditions.push(sql`NOT (
        ${tasks.status} IN ('failed', 'timed_out')
        AND ${tasks.id} IN (
          SELECT parent_task_id FROM tasks
          WHERE parent_task_id IS NOT NULL
            AND status IN ('done', 'completed')
        )
      )`);
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = db.select({
      task: tasks,
      assignedKeyLabel: aiProviderKeys.label,
      // Correlated subquery: most recent model actually used during execution
      // (from usage_records). NULL when the task never produced a usage record
      // (e.g. still queued, failed before a first turn, or used a provider that
      // does not report usage). Frontend falls back to `task.model`/"Default".
      actualModelUsed: sql<string | null>`(SELECT model FROM usage_records WHERE task_id = ${tasks.id} ORDER BY id DESC LIMIT 1)`,
    }).from(tasks)
      .leftJoin(aiProviderKeys, eq(tasks.assignedKeyId, aiProviderKeys.id))
      .where(where).orderBy(desc(tasks.createdAt)).limit(perPage).offset(offset).all();
    const items = rows.map(r => ({
      ...r.task,
      assigned_key_label: r.assignedKeyLabel,
      actual_model_used: r.actualModelUsed,
    }));
    /* v8 ignore next — SQL count(*) always returns one row, so `?? 0` is unreachable */
    const total = db.select({ count: sql<number>`count(*)` }).from(tasks).where(where).get()?.count ?? 0;

    return c.json({ items, total, page, perPage });
  });
}

export function registerTaskStats(router: Hono): void {
  // GET /tasks/stats — aggregated task counts by status
  router.get("/stats", (c) => {
    const db = getDb();
    const projectId = c.req.query("project_id");

    const conditions: any[] = [];
    if (projectId) conditions.push(eq(tasks.projectId, parseInt(projectId)));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = db.select({
      status: tasks.status,
      count: sql<number>`count(*)`,
    }).from(tasks).where(where).groupBy(tasks.status).all();

    const stats: Record<string, number> = {
      total: 0, queued: 0, assigned: 0, running: 0,
      completed: 0, done: 0, failed: 0, timed_out: 0, cancelled: 0,
    };
    for (const row of rows) {
      stats[row.status] = row.count;
      /* v8 ignore next — stats.total is pre-initialised to 0, so `?? 0` is unreachable */
      stats.total = (stats.total ?? 0) + row.count;
    }

    // Failed tasks that have a child (manual /rerun and auto-retry both insert a
    // new row with parent_task_id = the failed task's id, so one EXISTS covers both).
    const failedRerunAgg = db.select({
      count: sql<number>`count(*)`,
    }).from(tasks)
      .where(and(
        ...(where ? [where] : []),
        eq(tasks.status, "failed"),
        sql`${tasks.id} IN (SELECT parent_task_id FROM tasks WHERE parent_task_id IS NOT NULL)`,
      ))
      .get();
    /* v8 ignore next 3 — SQL count(*) and pre-initialised stats.failed always defined; `stats.failed ?? 0` fallback is defensive against the statically-inferred possibility of `undefined`, but every branch of the status-reducing loop initialises all counts to 0 before returning */
    const failedRerun = failedRerunAgg?.count ?? 0;
    const failedNotRerun = (stats.failed ?? 0) - failedRerun;

    // Superseded failures: failed OR timed_out rows whose rerun chain produced
    // a successful terminal state (`done`/`completed`). These are the rows the
    // Tasks list hides by default. Power the "build effectively succeeded"
    // accounting in the UI without forcing callers to re-derive it.
    const supersededFailuresAgg = db.select({
      count: sql<number>`count(*)`,
    }).from(tasks)
      .where(and(
        ...(where ? [where] : []),
        sql`${tasks.status} IN ('failed', 'timed_out')`,
        sql`${tasks.id} IN (
          SELECT parent_task_id FROM tasks
          WHERE parent_task_id IS NOT NULL
            AND status IN ('done', 'completed')
        )`,
      ))
      .get();
    /* v8 ignore next — SQL count(*) always returns one row */
    const supersededFailures = supersededFailuresAgg?.count ?? 0;

    // Build after re-run: successful tasks (done/completed) that are themselves
    // a rerun of a failed parent. The rescue rate metric the user asked for —
    // how often does a re-run actually save the build.
    const buildAfterRerunAgg = db.select({
      count: sql<number>`count(*)`,
    }).from(tasks)
      .where(and(
        ...(where ? [where] : []),
        sql`${tasks.status} IN ('done', 'completed')`,
        sql`${tasks.parentTaskId} IS NOT NULL`,
      ))
      .get();
    /* v8 ignore next — SQL count(*) always returns one row */
    const buildAfterRerun = buildAfterRerunAgg?.count ?? 0;

    // Average duration of completed tasks (seconds)
    const durationAgg = db.select({
      avgDuration: sql<number>`AVG(
      CAST((julianday(${tasks.completedAt}) - julianday(${tasks.startedAt})) * 86400 AS REAL)
    )`,
    }).from(tasks)
      .where(and(
        ...(where ? [where] : []),
        sql`${tasks.startedAt} IS NOT NULL AND ${tasks.completedAt} IS NOT NULL`,
      ))
      .get();

    return c.json({
      ...stats,
      failedRerun,
      failedNotRerun,
      supersededFailures,
      buildAfterRerun,
      avgDurationSeconds: durationAgg?.avgDuration ?? null,
    });
  });
}

export function registerTaskGetById(router: Hono): void {
  // GET /tasks/:id
  router.get("/:id", (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const row = db.select({
      task: tasks,
      assignedKeyLabel: aiProviderKeys.label,
      actualModelUsed: sql<string | null>`(SELECT model FROM usage_records WHERE task_id = ${tasks.id} ORDER BY id DESC LIMIT 1)`,
    }).from(tasks)
      .leftJoin(aiProviderKeys, eq(tasks.assignedKeyId, aiProviderKeys.id))
      .where(eq(tasks.id, id)).get();
    if (!row) throw new NotFoundError("Task");

    // Direct children of this task (manual /rerun + auto-retry both set
    // parent_task_id). Frontend uses this to render the rerun chain —
    // "Re-runs: #123 (running)" — without a second round-trip.
    const children = db.select({
      id: tasks.id,
      status: tasks.status,
      label: tasks.label,
      createdAt: tasks.createdAt,
    }).from(tasks)
      .where(eq(tasks.parentTaskId, id))
      .orderBy(tasks.createdAt)
      .all();

    const task = {
      ...row.task,
      assigned_key_label: row.assignedKeyLabel,
      actual_model_used: row.actualModelUsed,
      children,
      ...serializeSpec(row.task),
    };

    // Include live metrics for running tasks
    const liveMetrics = taskExecutor.getMetrics(id);
    if (liveMetrics) {
      return c.json({
        ...task,
        liveMetrics: {
          input_tokens: liveMetrics.inputTokens,
          output_tokens: liveMetrics.outputTokens,
          cache_creation_tokens: liveMetrics.cacheCreationInputTokens,
          cache_read_tokens: liveMetrics.cacheReadInputTokens,
          total_cost_usd: liveMetrics.totalCostUsd,
          turns: liveMetrics.turns,
          duration_ms: liveMetrics.durationMs,
        },
      });
    }
    return c.json(task);
  });
}

export function registerTaskCreate(router: Hono): void {
  // POST /tasks — create and queue
  router.post("/", async (c) => {
    const db = getDb();
    const body = await c.req.json();
    if (!body.prompt && !body.promptFile) throw new ValidationError("prompt or promptFile is required");
    if ("disabledSkills" in body) {
      throw new ValidationError("disabledSkills removed — task-level disable is no longer supported; set at workspace or project level");
    }
    if ("disabledMcpServers" in body) {
      throw new ValidationError("disabledMcpServers removed — task-level disable is no longer supported; set at workspace or project level");
    }

    const createPerm = parsePermissionModeBody(body);
    // Validate spec fields up front so a 400 beats the DB insert. Only the
    // three spec keys are extracted; unrelated body keys are ignored here.
    const spec = parseSpecFieldsOrThrow({
      ...(body.acceptanceCriteria !== undefined && { acceptanceCriteria: body.acceptanceCriteria }),
      ...(body.decisionTable !== undefined && { decisionTable: body.decisionTable }),
    });
    const newTask = db.insert(tasks).values({
      projectId: body.projectId ?? null,
      prompt: body.prompt ?? null,
      promptFile: body.promptFile ?? null,
      agent: body.agent ?? "claude-code",
      model: body.model ?? null,
      taskType: body.taskType ?? "execution",
      label: body.label ?? null,
      workingDir: body.workingDir ?? null,
      timeoutSeconds: body.timeoutSeconds ?? null,
      maxRetries: body.maxRetries ?? 0,
      envVars: body.envVars ? JSON.stringify(body.envVars) : null,
      assignedKeyId: body.assignedKeyId ?? null,
      requiresApproval: body.requiresApproval ?? false,
      ...(createPerm !== undefined && { permissionMode: createPerm }),
      ...(spec.acceptanceCriteria !== undefined && {
        acceptanceCriteria: spec.acceptanceCriteria === null ? null : JSON.stringify(spec.acceptanceCriteria),
      }),
      ...(spec.decisionTable !== undefined && {
        decisionTable: spec.decisionTable === null ? null : JSON.stringify(spec.decisionTable),
      }),
    }).returning().get();

    /* v8 ignore next — `.returning().get()` on a just-inserted row is always defined in better-sqlite3 */
    if (!newTask) throw new Error("Failed to create task");

    // Queue for local execution
    taskExecutor.execute(newTask.id);

    return c.json({ ...newTask, ...serializeSpec(newTask) }, 201);
  });
}

export function registerTaskPatch(router: Hono): void {
  // PATCH /tasks/:id — update mutable task config (currently only permission_mode)
  router.patch("/:id", async (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const existing = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!existing) throw new NotFoundError("Task");

    const body = await c.req.json();
    const permissionMode = parsePermissionModeBody(body);

    db.update(tasks)
      .set({
        ...(permissionMode !== undefined && { permissionMode }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tasks.id, id))
      .run();

    const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
    return c.json(updated);
  });
}

export function registerTaskPut(router: Hono): void {
  // PUT /tasks/:id — replace the spec fields on an existing task. A key omitted
  // from the body is left untouched; explicit `null` clears the field. Cap
  // violations fail with 400 before the DB row is touched.
  //
  // Spec-required gate: if the body asks to transition the task to
  // `state: 'ready'` and the task belongs to a plan with `spec_required: true`,
  // the final (post-merge) `acceptance_criteria` must be non-empty. This is an
  // authoring-side gate only — the task executor never inspects `spec_required`,
  // so running tasks are not disturbed.
  router.put("/:id", async (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const existing = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!existing) throw new NotFoundError("Task");

    const body = await c.req.json().catch(() => ({}));
    const spec = parseSpecFieldsOrThrow({
      ...(body.acceptanceCriteria !== undefined && { acceptanceCriteria: body.acceptanceCriteria }),
      ...(body.decisionTable !== undefined && { decisionTable: body.decisionTable }),
    });

    // ─── spec_required gate ───
    // The gate fires only on the `ready` transition. Evaluate against the
    // *merged* acceptance_criteria — callers can legitimately attach criteria
    // and flip the state in the same request.
    if (body.state === "ready") {
      const mergedCriteria: string[] | null =
        spec.acceptanceCriteria !== undefined
          ? (spec.acceptanceCriteria ?? null)
          : parseJsonOrNull<string[]>(existing.acceptanceCriteria);

      const isEmpty = !mergedCriteria || mergedCriteria.length === 0;

      if (isEmpty && existing.targetSliceSlug && existing.projectId != null) {
        const project = db.select().from(projects).where(eq(projects.id, existing.projectId)).get();
        /* v8 ignore next — the `!project?.path` branch fires only when the project row was deleted between fetch-and-check or its path column is null; both states are prevented by FK + NOT NULL constraints on the schema */
        if (project?.path) {
          const milestone = findMilestoneBySlice(project.path, existing.targetSliceSlug);
          if (milestone?.specRequired) {
            throw new AppError(400, "spec_required");
          }
        }
      }
    }

    db.update(tasks)
      .set({
        ...(spec.acceptanceCriteria !== undefined && {
          acceptanceCriteria:
            spec.acceptanceCriteria === null ? null : JSON.stringify(spec.acceptanceCriteria),
        }),
        ...(spec.decisionTable !== undefined && {
          decisionTable: spec.decisionTable === null ? null : JSON.stringify(spec.decisionTable),
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tasks.id, id))
      .run();

    const updated = db.select().from(tasks).where(eq(tasks.id, id)).get();
    /* v8 ignore next — the row was fetched as `existing` earlier in the same handler and the subsequent UPDATE keeps the same primary key, so this re-select is always non-null */
    if (!updated) throw new NotFoundError("Task");
    return c.json({ ...updated, ...serializeSpec(updated) });
  });
}

export function registerTaskCancel(router: Hono): void {
  // POST /tasks/:id/cancel
  router.post("/:id/cancel", (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!task) throw new NotFoundError("Task");

    /* v8 ignore next — tasks.status has DB default 'queued', so `?? "queued"` is unreachable */
    if (!validateTaskTransition(task.status ?? "queued", "cancelled")) {
      throw new ValidationError(`Cannot cancel task in status '${task.status}'`);
    }

    taskExecutor.cancel(id);
    // Always update DB — abort is async and may not have completed yet
    db.update(tasks)
      .set({ status: "cancelled", completedAt: new Date().toISOString() })
      .where(eq(tasks.id, id))
      .run();
    wsManager.broadcastAll({ type: "task_status", taskId: id, status: "cancelled" });

    return c.json({ status: "cancelled" });
  });
}

export function registerTaskRerun(router: Hono): void {
  // POST /tasks/:id/rerun
  router.post("/:id/rerun", async (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const original = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!original) throw new NotFoundError("Task");

    const newTask = db.insert(tasks).values({
      projectId: original.projectId,
      prompt: original.prompt,
      promptFile: original.promptFile,
      agent: original.agent,
      model: original.model,
      taskType: original.taskType,
      label: original.label ? `rerun-${original.label}` : `rerun-${id}`,
      workingDir: original.workingDir,
      timeoutSeconds: original.timeoutSeconds,
      maxRetries: original.maxRetries,
      parentTaskId: id,
      requiresApproval: original.requiresApproval,
      targetSliceSlug: original.targetSliceSlug,
      permissionMode: original.permissionMode,
      envVars: original.envVars,
    }).returning().get();

    /* v8 ignore next — `.returning().get()` on a just-inserted row is always defined in better-sqlite3 */
    if (!newTask) throw new Error("Failed to create task");

    // If this rerun replaces a plan-task execution, repoint the plan so the tree
    // reflects the new attempt instead of the stale failure.
    const { repointPlanTask } = await import("../../services/auto-executor.js");
    repointPlanTask(id, newTask.id);

    taskExecutor.execute(newTask.id);

    return c.json(newTask, 201);
  });
}

export function registerTaskApproval(router: Hono): void {
  // POST /tasks/:id/approve
  router.post("/:id/approve", async (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const body = await c.req.json().catch(() => ({}));
    const note = body.note ?? null;

    const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!task) throw new NotFoundError("Task");
    /* v8 ignore next — tasks.status has DB default 'queued', so `?? QUEUED` is unreachable */
    if (!validateTaskTransition(task.status ?? TaskStatus.QUEUED, TaskStatus.DONE)) {
      throw new ValidationError(`Cannot approve task in status '${task.status}'`);
    }

    db.update(tasks)
      .set({
        status: TaskStatus.DONE,
        exitCode: 0,
        approvalStatus: "approved",
        approvedAt: new Date().toISOString(),
        approvalNote: note,
      })
      .where(eq(tasks.id, id))
      .run();

    wsManager.broadcastAll({ type: "task_status", taskId: id, status: TaskStatus.DONE });
    // Task left pending_approval, so any cached attention list is stale.
    emitAttentionChanged(wsManager);
    return c.json({ ok: true });
  });

  // POST /tasks/:id/reject
  router.post("/:id/reject", async (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const body = await c.req.json().catch(() => ({}));
    const note = body.note ?? null;

    const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!task) throw new NotFoundError("Task");
    /* v8 ignore next — tasks.status has DB default 'queued', so `?? QUEUED` is unreachable */
    if (!validateTaskTransition(task.status ?? TaskStatus.QUEUED, TaskStatus.CANCELLED)) {
      throw new ValidationError(`Cannot reject task in status '${task.status}'`);
    }

    /* v8 ignore next — rollback guard: executed only when the task actually ran (gitCommitBefore is populated by task-executor on spawn) AND a workingDir was resolved; branch tests would need a fully-executed task fixture */
    if (task.gitCommitBefore && task.workingDir) {
      /* v8 ignore start — rollback exec depends on real git repo state */
      try {
        execFileSync("git", ["checkout", task.gitCommitBefore, "--", "."], { cwd: task.workingDir });
      } catch { /* rollback failed — continue */ }
      /* v8 ignore stop */
    }

    db.update(tasks)
      .set({
        status: TaskStatus.CANCELLED,
        approvalStatus: "rejected",
        approvedAt: new Date().toISOString(),
        approvalNote: note,
        errorMessage: `Rejected: ${note ?? "no reason"}`,
      })
      .where(eq(tasks.id, id))
      .run();

    wsManager.broadcastAll({ type: "task_status", taskId: id, status: TaskStatus.CANCELLED });
    // Rejecting also clears the pending_approval blocker from /attention.
    emitAttentionChanged(wsManager);
    return c.json({ ok: true });
  });
}
