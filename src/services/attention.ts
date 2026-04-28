import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { FlockctlDb } from "../db/index.js";
import { tasks, chats, agentQuestions } from "../db/schema.js";
import type { AgentSession } from "./agent-session/index.js";
import type { QuestionOption } from "./agent-session/index.js";
import { TaskStatus } from "../lib/types.js";

/**
 * A single blocker the user must act on. One of:
 *  - `task_approval`: a task is halted in `pending_approval` status awaiting
 *    a diff/result approval.
 *  - `chat_approval`: a chat is halted after a turn with `approvalStatus =
 *    'pending'` awaiting the user's approve/reject (symmetric with
 *    `task_approval` — opt-in via `chats.requiresApproval`).
 *  - `task_permission`: a running task session is waiting on a per-tool
 *    permission grant.
 *  - `chat_permission`: an active chat session is waiting on a per-tool
 *    permission grant.
 *  - `task_question`: a running task is blocked on an `agent_questions` row
 *    awaiting the user's answer (free-form prompt or AskUserQuestion-style
 *    multiple-choice picker).
 *  - `chat_question`: same as `task_question` but emitted from a chat session.
 *
 * Raw tool-call arguments are intentionally NOT included — only the tool name
 * is surfaced, since arguments can contain secrets.
 *
 * Casing: every field is camelCase on the wire. The DB stores `multi_select`
 * / `created_at` (snake), but the route serializer maps to camel before
 * responding so `task_permission` and the new `*_question` rows share one
 * convention.
 */
export type AttentionItem =
  | {
      kind: "task_approval";
      taskId: number;
      projectId: number;
      title: string;
      since: string;
    }
  | {
      kind: "chat_approval";
      chatId: number;
      projectId: number | null;
      title: string;
      since: string;
    }
  | {
      kind: "task_permission";
      taskId: number;
      projectId: number;
      requestId: string;
      tool: string;
      since: string;
    }
  | {
      kind: "chat_permission";
      chatId: number;
      projectId: number | null;
      requestId: string;
      tool: string;
      since: string;
    }
  | {
      kind: "task_question";
      requestId: string;
      taskId: number;
      projectId: number;
      question: string;
      // Short chip label (≤ 12 chars per Claude harness convention) rendered
      // above the option list. Omitted entirely when absent — free-form
      // prompts have no header.
      header?: string;
      // Multiple-choice options, when the question came from AskUserQuestion.
      // Omitted entirely (not null/empty) for free-form prompts; the frontend
      // treats absence as "no picker — render a text input".
      options?: Array<{ label: string; description?: string; preview?: string }>;
      multiSelect: boolean;
      // ISO timestamp from `agent_questions.created_at`. The aggregator orders
      // questions oldest-first per M05's "answer the oldest first" rule.
      createdAt: string;
    }
  | {
      kind: "chat_question";
      requestId: string;
      chatId: number;
      // Chats may be unattached to a project (workspace-level), mirroring
      // `chat_approval` / `chat_permission`.
      projectId: number | null;
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string; preview?: string }>;
      multiSelect: boolean;
      createdAt: string;
    };

/**
 * Iterable of `[id, session]` pairs. Matches the shape produced by the
 * internal `Map<number, AgentSession>` inside TaskExecutor/ChatExecutor,
 * but is defined abstractly here so the aggregator can be unit-tested
 * with in-memory fakes.
 */
export interface AttentionSessionRegistry {
  activeTaskSessions(): Iterable<[taskId: number, session: AgentSession]>;
  activeChatSessions(): Iterable<[chatId: number, session: AgentSession]>;
}

/**
 * Aggregate every blocker currently awaiting user action into a single,
 * recency-sorted list.
 *
 * Sources (no DB writes, no caching — the registry is in-process and the
 * DB queries hit indexed columns):
 *  1. `tasks` rows with `status = 'pending_approval'`
 *  2. `chats` rows with `requiresApproval=1 AND approvalStatus = 'pending'`
 *  3. Pending permission requests on every active task AgentSession
 *  4. Pending permission requests on every active chat AgentSession
 *  5. `agent_questions` rows with `task_id IS NOT NULL AND status='pending'`
 *  6. `agent_questions` rows with `chat_id IS NOT NULL AND status='pending'`
 *
 * Sections 5/6 are DB-only (no in-memory dependency) so they survive a
 * daemon restart — a question persisted before the crash continues to surface
 * once the process comes back up.
 *
 * Results are sorted by `since` (or `createdAt` for question kinds, see
 * `attentionItemTimestamp`) descending so the UI can render "what just
 * started blocking me" at the top without further sorting.
 */
