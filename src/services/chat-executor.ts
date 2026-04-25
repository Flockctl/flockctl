import { AgentSession } from "./agent-session/index.js";
import type { PermissionRequest, QuestionRequest } from "./agent-session/index.js";
import type { PermissionMode } from "./permission-resolver.js";
import { wsManager } from "./ws-manager.js";
import { getDb } from "../db/index.js";
import { chats, chatMessages, agentQuestions } from "../db/schema.js";
import { and, eq, sql } from "drizzle-orm";
import { formatToolCall, formatToolResult } from "./tool-format.js";
import { recordTodoWrite } from "./todo-store.js";
import { emitAttentionChanged } from "./attention.js";
import {
  broadcastAgentQuestion,
  broadcastAgentQuestionResolved,
  broadcastPermissionRequest,
  broadcastPermissionResolved,
  persistAgentQuestion,
} from "./agent-interaction.js";
import {
  buildEntriesFromToolCall,
  parseJournal,
  serializeJournal,
  summarizeJournal,
} from "./file-edit-journal.js";

/**
 * Tracks in-flight chat AgentSessions by chatId. Unlike TaskExecutor, this
 * has no queue or concurrency cap — chats run as soon as the user sends a
 * message, one session per chat. Provides UI-facing permission resolution.
 */
class ChatExecutor {
  private sessions = new Map<number, AgentSession>();
  // Chats that have been claimed (user message persisted + stream endpoint
  // entered) but whose AgentSession is still being wired up. Needed because
  // there's a small async window between `POST /chats/:id/messages/stream`
  // saving the user row and the streamSSE arrow reaching `register(id, session)`
  // — if `GET /chats/:id` lands in that window, the bare `sessions.has(id)`
  // check used to return `false` while the messages list already ended with
  // the user's turn, which flipped the UI into the "Response was not received"
  // fallback whenever someone switched chats and came back. Treating a
  // claimed chat as running closes that race without having to promote
  // session wiring before the SSE arrow runs (which would break the
  // ordering invariant between our flush-pending listener and chat-executor's
  // tool_call listener).
  private pendingSessions = new Set<number>();

  /**
   * Mark a chat as running BEFORE the full session is wired up. The stream
   * handler calls this right after persisting the user message so that any
   * concurrent `GET /chats/:id` sees `isRunning=true` instead of a torn state
   * (user message in DB + `isRunning=false`). Paired with `release()` for the
   * error path and `register()` for the happy path, both of which clear the
   * pending flag. Idempotent — a second claim for the same chat is a no-op.
   */
  claim(chatId: number): void {
    if (this.sessions.has(chatId) || this.pendingSessions.has(chatId)) return;
    this.pendingSessions.add(chatId);
  }

  /**
   * Drop a `claim` that was never promoted to a real session (setup threw
   * before reaching `register`). Broadcasts `session_ended` so any UI that
   * picked up an earlier `isRunning=true` from a racing GET sees the flag
   * flip back down instead of getting stuck. No-op when no claim exists.
   */
  release(chatId: number): void {
    if (!this.pendingSessions.delete(chatId)) return;
    wsManager.broadcastChat(chatId, {
      type: "session_ended",
      payload: { chat_id: String(chatId) },
    });
  }

