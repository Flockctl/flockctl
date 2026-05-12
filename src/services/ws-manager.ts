import { EventEmitter } from "events";
import { normalizeTimestampsDeep } from "../lib/normalize-timestamps.js";

interface WSClient {
  send(data: string): void;
  readyState: number;
}

/**
 * Serialise a broadcast frame after normalising any leaked SQLite-bare
 * timestamp strings to ISO-Z. Mirrors the HTTP-response middleware in
 * `server.ts` so WebSocket consumers receive the same `2026-04-27T17:04:51Z`
 * shape as REST consumers — without this the chat/list/inbox panels would
 * skew by the user's UTC offset on every push frame that carries a DB row
 * (assistant-final, status, attention-source updates, etc.). Idempotent on
 * already-normalised values, so safe to apply unconditionally.
 */
function serialiseFrame(payload: unknown): string {
  return JSON.stringify(normalizeTimestampsDeep(payload));
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
 * `wakeup_status` envelope. Emitted whenever a `scheduled_wakeups` row
 * transitions state — `pending` (newly recorded), `fired`, `cancelled`,
 * or `missed` (sweep recovered the row past its grace window).
 *
 * Goes to global chat-list clients so the inbox view can update its
 * countdown / badge in real time without a refetch. Per-chat scoped
 * clients ALSO receive it (the broadcast helper fans to both) so the
 * open chat panel can swap its "scheduled — resuming in 4:12" chip in
 * place when the worker fires.
 *
 * Carries the small subset of row fields the UI actually needs; full
 * details (prompt body, claude_session_id) stay server-side and the UI
 * looks them up by id when the operator clicks into a row.
 */
export interface WakeupStatusFrame {
  type: "wakeup_status";
  wakeup_id: string;
  chat_id: number | null;
  task_id: number | null;
  status: "pending" | "fired" | "cancelled" | "missed";
  fire_at: number;
  reason: string | null;
  /** Unix epoch milliseconds at broadcast time. */
  ts: number;
}

/**
 * Discriminated union of all typed broadcast envelopes the WSManager
 * emits. Members are appended additively as new broadcast types ship;
 * the client-side counterpart in `ui/src/lib/ws.ts` (`MessageType`)
 * extends in lockstep.
 */
export type WsBroadcastFrame = ChatAssistantFinalFrame | WakeupStatusFrame;

/**
 * Lifecycle callback fired on the FIRST project subscriber's
 * `addProjectClient` call (no matter how many tasks/chats are also wired
 * up). Used by the FS watcher to lazily start a chokidar watcher only
 * when at least one UI tab is actually listening for `fs.changed` frames
 * — saves inotify FDs on idle projects.
 */
export type ProjectSubscriberHook = (
  projectId: string,
) => void | Promise<void>;

/**
 * Workspace subscriber hooks mirror the project ones. A workspace
 * subscription scopes a client to every event emitted for the
 * workspace as a whole (e.g. an `fs.changed` frame at workspace level
 * for the workspace AGENTS.md tree). The same lazy-start /
 * release-on-last-unsubscriber contract applies.
 */
export type WorkspaceSubscriberHook = (
  workspaceId: string,
) => void | Promise<void>;

/**
 * In-band subscribe protocol envelope. After the WS handshake completes
 * (and `?token=` bearer auth has already been enforced at the upgrade
 * boundary in `server.ts`), the client may send one of these JSON
 * messages to scope itself to a project or workspace topic.
 *
 * Wire shape:
 *   { kind: "subscribe", topic: "fs", projectId: "<uuid>" }
 *   { kind: "subscribe", topic: "fs", workspaceId: "<uuid>" }
 *
 * `topic` is currently a single literal (`"fs"`) but is broken out so
 * future broadcast channels (e.g. `"git"`, `"missions"`) can plug in
 * without a wire-format break — the routing decision lives in
 * `handleSubscribeMessage` below.
 */
export interface SubscribeMessage {
  kind: "subscribe";
  topic: "fs";
  projectId?: string;
  workspaceId?: string;
}

export interface SubscribeResult {
  ok: boolean;
  /** Set when ok=false; populated for tests / observability. */
  reason?: string;
  /** Set when ok=true; tells the caller which scope was attached. */
  scope?: { kind: "project"; projectId: string } | { kind: "workspace"; workspaceId: string };
}

class WSManager extends EventEmitter {
  private taskClients = new Map<number, Set<WSClient>>();
  private chatClients = new Map<number, Set<WSClient>>();
  private projectClients = new Map<string, Set<WSClient>>();
  private workspaceClients = new Map<string, Set<WSClient>>();
  private globalChatClients = new Set<WSClient>();
  private allClients = new Set<WSClient>();

  // Lifecycle hooks for project subscriptions. Set by
  // `setProjectSubscriberHooks` at module wire-up time (server-entry /
  // fs-watcher boot). Watcher attaches/detaches a chokidar instance lazily
  // — see fs-watcher.ts.
  private onProjectFirstSubscriber: ProjectSubscriberHook | null = null;
  private onProjectLastUnsubscriber: ProjectSubscriberHook | null = null;

  // Same lifecycle pattern, scoped to workspace ids.
  private onWorkspaceFirstSubscriber: WorkspaceSubscriberHook | null = null;
  private onWorkspaceLastUnsubscriber: WorkspaceSubscriberHook | null = null;

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

  /**
   * Register a WS client interested in `fs.changed` (and similar) frames
   * for a single project. On the FIRST subscriber for a given projectId
   * fires `onProjectFirstSubscriber` (fire-and-forget — failure to start
   * the watcher must not block the WS open handshake).
   */
  addProjectClient(projectId: string, ws: WSClient) {
    let set = this.projectClients.get(projectId);
    const isFirst = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.projectClients.set(projectId, set);
    }
    set.add(ws);
    this.allClients.add(ws);
    if (isFirst && this.onProjectFirstSubscriber) {
      void Promise.resolve(this.onProjectFirstSubscriber(projectId)).catch(
        (err) => {
          console.warn(
            `[ws-manager] onProjectFirstSubscriber for ${projectId} threw:`,
            err,
          );
        },
      );
    }
  }

  /**
   * Register a WS client interested in workspace-scoped frames. Mirrors
   * `addProjectClient` — same lazy first-subscriber lifecycle hook.
   */
  addWorkspaceClient(workspaceId: string, ws: WSClient) {
    let set = this.workspaceClients.get(workspaceId);
    const isFirst = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.workspaceClients.set(workspaceId, set);
    }
    set.add(ws);
    this.allClients.add(ws);
    if (isFirst && this.onWorkspaceFirstSubscriber) {
      void Promise.resolve(
        this.onWorkspaceFirstSubscriber(workspaceId),
      ).catch((err) => {
        console.warn(
          `[ws-manager] onWorkspaceFirstSubscriber for ${workspaceId} threw:`,
          err,
        );
      });
    }
  }

  /**
   * Defensive sweep: remove every socket whose `readyState` is no longer
   * `OPEN` (1) from every channel set. Normally `removeClient(ws)` is fired
   * by the WS layer's `close` listener — this method covers the case where
   * the listener never wires (HMR remount in dev, exception during open,
   * tests that bypass the upgrade handler) so dead sockets don't accumulate
   * forever. Idempotent and safe to call from any scheduling point.
   */
  sweepClosedClients(): number {
    const dead: WSClient[] = [];
    for (const ws of this.allClients) {
      // ws.readyState === 1 means OPEN per the WebSocket spec; we treat
      // anything else (CLOSING=2, CLOSED=3) as dead. The Node WS-binding
      // sometimes leaves CLOSED sockets behind without firing `close`.
      if (ws.readyState !== 1) dead.push(ws);
    }
    for (const ws of dead) this.removeClient(ws);
    return dead.length;
  }

  removeClient(ws: WSClient) {
    for (const [taskId, set] of this.taskClients) {
      if (set.delete(ws) && set.size === 0) this.taskClients.delete(taskId);
    }
    for (const [chatId, set] of this.chatClients) {
      if (set.delete(ws) && set.size === 0) this.chatClients.delete(chatId);
    }
    // Project-scoped removal — also fires the last-unsubscriber hook so the
    // watcher can release its inotify FDs.
    const drainedProjects: string[] = [];
    for (const [projectId, set] of this.projectClients) {
      if (set.delete(ws) && set.size === 0) {
        this.projectClients.delete(projectId);
        drainedProjects.push(projectId);
      }
    }
    // Workspace-scoped removal mirrors the project path.
    const drainedWorkspaces: string[] = [];
    for (const [workspaceId, set] of this.workspaceClients) {
      if (set.delete(ws) && set.size === 0) {
        this.workspaceClients.delete(workspaceId);
        drainedWorkspaces.push(workspaceId);
      }
    }
    this.globalChatClients.delete(ws);
    this.allClients.delete(ws);
    if (this.onProjectLastUnsubscriber) {
      for (const projectId of drainedProjects) {
        void Promise.resolve(this.onProjectLastUnsubscriber(projectId)).catch(
          (err) => {
            console.warn(
              `[ws-manager] onProjectLastUnsubscriber for ${projectId} threw:`,
              err,
            );
          },
        );
      }
    }
    if (this.onWorkspaceLastUnsubscriber) {
      for (const workspaceId of drainedWorkspaces) {
        void Promise.resolve(
          this.onWorkspaceLastUnsubscriber(workspaceId),
        ).catch((err) => {
          console.warn(
            `[ws-manager] onWorkspaceLastUnsubscriber for ${workspaceId} threw:`,
            err,
          );
        });
      }
    }
  }

  /**
   * Wire connect/disconnect hooks for project subscribers. Intended to be
   * called once at server boot (e.g. by fs-watcher's module init) so the
   * watcher can start lazily on first subscribe and release FDs on last
   * unsubscribe. Calling again replaces the previous hooks.
   */
  setProjectSubscriberHooks(hooks: {
    onFirstSubscriber?: ProjectSubscriberHook | null;
    onLastUnsubscriber?: ProjectSubscriberHook | null;
  }): void {
    this.onProjectFirstSubscriber = hooks.onFirstSubscriber ?? null;
    this.onProjectLastUnsubscriber = hooks.onLastUnsubscriber ?? null;
  }

  /**
   * Workspace counterpart to `setProjectSubscriberHooks`. Calling again
   * replaces the previous hooks. Either field can be null to clear.
   */
  setWorkspaceSubscriberHooks(hooks: {
    onFirstSubscriber?: WorkspaceSubscriberHook | null;
    onLastUnsubscriber?: WorkspaceSubscriberHook | null;
  }): void {
    this.onWorkspaceFirstSubscriber = hooks.onFirstSubscriber ?? null;
    this.onWorkspaceLastUnsubscriber = hooks.onLastUnsubscriber ?? null;
  }

  /**
   * Parse and dispatch an in-band subscribe envelope. The WS endpoint
   * has already authenticated the connection via `?token=` bearer auth
   * (see `verifyWsToken` in `src/middleware/remote-auth.ts`), so this
   * helper does NOT re-check auth — auth is per-connection, not per-
   * message.
   *
   * The contract is intentionally narrow:
   *
   *   { kind: "subscribe", topic: "fs", projectId: "<uuid>" }
   *   { kind: "subscribe", topic: "fs", workspaceId: "<uuid>" }
   *
   * - `kind` MUST be `"subscribe"`. Anything else is rejected.
   * - `topic` MUST be `"fs"` (today's only routable topic).
   * - Exactly ONE of `projectId` / `workspaceId` MUST be present and
   *   non-empty. Both-or-neither is a parse error — the caller can
   *   close the socket on `ok=false` if it wants strict behaviour.
   *
   * On success the helper attaches `ws` to the appropriate scope
   * (project OR workspace) and returns the resolved scope so the caller
   * can ack / log. Subsequent broadcasts via `broadcastToProject` /
   * `broadcastToWorkspace` will reach this client.
   */
  handleSubscribeMessage(
    ws: WSClient,
    raw: unknown,
  ): SubscribeResult {
    let parsed: SubscribeMessage;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw) as SubscribeMessage;
      } catch {
        return { ok: false, reason: "invalid_json" };
      }
    } else if (raw && typeof raw === "object") {
      parsed = raw as SubscribeMessage;
    } else {
      return { ok: false, reason: "invalid_envelope" };
    }

    if (parsed.kind !== "subscribe") {
      return { ok: false, reason: "unknown_kind" };
    }
    if (parsed.topic !== "fs") {
      return { ok: false, reason: "unknown_topic" };
    }

    const hasProject =
      typeof parsed.projectId === "string" && parsed.projectId.length > 0;
    const hasWorkspace =
      typeof parsed.workspaceId === "string" && parsed.workspaceId.length > 0;

    if (hasProject && hasWorkspace) {
      return { ok: false, reason: "ambiguous_scope" };
    }
    if (!hasProject && !hasWorkspace) {
      return { ok: false, reason: "missing_scope" };
    }

    if (hasProject) {
      const projectId = parsed.projectId as string;
      this.addProjectClient(projectId, ws);
      return { ok: true, scope: { kind: "project", projectId } };
    }
    const workspaceId = parsed.workspaceId as string;
    this.addWorkspaceClient(workspaceId, ws);
    return { ok: true, scope: { kind: "workspace", workspaceId } };
  }

  /**
   * Project-scoped broadcast. Fans the frame to every client that called
   * `addProjectClient(projectId, ws)`. Intended for FS-watcher events
   * (`fs.changed`, `fs.watch.degraded`) but the contract is generic — any
   * frame the project page wants to receive without subscribing per-task
   * or per-chat goes here.
   */
  broadcastToProject(projectId: string, data: Record<string, unknown>) {
    const set = this.projectClients.get(projectId);
    if (!set || set.size === 0) return;
    const msg = serialiseFrame({ ...data, projectId });
    this._send(set, msg);
  }

  /**
   * Workspace-scoped broadcast. Mirrors `broadcastToProject` — fans the
   * frame to every client that called `addWorkspaceClient(workspaceId,
   * ws)` (or subscribed in-band via `handleSubscribeMessage` with a
   * `workspaceId`). Used for workspace-scoped FS frames and the planned
   * `git`/`missions` workspace-level topics.
   */
  broadcastToWorkspace(workspaceId: string, data: Record<string, unknown>) {
    const set = this.workspaceClients.get(workspaceId);
    if (!set || set.size === 0) return;
    const msg = serialiseFrame({ ...data, workspaceId });
    this._send(set, msg);
  }

  broadcast(taskId: number, data: Record<string, unknown>) {
    const set = this.taskClients.get(taskId);
    if (!set || set.size === 0) return;
    const msg = serialiseFrame({ ...data, taskId });
    this._send(set, msg);
  }

  broadcastChat(chatId: number, data: Record<string, unknown>) {
    const msg = serialiseFrame({ ...data, chatId });
    const scoped = this.chatClients.get(chatId);
    if (scoped && scoped.size > 0) this._send(scoped, msg);
    if (this.globalChatClients.size > 0) this._send(this.globalChatClients, msg);
  }

  broadcastAll(data: Record<string, unknown>) {
    if (this.allClients.size === 0) return;
    const msg = serialiseFrame(data);
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
    const frame = serialiseFrame({
      type: "chat_assistant_final",
      chat_id: chatId,
      message_id: messageId,
      ts: Date.now(),
    });
    this._send(this.globalChatClients, frame);
  }

  /**
   * Broadcast a `wakeup_status` envelope. Fans to chat-scoped clients
   * (so the open chat panel updates its countdown chip), task-scoped
   * clients (same idea for task views), AND global chat-list clients
   * (so the inbox sees the state change without polling).
   */
  broadcastWakeupStatus(frame: Omit<WakeupStatusFrame, "type" | "ts">): void {
    const payload: WakeupStatusFrame = {
      ...frame,
      type: "wakeup_status",
      ts: Date.now(),
    };
    const msg = serialiseFrame(payload);

    if (frame.chat_id !== null) {
      const scoped = this.chatClients.get(frame.chat_id);
      if (scoped && scoped.size > 0) this._send(scoped, msg);
    }
    if (frame.task_id !== null) {
      const scoped = this.taskClients.get(frame.task_id);
      if (scoped && scoped.size > 0) this._send(scoped, msg);
    }
    if (this.globalChatClients.size > 0) {
      this._send(this.globalChatClients, msg);
    }
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
    this.projectClients.clear();
    this.workspaceClients.clear();
    this.globalChatClients.clear();
    this.allClients.clear();
  }
}

export const wsManager = new WSManager();