export function collectAttentionItems(
  db: FlockctlDb,
  registry: AttentionSessionRegistry,
): AttentionItem[] {
  const items: AttentionItem[] = [];

  // 1. Tasks halted in pending_approval.
  const pendingApprovalRows = db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      label: tasks.label,
      prompt: tasks.prompt,
      updatedAt: tasks.updatedAt,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(eq(tasks.status, TaskStatus.PENDING_APPROVAL))
    .all();

  for (const row of pendingApprovalRows) {
    if (row.projectId == null) continue;
    const since = row.updatedAt ?? row.createdAt ?? new Date().toISOString();
    items.push({
      kind: "task_approval",
      taskId: row.id,
      projectId: row.projectId,
      title: row.label ?? deriveTitleFromPrompt(row.prompt) ?? "",
      since,
    });
  }

  // 2. Chats halted in pending approval. Symmetric with task_approval: a chat
  //    with `requiresApproval=true` flips `approvalStatus='pending'` at the
  //    end of each assistant turn and waits for the user to call
  //    POST /chats/:id/{approve,reject}. Unlike tasks, a chat may have
  //    `projectId=null` (workspace-level or unattached chats), so the item
  //    carries `projectId: number | null`.
  const pendingChatApprovalRows = db
    .select({
      id: chats.id,
      projectId: chats.projectId,
      title: chats.title,
      updatedAt: chats.updatedAt,
      createdAt: chats.createdAt,
    })
    .from(chats)
    .where(and(eq(chats.requiresApproval, true), eq(chats.approvalStatus, "pending")))
    .all();

  for (const row of pendingChatApprovalRows) {
    const since = row.updatedAt ?? row.createdAt ?? new Date().toISOString();
    items.push({
      kind: "chat_approval",
      chatId: row.id,
      projectId: row.projectId ?? null,
      title: row.title ?? "",
      since,
    });
  }

  // 3. Task sessions with pending permission requests. Look up the project
  //    for each task from the DB — the session itself doesn't carry it.
  for (const [taskId, session] of registry.activeTaskSessions()) {
    let entries: ReturnType<AgentSession["pendingPermissionEntries"]>;
    try {
      entries = session.pendingPermissionEntries();
    } catch (err) {
      console.warn(`[attention] skipping task session ${taskId}:`, err);
      continue;
    }
    if (entries.length === 0) continue;

    const taskRow = db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get();
    if (!taskRow || taskRow.projectId == null) continue;

    for (const { request, createdAt } of entries) {
      items.push({
        kind: "task_permission",
        taskId,
        projectId: taskRow.projectId,
        requestId: request.requestId,
        tool: request.toolName,
        since: createdAt.toISOString(),
      });
    }
  }

  // 4. Chat sessions with pending permission requests. Chats may be
  //    unattached to a project (projectId is nullable on the chats table).
  for (const [chatId, session] of registry.activeChatSessions()) {
    let entries: ReturnType<AgentSession["pendingPermissionEntries"]>;
    try {
      entries = session.pendingPermissionEntries();
    } catch (err) {
      console.warn(`[attention] skipping chat session ${chatId}:`, err);
      continue;
    }
    if (entries.length === 0) continue;

    const chatRow = db
      .select({ projectId: chats.projectId })
      .from(chats)
      .where(eq(chats.id, chatId))
      .get();
    const projectId = chatRow?.projectId ?? null;

    for (const { request, createdAt } of entries) {
      items.push({
        kind: "chat_permission",
        chatId,
        projectId,
        requestId: request.requestId,
        tool: request.toolName,
        since: createdAt.toISOString(),
      });
    }
  }

  // 5. Task questions — pending `agent_questions` rows scoped to a task.
  //    Symmetric with section 3: we read the row out of the DB, then resolve
  //    the owning task's projectId via a second lookup so we can fill the
  //    AttentionItem (which carries projectId for client-side filtering).
  //    Skip the row when the task is missing (cascade should have nuked the
  //    question, but tolerate races) or has no projectId — same skip the
  //    permission section applies, kept identical so the two sources behave
  //    the same way under partial DB state.
  //
  //    Order note: the existing approval/permission sections do not impose a
  //    SQL `ORDER BY` and rely on the trailing `items.sort(... DESC)` for
  //    final ordering. M05 asks question rows to be presented oldest-first,
  //    but the global sort still re-orders the whole list newest-first via
  //    `attentionItemTimestamp` (which reads `createdAt` for question kinds).
  //    We keep `ORDER BY agent_questions.created_at ASC` here anyway so that
  //    rows sharing an exact `created_at` value (possible when SQLite's
  //    second-resolution `datetime('now')` default fires twice in one tick)
  //    arrive in deterministic insert order — V8's stable sort then preserves
  //    that order through the global re-sort. Frontend interleave stays
  //    deterministic without us touching the existing rows.
  const taskQuestionRows = db
    .select({
      requestId: agentQuestions.requestId,
      taskId: agentQuestions.taskId,
      question: agentQuestions.question,
      options: agentQuestions.options,
      multiSelect: agentQuestions.multiSelect,
      header: agentQuestions.header,
      createdAt: agentQuestions.createdAt,
    })
    .from(agentQuestions)
    .where(
      and(isNotNull(agentQuestions.taskId), eq(agentQuestions.status, "pending")),
    )
    .orderBy(asc(agentQuestions.createdAt))
    .all();

  for (const row of taskQuestionRows) {
    if (row.taskId == null) continue;
    const taskRow = db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, row.taskId))
      .get();
    if (!taskRow || taskRow.projectId == null) continue;
    const base = serializeQuestionRow(row, "task");
    items.push({
      ...base,
      kind: "task_question",
      taskId: row.taskId,
      projectId: taskRow.projectId,
    });
  }

  // 6. Chat questions — same shape as section 5, but bound to a chat. Mirrors
  //    section 4 (chat permissions): chats may be unattached to a project,
  //    so `projectId` is `number | null` rather than skipping the row.
  const chatQuestionRows = db
    .select({
      requestId: agentQuestions.requestId,
      chatId: agentQuestions.chatId,
      question: agentQuestions.question,
      options: agentQuestions.options,
      multiSelect: agentQuestions.multiSelect,
      header: agentQuestions.header,
      createdAt: agentQuestions.createdAt,
    })
    .from(agentQuestions)
    .where(
      and(isNotNull(agentQuestions.chatId), eq(agentQuestions.status, "pending")),
    )
    .orderBy(asc(agentQuestions.createdAt))
    .all();

  for (const row of chatQuestionRows) {
    if (row.chatId == null) continue;
    const chatRow = db
      .select({ projectId: chats.projectId })
      .from(chats)
      .where(eq(chats.id, row.chatId))
      .get();
    // Tolerate a missing chat the same way section 3 tolerates a missing
    // task: cascade should clean these up, but we don't want a stale row to
    // crash the aggregator if a delete races with a question still in
    // `pending` status.
    if (!chatRow) continue;
    const base = serializeQuestionRow(row, "chat");
    items.push({
      ...base,
      kind: "chat_question",
      chatId: row.chatId,
      projectId: chatRow.projectId ?? null,
    });
  }

  // Newest blocker first. Sort is stable in V8 so ties keep insertion order,
  // which naturally groups approvals before permissions at the same instant.
  // Approval/permission rows expose `since`; question rows expose `createdAt`
  // — `attentionItemTimestamp` collapses them into one comparable string.
  items.sort((a, b) => {
    const ta = attentionItemTimestamp(a);
    const tb = attentionItemTimestamp(b);
    return ta < tb ? 1 : ta > tb ? -1 : 0;
  });

  return items;
}