  register(chatId: number, session: AgentSession): void {
    // Promote a prior `claim()` — if the stream handler already marked the
    // chat as pending, drop that flag first so `isRunning` doesn't double-
    // count, then carry on with the real wiring. A direct `register()` call
    // without a preceding claim is still valid (tests take that path).
    this.pendingSessions.delete(chatId);
    this.sessions.set(chatId, session);

    wsManager.broadcastChat(chatId, {
      type: "session_started",
      payload: { chat_id: String(chatId) },
    });

    session.on("permission_request", (request: PermissionRequest) => {
      broadcastPermissionRequest({ kind: "chat", id: chatId }, request);
      // Note: `attention_changed` is emitted by AgentSession.canUseTool when
      // it adds the pending entry — do NOT re-emit here. The invariant
      // documented in src/services/attention.ts is "exactly one broadcast
      // per transition"; duplicating the emit would make sidebar badges
      // and the attention list double-refresh on every permission prompt.
    });

    // Agent-emitted clarification question (AskUserQuestion tool). Chats do
    // NOT have a dedicated status column — the "waiting" state is derived
    // from EXISTS(SELECT 1 FROM agent_questions WHERE chat_id=? AND
    // status='pending'). We still persist the question row so the UI can
    // re-hydrate the block after a page reload (same pattern as
    // pending-permissions).
    session.on("question_request", (request: QuestionRequest) => {
      const ref = { kind: "chat", id: chatId } as const;
      const insertedId = persistAgentQuestion(ref, request);
      broadcastAgentQuestion(ref, request, insertedId);
      emitAttentionChanged(wsManager);
    });

    // Live permission-mode swap (variant B): surface every change as a WS
    // event so every connected UI updates its permission switcher without a
    // round-trip GET. Fires only on a REAL transition (getter/no-op short-
    // circuit lives inside AgentSession.updatePermissionMode).
    session.on(
      "permission_mode_changed",
      (evt: { previous: PermissionMode; current: PermissionMode }) => {
        wsManager.broadcastChat(chatId, {
          type: "chat_permission_mode_changed",
          payload: {
            chat_id: String(chatId),
            previous: evt.previous,
            current: evt.current,
          },
        });
      },
    );

    // Bulk auto-resolve after a permission-mode swap: the session fulfils the
    // pending promises internally, so the executor never sees a
    // `chatExecutor.resolvePermission` call. Broadcast the canonical
    // `permission_resolved` frame here instead so UI pending-cards disappear
    // exactly the same way they do on a manual allow. `attention_changed`
    // is already emitted once by the session at the end of the bulk loop —
    // do NOT re-emit here (single-emit invariant).
    session.on("permission_auto_resolved", (requestId: string) => {
      broadcastPermissionResolved({ kind: "chat", id: chatId }, requestId, "allow");
    });

    session.on("tool_call", (
      name: string,
      input: unknown,
      parentToolUseId: string | null = null,
      toolUseId: string | null = null,
    ) => {
      const db = getDb();
      const summary = formatToolCall(name, input);
      const row = db.insert(chatMessages).values({
        chatId,
        role: "tool",
        // Persist parent_tool_use_id alongside the call payload so /chats/:id
        // /todos/agents can recover the spawning Task call's `description`
        // for the per-agent tab label without a separate index. NULL means
        // "main agent" (top-level tool_use).
        //
        // tool_use_id is the SDK-assigned id of THIS tool_use block (`toolu_…`).
        // The /chats/:id/todos/agents route joins chat_todos.parent_tool_use_id
        // back to chat_messages where name='Task' AND tool_use_id matches, so
        // the spawning Task call's `description` becomes the sub-agent tab
        // label. NULL only on legacy rows from before this column was wired up.
        content: JSON.stringify({
          kind: "call",
          name,
          input,
          summary,
          parent_tool_use_id: parentToolUseId,
          tool_use_id: toolUseId,
        }),
      }).returning().get();
      wsManager.broadcastChat(chatId, {
        type: "tool_call",
        payload: {
          chat_id: String(chatId),
          message_id: row.id,
          tool_name: name,
          summary,
          parent_tool_use_id: parentToolUseId,
          tool_use_id: toolUseId,
        },
      });

      // Parallel projection of TodoWrite snapshots into chat_todos so the UI
      // can render progress without re-parsing every tool-call message.
      // The `todo_updated` WS event is broadcast from inside recordTodoWrite
      // (after a successful insert); dedup hits don't re-broadcast.
      //
      // `parentToolUseId` flows in from the SDK side and is what the new
      // "Todo history" tabs UI keys on — null = main agent, `toolu_…` = a
      // specific sub-agent. Without forwarding it here, the projection
      // would still work but every snapshot would be attributed to "main"
      // and tabs would collapse to a single tab.
      if (name === "TodoWrite") {
        recordTodoWrite({ chatId, input, parentToolUseId });
      }

      // File-edit journal — append any { filePath, original, current }
      // entries derived from Edit/Write/MultiEdit/str_replace tool inputs,
      // persist the updated journal, and broadcast a `chat_diff_updated`
      // frame so the "Changes" card at the bottom of the chat updates live
      // without a page reload. Unlike tasks (which flush once at run end),
      // chats are long-lived — every hit is persisted so a daemon restart
      // mid-conversation does not lose the journal.
      const newEntries = buildEntriesFromToolCall(name, input);
      if (newEntries.length > 0) {
        const existing = db
          .select({ fileEdits: chats.fileEdits })
          .from(chats)
          .where(eq(chats.id, chatId))
          .get();
        const journal = parseJournal(existing?.fileEdits);
        journal.entries.push(...newEntries);
        const serialized = serializeJournal(journal);
        db.update(chats).set({ fileEdits: serialized }).where(eq(chats.id, chatId)).run();
        /* v8 ignore next — summarizeJournal always returns a populated object
           when journal.entries is non-empty (we just pushed newEntries); the
           `?.text ?? null` chain is TS null-safety glue. */
        const summaryText = summarizeJournal(journal)?.text ?? null;
        wsManager.broadcastChat(chatId, {
          type: "chat_diff_updated",
          payload: {
            chat_id: String(chatId),
            summary: summaryText,
            total_entries: journal.entries.length,
          },
        });
      }
    });

    session.on("tool_result", (name: string, output: string) => {
      const db = getDb();
      const summary = formatToolResult(name, output);
      const row = db.insert(chatMessages).values({
        chatId,
        role: "tool",
        content: JSON.stringify({ kind: "result", name, output, summary }),
      }).returning().get();
      wsManager.broadcastChat(chatId, {
        type: "tool_result",
        payload: {
          chat_id: String(chatId),
          message_id: row.id,
          tool_name: name,
          summary,
        },
      });
    });
  }

