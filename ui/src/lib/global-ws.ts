/**
 * global-ws — singleton WebSocket connection manager for project-scoped
 * topic subscriptions.
 *
 * The chat-list `useGlobalWs` hook (in `lib/hooks/global-ws.ts`) covers
 * the broadcast-all fan-out used by the chat-list live indicators. This
 * module is its sibling for the in-band `subscribe` protocol exposed by
 * `WSManager.handleSubscribeMessage` on the server: a client opens one
 * shared socket, sends `{kind:"subscribe", topic:"fs", projectId}`
 * envelopes for every project tab it has open, and demuxes incoming
 * `fs.changed` (and friends) frames to the right per-project handlers.
 *
 * Design rationale:
 *
 * - **Singleton, not React-scoped.** The Code mode mounts/unmounts as
 *   the user switches tabs; we do not want a churn of TCP sockets or a
 *   resubscribe storm. The singleton keeps one socket per active server
 *   and reference-counts subscriptions per (topic, projectId).
 *
 * - **Server-id aware.** Same trick `useWebSocket` uses: subscribe to
 *   `subscribeActiveServerId` so that a server switch tears down the
 *   socket and reconnects against the new base URL. The handler set is
 *   preserved across the swap and re-subscribed on the new connection.
 *
 * - **Resubscribe on reconnect.** The reconnect logic in
 *   `WebSocketClient` already re-opens with exponential backoff. On
 *   each reopen we re-send the `subscribe` envelopes so a transient
 *   network blip does not silently drop the project's fs stream.
 *
 * - **Frame routing.** Server-side broadcasts include `projectId` (set
 *   by `wsManager.broadcastToProject`). We dispatch by that field; an
 *   `fs.changed` frame missing `projectId` is dropped (defensive — the
 *   server always populates it).
 */
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  WebSocketClient,
  ConnectionState,
  type WSMessage,
  getWsBaseUrl,
} from "./ws";
import { subscribeActiveServerId } from "./server-store";

/** A single `fs.changed` frame as broadcast by `services/fs-watcher.ts`. */
export interface FsChangedFrame {
  kind: "fs.changed";
  projectId: string;
  path: string;
  sha: string | null;
  event: "add" | "change" | "unlink";
  source: "agent" | "external";
  ts: number;
}

export type FsChangedHandler = (frame: FsChangedFrame) => void;

/**
 * Coalesced "something in `.git` moved" frame. The server-side watcher
 * fires this whenever `.git/HEAD`, `.git/index`, or `.git/refs/heads/*`
 * changes — the UI's contract is "porcelain peek + branches list are
 * stale, refetch them." No per-file detail lives on the wire.
 */
export interface GitStatusChangedFrame {
  kind: "git-status-changed";
  projectId: string;
  ts: number;
}

export type GitStatusChangedHandler = (frame: GitStatusChangedFrame) => void;

/**
 * Internal — narrow guard that yields a typed `FsChangedFrame` from the
 * over-the-wire JSON. Anything that doesn't match the contract is
 * silently dropped (server-side bug, partial deploy, foreign frame).
 */
function isFsChangedFrame(data: unknown): data is FsChangedFrame {
  if (!data || typeof data !== "object") return false;
  const f = data as Record<string, unknown>;
  return (
    f.kind === "fs.changed" &&
    typeof f.projectId === "string" &&
    typeof f.path === "string" &&
    (typeof f.sha === "string" || f.sha === null) &&
    (f.event === "add" || f.event === "change" || f.event === "unlink") &&
    (f.source === "agent" || f.source === "external") &&
    typeof f.ts === "number"
  );
}

function isGitStatusChangedFrame(data: unknown): data is GitStatusChangedFrame {
  if (!data || typeof data !== "object") return false;
  const f = data as Record<string, unknown>;
  return (
    f.kind === "git-status-changed" &&
    typeof f.projectId === "string" &&
    typeof f.ts === "number"
  );
}

/**
 * The WS path the singleton talks to. `/ws/ui/fs` is the natural fit for
 * the `subscribe` protocol — `WSManager.handleSubscribeMessage` is the
 * server-side dispatcher and is endpoint-agnostic, so this stays
 * backwards-compatible if the route alias changes.
 */
const FS_WS_PATH = "/ws/ui/fs";

