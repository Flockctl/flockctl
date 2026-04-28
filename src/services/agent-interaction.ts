import type {
  PermissionRequest,
  QuestionRequest,
  QuestionOption,
} from "./agent-session/index.js";
import { getDb } from "../db/index.js";
import { agentQuestions } from "../db/schema.js";
import { wsManager } from "./ws-manager.js";

/**
 * Shared cross-entity helpers for task and chat `AgentSession` events.
 *
 * Both `TaskExecutor` and `ChatExecutor` subscribe to the same four session
 * events (`permission_request`, `question_request`, `tool_call`, `tool_result`)
 * and have historically duplicated the WS-broadcast + DB-persistence logic
 * with only the id-field name (`task_id` vs `chat_id`) and the WS channel
 * (`broadcast` vs `broadcastChat`) swapped. This module collapses both paths
 * behind a single `AgentRef` discriminator so payload shapes, column choices
 * on `agent_questions`, and event names can never drift apart.
 *
 * Executor-specific side effects (task log rows, task status transitions,
 * backing-chat forwarding, todo snapshot projection) stay inline in the
 * executors — they're genuinely different between entities.
 */

/**
 * Points at either a task or a chat. Used to pick the WS channel, the
 * `agent_questions.taskId`/`chatId` column, and the `task_id`/`chat_id`
 * field embedded in broadcast payloads.
 */
export type AgentRef = { kind: "task"; id: number } | { kind: "chat"; id: number };

/** Emit `data` on the WS channel that belongs to `ref`. */
function broadcastOnChannel(ref: AgentRef, data: Record<string, unknown>): void {
  if (ref.kind === "task") wsManager.broadcast(ref.id, data);
  else wsManager.broadcastChat(ref.id, data);
}

/**
 * The primary id field for payloads — `{ task_id }` for tasks,
 * `{ chat_id }` for chats. Callers that also need to include the *other*
 * entity's id (e.g. a task whose backing chat should be surfaced in the
 * broadcast) pass it via the `extraPayload` argument on the broadcasters.
 */
function primaryIdField(ref: AgentRef): { task_id: string } | { chat_id: string } {
  return ref.kind === "task" ? { task_id: String(ref.id) } : { chat_id: String(ref.id) };
}

/**
 * Broadcast a `permission_request` WS event with the canonical payload.
 * Shape is identical across tasks and chats; only the channel + id field
 * differ and both are driven by `ref`.
 */
export function broadcastPermissionRequest(
  ref: AgentRef,
  request: PermissionRequest,
  extraPayload: Record<string, unknown> = {},
): void {
  broadcastOnChannel(ref, {
    type: "permission_request",
    payload: {
      ...primaryIdField(ref),
      request_id: request.requestId,
      tool_name: request.toolName,
      tool_input: request.toolInput,
      title: request.title ?? null,
      display_name: request.displayName ?? null,
      description: request.description ?? null,
      decision_reason: request.decisionReason ?? null,
      tool_use_id: request.toolUseID,
      ...extraPayload,
    },
  });
}

/**
 * Broadcast a `permission_resolved` WS event after the UI responds.
 * `attention_changed` is emitted separately by `AgentSession.resolvePermission`
 * — do NOT re-emit it here (single-emit invariant, see attention.ts docs).
 */
export function broadcastPermissionResolved(
  ref: AgentRef,
  requestId: string,
  behavior: "allow" | "deny",
): void {
  broadcastOnChannel(ref, {
    type: "permission_resolved",
    payload: {
      ...primaryIdField(ref),
      request_id: requestId,
      behavior,
    },
  });
}

/**
 * Persist a pending agent question into `agent_questions`. Returns the
 * inserted row's id, or `null` when the INSERT collided on the UNIQUE
 * `request_id` index (treated as an idempotent replay — the row already
 * exists). Any other error is logged; callers should treat `null` as
 * "no new row created" and proceed — the session still owns the truth.
 */
