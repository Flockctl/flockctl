import type { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../../db/index.js";
import { chats, chatMessages, chatTodos } from "../../db/schema.js";
import { eq, sql, desc, and, isNull } from "drizzle-orm";
import { paginationParams } from "../../lib/pagination.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { computeCounts, type Todo } from "../../services/todo-store.js";
import { parseTodosJson } from "./helpers.js";
import { getChatOrThrow } from "../../lib/db-helpers.js";

// ─── Todos ──────────────────────────────────────────────────────────────────
// Zod-validated `:id` path param. Same pattern as `attachmentIdParamSchema`
// above — keeps ValidationError (422) separate from NotFoundError (404).
export const todosIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * Sentinel agent key used by /chats/:id/todos/{agents,history?agent=…} to
 * stand in for "main agent" (the one with `parent_tool_use_id IS NULL` in
 * `chat_todos`). NULL would be ambiguous on the wire — `?agent=` could mean
 * "main" or "missing" — so we pick a reserved literal that can never collide
 * with an SDK-issued `toolu_…` id.
 */
export const MAIN_AGENT_KEY = "main";

interface AgentSummary {
  /** `MAIN_AGENT_KEY` for the main agent, otherwise the SDK `toolu_…` id. */
  key: string;
  /** NULL for the main agent; the spawning Task call's tool_use id otherwise.
   *  Mirrors the `parent_tool_use_id` column for direct comparisons. */
  parentToolUseId: string | null;
  /** Human label for the per-agent tab. "Main agent" for the main timeline,
   *  the spawning Task tool's `description` (truncated by the UI) for a
   *  sub-agent, falling back to a synthesised "Sub-agent <id-prefix>" when
   *  the spawning Task call cannot be resolved (e.g. legacy chat_messages
   *  rows from before tool_use_id was persisted in the JSON content). */
  label: string;
  /** Optional sub-agent type from the Task input (e.g. "general-purpose").
   *  Surfaces the SDK's agent classification so the UI can show a chip. */
  subagentType: string | null;
  /** Snapshots emitted by this agent so far (used by the UI to know whether
   *  to render the collapsible "older snapshots" section under the latest). */
  snapshotCount: number;
  /** Latest snapshot for this agent, with `completedAt` annotated per todo
   *  (see `annotateCompletedAt`). NULL only in the pathological case of an
   *  agent group with zero rows — `snapshotCount > 0` guarantees non-null. */
  latest: {
    id: number;
    createdAt: string;
    todos: TodoWithCompletedAt[];
    counts: ReturnType<typeof computeCounts>;
  } | null;
}

/** Todo enriched with the timestamp at which it first transitioned to
 *  "completed" (across the agent's snapshot timeline, identified by `content`).
 *  NULL means the todo isn't completed yet OR its first-completed transition
 *  predates the rows we have (defensive — should not happen in practice). */
export interface TodoWithCompletedAt extends Todo {
  completedAt: string | null;
}

/**
 * Walk an agent's snapshots in chronological order and stamp each todo in
 * the latest snapshot with the timestamp at which its `content` first
 * appeared with status `"completed"`. Identifying a todo across snapshots
 * by `content` matches how the agent itself addresses them — TodoWrite
 * replaces the entire array each call but content strings remain stable.
 *
 * Pure / no DB access — exported for unit testing.
 */
export function annotateCompletedAt(
  snapshotsAsc: Array<{ createdAt: string; todos: Todo[] }>,
): TodoWithCompletedAt[] {
  if (snapshotsAsc.length === 0) return [];
  // First-completion timestamp per todo content. Once set, we never overwrite
  // — agents sometimes reset a "completed" todo back to "in_progress" to
  // re-do work, but the user wants to see WHEN the original completion
  // happened in the timeline, not the latest re-completion.
  const firstCompletedAt = new Map<string, string>();
  for (const snap of snapshotsAsc) {
    for (const t of snap.todos) {
      if (t.status === "completed" && !firstCompletedAt.has(t.content)) {
        firstCompletedAt.set(t.content, snap.createdAt);
      }
    }
  }
  const latest = snapshotsAsc[snapshotsAsc.length - 1]!;
  return latest.todos.map((t) => ({
    ...t,
    completedAt: t.status === "completed" ? (firstCompletedAt.get(t.content) ?? null) : null,
  }));
}

/** Try to extract the spawning Task call's `description` and `subagent_type`
 *  for a given `parentToolUseId`. Returns `{ label: null, subagentType: null }`
 *  when no matching Task message can be resolved (legacy rows, sub-agent
 *  spawned by something other than Task, or the sub-agent's parent is
 *  outside the inspected chat). */
function resolveTaskMeta(
  toolMessages: Array<{ content: string }>,
  parentToolUseId: string,
): { label: string | null; subagentType: string | null } {
  for (const m of toolMessages) {
    let parsed: any;
    try {
      parsed = JSON.parse(m.content);
    } catch {
      continue;
    }
    if (parsed?.kind !== "call" || parsed?.name !== "Task") continue;
    if (parsed?.tool_use_id !== parentToolUseId) continue;
    const input = parsed.input ?? {};
    const description = typeof input.description === "string" ? input.description : null;
    const subagentType = typeof input.subagent_type === "string" ? input.subagent_type : null;
    return { label: description, subagentType };
  }
  return { label: null, subagentType: null };
}

export function registerChatTodos(router: Hono): void {
  // GET /chats/:id/todos — latest TodoWrite snapshot for a chat, plus the
  // pre-computed counts. Returns 204 when the chat exists but has never
  // received a TodoWrite call; 404 when the chat itself is unknown.
  router.get("/:id/todos", (c) => {
    const paramParse = todosIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!paramParse.success) throw new ValidationError("invalid chat id");
    const chatId = paramParse.data.id;

    const db = getDb();
    getChatOrThrow(chatId);

    const snapshot = db
      .select()
      .from(chatTodos)
      .where(eq(chatTodos.chatId, chatId))
      .orderBy(desc(chatTodos.createdAt), desc(chatTodos.id))
      .limit(1)
      .get();

    if (!snapshot) return c.body(null, 204);

    const todos = parseTodosJson(snapshot.todosJson);
    return c.json({
      snapshot: {
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        todos,
      },
      counts: computeCounts(todos),
    });
  });

  // GET /chats/:id/todos/history — paginated snapshot history (newest first).
  // Mirrors the list-envelope used elsewhere in this router ({ items, total,
  // page, perPage } via `paginationParams`) — no bespoke cursor shape.
  //
  // Optional `?agent=<MAIN_AGENT_KEY|toolu_…>` filter scopes the history to
  // a single agent's timeline. Without the filter the response collapses
  // sub-agents into the main feed (legacy callers stay byte-identical).
  router.get("/:id/todos/history", (c) => {
    const paramParse = todosIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!paramParse.success) throw new ValidationError("invalid chat id");
    const chatId = paramParse.data.id;

    const db = getDb();
    getChatOrThrow(chatId);

    const agentParam = c.req.query("agent");
    // Build the agent filter once and reuse for both rows + count queries so
    // the total never drifts from the slice the UI is paging through.
    let agentWhere = eq(chatTodos.chatId, chatId);
    if (agentParam !== undefined) {
      if (agentParam === MAIN_AGENT_KEY) {
        agentWhere = and(
          eq(chatTodos.chatId, chatId),
          isNull(chatTodos.parentToolUseId),
        )!;
      } else {
        // Defense in depth — `toolu_…` ids are SDK-controlled but the param
        // value is user-controlled; an empty string would silently match
        // every NULL row via the equals branch, so we reject it as 422.
        if (agentParam.length === 0) throw new ValidationError("agent must be non-empty");
        agentWhere = and(
          eq(chatTodos.chatId, chatId),
          eq(chatTodos.parentToolUseId, agentParam),
        )!;
      }
    }

    const { page, perPage, offset } = paginationParams(c);
    const rows = db
      .select()
      .from(chatTodos)
      .where(agentWhere)
      .orderBy(desc(chatTodos.createdAt), desc(chatTodos.id))
      .limit(perPage)
      .offset(offset)
      .all();
    const total = db
      .select({ count: sql<number>`count(*)` })
      .from(chatTodos)
      .where(agentWhere)
      .get()?.count ?? 0;

    const items = rows.map((r) => {
      const todos = parseTodosJson(r.todosJson);
      return {
        id: r.id,
        createdAt: r.createdAt,
        parentToolUseId: r.parentToolUseId,
        todos,
        counts: computeCounts(todos),
      };
    });

    return c.json({ items, total, page, perPage });
  });

  // GET /chats/:id/todos/agents — per-agent grouping that powers the tabs in
  // the Todo history drawer. Returns one entry per distinct
  // `parent_tool_use_id` (NULL coerced to MAIN_AGENT_KEY), each with the
  // latest snapshot, snapshot count, and a human label resolved by joining
  // back to the spawning Task call in chat_messages.
  router.get("/:id/todos/agents", (c) => {
    const paramParse = todosIdParamSchema.safeParse({ id: c.req.param("id") });
    if (!paramParse.success) throw new ValidationError("invalid chat id");
    const chatId = paramParse.data.id;

    const db = getDb();
    getChatOrThrow(chatId);

    // Fetch every snapshot for this chat in chronological order. We need the
    // full timeline (not just the latest per agent) so `annotateCompletedAt`
    // can compute the per-todo completion timestamps. Even with pathological
    // agents at MAX_TODOS=100 entries × hundreds of snapshots this stays in
    // the kilobyte range — no streaming required.
    const allRows = db
      .select({
        id: chatTodos.id,
        parentToolUseId: chatTodos.parentToolUseId,
        todosJson: chatTodos.todosJson,
        createdAt: chatTodos.createdAt,
      })
      .from(chatTodos)
      .where(eq(chatTodos.chatId, chatId))
      .orderBy(chatTodos.createdAt, chatTodos.id)
      .all();

    if (allRows.length === 0) return c.json({ items: [] });

    // Bucket snapshots by agent key. Preserves insertion order, so the tab
    // ordering matches "main agent first, then sub-agents in the order they
    // were spawned" — natural for left-to-right tab strips.
    const byAgent = new Map<string, {
      parentToolUseId: string | null;
      snapshots: Array<{ id: number; createdAt: string; todos: Todo[] }>;
    }>();
    for (const row of allRows) {
      const key = row.parentToolUseId ?? MAIN_AGENT_KEY;
      let bucket = byAgent.get(key);
      if (!bucket) {
        bucket = { parentToolUseId: row.parentToolUseId, snapshots: [] };
        byAgent.set(key, bucket);
      }
      bucket.snapshots.push({
        id: row.id,
        createdAt: row.createdAt,
        todos: parseTodosJson(row.todosJson),
      });
    }

    // Resolve sub-agent labels from chat_messages by parsing tool_call JSONs
    // for `name === "Task"`. Done in a single scan rather than per-id query —
    // a long chat may have thousands of tool messages but only a handful of
    // distinct sub-agents. Limited to role='tool' so we don't deserialise
    // every assistant turn.
    const subAgentIds = [...byAgent.keys()].filter((k) => k !== MAIN_AGENT_KEY);
    const taskMeta = new Map<string, { label: string | null; subagentType: string | null }>();
    if (subAgentIds.length > 0) {
      const toolMessages = db
        .select({ content: chatMessages.content })
        .from(chatMessages)
        .where(and(eq(chatMessages.chatId, chatId), eq(chatMessages.role, "tool")))
        .all();
      for (const id of subAgentIds) {
        taskMeta.set(id, resolveTaskMeta(toolMessages, id));
      }
    }

    const items: AgentSummary[] = [];
    for (const [key, bucket] of byAgent.entries()) {
      const annotated = annotateCompletedAt(bucket.snapshots);
      const latestSnap = bucket.snapshots[bucket.snapshots.length - 1]!;
      let label: string;
      let subagentType: string | null = null;
      if (key === MAIN_AGENT_KEY) {
        label = "Main agent";
      } else {
        const meta = taskMeta.get(key);
        if (meta?.label) {
          label = meta.label;
          subagentType = meta.subagentType;
        } else {
          // Fallback when no Task call was found in chat_messages (legacy
          // rows, or the chat was imported without tool history). Truncated
          // to keep the tab strip readable — the full id is still in `key`
          // for diagnostics.
          label = `Sub-agent ${key.slice(-6)}`;
        }
      }
      items.push({
        key,
        parentToolUseId: bucket.parentToolUseId,
        label,
        subagentType,
        snapshotCount: bucket.snapshots.length,
        latest: {
          id: latestSnap.id,
          createdAt: latestSnap.createdAt,
          todos: annotated,
          counts: computeCounts(latestSnap.todos),
        },
      });
    }

    return c.json({ items });
  });
}