/**
 * Common subset of a question AttentionItem — every field except the entity
 * id (`taskId` vs `chatId`) and the project id, which the caller adds after
 * resolving the parent row. The `kind` is set here so the call-site can spread
 * it directly into the union variant; the caller re-asserts `kind` to keep
 * TypeScript's discriminated-union narrowing happy when adding `taskId` /
 * `chatId`.
 *
 * Exported for tests only. Behaviour:
 *  - `options` is omitted when the row's column is NULL or parses to an empty
 *    array. Free-form questions (no picker) and explicit `options: []`
 *    therefore serialize identically — matching what the WS broadcaster does
 *    for the live event.
 *  - `header` is omitted when the row's column is NULL.
 *  - `multiSelect` is always present (boolean), even for free-form rows.
 *  - `createdAt` falls back to `now()` only when the row column is NULL,
 *    which only happens in tests that bypass the `datetime('now')` default.
 *  - Malformed `options` JSON is logged and treated as free-form so a single
 *    bad row never breaks the whole inbox.
 */
type QuestionRowForSerializer = {
  requestId: string;
  question: string;
  options: string | null;
  multiSelect: boolean;
  header: string | null;
  createdAt: string | null;
};

type SerializedQuestionBase = {
  kind: "task_question" | "chat_question";
  requestId: string;
  question: string;
  multiSelect: boolean;
  createdAt: string;
  header?: string;
  options?: QuestionOption[];
};

