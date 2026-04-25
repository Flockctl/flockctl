import { useEffect, useRef, useCallback, useState, useSyncExternalStore } from "react";
import { getApiBaseUrl } from "./api";
import {
  getActiveServerId,
  subscribeActiveServerId,
} from "./server-store";

// --- Message types mirroring shared/flockctl_shared/protocol.py ---

export const MessageType = {
  REGISTER: "register",
  HEARTBEAT: "heartbeat",
  HEARTBEAT_ACK: "heartbeat_ack",
  DISCONNECT: "disconnect",
  TASK_ASSIGN: "task_assign",
  TASK_STARTED: "task_started",
  LOG_LINE: "log_line",
  TASK_DONE: "task_done",
  TASK_METRICS: "task_metrics",
  TASK_STATUS: "task_status",
  PERMISSION_REQUEST: "permission_request",
  PERMISSION_RESOLVED: "permission_resolved",
  SESSION_STARTED: "session_started",
  SESSION_ENDED: "session_ended",
  TODO_UPDATED: "todo_updated",
  AGENT_QUESTION: "agent_question",
  AGENT_QUESTION_RESOLVED: "agent_question_resolved",
  // Chat-only: emitted by chat-executor.ts whenever a file-modifying tool
  // call appends entries to the chat's file_edits journal. Drives the
  // "Changes" card at the bottom of <ChatConversation>.
  CHAT_DIFF_UPDATED: "chat_diff_updated",
  // Chat-only: emitted when `PATCH /chats/:id` mutates the permission mode
  // of an in-flight session. Payload `{ chat_id, previous, current }`. The
  // UI updates the cached chat's `permission_mode` in-place so the selector
  // reflects the new value without a follow-up GET. Pending-permission
  // cards auto-resolved by the swap disappear via the `permission_resolved`
  // frames emitted one-per-request by the backend.
  CHAT_PERMISSION_MODE_CHANGED: "chat_permission_mode_changed",
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export interface WSMessage {
  type: MessageType;
  payload: Record<string, unknown>;
}

// --- Connection state ---

export const ConnectionState = {
  CONNECTING: "connecting",
  OPEN: "open",
  CLOSING: "closing",
  CLOSED: "closed",
} as const;
export type ConnectionState =
  (typeof ConnectionState)[keyof typeof ConnectionState];

// --- WebSocket URL helper ---

/** Derive the WebSocket base URL from the HTTP API base URL. */
export function getWsBaseUrl(): string {
  const base = getApiBaseUrl().replace(/\/$/, "");
  if (base.startsWith("https://")) {
    return base.replace("https://", "wss://");
  }
  if (base.startsWith("http://")) {
    return base.replace("http://", "ws://");
  }
  // Relative path (e.g. "/api" or "") — resolve against current origin
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${base}`;
}

// --- Reconnecting WebSocket client ---

export interface WebSocketClientOptions {
  /** Full WebSocket URL (e.g. ws://localhost:8000/ws/worker). */
  url: string;
  /** Called on every parsed message. */
  onMessage?: (msg: WSMessage) => void;
  /** Called when connection opens. */
  onOpen?: () => void;
  /** Called when connection closes. */
  onClose?: (event: CloseEvent) => void;
  /** Called on error. */
  onError?: (event: Event) => void;
  /** Enable auto-reconnect (default: true). */
  reconnect?: boolean;
  /** Max reconnect attempts (default: Infinity). */
  maxRetries?: number;
  /** Initial reconnect delay in ms (default: 1000). */
  reconnectDelay?: number;
  /** Max reconnect delay in ms (default: 30000). */
  maxReconnectDelay?: number;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private opts: Required<WebSocketClientOptions>;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private _state: ConnectionState = ConnectionState.CLOSED;
  private disposed = false;

  constructor(options: WebSocketClientOptions) {
    this.opts = {
      reconnect: true,
      maxRetries: Infinity,
      reconnectDelay: 1000,
      maxReconnectDelay: 30000,
      onMessage: () => {},
      onOpen: () => {},
      onClose: () => {},
      onError: () => {},
      ...options,
    };
  }

  get state(): ConnectionState {
    return this._state;
  }

  connect(): void {
    if (this.disposed) return;
    this.cleanup();

    this._state = ConnectionState.CONNECTING;
    this.ws = new WebSocket(this.opts.url);

    this.ws.onopen = () => {
      this._state = ConnectionState.OPEN;
      this.retryCount = 0;
      this.opts.onOpen();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as WSMessage;
        this.opts.onMessage(msg);
      } catch {
        // Ignore non-JSON messages
      }
    };

    this.ws.onclose = (event: CloseEvent) => {
      this._state = ConnectionState.CLOSED;
      this.opts.onClose(event);
      if (
        this.opts.reconnect &&
        !this.disposed &&
        this.retryCount < this.opts.maxRetries
      ) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (event: Event) => {
      this.opts.onError(event);
    };
  }

  send(msg: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.disposed = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws) {
      this._state = ConnectionState.CLOSING;
      this.ws.close();
      this.ws = null;
    }
    this._state = ConnectionState.CLOSED;
  }

  private cleanup(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      this.opts.reconnectDelay * 2 ** this.retryCount,
      this.opts.maxReconnectDelay,
    );
    this.retryCount++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
}

// --- React hook ---

export interface UseWebSocketOptions {
  /** WebSocket path relative to the API base (e.g. "/ws/worker"). */
  path: string;
  /** Called on every parsed message. */
  onMessage?: (msg: WSMessage) => void;
  /** Whether the connection should be active (default: true). */
  enabled?: boolean;
  /** Enable auto-reconnect (default: true). */
  reconnect?: boolean;
}

export interface UseWebSocketReturn {
  /** Current connection state. */
  state: ConnectionState;
  /** Send a typed message. */
  send: (msg: WSMessage) => void;
}

export function useWebSocket(
  options: UseWebSocketOptions,
): UseWebSocketReturn {
  const { path, onMessage, enabled = true, reconnect = true } = options;
  const [state, setState] = useState<ConnectionState>(ConnectionState.CLOSED);
  const clientRef = useRef<WebSocketClient | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  // Subscribe to active-server changes so a server switch tears down the
  // current socket (pointed at the old server) and reconnects to the new URL.
  const activeServerId = useSyncExternalStore(
    subscribeActiveServerId,
    getActiveServerId,
    getActiveServerId,
  );

  useEffect(() => {
    if (!enabled) {
      clientRef.current?.close();
      clientRef.current = null;
      setState(ConnectionState.CLOSED);
      return;
    }

    const url = `${getWsBaseUrl()}${path}`;
    const client = new WebSocketClient({
      url,
      reconnect,
      onMessage: (msg) => onMessageRef.current?.(msg),
      onOpen: () => setState(ConnectionState.OPEN),
      onClose: () => setState(ConnectionState.CLOSED),
    });

    clientRef.current = client;
    client.connect();

    return () => {
      client.close();
      clientRef.current = null;
    };
    // activeServerId intentionally in deps: re-run to reconnect on server switch.
  }, [path, enabled, reconnect, activeServerId]);

  const send = useCallback((msg: WSMessage) => {
    clientRef.current?.send(msg);
  }, []);

  return { state, send };
}
