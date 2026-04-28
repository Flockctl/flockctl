import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { projects, tasks } from "../db/schema.js";
import { and, desc, eq, like } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { parseIdParam } from "../lib/route-params.js";
import { buildPlanGenerationPrompt } from "../services/plan-prompt.js";
import { startAutoExecution, stopAutoExecution, getAutoExecutionStatus, repointPlanTask } from "../services/auto-executor.js";
import { resolveAllowedKeyIds, selectKeyForTask } from "../services/ai/key-selection.js";
import { taskExecutor } from "../services/task-executor/index.js";
import { computeWaves } from "../services/dependency-graph.js";
import {
  listMilestones, getMilestone, createMilestone, updateMilestone, deleteMilestone,
  listSlices, getSlice, createSlice, updateSlice, deleteSlice,
  listPlanTasks, getPlanTask, createPlanTask, updatePlanTask, deletePlanTask,
  getPlanDir, parseMd, writeMd,
} from "../services/plan-store/index.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getProjectOrThrow } from "../lib/db-helpers.js";

export const planningRoutes = new Hono();

/** Resolve project path from numeric project ID */
function getProjectPath(pid: number): string {
  const project = getProjectOrThrow(pid);
  if (!project.path) throw new ValidationError("Project has no path configured");
  return project.path;
}

// ─── Milestones ─────────────────────────────────

// POST /projects/:pid/milestones
planningRoutes.post("/:pid/milestones", async (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  const body = await c.req.json();

  const result = createMilestone(projectPath, {
    title: body.title,
    description: body.description,
    status: body.status,
    vision: body.vision,
    successCriteria: body.successCriteria,
    dependsOn: body.dependsOn,
    order: body.order_index ?? body.orderIndex ?? body.order ?? undefined,
    keyRisks: body.keyRisks,
    proofStrategy: body.proofStrategy,
    boundaryMapMarkdown: body.boundaryMapMarkdown,
    definitionOfDone: body.definitionOfDone,
  });
  return c.json(result, 201);
});

// GET /projects/:pid/milestones
planningRoutes.get("/:pid/milestones", (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  return c.json(listMilestones(projectPath));
});

// GET /projects/:pid/milestones/:slug
planningRoutes.get("/:pid/milestones/:slug", (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  const m = getMilestone(projectPath, c.req.param("slug"));
  if (!m) throw new NotFoundError("Milestone");
  return c.json(m);
});

// PATCH /projects/:pid/milestones/:slug
planningRoutes.patch("/:pid/milestones/:slug", async (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  const slug = c.req.param("slug");
  const existing = getMilestone(projectPath, slug);
  if (!existing) throw new NotFoundError("Milestone");

  const body = await c.req.json();
  const result = updateMilestone(projectPath, slug, {
    ...(body.title !== undefined && { title: body.title }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.status !== undefined && { status: body.status }),
    ...(body.order !== undefined && { order: body.order }),
    ...(body.orderIndex !== undefined && { order: body.orderIndex }),
    ...(body.order_index !== undefined && { order: body.order_index }),
  });
  return c.json(result);
});

// DELETE /projects/:pid/milestones/:slug
planningRoutes.delete("/:pid/milestones/:slug", (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  const slug = c.req.param("slug");
  const existing = getMilestone(projectPath, slug);
  if (!existing) throw new NotFoundError("Milestone");
  deleteMilestone(projectPath, slug);
  return c.json({ deleted: true });
});

// ─── Slices ─────────────────────────────────

// POST /projects/:pid/milestones/:mslug/slices
planningRoutes.post("/:pid/milestones/:mslug/slices", async (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  const mslug = c.req.param("mslug");
  const m = getMilestone(projectPath, mslug);
  if (!m) throw new NotFoundError("Milestone");

  const body = await c.req.json();
  const result = createSlice(projectPath, mslug, {
    title: body.title,
    description: body.description,
    status: body.status,
    risk: body.risk,
    depends: body.depends,
    goal: body.goal,
    demo: body.demo,
    successCriteria: body.successCriteria,
    order: body.order_index ?? body.orderIndex ?? body.order ?? undefined,
    proofLevel: body.proofLevel,
    integrationClosure: body.integrationClosure,
    observabilityImpact: body.observabilityImpact,
    threatSurface: body.threatSurface,
  });
  return c.json(result, 201);
});

