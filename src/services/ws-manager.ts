import { EventEmitter } from "events";

interface WSClient {
  send(data: string): void;
  readyState: number;
}

// ─── Typed broadcast envelopes ─────────────────────────────────────────────
//
// Discriminated-union view of every typed broadcast frame the WSManager
// emits. The runtime helpers below still construct frames inline with
// `JSON.stringify({...})`; this union is the *type-side* mirror so callers
// (tests, future consumers, the M16 chat-final-message subscriber) can
// `switch (frame.type)` with `never`-exhaustiveness instead of carrying
// `Record<string, unknown>` everywhere.
//
// Members are appended as new broadcast types ship — additive only. Every
// member must keep a literal `type` discriminator that matches the wire
// frame BYTE-FOR-BYTE; the client-side counterpart lives in
// `ui/src/lib/ws.ts` (`MessageType`) and must extend in lockstep.
//
// No runtime references — this is exported purely as a TypeScript surface,
// so adding a member here cannot regress the broadcast hot path.

/**
 * `chat_assistant_final` envelope. Emitted from the SSE `stream_end` branch
 * in `src/routes/chats/messages.ts` immediately AFTER the assistant
 * `chat_messages` row is committed, and ONLY on a clean turn-end (never on
 * abort/error/cancel). Carries no message body, preview, or title — the
 * UI looks up whatever it needs by `message_id`.
 *
 * Routed through `WSManager.broadcastChatAssistantFinal` to global
 * chat-list clients only; per-chat scoped clients already react to
 * `session_ended` and refetch.
 */
export interface ChatAssistantFinalFrame {
  type: "chat_assistant_final";
  chat_id: number;
  message_id: number;
  /** Unix epoch milliseconds at broadcast time. */
  ts: number;
}

/**
 * Discriminated union of all typed broadcast envelopes the WSManager
 * emits. Currently a single-member union; additional broadcast types
 * (task_status, chat_status, slice_status, mission_event, …) are
 * intentionally NOT yet folded in — those still flow through the loose
 * `Record<string, unknown>` helpers and will be migrated incrementally
 * so each one's typing change is reviewed in isolation.
 */
export type WsBroadcastFrame = ChatAssistantFinalFrame;

class WSManager extends EventEmitter {
  private taskClients = new Map<number, Set<WSClient>>();
  private chatClients = new Map<number, Set<WSClient>>();
  private globalChatClients = new Set<WSClient>();
  private allClients = new Set<WSClient>();

  addTaskClient(taskId: number, ws: WSClient) {
    let set = this.taskClients.get(taskId);
    if (!set) {
      set = new Set();
      this.taskClients.set(taskId, set);
    }
    set.add(ws);
    this.allClients.add(ws);
  }

  addChatClient(chatId: number, ws: WSClient) {
    let set = this.chatClients.get(chatId);
    if (!set) {
      set = new Set();
      this.chatClients.set(chatId, set);
    }
    set.add(ws);
    this.allClients.add(ws);
  }

  addGlobalChatClient(ws: WSClient) {
    this.globalChatClients.add(ws);
    this.allClients.add(ws);
  }

  removeClient(ws: WSClient) {
    for (const [taskId, set] of this.taskClients) {
      if (set.delete(ws) && set.size === 0) this.taskClients.delete(taskId);
    }
    for (const [chatId, set] of this.chatClients) {
      if (set.delete(ws) && set.size === 0) this.chatClients.delete(chatId);
    }
    this.globalChatClients.delete(ws);
    this.allClients.delete(ws);
  }

  broadcast(taskId: number, data: Record<string, unknown>) {
    const set = this.taskClients.get(taskId);
    if (!set || set.size === 0) return;
    const msg = JSON.stringify({ ...data, taskId });
    this._send(set, msg);
  }

  broadcastChat(chatId: number, data: Record<string, unknown>) {
    const msg = JSON.stringify({ ...data, chatId });
    const scoped = this.chatClients.get(chatId);
    if (scoped && scoped.size > 0) this._send(scoped, msg);
    if (this.globalChatClients.size > 0) this._send(this.globalChatClients, msg);
  }

  broadcastAll(data: Record<string, unknown>) {
    if (this.allClients.size === 0) return;
    const msg = JSON.stringify(data);
    this._send(this.allClients, msg);
  }

  /**
   * Broadcast a `task_status` envelope to all-clients (matches the existing
   * `wsManager.broadcastAll({ type: "task_status", taskId, status })` shape
   * scattered across task-executor sites).
   */
  broadcastTaskStatus(taskId: number, status: string, extra?: Record<string, unknown>) {
    this.broadcastAll({ type: "task_status", taskId, status, ...(extra ?? {}) });
  }

  /**
   * Broadcast a `chat_status` envelope to chat-scoped + global clients
   * (matches the existing `wsManager.broadcastChat(chatId, { type: "chat_status", status })`
   * shape scattered across chat-executor sites).
   */
  broadcastChatStatus(chatId: number, status: string, extra?: Record<string, unknown>) {
    this.broadcastChat(chatId, { type: "chat_status", status, ...(extra ?? {}) });
  }

  /**
   * Broadcast a `chat_assistant_final` envelope to global chat-list clients only.
   *
   * Per-chat scoped clients are intentionally NOT notified — they already react to
   * `session_ended` and refetch their message stream. The frame carries no body /
   * preview / title; consumers fetch what they need by id.
   */
  broadcastChatAssistantFinal(chatId: number, messageId: number): void {
    if (this.globalChatClients.size === 0) return;
    const frame = JSON.stringify({
      type: "chat_assistant_final",
      chat_id: chatId,
      message_id: messageId,
      ts: Date.now(),
    });
    this._send(this.globalChatClients, frame);
  }

  private _send(clients: Iterable<WSClient>, msg: string) {
    for (const client of clients) {
      if (client.readyState === 1) {
        try { client.send(msg); } catch { /* dead socket */ }
      }
    }
  }

  get clientCount(): number {
    return this.allClients.size;
  }

  closeAll(): void {
    for (const client of this.allClients) {
      try {
        if (client.readyState === 1 && typeof (client as any).close === "function") {
          (client as any).close();
        }
      } catch { /* ignore */ }
    }
    this.taskClients.clear();
    this.chatClients.clear();
    this.globalChatClients.clear();
    this.allClients.clear();
  }
}

export const wsManager = new WSManager();
