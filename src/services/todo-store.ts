/**
 * Parallel projection of Claude Code's TodoWrite tool_call events into the
 * `chat_todos` table. Each accepted call lands as an immutable snapshot row;
 * duplicates (identical todos array) are deduped in-process against the
 * latest snapshot for the chat.
 *
 * This is NOT a replacement for chat_messages — the raw tool_call is already
 * persisted there by chat-executor. The chat_todos row is a queryable
 * projection that lets the UI render a progress bar without re-parsing every
 * tool-call message.
 *
 * Kept as a pure module adjacent to `tool-format.ts`: tasks and chats both
 * call it from their existing tool_call handlers.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { chatTodos } from "../db/schema.js";
import { wsManager } from "./ws-manager.js";

/** Upper bound on a single snapshot. A runaway agent returning thousands of
 *  todos would bloat the table without helping the UI; we drop the snapshot
 *  with a warning rather than truncate (truncation would change semantics). */
const MAX_TODOS = 100;

export type TodoStatus = "pending" | "in_progress" | "completed";

/** The normalized shape stored in `todos_json`. `activeForm` mirrors the
 *  TodoWrite schema; we keep it optional for forward-compat with older
 *  snapshots that didn't include it. `priority` is accepted as a synonym
 *  for backward-compat with any callers that used it. */
export interface Todo {
  content: string;
  status: TodoStatus;
  activeForm?: string;
  priority?: string;
}

export interface TodoCounts {
  total: number;
  completed: number;
  in_progress: number;
  pending: number;
}

export interface RecordTodoWriteOpts {
  /** Required — chat_todos.chat_id is NOT NULL. Tasks without a backing chat
   *  should simply not call this helper. */
  chatId: number;
  /** Optional — set when the snapshot is produced by a task-scoped session. */
  taskId?: number | null;
  /**
   * Optional — `parent_tool_use_id` from the SDK's tool_use block. NULL (or
   * omitted) means the snapshot belongs to the main agent the user is
   * conversing with. A `toolu_…` id means it belongs to a sub-agent
   * spawned via the Claude Agent SDK's `Task` tool — the value points back
   * to the spawning Task tool_use so the UI can join to `chat_messages` to
   * recover the sub-agent's description for the per-agent tab label.
   *
   * Dedup is keyed per (chatId, parentToolUseId): two agents emitting the
   * same todos array both land as separate rows. Without this scoping a
   * sub-agent's identical `[step]` plan would silently mask the main
   * agent's, collapsing distinct timelines into one.
   */
  parentToolUseId?: string | null;
  /** Raw `input` from the tool_call event. May be an object or a JSON string. */
  input: unknown;
}

export interface RecordTodoWriteResult {
  rowId: number;
  counts: TodoCounts;
}

/** Pure helper — exposed so the HTTP layer (slice 01 API) can compute counts
 *  from a todos array without re-parsing tool-call events. */
export function computeCounts(todos: Todo[]): TodoCounts {
  let completed = 0;
  let inProgress = 0;
  let pending = 0;
  for (const t of todos) {
    if (t.status === "completed") completed++;
    else if (t.status === "in_progress") inProgress++;
    else pending++;
  }
  return { total: todos.length, completed, in_progress: inProgress, pending };
}

/** Parse the raw tool_call input into an object form. Returns null when the
 *  shape is irrecoverable (neither object nor JSON-parseable string). */
function parseRawInput(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

/** Normalize the TodoWrite input to a validated Todo[]. Returns null on any
 *  shape violation so the caller can skip without crashing the agent. */
function normalize(rawInput: unknown): Todo[] | null {
  const parsed = parseRawInput(rawInput);
  if (!parsed) return null;
  const raw = (parsed as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) return null;

  const out: Todo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    const content = e.content;
    const status = e.status;
    if (typeof content !== "string" || typeof status !== "string") return null;
    const todo: Todo = { content, status: status as TodoStatus };
    if (typeof e.activeForm === "string") todo.activeForm = e.activeForm;
    if (typeof e.priority === "string") todo.priority = e.priority;
    out.push(todo);
  }
  return out;
}

/**
 * Record a TodoWrite snapshot for a chat. Behavior:
 *
 *  - Invalid shapes (no `todos` array, non-string `status`, non-object entry)
 *    are logged via `console.warn` and silently skipped — the agent session
 *    MUST NOT crash on a malformed snapshot.
 *  - Oversize inputs (> MAX_TODOS entries) are rejected with a single warning.
 *  - When the serialized array equals the latest snapshot for the same chat,
 *    no row is inserted (dedup).
 *  - Otherwise inserts one row and returns its id + pre-computed counts.
 */
export function recordTodoWrite(opts: RecordTodoWriteOpts): RecordTodoWriteResult | null {
  const todos = normalize(opts.input);
  if (!todos) {
    console.warn(`[todo-store] Skipping malformed TodoWrite snapshot for chat ${opts.chatId}`);
    return null;
  }
  if (todos.length > MAX_TODOS) {
    console.warn(
      `[todo-store] Rejecting oversize TodoWrite snapshot (${todos.length} > ${MAX_TODOS}) for chat ${opts.chatId}`,
    );
    return null;
  }

  const db = getDb();
  const serialized = JSON.stringify(todos);
  const parentToolUseId = opts.parentToolUseId ?? null;

  // Dedup against the latest snapshot for THIS agent within the chat. We
  // scope by (chatId, parentToolUseId) — without that scope a sub-agent's
  // identical `[step]` plan would silently dedup against the main agent's
  // and the sub-agent's timeline would lose its first snapshot. `id DESC`
  // as a tiebreaker handles the edge case of two inserts within the same
  // `datetime('now')` second.
  const latest = db
    .select({ todosJson: chatTodos.todosJson })
    .from(chatTodos)
    .where(and(
      eq(chatTodos.chatId, opts.chatId),
      parentToolUseId === null
        ? isNull(chatTodos.parentToolUseId)
        : eq(chatTodos.parentToolUseId, parentToolUseId),
    ))
    .orderBy(desc(chatTodos.createdAt), desc(chatTodos.id))
    .limit(1)
    .get();

  if (latest?.todosJson === serialized) return null;

  try {
    const inserted = db
      .insert(chatTodos)
      .values({
        chatId: opts.chatId,
        taskId: opts.taskId ?? null,
        parentToolUseId,
        todosJson: serialized,
      })
      .returning()
      .get();
    const counts = computeCounts(todos);

    // Broadcast only after a successful insert. The dedup branch above
    // returns early, so identical snapshots never reach this point — no WS
    // storm when an agent re-sends the same todos list unchanged.
    // Envelope mirrors the rest of chat-executor's events:
    //   { type, payload: { chat_id, ... } } with String()-ified ids.
    //
    // `parent_tool_use_id` rides along on the broadcast so the UI can
    // attribute the live update to the right per-agent tab without a
    // refetch — `null` means main agent, a `toolu_…` id means a specific
    // sub-agent (matches the same field on /chats/:id/todos/agents).
    wsManager.broadcastChat(opts.chatId, {
      type: "todo_updated",
      payload: {
        chat_id: String(opts.chatId),
        task_id: opts.taskId != null ? String(opts.taskId) : null,
        parent_tool_use_id: parentToolUseId,
        counts,
        snapshot_id: inserted.id,
      },
    });

    return { rowId: inserted.id, counts };
  } catch (err) {
    // FK violation (unknown chat/task) or any other DB error — log and skip
    // rather than propagate into the agent loop.
    console.warn(
      `[todo-store] Failed to insert snapshot for chat ${opts.chatId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