class GlobalWsManager {
  private client: WebSocketClient | null = null;
  /** Reference count of active fs subscriptions per projectId. */
  private fsRefcount = new Map<string, number>();
  /** Registered handlers per projectId — fan-out to UI consumers. */
  private fsHandlers = new Map<string, Set<FsChangedHandler>>();
  /**
   * git-status-changed handlers per projectId. Reuses the same
   * subscribe envelope on the wire (`topic: "fs"`) — the server's git
   * watcher broadcasts onto the same project topic the fs watcher uses,
   * so a single subscribe gives us both streams.
   */
  private gitHandlers = new Map<string, Set<GitStatusChangedHandler>>();
  /** Cached unsubscribe for the active-server listener. */
  private serverUnsub: (() => void) | null = null;
  /**
   * Tracks whether the underlying socket is OPEN. Exposed via
   * {@link useWsConnected} so consumers can decide between live
   * invalidation and polling. Updated on every `onOpen` / `onClose`
   * (including reconnect transitions).
   */
  private connected = false;
  private connectionListeners = new Set<() => void>();
  /**
   * Listeners notified when the socket transitions from disconnected →
   * connected after at least one prior disconnect. The very first
   * `setConnected(true)` after process boot does NOT fire — there's no
   * "drift" to reconcile when nothing was ever connected. Subsequent
   * reconnects (network blip, server switch, manual close → reopen)
   * each fire the listeners exactly once.
   *
   * Used by the reconnect-drift handler to refetch open file shas and
   * raise a per-tab banner when disk has moved while we were offline.
   */
  private reconnectListeners = new Set<() => void>();
  /**
   * True once we've seen at least one disconnect after a successful
   * connect — the gate that distinguishes "first connect" from
   * "reconnect" so the drift-check only runs in the latter case.
   */
  private hasDisconnected = false;
  /**
   * Build a WS URL from the current base; injectable so unit tests can
   * pin a deterministic value without touching `window.location`.
   */
  private urlFactory: () => string = () => `${getWsBaseUrl()}${FS_WS_PATH}`;

  /**
   * Test seam — replace the URL factory and reset internal state. Used
   * by the unit-test suite to point the singleton at a fake WebSocket
   * server. Production code never touches this.
   */
  __setUrlFactoryForTests(factory: () => string): void {
    this.urlFactory = factory;
  }

  /**
   * Test seam — full reset: tears the socket down, clears refcounts and
   * handlers, drops the active-server listener. Mirrors what
   * `useEffect` cleanup would do across all React subscribers.
   */
  __resetForTests(): void {
    this.client?.close();
    this.client = null;
    this.fsRefcount.clear();
    this.fsHandlers.clear();
    this.gitHandlers.clear();
    this.serverUnsub?.();
    this.serverUnsub = null;
    this.setConnected(false);
    this.connectionListeners.clear();
    this.reconnectListeners.clear();
    this.hasDisconnected = false;
  }

  /**
   * Test-only — flip the internal connected flag and notify
   * subscribers. Used by the unit test to probe the
   * `useWsConnected` → polling-fallback transition without standing up
   * a real WebSocket.
   */
  __setConnectedForTests(value: boolean): void {
    this.setConnected(value);
  }

  /**
   * Subscribe to `fs.changed` frames for `projectId`. Returns an
   * unsubscribe function that decrements the refcount and tears the
   * connection down on the last subscriber.
   *
   * Idempotent on the wire — a second handler for the same projectId
   * does NOT trigger another `subscribe` envelope (the server already
   * has us in its set).
   */
  subscribeFs(projectId: string, handler: FsChangedHandler): () => void {
    let handlers = this.fsHandlers.get(projectId);
    if (!handlers) {
      handlers = new Set();
      this.fsHandlers.set(projectId, handlers);
    }
    handlers.add(handler);

    const prevCount = this.fsRefcount.get(projectId) ?? 0;
    this.fsRefcount.set(projectId, prevCount + 1);

    this.ensureClient();
    if (prevCount === 0) {
      this.sendSubscribe(projectId);
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const set = this.fsHandlers.get(projectId);
      set?.delete(handler);
      const next = (this.fsRefcount.get(projectId) ?? 1) - 1;
      if (next <= 0) {
        this.fsRefcount.delete(projectId);
        this.fsHandlers.delete(projectId);
      } else {
        this.fsRefcount.set(projectId, next);
      }
      // Last subscriber overall — tear the socket down so an idle UI
      // doesn't pin a connection forever.
      if (this.fsRefcount.size === 0 && this.gitHandlers.size === 0) {
        this.teardown();
      }
    };
  }