export function persistAgentQuestion(ref: AgentRef, request: QuestionRequest): number | null {
  const db = getDb();
  try {
    // Drizzle goes through better-sqlite3 prepared statements, so the
    // JSON-serialised options string and other text fields are bound as
    // parameters — never interpolated. SQL injection cannot escape this
    // path even when an option label embeds `'); DROP TABLE--`.
    const row = db
      .insert(agentQuestions)
      .values({
        requestId: request.requestId,
        ...(ref.kind === "task" ? { taskId: ref.id } : { chatId: ref.id }),
        toolUseId: request.toolUseID,
        question: request.question,
        // Empty/absent options collapse to NULL so existing readers that
        // treat NULL as "free-form" (the original 0029 shape) keep working.
        options: request.options && request.options.length > 0
          ? JSON.stringify(request.options)
          : null,
        multiSelect: request.multiSelect ?? false,
        header: request.header ?? null,
        status: "pending",
      })
      .returning({ id: agentQuestions.id })
      .get();
    return row?.id ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/UNIQUE constraint failed|request_id/i.test(msg)) {
      console.error(
        `[agent-interaction] failed to persist question for ${ref.kind} ${ref.id}:`,
        err,
      );
    }
    return null;
  }
}

/**
 * Broadcast an `agent_question` WS event. `extraPayload` lets a task that
 * has a backing chat include `chat_id`, or vice-versa — the helper only
 * guarantees the primary id and standard fields.
 */
export function broadcastAgentQuestion(
  ref: AgentRef,
  request: QuestionRequest,
  dbId: number | null,
  extraPayload: Record<string, unknown> = {},
): void {
  broadcastOnChannel(ref, {
    type: "agent_question",
    payload: {
      ...primaryIdField(ref),
      request_id: request.requestId,
      question: request.question,
      tool_use_id: request.toolUseID,
      db_id: dbId,
      // Additive structured fields (M05 multi-choice). `options` is omitted
      // entirely from the payload when absent so legacy free-form callers
      // and free-form rows keep producing exactly the same shape they did
      // before — clients that don't yet read these keys observe no diff.
      ...(request.options && request.options.length > 0
        ? { options: request.options }
        : {}),
      multi_select: request.multiSelect ?? false,
      ...(request.header ? { header: request.header } : {}),
      ...extraPayload,
    },
  });
}

/**
 * Re-broadcast an `agent_question` WS event from a persisted row. Used by
 * the resume path: when a WS client subscribes after a daemon restart, the
 * pending `agent_questions` rows are re-emitted so the UI sees the same
 * enriched payload it would have on the first push, without the in-memory
 * session having to be alive. Safely tolerates malformed `options` JSON
 * (treats it as free-form so the resume never crashes the WS pipeline).
 */
export function broadcastAgentQuestionFromRow(
  ref: AgentRef,
  row: {
    id: number;
    requestId: string;
    question: string;
    toolUseId: string;
    options: string | null;
    multiSelect: boolean;
    header: string | null;
  },
  extraPayload: Record<string, unknown> = {},
): void {
  let options: QuestionOption[] | null = null;
  if (row.options != null) {
    try {
      const parsed = JSON.parse(row.options);
      if (Array.isArray(parsed)) options = parsed as QuestionOption[];
    } catch {
      // Malformed JSON in the DB row is non-fatal: drop to free-form.
      options = null;
    }
  }
  broadcastOnChannel(ref, {
    type: "agent_question",
    payload: {
      ...primaryIdField(ref),
      request_id: row.requestId,
      question: row.question,
      tool_use_id: row.toolUseId,
      db_id: row.id,
      ...(options && options.length > 0 ? { options } : {}),
      multi_select: row.multiSelect ?? false,
      ...(row.header ? { header: row.header } : {}),
      ...extraPayload,
    },
  });
}

/**
 * Broadcast an `agent_question_resolved` WS event after the UI answers.
 * `attention_changed` is emitted by the executor's `answerQuestion` — keep
 * the single-emit invariant, do not re-emit from this helper.
 */
export function broadcastAgentQuestionResolved(
  ref: AgentRef,
  requestId: string,
  answer: string,
  extraPayload: Record<string, unknown> = {},
): void {
  broadcastOnChannel(ref, {
    type: "agent_question_resolved",
    payload: {
      ...primaryIdField(ref),
      request_id: requestId,
      answer,
      ...extraPayload,
    },
  });
}
