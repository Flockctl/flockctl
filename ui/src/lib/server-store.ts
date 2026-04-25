import type { ServerConnection } from "./types";

/**
 * Active-server id lives in localStorage so the choice survives reloads.
 * Bearer tokens never touch the UI — remote access is tunnelled over SSH
 * and the loopback endpoint the tunnel exposes does not require auth.
 */
const ACTIVE_KEY = "flockctl_active_server";

export const LOCAL_SERVER_ID = "local";

export const LOCAL_SERVER: ServerConnection = {
  id: LOCAL_SERVER_ID,
  name: "Local",
  is_local: true,
};

/**
 * Per-remote loopback port the SSH tunnel is bound to. `getApiBaseUrl()`
 * and `getWsBaseUrl()` read from this map to assemble
 * `http://127.0.0.1:${tunnelPort}` URLs; the map is kept in sync with the
 * server context on every refresh.
 */
const serverTunnelPortMap = new Map<string, number>();

// Subscribers notified when the active server id changes. Lets components
// (e.g. useWebSocket) tear down and reconnect without relying on React context.
const activeServerListeners = new Set<() => void>();

export function subscribeActiveServerId(listener: () => void): () => void {
  activeServerListeners.add(listener);
  return () => {
    activeServerListeners.delete(listener);
  };
}

function notifyActiveServerChanged(): void {
  for (const listener of activeServerListeners) {
    try {
      listener();
    } catch {
      // listeners must not throw; swallow to keep other subscribers alive
    }
  }
}

export function setServerMap(
  servers: Array<{ id: string; tunnelPort: number | null | undefined }>,
): void {
  serverTunnelPortMap.clear();
  for (const s of servers) {
    if (typeof s.tunnelPort === "number") {
      serverTunnelPortMap.set(s.id, s.tunnelPort);
    }
  }
}

export function getServerTunnelPort(id: string): number | undefined {
  return serverTunnelPortMap.get(id);
}

export function getActiveServerId(): string {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? LOCAL_SERVER_ID;
  } catch {
    return LOCAL_SERVER_ID;
  }
}

export function setActiveServerId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // ignore storage errors
  }
  notifyActiveServerChanged();
}