// GET /projects/:pid/milestones/:mslug/slices
planningRoutes.get("/:pid/milestones/:mslug/slices", (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  return c.json(listSlices(projectPath, c.req.param("mslug")));
});

// GET /projects/:pid/milestones/:mslug/slices/:sslug
planningRoutes.get("/:pid/milestones/:mslug/slices/:sslug", (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  const s = getSlice(projectPath, c.req.param("mslug"), c.req.param("sslug"));
  if (!s) throw new NotFoundError("Slice");
  return c.json(s);
});

// PATCH /projects/:pid/milestones/:mslug/slices/:sslug
planningRoutes.patch("/:pid/milestones/:mslug/slices/:sslug", async (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  const mslug = c.req.param("mslug");
  const sslug = c.req.param("sslug");
  const existing = getSlice(projectPath, mslug, sslug);
  if (!existing) throw new NotFoundError("Slice");

  const body = await c.req.json();
  const result = updateSlice(projectPath, mslug, sslug, {
    ...(body.title !== undefined && { title: body.title }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.status !== undefined && { status: body.status }),
    ...(body.order !== undefined && { order: body.order }),
    ...(body.orderIndex !== undefined && { order: body.orderIndex }),
    ...(body.order_index !== undefined && { order: body.order_index }),
  });
  return c.json(result);
});

// DELETE /projects/:pid/milestones/:mslug/slices/:sslug
planningRoutes.delete("/:pid/milestones/:mslug/slices/:sslug", (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  const mslug = c.req.param("mslug");
  const sslug = c.req.param("sslug");
  const existing = getSlice(projectPath, mslug, sslug);
  if (!existing) throw new NotFoundError("Slice");
  deleteSlice(projectPath, mslug, sslug);
  return c.json({ deleted: true });
});

// ─── Plan Tasks ─────────────────────────────────

// POST /.../slices/:sslug/tasks
planningRoutes.post("/:pid/milestones/:mslug/slices/:sslug/tasks", async (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  const mslug = c.req.param("mslug");
  const sslug = c.req.param("sslug");
  const s = getSlice(projectPath, mslug, sslug);
  if (!s) throw new NotFoundError("Slice");

  const body = await c.req.json();
  const result = createPlanTask(projectPath, mslug, sslug, {
    title: body.title,
    description: body.description,
    model: body.model,
    estimate: body.estimate,
    files: body.files,
    verify: body.verify,
    depends: body.depends,
    inputs: body.inputs,
    expectedOutput: body.expectedOutput,
    order: body.order_index ?? body.orderIndex ?? body.order ?? undefined,
    failureModes: body.failureModes,
    negativeTests: body.negativeTests,
    observabilityImpact: body.observabilityImpact,
  });
  return c.json(result, 201);
});

// GET /.../slices/:sslug/tasks
planningRoutes.get("/:pid/milestones/:mslug/slices/:sslug/tasks", (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  return c.json(listPlanTasks(projectPath, c.req.param("mslug"), c.req.param("sslug")));
});

// GET /.../tasks/:tslug
planningRoutes.get("/:pid/milestones/:mslug/slices/:sslug/tasks/:tslug", (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  const t = getPlanTask(projectPath, c.req.param("mslug"), c.req.param("sslug"), c.req.param("tslug"));
  if (!t) throw new NotFoundError("Plan Task");
  return c.json(t);
});

