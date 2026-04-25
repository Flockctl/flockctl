import { and, eq } from "drizzle-orm";
import type { FlockctlDb } from "../db/index.js";
import { tasks, chats } from "../db/schema.js";
import type { AgentSession } from "./agent-session/index.js";
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
 *
 * Raw tool-call arguments are intentionally NOT included — only the tool name
 * is surfaced, since arguments can contain secrets.
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
 * DB query hits a single indexed column):
 *  1. `tasks` rows with `status = 'pending_approval'`
 *  2. `chats` rows with `requiresApproval=1 AND approvalStatus = 'pending'`
 *  3. Pending permission requests on every active task AgentSession
 *  4. Pending permission requests on every active chat AgentSession
 *
 * Results are sorted by `since` descending (newest blocker first) so the
 * UI can render "what just started blocking me" at the top without further
 * sorting.
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

  // Newest blocker first. Sort is stable in V8 so ties keep insertion order,
  // which naturally groups approvals before permissions at the same instant.
  items.sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : 0));

  return items;
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