  /**
   * Subscribe to `git-status-changed` frames for `projectId`. Reuses
   * the same shared socket the fs subscription uses — git broadcasts
   * are routed through the project topic, so the server already knows
   * to fan us in once an fs subscribe envelope has been sent.
   *
   * For decoupled correctness we still send a `subscribe` envelope on
   * the FIRST git handler if no fs subscriber exists for the same
   * projectId yet (otherwise the project's WS bucket would be empty
   * server-side). The refcount is tracked separately so a teardown of
   * fs handlers does not silently kill the git stream.
   */
  subscribeGit(
    projectId: string,
    handler: GitStatusChangedHandler,
  ): () => void {
    let handlers = this.gitHandlers.get(projectId);
    const isFirstForProject = !handlers;
    if (!handlers) {
      handlers = new Set();
      this.gitHandlers.set(projectId, handlers);
    }
    handlers.add(handler);

    this.ensureClient();
    // If no fs subscriber has registered for this projectId yet, we
    // still need a `subscribe` envelope on the wire — both streams
    // share the project topic.
    if (isFirstForProject && (this.fsRefcount.get(projectId) ?? 0) === 0) {
      this.sendSubscribe(projectId);
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const set = this.gitHandlers.get(projectId);
      set?.delete(handler);
      if (set && set.size === 0) {
        this.gitHandlers.delete(projectId);
      }
      if (this.fsRefcount.size === 0 && this.gitHandlers.size === 0) {
        this.teardown();
      }
    };
  }

  /**
   * Subscribe to socket connection-state changes. The listener is
   * called whenever the OPEN/CLOSED bit flips; consumers (e.g.
   * {@link useWsConnected}) read the current value via
   * {@link isConnected}. Returns an unsubscribe.
   *
   * Note: unlike the fs/git subscription methods, this does NOT open
   * the socket — `subscribeConnected` is purely observational. A
   * consumer that wants to know when the socket is open enough to
   * receive frames is implicitly waiting on someone else
   * (e.g. `useFsChangedHandler`) to drive the connection.
   */
  subscribeConnected(listener: () => void): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  isConnected = (): boolean => this.connected;

  /**
   * Subscribe to reconnect events — fired whenever the socket flips
   * from disconnected → connected AFTER having been disconnected at
   * least once. Use this to refetch state that may have drifted while
   * we were offline (e.g. file shas for open editor tabs).
   *
   * Unlike `subscribeConnected`, this is edge-triggered (one call per
   * transition, not per state read). The very first connect after
   * process boot does not fire the listeners — callers that also need
   * to seed initial state on first-connect should drive that path
   * separately.
   *
   * Returns an unsubscribe.
   */
  subscribeReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => {
      this.reconnectListeners.delete(listener);
    };
  }

  /**
   * Test-only — synthesise a reconnect transition (false → true) so
   * the unit test can drive the drift-check handler without standing
   * up a real socket. Bypasses the `hasDisconnected` gate so the
   * reconnect listeners fire unconditionally.
   */
  __fireReconnectForTests(): void {
    for (const l of this.reconnectListeners) {
      try {
        l();
      } catch (err) {
        console.error("[global-ws] reconnect listener threw:", err);
      }
    }
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return;
    const wasConnected = this.connected;
    this.connected = value;
    for (const l of this.connectionListeners) {
      try {
        l();
      } catch (err) {
        // Defensive — a single bad listener must not nuke the loop.

        console.error("[global-ws] connection listener threw:", err);
      }
    }
    // Edge-trigger reconnect listeners on the disconnect → connect
    // transition, but only after we've seen at least one disconnect.
    if (!value && wasConnected) {
      this.hasDisconnected = true;
      return;
    }
    if (value && this.hasDisconnected) {
      for (const l of this.reconnectListeners) {
        try {
          l();
        } catch (err) {
          // Defensive — a single bad listener must not nuke the loop.

          console.error("[global-ws] reconnect listener threw:", err);
        }
      }
    }
  }

  /** Internal — open a new WS client if one isn't already live. */
  private ensureClient(): void {
    if (this.client) return;
    if (!this.serverUnsub) {
      // A server switch: drop the socket; the next `ensureClient` will
      // rebuild it against the new base URL and re-send the active
      // `subscribe` envelopes.
      this.serverUnsub = subscribeActiveServerId(() => {
        if (this.fsRefcount.size === 0 && this.gitHandlers.size === 0) return;
        this.client?.close();
        this.client = null;
        this.setConnected(false);
        this.ensureClient();
        this.resubscribeAll();
      });
    }
    const client = new WebSocketClient({
      url: this.urlFactory(),
      reconnect: true,
      onOpen: () => {
        // (Re)send subscribes after every successful (re)connect — the
        // server forgets us on close.
        this.resubscribeAll();
        this.setConnected(true);
      },
      onClose: () => {
        // Auto-reconnect runs separately; flip the bit so consumers can
        // resume polling while the socket is down.
        this.setConnected(false);
      },
      onMessage: (msg) => this.dispatch(msg),
    });
    this.client = client;
    client.connect();
  }

  /** Internal — close and clear cached references. */
  private teardown(): void {
    this.client?.close();
    this.client = null;
    this.serverUnsub?.();
    this.serverUnsub = null;
    this.setConnected(false);
  }

  private sendSubscribe(projectId: string): void {
    if (!this.client) return;
    if (this.client.state !== ConnectionState.OPEN) {
      // Not yet open — `onOpen` will resubscribe once the socket flips.
      return;
    }
    // The wire envelope here intentionally bypasses the typed `WSMessage`
    // shape — the server's subscribe protocol uses `kind` (not `type`),
    // and shoehorning that into `WSMessage` would muddy chat semantics.
    this.client.send({
      kind: "subscribe",
      topic: "fs",
      projectId,
    } as unknown as WSMessage);
  }

  private resubscribeAll(): void {
    // Union of fs + git project ids — both streams share the project
    // topic envelope, so one `subscribe` per id covers both.
    const projectIds = new Set<string>();
    for (const id of this.fsRefcount.keys()) projectIds.add(id);
    for (const id of this.gitHandlers.keys()) projectIds.add(id);
    for (const projectId of projectIds) {
      this.sendSubscribe(projectId);
    }
  }

  private dispatch(msg: WSMessage): void {
    // Frames coming back over the wire are `{kind, projectId, ...}` —
    // `WSMessage`'s `{type, payload}` shape is enforced for chat traffic
    // only. Treat the parsed JSON as `unknown` and route by `kind`.
    const data = msg as unknown;
    if (isFsChangedFrame(data)) {
      const handlers = this.fsHandlers.get(data.projectId);
      if (!handlers || handlers.size === 0) return;
      for (const h of handlers) {
        try {
          h(data);
        } catch (err) {
          // A single bad handler must not nuke the dispatch loop.

          console.error("[global-ws] fs.changed handler threw:", err);
        }
      }
      return;
    }
    if (isGitStatusChangedFrame(data)) {
      const handlers = this.gitHandlers.get(data.projectId);
      if (!handlers || handlers.size === 0) return;
      for (const h of handlers) {
        try {
          h(data);
        } catch (err) {
          // A single bad handler must not nuke the dispatch loop.

          console.error("[global-ws] git-status-changed handler threw:", err);
        }
      }
      return;
    }
  }
}