// PATCH /.../tasks/:tslug
planningRoutes.patch("/:pid/milestones/:mslug/slices/:sslug/tasks/:tslug", async (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  const mslug = c.req.param("mslug");
  const sslug = c.req.param("sslug");
  const tslug = c.req.param("tslug");
  const existing = getPlanTask(projectPath, mslug, sslug, tslug);
  if (!existing) throw new NotFoundError("Plan Task");

  const body = await c.req.json();
  const result = updatePlanTask(projectPath, mslug, sslug, tslug, {
    ...(body.title !== undefined && { title: body.title }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.status !== undefined && { status: body.status }),
    ...(body.order !== undefined && { order: body.order }),
    ...(body.orderIndex !== undefined && { order: body.orderIndex }),
    ...(body.order_index !== undefined && { order: body.order_index }),
  });
  return c.json(result);
});

// DELETE /.../tasks/:tslug
planningRoutes.delete("/:pid/milestones/:mslug/slices/:sslug/tasks/:tslug", (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  const mslug = c.req.param("mslug");
  const sslug = c.req.param("sslug");
  const tslug = c.req.param("tslug");
  const existing = getPlanTask(projectPath, mslug, sslug, tslug);
  if (!existing) throw new NotFoundError("Plan Task");
  deletePlanTask(projectPath, mslug, sslug, tslug);
  return c.json({ deleted: true });
});

// ─── Plan Generation ─────────────────────────────

// POST /projects/:pid/generate-plan
planningRoutes.post("/:pid/generate-plan", async (c) => {
  const db = getDb();
  const pid = parseIdParam(c, "pid");
  const projectPath = getProjectPath(pid);

  const body = await c.req.json();
  const prompt = body.prompt;
  const mode = body.mode ?? "quick";
  // Optional UI-provided overrides. When omitted, the daemon picks a key via
  // `selectKeyForTask` (workspace/project inheritance) and leaves `model`
  // unset so the agent falls back to the project/global default.
  const requestedKeyIdRaw = body.aiProviderKeyId ?? body.ai_provider_key_id;
  const requestedKeyId =
    typeof requestedKeyIdRaw === "number"
      ? requestedKeyIdRaw
      : typeof requestedKeyIdRaw === "string" && requestedKeyIdRaw.trim() !== ""
        ? parseInt(requestedKeyIdRaw, 10)
        : null;
  if (requestedKeyIdRaw !== undefined && requestedKeyIdRaw !== null && !Number.isFinite(requestedKeyId)) {
    throw new ValidationError("aiProviderKeyId must be a number");
  }
  const requestedModelRaw = body.model;
  const requestedModel =
    typeof requestedModelRaw === "string" && requestedModelRaw.trim() !== ""
      ? requestedModelRaw.trim()
      : null;

  if (!prompt || typeof prompt !== "string") {
    throw new ValidationError("prompt is required");
  }
  if (mode !== "quick" && mode !== "deep") {
    throw new ValidationError("mode must be 'quick' or 'deep'");
  }

  // Enforce the project/workspace allow-list — the user may only assign keys
  // that are permitted for this project's scope. An empty resolved list means
  // "no restriction" (any active key is fine).
  if (requestedKeyId) {
    const allowedIds = resolveAllowedKeyIds({ projectId: pid });
    if (allowedIds.length > 0 && !allowedIds.includes(requestedKeyId)) {
      throw new ValidationError(
        "aiProviderKeyId is not in the project's allowed key list. " +
        "Pick a key permitted by the project/workspace, or widen the whitelist via PATCH /projects/:id.",
      );
    }
  }

  let selectedKey;
  try {
    selectedKey = await selectKeyForTask({
      projectId: pid,
      assignedKeyId: requestedKeyId ?? null,
    });
  } catch (err: any) {
    throw new ValidationError(err?.message ?? "No available AI keys");
  }

  // Build agent prompt — the agent will create plan files directly
  const agentPrompt = await buildPlanGenerationPrompt(pid, projectPath, prompt, mode);

  // Create task — TaskExecutor will run it asynchronously
  const task = db.insert(tasks).values({
    projectId: pid,
    prompt: agentPrompt,
    agent: "claude-code",
    model: requestedModel,
    taskType: "execution",
    label: `plan-generate-${mode}`,
    assignedKeyId: selectedKey.id,
    workingDir: projectPath,
    status: "queued",
  }).returning().get();

  // Fire and forget — task executor streams via WebSocket
  taskExecutor.execute(task!.id);

  return c.json({ taskId: task!.id }, 201);
});