export function serializeQuestionRow(
  row: QuestionRowForSerializer,
  surface: "task" | "chat",
): SerializedQuestionBase {
  const out: SerializedQuestionBase = {
    kind: surface === "task" ? "task_question" : "chat_question",
    requestId: row.requestId,
    question: row.question,
    multiSelect: row.multiSelect,
    createdAt: row.createdAt ?? new Date().toISOString(),
  };
  if (row.header != null) out.header = row.header;
  if (row.options != null) {
    try {
      const parsed = JSON.parse(row.options);
      if (Array.isArray(parsed) && parsed.length > 0) {
        out.options = parsed as QuestionOption[];
      }
    } catch (err) {
      console.warn(
        `[attention] failed to parse agent_questions.options for ${row.requestId}:`,
        err,
      );
    }
  }
  return out;
}

/**
 * Pick the comparable timestamp out of any `AttentionItem` variant. The two
 * timestamp fields (`since` for approvals/permissions, `createdAt` for
 * questions) are deliberately kept distinct in the public type — `since`
 * means "blocking since" and includes the moment a long-running task moved
 * into pending_approval, while `createdAt` is the row-creation time of the
 * underlying `agent_questions` row. They're the same kind of value (an ISO
 * string a sort can compare lexicographically) but different sources.
 */
function attentionItemTimestamp(item: AttentionItem): string {
  return item.kind === "task_question" || item.kind === "chat_question"
    ? item.createdAt
    : item.since;
}

/**
 * Minimal broadcaster shape — just the one method `emitAttentionChanged`
 * needs. Defined structurally so tests can pass a fake without importing
 * the real `WSManager`.
 */
export interface AttentionBroadcaster {
  broadcastAll(data: Record<string, unknown>): void;
}

/**
 * Fire the single WS event (`attention_changed`) that tells every connected
 * client to re-fetch `GET /attention`. Attention is orthogonal to per-task
 * status broadcasts — callers invoke this in addition to (not instead of)
 * whatever status message they already emit.
 *
 * Centralized here so the event name lives in exactly one module and the
 * three call sites (task executor on pending_approval, approve route, reject
 * route) can't drift apart.
 */
export function emitAttentionChanged(broadcaster: AttentionBroadcaster): void {
  broadcaster.broadcastAll({ type: "attention_changed", payload: {} });
}

/**
 * Best-effort short title for a task that has no `label`. Takes the first
 * non-empty line of the prompt, trimmed to a reasonable length. Returns
 * null for empty/null prompts so the caller can fall back to `""`.
 */
function deriveTitleFromPrompt(prompt: string | null | undefined): string | null {
  if (!prompt) return null;
  const firstLine = prompt.split("\n").map((s) => s.trim()).find((s) => s.length > 0);
  if (!firstLine) return null;
  return firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine;
}