/**
 * The shared singleton instance. Importable from anywhere in the UI;
 * React layers use the `useFsChangedHandler` hook in
 * `lib/handlers/fs-changed.ts` rather than touching this directly.
 */
export const globalWs = new GlobalWsManager();

/**
 * React hook — returns `true` while the singleton's underlying
 * WebSocket is in the OPEN state, `false` otherwise (CONNECTING,
 * CLOSED, or no socket yet).
 *
 * Consumers use this to swap between live invalidation (driven by
 * server-pushed frames) and a polling fallback while the socket is
 * down. The hook is built on `useSyncExternalStore` so it stays in
 * lockstep with the singleton's state without introducing a render
 * loop — every flip notifies subscribers exactly once.
 *
 * NOTE: This hook is purely observational. It does NOT open the
 * socket on mount — a parallel `useFsChangedHandler` (or
 * `useGitStatusChangedHandler`) somewhere in the same tree is what
 * drives the connection. A consumer that mounts only `useWsConnected`
 * will see `false` indefinitely, which is the right answer (no one is
 * driving the wire, so polling is the only viable strategy).
 */
export function useWsConnected(): boolean {
  return useSyncExternalStore(
    (listener) => globalWs.subscribeConnected(listener),
    () => globalWs.isConnected(),
    // SSR snapshot — never connected at hydration time. A real socket
    // boot in the post-hydration `useEffect` flips the bit later.
    () => false,
  );
}

/**
 * Return `true` when `document.hidden` is `false`. Used to pause
 * background polling on hidden tabs (visibilitychange-driven). Stays
 * `true` in SSR / non-browser contexts so server-rendered code paths
 * don't accidentally disable polling.
 */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState<boolean>(
    typeof document === "undefined" ? true : !document.hidden,
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/**
 * Compute a WS-aware `refetchInterval` value for `useQuery`.
 *
 * Returns `false` (no polling) when:
 *   - the tab is hidden (no point polling when nobody's watching), OR
 *   - the global WebSocket is connected (server-pushed cache
 *     invalidation owns freshness; polling would be duplicate work).
 *
 * Otherwise returns the supplied fallback interval. Mirrors the
 * pattern in `useGitStatusForTree` which had this logic inlined; the
 * helper centralises the rule so the audit-flagged `refetchInterval:
 * 10_000` spots (tasks list, kanban, schedules, project subscriptions)
 * can adopt it with a one-line edit per call site.
 */
export function useWsAwarePolling(fallbackMs: number): number | false {
  const visible = useDocumentVisible();
  const connected = useWsConnected();
  if (!visible) return false;
  if (connected) return false;
  return fallbackMs;
}
