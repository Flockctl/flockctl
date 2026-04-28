import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { agentQuestions, chats, tasks } from "../../db/schema.js";
import { TaskStatus, validateTaskTransition } from "../../lib/types.js";
import { emitAttentionChanged } from "../attention.js";
import {
  broadcastAgentQuestion,
  broadcastAgentQuestionResolved,
  persistAgentQuestion,
} from "../agent-interaction.js";
import type { QuestionRequest } from "../agent-session/index.js";
import { wsManager } from "../ws-manager.js";

type AgentQuestionRow = typeof agentQuestions.$inferSelect;

/**
 * Look up a pending agent_questions row for a given (taskId, requestId) pair.
 * Returns null when the row is missing or already resolved — callers can
 * treat that as "the UI raced us".
 */
export function findPendingQuestionRow(taskId: number, requestId: string): AgentQuestionRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(agentQuestions)
    .where(and(eq(agentQuestions.requestId, requestId), eq(agentQuestions.taskId, taskId)))
    .get();
  if (!row || row.status !== "pending") return null;
  return row;
}

/**
 * Persist an agent-emitted question, flip the task to `waiting_for_input`,
 * and broadcast the block to every WS client. Idempotent on `request_id`
 * so the same emitter ID re-entering (e.g. session replay) cannot create
 * duplicate rows. When the transition is rejected (task already terminal,
 * e.g. cancelled mid-emit) the row is still inserted so the event isn't
 * silently dropped, but the status is left untouched.
 *
 * Returns the inserted row id so the caller can append a log line with the
 * proper context (logging stays on the executor so `appendLog` is private).
 */
export function handleQuestionEmitted(taskId: number, request: QuestionRequest): number | null {
  const db = getDb();
  const taskRef = { kind: "task", id: taskId } as const;
  const insertedId = persistAgentQuestion(taskRef, request);

  const current = db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).get();
  if (current && validateTaskTransition(current.status ?? "", TaskStatus.WAITING_FOR_INPUT)) {
    db.update(tasks)
      .set({ status: TaskStatus.WAITING_FOR_INPUT, updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, taskId))
      .run();
    wsManager.broadcastTaskStatus(taskId, TaskStatus.WAITING_FOR_INPUT);
  }

  const backingChat = db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.entityType, "task"), eq(chats.entityId, String(taskId))))
    .get();
  // Task-channel broadcast carries `chat_id` (nullable) so UI clients
  // subscribed to the task can deep-link into the backing chat if any.
  broadcastAgentQuestion(taskRef, request, insertedId, {
    chat_id: backingChat?.id != null ? String(backingChat.id) : null,
  });
  // Mirror to the backing chat's channel so clients subscribed to the
  // chat see the question too — same payload, `task_id` as the extra.
  if (backingChat?.id != null) {
    broadcastAgentQuestion(
      { kind: "chat", id: backingChat.id },
      request,
      insertedId,
      { task_id: String(taskId) },
    );
  }
  // Surface the waiting task as a new blocker in /attention without
  // waiting for the next poll.
  emitAttentionChanged(wsManager);

  return insertedId;
}

/**
 * Hot-path question resolution: the agent session is still in memory and
 * has already accepted the answer. Persists the answer, flips the task
 * back to `running`, and broadcasts the resolution on both the task and
 * backing-chat channels.
 */
export function resolveQuestionHot(taskId: number, row: AgentQuestionRow, requestId: string, answer: string): void {
  const db = getDb();
  db.update(agentQuestions)
    .set({ answer, status: "answered", answeredAt: new Date().toISOString() })
    .where(eq(agentQuestions.id, row.id))
    .run();

  // Flip back to running — the session has resumed and the agentic loop
  // is already past the await. The DB transition keeps the UI in sync.
  const current = db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).get();
  if (current && validateTaskTransition(current.status ?? "", TaskStatus.RUNNING)) {
    db.update(tasks)
      .set({ status: TaskStatus.RUNNING, updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, taskId))
      .run();
    wsManager.broadcastTaskStatus(taskId, TaskStatus.RUNNING);
  }

  const taskRef = { kind: "task", id: taskId } as const;
  broadcastAgentQuestionResolved(taskRef, requestId, answer);
  const backingChat = db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.entityType, "task"), eq(chats.entityId, String(taskId))))
    .get();
  if (backingChat?.id != null) {
    broadcastAgentQuestionResolved(
      { kind: "chat", id: backingChat.id },
      requestId,
      answer,
      { task_id: String(taskId) },
    );
  }

  emitAttentionChanged(wsManager);
}

