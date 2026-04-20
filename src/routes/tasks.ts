import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { tasks, taskLogs, aiProviderKeys } from "../db/schema.js";
import { eq, and, sql, desc, gte, lte, like } from "drizzle-orm";
import { paginationParams } from "../lib/pagination.js";
import { validateTaskTransition, TaskStatus } from "../lib/types.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { taskExecutor } from "../services/task-executor.js";
import { wsManager } from "../services/ws-manager.js";
import { execFileSync } from "child_process";
import { parsePermissionModeBody } from "./_permission-mode.js";

export const taskRoutes = new Hono();

// GET /tasks — list with filters
taskRoutes.get("/", (c) => {
  const db = getDb();
  const { page, perPage, offset } = paginationParams(c);

  const conditions: any[] = [];
  const status = c.req.query("status");
  const projectId = c.req.query("project_id");
  const taskType = c.req.query("task_type");
  const label = c.req.query("label");
  const createdAfter = c.req.query("created_after");
  const createdBefore = c.req.query("created_before");

  if (status) conditions.push(eq(tasks.status, status));
  if (projectId) conditions.push(eq(tasks.projectId, parseInt(projectId)));
  if (taskType) conditions.push(eq(tasks.taskType, taskType));
  if (label) conditions.push(like(tasks.label, `%${label}%`));
  if (createdAfter) conditions.push(gte(tasks.createdAt, createdAfter));
  if (createdBefore) conditions.push(lte(tasks.createdAt, createdBefore));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = db.select({
    task: tasks,
    assignedKeyLabel: aiProviderKeys.label,
  }).from(tasks)
    .leftJoin(aiProviderKeys, eq(tasks.assignedKeyId, aiProviderKeys.id))
    .where(where).orderBy(desc(tasks.createdAt)).limit(perPage).offset(offset).all();
  const items = rows.map(r => ({ ...r.task, assigned_key_label: r.assignedKeyLabel }));
  const total = db.select({ count: sql<number>`count(*)` }).from(tasks).where(where).get()?.count ?? 0;

  return c.json({ items, total, page, perPage });
});

// GET /tasks/stats — aggregated task counts by status
taskRoutes.get("/stats", (c) => {
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
    stats.total += row.count;
  }

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

  return c.json({ ...stats, avgDurationSeconds: durationAgg?.avgDuration ?? null });
});

// GET /tasks/:id
taskRoutes.get("/:id", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const row = db.select({
    task: tasks,
    assignedKeyLabel: aiProviderKeys.label,
  }).from(tasks)
    .leftJoin(aiProviderKeys, eq(tasks.assignedKeyId, aiProviderKeys.id))
    .where(eq(tasks.id, id)).get();
  if (!row) throw new NotFoundError("Task");
  const task = { ...row.task, assigned_key_label: row.assignedKeyLabel };

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

// GET /tasks/:id/logs
taskRoutes.get("/:id/logs", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) throw new NotFoundError("Task");

  const rows = db.select().from(taskLogs).where(eq(taskLogs.taskId, id)).orderBy(taskLogs.timestamp).all();
  const logs = rows.map((r) => ({
    id: String(r.id),
    task_id: String(r.taskId),
    content: r.content,
    stream_type: r.streamType,
    timestamp: r.timestamp,
  }));
  return c.json(logs);
});

// POST /tasks — create and queue
taskRoutes.post("/", async (c) => {
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
  }).returning().get();

  if (!newTask) throw new Error("Failed to create task");

  // Queue for local execution
  taskExecutor.execute(newTask.id);

  return c.json(newTask, 201);
});

// PATCH /tasks/:id — update mutable task config (currently only permission_mode)
taskRoutes.patch("/:id", async (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
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

// POST /tasks/:id/cancel
taskRoutes.post("/:id/cancel", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) throw new NotFoundError("Task");

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

// POST /tasks/:id/rerun
taskRoutes.post("/:id/rerun", async (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
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

  if (!newTask) throw new Error("Failed to create task");

  // If this rerun replaces a plan-task execution, repoint the plan so the tree
  // reflects the new attempt instead of the stale failure.
  const { repointPlanTask } = await import("../services/auto-executor.js");
  repointPlanTask(id, newTask.id);

  taskExecutor.execute(newTask.id);

  return c.json(newTask, 201);
});

// GET /tasks/:id/diff — git diff with optional truncation (?maxLines=N, default 2000)
taskRoutes.get("/:id/diff", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) throw new NotFoundError("Task");
  if (!task.gitCommitBefore) throw new NotFoundError("Git diff info");

  const workingDir = task.workingDir;
  if (!workingDir) throw new ValidationError("No working directory");

  const maxLines = parseInt(c.req.query("maxLines") ?? "2000") || 2000;

  try {
    const commitAfter = task.gitCommitAfter ?? "HEAD";
    let diff = execFileSync(
      "git", ["diff", `${task.gitCommitBefore}..${commitAfter}`],
      { cwd: workingDir, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 }
    );
    /* v8 ignore next 3 — defensive: only hit when before===after produces no diff */
    if (!diff && task.gitCommitBefore === task.gitCommitAfter) {
      diff = execFileSync("git", ["diff"], { cwd: workingDir, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
    }

    const lines = diff.split("\n");
    const truncated = lines.length > maxLines;
    if (truncated) diff = lines.slice(0, maxLines).join("\n");

    return c.json({
      commitBefore: task.gitCommitBefore,
      commitAfter: task.gitCommitAfter,
      summary: task.gitDiffSummary,
      diff,
      truncated,
      totalLines: lines.length,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST /tasks/:id/approve
taskRoutes.post("/:id/approve", async (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const note = body.note ?? null;

  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) throw new NotFoundError("Task");
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
  return c.json({ ok: true });
});

// POST /tasks/:id/reject
taskRoutes.post("/:id/reject", async (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const note = body.note ?? null;

  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) throw new NotFoundError("Task");
  if (!validateTaskTransition(task.status ?? TaskStatus.QUEUED, TaskStatus.CANCELLED)) {
    throw new ValidationError(`Cannot reject task in status '${task.status}'`);
  }

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
  return c.json({ ok: true });
});

// POST /tasks/:id/permission/:requestId — respond to a tool permission request
taskRoutes.post("/:id/permission/:requestId", async (c) => {
  const id = parseInt(c.req.param("id"));
  const requestId = c.req.param("requestId");
  const body = await c.req.json().catch(() => ({}));
  const behavior = body.behavior; // "allow" | "deny"

  if (behavior !== "allow" && behavior !== "deny") {
    throw new ValidationError("behavior must be 'allow' or 'deny'");
  }

  if (!taskExecutor.isRunning(id)) {
    throw new ValidationError("Task is not running");
  }

  const result = behavior === "allow"
    ? { behavior: "allow" as const }
    : { behavior: "deny" as const, message: body.message ?? "Denied by user" };

  const resolved = taskExecutor.resolvePermission(id, requestId, result);
  if (!resolved) {
    throw new NotFoundError("Permission request");
  }

  return c.json({ ok: true });
});
