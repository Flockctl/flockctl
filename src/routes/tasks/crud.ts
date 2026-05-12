import type { Hono } from "hono";
import { getDb } from "../../db/index.js";
import { tasks, aiProviderKeys, usageRecords } from "../../db/schema.js";
import { eq, and, sql, desc, gte, lte, like, inArray, type SQL } from "drizzle-orm";
import { paginationParams } from "../../lib/pagination.js";
import { validateTaskTransition, TaskStatus } from "../../lib/types.js";
import { AppError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { parseIdParam, parseIdQuery } from "../../lib/route-params.js";
import { taskExecutor } from "../../services/task-executor/index.js";
import { resolvePermissionMode } from "../../services/permission-resolver.js";
import { loadProjectConfig } from "../../services/project-config.js";
import { loadWorkspaceConfig } from "../../services/workspace-config.js";
import { wsManager } from "../../services/ws-manager.js";
import { emitAttentionChanged } from "../../services/attention.js";
import { findMilestoneBySlice } from "../../services/plan-store/index.js";
import { execa } from "execa";
import { parsePermissionModeBody } from "../_permission-mode.js";
import { parseIsolationBody } from "../_isolation.js";
import {
  parseSpecFieldsOrThrow,
  parseJsonOrNull,
  serializeSpec,
} from "./helpers.js";
import { getTaskOrThrow, getProjectById, getWorkspaceById } from "../../lib/db-helpers.js";
import { assertSafeWritePath } from "../../lib/safe-fs-path.js";

/**
 * Correlated subquery: total USD spend for one task across every
 * `usage_records` row pointing at it. `COALESCE(... , 0)` so a task without
 * any usage rows reports `0` rather than `null`, letting the UI render
 * `$0.00` directly without a second-round fallback.
 *
 * Centralised here to keep the list and detail endpoints byte-identical;
 * a drift between them used to be how cost columns desynced after schema
 * tweaks.
 */
const taskCostUsdSubquery = sql<number>`COALESCE((SELECT SUM(total_cost_usd) FROM usage_records WHERE task_id = ${tasks.id}), 0)`;

/**
 * Subquery for the most-recently-recorded model on a task. Mirrors the
 * `actualModelUsed` column on the list and detail endpoints. NULL when the
 * task never produced a usage row (e.g. still queued, failed before a first
 * turn, or used a provider that does not report usage). Frontend falls back
 * to `task.model` / "Default".
 */
const taskActualModelSubquery = sql<string | null>`(SELECT model FROM usage_records WHERE task_id = ${tasks.id} ORDER BY id DESC LIMIT 1)`;

export function registerTaskList(router: Hono): void {
  // GET /tasks — list with filters
  router.get("/", (c) => {
    const db = getDb();
    const { page, perPage, offset } = paginationParams(c);

    const conditions: SQL[] = [];
    const status = c.req.query("status");
    const projectId = parseIdQuery(c, "project_id");
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
    if (projectId !== undefined) conditions.push(eq(tasks.projectId, projectId));
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

    // ─── Page query ───
    //
    // Audit-round-4: the previous shape used two correlated subqueries
    // (`taskCostUsdSubquery`, `taskActualModelSubquery`) that fired per
    // returned row → 2 × perPage = up to 100 extra usage_records scans
    // per `/tasks` request. We now run the page in three queries:
    //
    //   1. The task page itself + assigned-key label (existing query
    //      minus the correlated columns).
    //   2. A batched `SUM(total_cost_usd) GROUP BY task_id` over the
    //      returned task ids — one scan regardless of page size.
    //   3. A batched "latest model per task" lookup over the same id
    //      set — one scan, JS picks the first row per task.
    //
    // Plus the `count(*)` for total. Total: 4 queries instead of
    // 2 × perPage + 1. Result shape is byte-identical to the legacy
    // response.
    const rows = db
      .select({
        task: tasks,
        assignedKeyLabel: aiProviderKeys.label,
      })
      .from(tasks)
      .leftJoin(aiProviderKeys, eq(tasks.assignedKeyId, aiProviderKeys.id))
      .where(where)
      .orderBy(desc(tasks.createdAt))
      .limit(perPage)
      .offset(offset)
      .all();

    const pageTaskIds = rows
      .map((r) => r.task.id)
      .filter((id): id is number => typeof id === "number");

    // Cost aggregation — one query.
    const costByTask = new Map<number, number>();
    if (pageTaskIds.length > 0) {
      const costRows = db
        .select({
          taskId: usageRecords.taskId,
          cost: sql<number>`COALESCE(SUM(${usageRecords.totalCostUsd}), 0)`.as(
            "cost_usd",
          ),
        })
        .from(usageRecords)
        .where(inArray(usageRecords.taskId, pageTaskIds))
        .groupBy(usageRecords.taskId)
        .all();
      for (const r of costRows) {
        if (r.taskId !== null) costByTask.set(r.taskId, r.cost);
      }
    }

    // Latest-model lookup — one query ordered (task_id, id DESC) so
    // the first row per task_id in JS is the latest.
    const modelByTask = new Map<number, string>();
    if (pageTaskIds.length > 0) {
      const modelRows = db
        .select({
          taskId: usageRecords.taskId,
          model: usageRecords.model,
        })
        .from(usageRecords)
        .where(inArray(usageRecords.taskId, pageTaskIds))
        .orderBy(usageRecords.taskId, desc(usageRecords.id))
        .all();
      for (const r of modelRows) {
        if (r.taskId === null) continue;
        if (modelByTask.has(r.taskId)) continue;
        modelByTask.set(r.taskId, r.model);
      }
    }

    const items = rows.map((r) => ({
      ...r.task,
      assigned_key_label: r.assignedKeyLabel,
      actual_model_used: modelByTask.get(r.task.id) ?? null,
      cost_usd: costByTask.get(r.task.id) ?? 0,
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
    const projectId = parseIdQuery(c, "project_id");

    const conditions: SQL[] = [];
    if (projectId !== undefined) conditions.push(eq(tasks.projectId, projectId));
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
      actualModelUsed: taskActualModelSubquery,
      costUsd: taskCostUsdSubquery,
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
      cost_usd: row.costUsd,
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
    const body = await c.req.json().catch(() => ({}));
    if (!body.prompt && !body.promptFile) throw new ValidationError("prompt or promptFile is required");
    // Path-safety (audit-round-7 SECURITY finding): the task executor
    // later does `mkdirSync(workingDir, { recursive: true })` and uses
    // workingDir as cwd for `execa("git", ...)` + the agent session.
    // Without this guard a POST `{ workingDir: "/etc/foo" }` would
    // create directories under privileged paths. `assertSafeWritePath`
    // rejects system directories and absolute traversal — same gate
    // POST /projects + POST /workspaces use.
    if (typeof body.workingDir === "string" && body.workingDir.length > 0) {
      assertSafeWritePath(body.workingDir);
    }
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
    // Isolation mode (added in migration 0060). Accepts the explicit
    // `'worktree'` opt-in or null/undefined for legacy shared-cwd
    // behaviour. Rejects any other string up front so the DB never holds
    // a value the executor doesn't know how to honour. Future modes
    // (`'container'`, `'sandbox'`, …) extend this set without a
    // CHECK-drop migration — the column itself is just `TEXT NULL`.
    const isolation = parseIsolationBody(body);
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
      ...(isolation !== undefined && { isolation }),
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
    const existing = getTaskOrThrow(id);

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

    // Variant-B live propagation (parity with chats PATCH): if the PATCH
    // touched `permission_mode` AND the task has an in-flight AgentSession,
    // push the new EFFECTIVE mode (task → project → workspace → "auto")
    // into the running session. This is what lets the user flip
    // `default` → `bypassPermissions` while an agent is blocked on a
    // permission prompt and have the pending prompt auto-resolve instead
    // of waiting for the next turn. The DB PATCH already handles the
    // "next turn" case on its own; this block is purely about the CURRENT
    // turn. We skip the work when no session is running.
    if (permissionMode !== undefined && updated && taskExecutor.isRunning(id)) {
      const projectRecord = updated.projectId ? getProjectById(updated.projectId) : null;
      const workspaceRecord = projectRecord?.workspaceId
        ? getWorkspaceById(projectRecord.workspaceId)
        : null;
      const projectConfig = projectRecord?.path ? loadProjectConfig(projectRecord.path) : {};
      const workspaceConfig = workspaceRecord?.path ? loadWorkspaceConfig(workspaceRecord.path) : {};
      const effective = resolvePermissionMode({
        task: updated.permissionMode,
        project: projectConfig.permissionMode,
        workspace: workspaceConfig.permissionMode,
      });
      taskExecutor.updatePermissionMode(id, effective);
    }

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
    const existing = getTaskOrThrow(id);

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
        const project = getProjectById(existing.projectId);
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
    const task = getTaskOrThrow(id);

    /* v8 ignore next — tasks.status has DB default 'queued', so `?? "queued"` is unreachable */
    if (!validateTaskTransition(task.status ?? "queued", "cancelled")) {
      throw new ValidationError(`Cannot cancel task in status '${task.status}'`);
    }

    taskExecutor.cancel(id);
    // Always update DB — abort is async and may not have completed yet.
    // `resumeAt` is cleared too so a stale wake-up timestamp can't leak into a
    // future re-queue (e.g. via the failed→queued retry path); the scheduler
    // entry was just torn down by `taskExecutor.cancel` above, but the column
    // is what survives a daemon restart.
    db.update(tasks)
      .set({ status: "cancelled", resumeAt: null, completedAt: new Date().toISOString() })
      .where(eq(tasks.id, id))
      .run();
    wsManager.broadcastTaskStatus(id, "cancelled");

    return c.json({ status: "cancelled" });
  });
}

export function registerTaskRerun(router: Hono): void {
  // POST /tasks/:id/rerun
  router.post("/:id/rerun", async (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const original = getTaskOrThrow(id);

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
      // Inherit isolation intent — the rerun gets its own fresh
      // worktree (different task id ⇒ different branch / path).
      isolation: original.isolation,
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

    const task = getTaskOrThrow(id);
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

    wsManager.broadcastTaskStatus(id, TaskStatus.DONE);
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

    const task = getTaskOrThrow(id);
    /* v8 ignore next — tasks.status has DB default 'queued', so `?? QUEUED` is unreachable */
    if (!validateTaskTransition(task.status ?? TaskStatus.QUEUED, TaskStatus.CANCELLED)) {
      throw new ValidationError(`Cannot reject task in status '${task.status}'`);
    }

    /* v8 ignore next — rollback guard: executed only when the task actually ran (gitCommitBefore is populated by task-executor on spawn) AND a workingDir was resolved; branch tests would need a fully-executed task fixture */
    if (task.gitCommitBefore && task.workingDir) {
      /* v8 ignore start — rollback exec depends on real git repo state */
      try {
        await execa("git", ["checkout", task.gitCommitBefore, "--", "."], {
          cwd: task.workingDir,
        });
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

    wsManager.broadcastTaskStatus(id, TaskStatus.CANCELLED);
    // Rejecting also clears the pending_approval blocker from /attention.
    emitAttentionChanged(wsManager);
    return c.json({ ok: true });
  });
}