/**
 * Cold-path question resolution: the daemon restarted after the question
 * was emitted. The in-memory session is gone, so we persist the answer,
 * flip the task back to QUEUED, and let the caller re-kick `execute(taskId)`
 * which will resume via `claudeSessionId`. Returns false when the task is
 * not actually parked in `waiting_for_input`.
 */
export function resolveQuestionCold(taskId: number, row: AgentQuestionRow, requestId: string, answer: string): boolean {
  const db = getDb();
  const current = db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).get();
  if (!current || current.status !== TaskStatus.WAITING_FOR_INPUT) return false;

  db.update(agentQuestions)
    .set({ answer, status: "answered", answeredAt: new Date().toISOString() })
    .where(eq(agentQuestions.id, row.id))
    .run();
  db.update(tasks)
    .set({ status: TaskStatus.QUEUED, updatedAt: new Date().toISOString() })
    .where(eq(tasks.id, taskId))
    .run();
  wsManager.broadcastTaskStatus(taskId, TaskStatus.QUEUED);
  const taskRef = { kind: "task", id: taskId } as const;
  broadcastAgentQuestionResolved(taskRef, requestId, answer);
  const backingChat = db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.entityType, "task"), eq(chats.entityId, String(taskId))))
    .get();
  if (backingChat?.id != null) {
    broadcastAgentQuestionResolved(
      { kind: "chat", id: backingChat.id },
      requestId,
      answer,
      { task_id: String(taskId) },
    );
  }
  emitAttentionChanged(wsManager);
  return true;
}

/**
 * Fetch pending questions for a task ordered oldest-first.
 *
 * Symmetric with `chat-executor.ts:pendingQuestions` — surfaces the
 * structured `options` / `multiSelect` / `header` columns alongside the
 * question text so the task page can render the same single/multi-select
 * picker the inbox renders. Without these fields the UI falls back to a
 * text-only input even when the underlying `agent_questions` row has
 * options (the bug surfaced when QA noticed the task page showed only
 * "Type your answer…" while `/attention` rendered the radio group for
 * the same question).
 *
 * `options` is parsed from the JSON-encoded text column. Malformed JSON
 * collapses to `null` so a corrupt row never blocks page hydration —
 * matches the forgiving rule used by both the chat path and
 * `broadcastAgentQuestionFromRow` in `agent-interaction.ts`.
 */
export function listPendingQuestions(taskId: number): Array<{
  id: number;
  requestId: string;
  question: string;
  toolUseId: string;
  createdAt: string | null;
  options: Array<{ label: string; description?: string; preview?: string }> | null;
  multiSelect: boolean;
  header: string | null;
}> {
  const db = getDb();
  const rows = db
    .select()
    .from(agentQuestions)
    .where(and(eq(agentQuestions.taskId, taskId), eq(agentQuestions.status, "pending")))
    .all();
  /* v8 ignore start — createdAt has a DB default so r.createdAt is always
     a populated string in practice; the `?? null` fallbacks are TS
     null-safety glue that no test path exercises. */
  return rows
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
    .map((r) => {
      let parsedOptions:
        | Array<{ label: string; description?: string; preview?: string }>
        | null = null;
      if (r.options != null) {
        try {
          const parsed = JSON.parse(r.options);
          if (Array.isArray(parsed) && parsed.length > 0) {
            parsedOptions = parsed;
          }
        } catch {
          parsedOptions = null;
        }
      }
      return {
        id: r.id,
        requestId: r.requestId,
        question: r.question,
        toolUseId: r.toolUseId,
        createdAt: r.createdAt ?? null,
        options: parsedOptions,
        multiSelect: Boolean(r.multiSelect),
        header: r.header ?? null,
      };
    });
  /* v8 ignore stop */
}
