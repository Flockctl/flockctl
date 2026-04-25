import type { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../../db/index.js";
import { tasks, agentQuestions } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { AppError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { parseIdParam } from "../../lib/route-params.js";
import { taskExecutor } from "../../services/task-executor/index.js";

export function registerTaskPendingPermissions(router: Hono): void {
  // GET /tasks/:id/pending-permissions — full pending permission requests for a
  // running task. Used by the task detail UI to re-hydrate the permission card
  // after a page reload (WS events are not replayed on reconnect).
  router.get("/:id/pending-permissions", (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!task) throw new NotFoundError("Task");

    const requests = taskExecutor.pendingPermissions(id).map((r) => ({
      request_id: r.requestId,
      tool_name: r.toolName,
      tool_input: r.toolInput,
      title: r.title ?? null,
      display_name: r.displayName ?? null,
      description: r.description ?? null,
      decision_reason: r.decisionReason ?? null,
      tool_use_id: r.toolUseID,
    }));
    return c.json({ items: requests });
  });
}

export function registerTaskQuestions(router: Hono): void {
  // GET /tasks/:id/pending-questions — open agent_questions rows awaiting a
  // user answer. Unlike pending-permissions (which reads from the in-memory
  // session), this is DB-backed so the UI can re-hydrate after a daemon
  // restart too — a task parked in `waiting_for_input` must stay answerable
  // across process boundaries.
  router.get("/:id/pending-questions", (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!task) throw new NotFoundError("Task");
    return c.json({ items: taskExecutor.pendingQuestions(id) });
  });

  // POST /tasks/:id/question/:requestId — answer an open agent question.
  // Hot path (session in memory) resolves inline and flips the task back to
  // running. Cold path (post-restart) marks the row answered and re-queues
  // the task, letting the resumeSessionId flow continue the Claude Code
  // session where it left off.
  router.post("/:id/question/:requestId", async (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const requestId = c.req.param("requestId");
    const body = await c.req.json().catch(() => ({}));
    const answer = body.answer;

    if (typeof answer !== "string" || answer.length === 0) {
      throw new ValidationError("answer must be a non-empty string");
    }
    if (answer.length > 10_000) {
      throw new ValidationError("answer must be ≤ 10000 characters");
    }

    const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!task) throw new NotFoundError("Task");

    const ok = taskExecutor.answerQuestion(id, requestId, answer);
    if (!ok) throw new NotFoundError("Agent question");

    return c.json({ ok: true });
  });

  // ─── Question /answer endpoints (slice 02 HTTP surface) ────────────────────
  // Mirrors the shape of the permission handler above: validate → check state
  // → call executor → return { ok: true, ... }. Only difference is the answer
  // endpoint distinguishes "unknown / wrong-task" (404) from "already answered"
  // (409) so the UI can tell a real stale request apart from a cross-user race.
  const questionIdParamsSchema = z.object({
    id: z.coerce.number().int().positive(),
  });
  const questionAnswerParamsSchema = z.object({
    id: z.coerce.number().int().positive(),
    requestId: z.string().min(1).max(200),
  });
  const questionAnswerBodySchema = z.object({
    answer: z.string().min(1).max(8000),
  });

  // GET /tasks/:id/questions — list pending agent questions for the task.
  // Usually 0 or 1 entries; the UI uses this to re-hydrate the question card
  // after a page reload. DB-backed so it survives daemon restarts.
  router.get("/:id/questions", (c) => {
    const params = questionIdParamsSchema.safeParse({ id: c.req.param("id") });
    if (!params.success) throw new AppError(400, "invalid task id");
    const id = params.data.id;

    const db = getDb();
    const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!task) throw new NotFoundError("Task");

    return c.json({ items: taskExecutor.pendingQuestions(id) });
  });

  // POST /tasks/:id/question/:requestId/answer — answer a pending agent
  // question. Zod-validates id + requestId + body; 404 if the row is unknown
  // or belongs to another task; 409 if the row was already answered (or
  // cancelled); otherwise delegates to taskExecutor.answerQuestion which
  // persists the answer, relays it to the in-flight session, and flips the
  // task back to `running`. Response echoes the post-answer task status so
  // the UI can update without waiting for the WS broadcast.
  router.post("/:id/question/:requestId/answer", async (c) => {
    const params = questionAnswerParamsSchema.safeParse({
      id: c.req.param("id"),
      requestId: c.req.param("requestId"),
    });
    if (!params.success) throw new AppError(400, "invalid path parameters");
    const { id, requestId } = params.data;

    const rawBody = await c.req.json().catch(() => ({}));
    const body = questionAnswerBodySchema.safeParse(rawBody);
    if (!body.success) {
      const details: Record<string, string[]> = {};
      for (const issue of body.error.issues) {
        const key = issue.path.length > 0 ? String(issue.path[0]) : "_";
        (details[key] ||= []).push(issue.message);
      }
      throw new AppError(400, "invalid request body", details);
    }

    const db = getDb();
    const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!task) throw new NotFoundError("Task");

    // Look up the question by requestId alone so we can tell "unknown" apart
    // from "wrong task" apart from "already answered". Both of the first two
    // map to 404; a non-pending row maps to 409.
    const row = db.select().from(agentQuestions).where(eq(agentQuestions.requestId, requestId)).get();
    if (!row || row.taskId !== id) throw new NotFoundError("Agent question");
    if (row.status !== "pending") {
      throw new AppError(409, "Agent question already resolved");
    }

    const ok = taskExecutor.answerQuestion(id, requestId, body.data.answer);
    if (!ok) {
      // Race: the row was pending a moment ago but got resolved concurrently.
      // Re-read to decide 404 vs 409 rather than guessing.
      const recheck = db.select().from(agentQuestions).where(eq(agentQuestions.requestId, requestId)).get();
      if (!recheck) throw new NotFoundError("Agent question");
      throw new AppError(409, "Agent question already resolved");
    }

    const updated = db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, id)).get();
    return c.json({ ok: true, taskStatus: updated?.status ?? null });
  });
}

export function registerTaskPermissionResolve(router: Hono): void {
  // POST /tasks/:id/permission/:requestId — respond to a tool permission request
  router.post("/:id/permission/:requestId", async (c) => {
    const id = parseIdParam(c);
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

    // Note: `attention_changed` is emitted by AgentSession.resolvePermission
    // (called transitively via taskExecutor.resolvePermission). The route must
    // NOT re-emit — the one-broadcast-per-transition invariant is enforced by
    // attention-broadcast.test.ts.
    return c.json({ ok: true });
  });
}
