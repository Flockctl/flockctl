import { AgentSession } from "./agent-session.js";
import type { PermissionRequest } from "./agent-session.js";
import { wsManager } from "./ws-manager.js";
import { getDb } from "../db/index.js";
import { chatMessages } from "../db/schema.js";
import { formatToolCall, formatToolResult } from "./tool-format.js";

/**
 * Tracks in-flight chat AgentSessions by chatId. Unlike TaskExecutor, this
 * has no queue or concurrency cap — chats run as soon as the user sends a
 * message, one session per chat. Provides UI-facing permission resolution.
 */
class ChatExecutor {
  private sessions = new Map<number, AgentSession>();

  register(chatId: number, session: AgentSession): void {
    this.sessions.set(chatId, session);

    wsManager.broadcastChat(chatId, {
      type: "session_started",
      payload: { chat_id: String(chatId) },
    });

    session.on("permission_request", (request: PermissionRequest) => {
      wsManager.broadcastChat(chatId, {
        type: "permission_request",
        payload: {
          chat_id: String(chatId),
          request_id: request.requestId,
          tool_name: request.toolName,
          tool_input: request.toolInput,
          title: request.title ?? null,
          display_name: request.displayName ?? null,
          description: request.description ?? null,
          decision_reason: request.decisionReason ?? null,
          tool_use_id: request.toolUseID,
        },
      });
    });

    session.on("tool_call", (name: string, input: unknown) => {
      const db = getDb();
      const summary = formatToolCall(name, input);
      const row = db.insert(chatMessages).values({
        chatId,
        role: "tool",
        content: JSON.stringify({ kind: "call", name, input, summary }),
      }).returning().get();
      wsManager.broadcastChat(chatId, {
        type: "tool_call",
        payload: {
          chat_id: String(chatId),
          message_id: row.id,
          tool_name: name,
          summary,
        },
      });
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
    if (!this.sessions.delete(chatId)) return;
    wsManager.broadcastChat(chatId, {
      type: "session_ended",
      payload: { chat_id: String(chatId) },
    });
  }

  isRunning(chatId: number): boolean {
    return this.sessions.has(chatId);
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
    while (this.sessions.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
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
      wsManager.broadcastChat(chatId, {
        type: "permission_resolved",
        payload: {
          chat_id: String(chatId),
          request_id: requestId,
          behavior: result.behavior,
        },
      });
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

  /** Chat IDs with active sessions. */
  runningChatIds(): number[] {
    return Array.from(this.sessions.keys());
  }
}

export const chatExecutor = new ChatExecutor();
