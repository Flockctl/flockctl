import type { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../../db/index.js";
import { chats, agentQuestions } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { AppError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { parseIdParam } from "../../lib/route-params.js";
import { chatExecutor } from "../../services/chat-executor.js";
import { getChatOrThrow } from "../../lib/db-helpers.js";

// ─── Question /answer endpoints (slice 02 HTTP surface) ────────────────────
// Mirrors the task route of the same name. 404 means the requestId is
// unknown or belongs to another chat; 409 means the row was already
// answered/cancelled; oversize body → 400.
export const chatQuestionIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});
export const chatQuestionAnswerParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  requestId: z.string().min(1).max(200),
});
export const chatQuestionAnswerBodySchema = z.object({
  answer: z.string().min(1).max(8000),
});

export function registerChatQuestions(router: Hono): void {
  // GET /chats/:id/pending-questions — open agent_questions rows awaiting a user
  // answer for this chat. DB-backed so it survives daemon restarts: the chat has
  // no `waiting_for_input` status column — the derived flag is EXISTS(pending
  // agent_question), and the UI uses this endpoint to re-hydrate the question
  // card on page reload.
  router.get("/:id/pending-questions", (c) => {
    const id = parseIdParam(c);
    getChatOrThrow(id);
    return c.json({ items: chatExecutor.pendingQuestions(id) });
  });

  // POST /chats/:id/question/:requestId — answer an open agent clarification
  // question emitted via the AskUserQuestion tool. Requires the chat session to
  // be in-memory (the answer is relayed to the in-flight AgentSession).
  router.post("/:id/question/:requestId", async (c) => {
    const id = parseIdParam(c);
    const requestId = c.req.param("requestId");
    const body = await c.req.json().catch(() => ({}));
    const answer = body.answer;

    if (typeof answer !== "string" || answer.trim().length === 0) {
      throw new ValidationError("answer must be a non-empty string");
    }
    if (answer.length > 10_000) {
      throw new ValidationError("answer must be at most 10000 characters");
    }

    getChatOrThrow(id);

    if (!chatExecutor.isRunning(id)) {
      throw new ValidationError("Chat session is not running");
    }

    const ok = chatExecutor.answerQuestion(id, requestId, answer);
    if (!ok) {
      throw new NotFoundError("Agent question");
    }

    return c.json({ ok: true });
  });

  // GET /chats/:id/questions — list pending agent questions for the chat.
  router.get("/:id/questions", (c) => {
    const params = chatQuestionIdParamsSchema.safeParse({ id: c.req.param("id") });
    if (!params.success) throw new AppError(400, "invalid chat id");
    const id = params.data.id;

    getChatOrThrow(id);

    return c.json({ items: chatExecutor.pendingQuestions(id) });
  });

  // POST /chats/:id/question/:requestId/answer — resolve a pending agent
  // question raised inside this chat. Look-up-before-delegate so we can
  // distinguish 404 (unknown / wrong chat) from 409 (already answered).
  router.post("/:id/question/:requestId/answer", async (c) => {
    const params = chatQuestionAnswerParamsSchema.safeParse({
      id: c.req.param("id"),
      requestId: c.req.param("requestId"),
    });
    if (!params.success) throw new AppError(400, "invalid path parameters");
    const { id, requestId } = params.data;

    const rawBody = await c.req.json().catch(() => ({}));
    const body = chatQuestionAnswerBodySchema.safeParse(rawBody);
    if (!body.success) {
      const details: Record<string, string[]> = {};
      for (const issue of body.error.issues) {
        const key = issue.path.length > 0 ? String(issue.path[0]) : "_";
        (details[key] ||= []).push(issue.message);
      }
      throw new AppError(400, "invalid request body", details);
    }

    const db = getDb();
    getChatOrThrow(id);

    const row = db.select().from(agentQuestions).where(eq(agentQuestions.requestId, requestId)).get();
    if (!row || row.chatId !== id) throw new NotFoundError("Agent question");
    if (row.status !== "pending") {
      throw new AppError(409, "Agent question already resolved");
    }

    const ok = chatExecutor.answerQuestion(id, requestId, body.data.answer);
    if (!ok) {
      const recheck = db.select().from(agentQuestions).where(eq(agentQuestions.requestId, requestId)).get();
      if (!recheck) throw new NotFoundError("Agent question");
      throw new AppError(409, "Agent question already resolved");
    }

    // Symmetric with the task variant's `taskStatus`: chats have no `.status`
    // column (the closest field is `approval_status`), so we surface that so
    // the UI can update without waiting for the WS broadcast.
    const updated = db.select({ approvalStatus: chats.approvalStatus }).from(chats).where(eq(chats.id, id)).get();
    return c.json({ ok: true, chatStatus: updated?.approvalStatus ?? null });
  });
}