// GET /projects/:pid/generate-plan/status — is plan generation in progress?
// Looks only at the most recent plan-generate task for the project, so zombie
// tasks from earlier crashed runs never mask a newer completed run.
planningRoutes.get("/:pid/generate-plan/status", (c) => {
  const db = getDb();
  const pid = parseIdParam(c, "pid");

  const latest = db.select()
    .from(tasks)
    .where(and(
      eq(tasks.projectId, pid),
      like(tasks.label, "plan-generate-%"),
    ))
    .orderBy(desc(tasks.createdAt))
    .limit(1)
    .get();

  const active = latest && (latest.status === "queued" || latest.status === "running");
  if (!active) {
    return c.json({ generating: false });
  }

  return c.json({
    generating: true,
    task_id: latest!.id,
    status: latest!.status,
    mode: latest!.label?.replace(/^plan-generate-/, "") ?? null,
    started_at: latest!.startedAt,
    created_at: latest!.createdAt,
  });
});

// ─── Auto-Execution ─────────────────────────────

// POST /projects/:pid/milestones/:mslug/auto-execute — start
planningRoutes.post("/:pid/milestones/:mslug/auto-execute", async (c) => {
  const pid = parseIdParam(c, "pid");
  const projectPath = getProjectPath(pid);
  const mslug = c.req.param("mslug");

  const m = getMilestone(projectPath, mslug);
  if (!m) throw new NotFoundError("Milestone");

  startAutoExecution(pid, projectPath, mslug);

  const slices = listSlices(projectPath, mslug);
  return c.json({
    status: "started",
    milestone_id: mslug,
    current_slice_ids: slices.filter(s => s.status === "active").map(s => s.slug),
  });
});

// DELETE /projects/:pid/milestones/:mslug/auto-execute — stop
planningRoutes.delete("/:pid/milestones/:mslug/auto-execute", (c) => {
  const mslug = c.req.param("mslug");
  const stopped = stopAutoExecution(mslug);
  return c.json({
    status: stopped ? "stopped" : "not_running",
    milestone_id: mslug,
    current_slice_ids: [],
  });
});

// GET /projects/:pid/milestones/:mslug/auto-execute — status
planningRoutes.get("/:pid/milestones/:mslug/auto-execute", (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  const mslug = c.req.param("mslug");

  const m = getMilestone(projectPath, mslug);
  if (!m) throw new NotFoundError("Milestone");

  const execStatus = getAutoExecutionStatus(mslug);
  const slices = listSlices(projectPath, mslug);
  const completedSlices = slices.filter(s => s.status === "completed").length;

  return c.json({
    status: execStatus.running ? "running" : m.status ?? "pending",
    milestone_id: mslug,
    current_slice_ids: slices.filter(s => s.status === "active").map(s => s.slug),
    started_at: null,
    completed_slices: completedSlices,
    total_slices: slices.length,
  });
});