  unregister(chatId: number): void {
    // Also clear any lingering `claim()` — the finally block in the stream
    // route calls `unregister` unconditionally, so a claim that never got
    // promoted (setup threw before `register`) still gets reaped here even
    // though `release()` is the preferred exit for that path.
    const hadSession = this.sessions.delete(chatId);
    const hadPending = this.pendingSessions.delete(chatId);
    if (!hadSession && !hadPending) return;
    wsManager.broadcastChat(chatId, {
      type: "session_ended",
      payload: { chat_id: String(chatId) },
    });
  }

  isRunning(chatId: number): boolean {
    // Treat claimed-but-not-yet-wired-up chats as running. Closes the
    // "user message persisted, session not yet registered" race documented
    // on the `pendingSessions` field above.
    return this.sessions.has(chatId) || this.pendingSessions.has(chatId);
  }

  cancel(chatId: number): boolean {
    const s = this.sessions.get(chatId);
    if (!s) return false;
    s.abort();
    return true;
  }

  /** Abort every active chat session — called on daemon shutdown. */
  cancelAll(): void {
    for (const [, session] of this.sessions) {
      session.abort("shutdown");
    }
  }

  /**
   * Wait until every active chat session has unregistered (i.e. its handler
   * finished saving the assistant message and usage). Used by graceful
   * shutdown so in-flight streams aren't lost to `process.exit`.
   */
  async waitForIdle(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // Also drain pending claims — a chat that was just claimed but has not
    // yet promoted to a real session is still "in flight" from the daemon
    // shutdown perspective.
    while ((this.sessions.size > 0 || this.pendingSessions.size > 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * Variant-B live permission-mode switch: mutate the running session's
   * permission mode (which also auto-resolves any pending permission
   * entries the new mode would have allowed). Returns false when no
   * session is active — the DB-level PATCH still applies and the new mode
   * takes effect on the next turn regardless.
   *
   * The route layer calls this AFTER persisting the new value to
   * `chats.permissionMode` (or resolving the inherit-chain when the column
   * is cleared to null), so DB and in-memory state stay consistent.
   */
  updatePermissionMode(chatId: number, mode: PermissionMode): boolean {
    const s = this.sessions.get(chatId);
    if (!s) return false;
    s.updatePermissionMode(mode);
    return true;
  }

  resolvePermission(
    chatId: number,
    requestId: string,
    result: { behavior: "allow" } | { behavior: "deny"; message: string },
  ): boolean {
    const s = this.sessions.get(chatId);
    if (!s) return false;
    const ok = s.resolvePermission(requestId, result);
    if (ok) {
      broadcastPermissionResolved({ kind: "chat", id: chatId }, requestId, result.behavior);
      // Note: `attention_changed` is emitted by AgentSession.resolvePermission
      // when it removes the pending entry — do NOT re-emit here. Single-emit
      // invariant enforced by attention-broadcast.test.ts.
    }
    return ok;
  }

  /** Snapshot of `{ chatId: pendingCount }` across all active sessions. */
  pendingPermissionCounts(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const [chatId, session] of this.sessions) {
      const n = session.pendingPermissionCount;
      if (n > 0) out[chatId] = n;
    }
    return out;
  }

  /** Full pending permission requests awaiting a UI response for this chat. */
  pendingPermissions(chatId: number): PermissionRequest[] {
    const session = this.sessions.get(chatId);
    return session ? session.pendingPermissionRequests() : [];
  }

  /**
   * Answer a pending agent question for a chat. Flip the row to 'answered',
   * relay the answer back to the in-flight session (which unblocks the
   * agentic loop waiting inside AgentSession.awaitUserAnswer).
   *
   * Chats have no explicit `waiting_for_input` status — the derived flag is
   * `EXISTS(pending agent_question for chat)`. Once this row moves to
   * 'answered', the derivation naturally returns false again.
   */
  answerQuestion(chatId: number, requestId: string, answer: string): boolean {
    const db = getDb();
    const row = db
      .select()
      .from(agentQuestions)
      .where(and(eq(agentQuestions.requestId, requestId), eq(agentQuestions.chatId, chatId)))
      .get();
    if (!row || row.status !== "pending") return false;

    const session = this.sessions.get(chatId);
    if (!session) return false;

    const ok = session.resolveQuestion(requestId, answer);
    if (!ok) return false;

    db.update(agentQuestions)
      .set({ answer, status: "answered", answeredAt: new Date().toISOString() })
      .where(eq(agentQuestions.id, row.id))
      .run();

    broadcastAgentQuestionResolved({ kind: "chat", id: chatId }, requestId, answer);
    emitAttentionChanged(wsManager);
    return true;
  }

  /** Pending agent questions for a chat, oldest-first. */
  pendingQuestions(chatId: number): Array<{
    id: number;
    requestId: string;
    question: string;
    toolUseId: string;
    createdAt: string | null;
  }> {
    const db = getDb();
    const rows = db
      .select()
      .from(agentQuestions)
      .where(and(eq(agentQuestions.chatId, chatId), eq(agentQuestions.status, "pending")))
      .all();
    /* v8 ignore start — createdAt has a DB default so r.createdAt is always
       a populated string in practice; the `?? ""` / `?? null` fallbacks are
       TS null-safety glue that no test path exercises. */
    return rows
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
      .map((r) => ({
        id: r.id,
        requestId: r.requestId,
        question: r.question,
        toolUseId: r.toolUseId,
        createdAt: r.createdAt ?? null,
      }));
    /* v8 ignore stop */
  }

  /**
   * True when the chat has at least one open agent question — the derived
   * "waiting_for_input" flag for chats (no column equivalent to the task
   * status). Read directly from the DB so it works across restarts, not
   * only for in-memory sessions.
   */
  isWaitingForInput(chatId: number): boolean {
    const db = getDb();
    const row = db
      .select({ n: sql<number>`count(*)` })
      .from(agentQuestions)
      .where(and(eq(agentQuestions.chatId, chatId), eq(agentQuestions.status, "pending")))
      .get();
    /* v8 ignore next — `select count(*)` always returns exactly one row;
       the `row?.n ?? 0` chain is TS glue for an unreachable null case. */
    return (row?.n ?? 0) > 0;
  }

  /** Chat IDs with active sessions. */
  runningChatIds(): number[] {
    return Array.from(this.sessions.keys());
  }

  /** Iterable of `[chatId, session]` for every in-flight chat session. Used
   *  by the attention aggregator to surface pending permission requests. */
  activeSessions(): IterableIterator<[number, AgentSession]> {
    return this.sessions.entries();
  }

  /**
   * Post-turn hook — called by the message endpoints after a session
   * completes successfully. If the chat is marked `requiresApproval=true`
   * and isn't already in a pending/decided state, flip its `approvalStatus`
   * to `"pending"` and emit `attention_changed` so the blocker surfaces
   * in `GET /attention`. A chat that is already pending stays pending
   * (second consecutive turn before the user reviews does not re-broadcast);
   * an already-decided chat re-enters pending on the next turn only if the
   * user reset the flag.
   *
   * Mirrors the task path where `TaskStatus.PENDING_APPROVAL` is set at the
   * end of `_run()` — kept symmetric so the attention inbox can treat task
   * and chat approvals as the same kind of blocker in the UI.
   */
  markPendingApprovalIfRequired(chatId: number): void {
    const db = getDb();
    const chat = db
      .select({ requiresApproval: chats.requiresApproval, approvalStatus: chats.approvalStatus })
      .from(chats)
      .where(eq(chats.id, chatId))
      .get();
    if (!chat || !chat.requiresApproval) return;
    if (chat.approvalStatus === "pending") return;
    db.update(chats)
      .set({ approvalStatus: "pending", updatedAt: new Date().toISOString() })
      .where(eq(chats.id, chatId))
      .run();
    emitAttentionChanged(wsManager);
  }
}

export const chatExecutor = new ChatExecutor();