// POST /projects/:pid/milestones/:mslug/rerun-failed —
// bulk re-run every plan task in this milestone whose latest execution
// attempt is in a "failed" terminal state. Mirrors the per-task
// `POST /tasks/:id/rerun` shape (clone the task row, set parentTaskId,
// `repointPlanTask` to flip the plan task back to "active", and queue
// the new task) but does it across the whole milestone in one shot so
// users don't have to click `Re-run` on every red row when a wave
// fails.
//
// Notes:
//  - Only plan tasks with `status === "failed"` AND a non-null
//    `executionTaskId` are rerun. A failed plan task without an exec
//    link is a planning-time failure with nothing to clone, so we skip
//    it rather than fabricating a task row.
//  - Query param `resume` (default "true") controls whether we restart
//    auto-execution for this milestone. Pass `?resume=false` if the
//    caller only wants to re-queue the failed leaves and leave the
//    orchestrator alone (e.g. a smoke test).
//  - Idempotent-ish: calling it twice in a row simply produces a
//    fresh batch of rerun tasks the second time only if any of the
//    first batch failed again. If everything from the first batch is
//    still active/done the second call returns `count: 0`.
planningRoutes.post("/:pid/milestones/:mslug/rerun-failed", async (c) => {
  const db = getDb();
  const pid = parseIdParam(c, "pid");
  const projectPath = getProjectPath(pid);
  const mslug = c.req.param("mslug");

  const m = getMilestone(projectPath, mslug);
  if (!m) throw new NotFoundError("Milestone");

  const resumeQuery = c.req.query("resume");
  const resume = resumeQuery == null ? true : resumeQuery !== "false";

  // Walk slices → plan tasks → collect failed leaves with a linked exec task.
  const slices = listSlices(projectPath, mslug);
  const failedExecIds: number[] = [];
  for (const s of slices) {
    const planTasks = listPlanTasks(projectPath, mslug, s.slug);
    for (const pt of planTasks) {
      if (pt.status === "failed" && typeof pt.executionTaskId === "number") {
        failedExecIds.push(pt.executionTaskId);
      }
    }
  }

  if (failedExecIds.length === 0) {
    return c.json({ rerun: [], count: 0, resumed: false });
  }

  const created: { originalTaskId: number; newTaskId: number }[] = [];
  for (const execId of failedExecIds) {
    const original = db.select().from(tasks).where(eq(tasks.id, execId)).get();
    /* v8 ignore next — failed plan tasks always carry a live exec row;
       the missing-row branch is defensive against a manually-deleted
       task and isn't worth staging in the test bed. */
    if (!original) continue;

    const newTask = db.insert(tasks).values({
      projectId: original.projectId,
      prompt: original.prompt,
      promptFile: original.promptFile,
      agent: original.agent,
      model: original.model,
      taskType: original.taskType,
      label: original.label ? `rerun-${original.label}` : `rerun-${execId}`,
      workingDir: original.workingDir,
      timeoutSeconds: original.timeoutSeconds,
      maxRetries: original.maxRetries,
      parentTaskId: execId,
      requiresApproval: original.requiresApproval,
      targetSliceSlug: original.targetSliceSlug,
      permissionMode: original.permissionMode,
      envVars: original.envVars,
    }).returning().get();
    /* v8 ignore next — `.returning().get()` on a just-inserted row is always defined in better-sqlite3 */
    if (!newTask) continue;

    repointPlanTask(execId, newTask.id);
    taskExecutor.execute(newTask.id);
    created.push({ originalTaskId: execId, newTaskId: newTask.id });
  }

  let resumed = false;
  if (resume && created.length > 0) {
    // Fire-and-forget, same shape as POST /auto-execute. The orchestrator
    // early-returns if it's already running for this milestone, so this
    // is safe to call regardless of current state.
    void startAutoExecution(pid, projectPath, mslug);
    resumed = true;
  }

  return c.json({
    rerun: created,
    count: created.length,
    resumed,
  });
});

// ─── Execution Graph ─────────────────────────────

// GET /projects/:pid/milestones/:mslug/execution-graph
planningRoutes.get("/:pid/milestones/:mslug/execution-graph", (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  const mslug = c.req.param("mslug");
  const m = getMilestone(projectPath, mslug);
  if (!m) throw new NotFoundError("Milestone");

  const slices = listSlices(projectPath, mslug);

  const rawWaves = computeWaves(slices.map(s => ({
    id: s.slug,
    depends: s.depends ?? [],
  })));

  const sliceMap = new Map(slices.map(s => [s.slug, s]));
  const waves = rawWaves.map(w => ({
    waveIndex: w.wave,
    sliceIds: w.ids,
    slices: w.ids.map(slug => sliceMap.get(slug)).filter(Boolean),
  }));

  const criticalPath = rawWaves.flatMap(w => w.ids);
  const parallelismFactor = Math.max(...rawWaves.map(w => w.ids.length), 1);

  return c.json({
    milestoneId: mslug,
    waves,
    criticalPath,
    errors: [],
    parallelismFactor,
    sliceWorkers: {},
  });
});

// ─── File Content ─────────────────────────────

/** Resolve the .md file path for a planning entity */
function resolveEntityPath(projectPath: string, entityType: string, milestoneSlug?: string, sliceSlug?: string, taskSlug?: string): string {
  const planDir = getPlanDir(projectPath);
  if (entityType === "milestone" && milestoneSlug) {
    return join(planDir, milestoneSlug, "milestone.md");
  }
  if (entityType === "slice" && milestoneSlug && sliceSlug) {
    return join(planDir, milestoneSlug, sliceSlug, "slice.md");
  }
  if (entityType === "task" && milestoneSlug && sliceSlug && taskSlug) {
    return join(planDir, milestoneSlug, sliceSlug, `${taskSlug}.md`);
  }
  throw new ValidationError("Invalid entity type or missing slugs");
}

// GET /projects/:pid/milestones/:slug/readme — read per-milestone README.md
planningRoutes.get("/:pid/milestones/:slug/readme", (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  const slug = c.req.param("slug");
  const filePath = join(getPlanDir(projectPath), slug, "README.md");
  if (!existsSync(filePath)) throw new NotFoundError("README");

  const content = readFileSync(filePath, "utf-8");
  return c.json({ content, path: filePath });
});

// GET /projects/:pid/plan-file?type=milestone&milestone=slug[&slice=slug][&task=slug]
planningRoutes.get("/:pid/plan-file", (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  const entityType = c.req.query("type") ?? "";
  const milestoneSlug = c.req.query("milestone");
  const sliceSlug = c.req.query("slice");
  const taskSlug = c.req.query("task");

  const filePath = resolveEntityPath(projectPath, entityType, milestoneSlug, sliceSlug, taskSlug);
  if (!existsSync(filePath)) throw new NotFoundError("Plan file");

  const content = readFileSync(filePath, "utf-8");
  return c.json({ content, path: filePath });
});

// PUT /projects/:pid/plan-file — update raw file content
planningRoutes.put("/:pid/plan-file", async (c) => {
  const projectPath = getProjectPath(parseIdParam(c, "pid"));
  const body = await c.req.json();
  const entityType = body.type ?? "";
  const milestoneSlug = body.milestone;
  const sliceSlug = body.slice;
  const taskSlug = body.task;
  const content = body.content;

  if (typeof content !== "string") throw new ValidationError("content is required");

  const filePath = resolveEntityPath(projectPath, entityType, milestoneSlug, sliceSlug, taskSlug);
  if (!existsSync(filePath)) throw new NotFoundError("Plan file");

  // Parse the new content as markdown with frontmatter and write it back
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fmMatch) {
    const { parse: parseYaml } = await import("yaml");
    const frontmatter = parseYaml(fmMatch[1] ?? "") ?? {};
    const body2 = (fmMatch[2] ?? "").trim();
    writeMd(filePath, frontmatter, body2);
  } else {
    // No frontmatter — write as plain body with empty frontmatter
    writeMd(filePath, {}, content.trim());
  }

  return c.json({ ok: true });
});

// POST /projects/:pid/auto-execute-all — start auto-execution for all milestones
planningRoutes.post("/:pid/auto-execute-all", async (c) => {
  const pid = parseIdParam(c, "pid");
  const projectPath = getProjectPath(pid);
  const milestones = listMilestones(projectPath);

  const started: string[] = [];
  for (const m of milestones) {
    if (m.status !== "completed") {
      startAutoExecution(pid, projectPath, m.slug);
      started.push(m.slug);
    }
  }

  return c.json({ status: "started", milestones: started });
});
