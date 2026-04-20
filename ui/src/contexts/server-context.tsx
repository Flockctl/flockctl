import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { getApiBaseUrl, getAuthHeaders } from "@/lib/api";
import {
  LOCAL_SERVER,
  LOCAL_SERVER_ID,
  cacheToken,
  clearCachedToken,
  getActiveServerId,
  setActiveServerId as persistActiveServerId,
  setServerMap,
} from "@/lib/server-store";
import type { ConnectionStatus, ServerConnection } from "@/lib/types";

interface RemoteServerDTO {
  id: string;
  name: string;
  url: string;
  has_token: boolean;
}

interface ServerContextValue {
  servers: ServerConnection[];
  activeServer: ServerConnection;
  connectionStatus: ConnectionStatus;
  switchServer: (id: string) => void;
  refreshServers: () => Promise<void>;
  testConnection: () => Promise<void>;
}

const ServerContext = createContext<ServerContextValue | null>(null);

const HEALTH_CHECK_INTERVAL_MS = 30_000;

async function checkServerHealth(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const headers = { ...getAuthHeaders() };
    const res = await fetch(`${url}/health`, { method: "GET", headers, signal });
    return res.ok;
  } catch {
    return false;
  }
}

export function ServerProvider({ children }: { children: ReactNode }) {
  const [servers, setServers] = useState<ServerConnection[]>([LOCAL_SERVER]);
  const [activeServerId, setActiveId] = useState<string>(() => getActiveServerId());
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("checking");
  const queryClient = useQueryClient();
  const healthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activeServer = useMemo(
    () => servers.find((s) => s.id === activeServerId) ?? LOCAL_SERVER,
    [servers, activeServerId],
  );

  // Keep the api-layer server URL map in sync with the context state.
  useEffect(() => {
    setServerMap(
      servers
        .filter((s) => !s.is_local)
        .map((s) => ({ id: s.id, url: s.url })),
    );
  }, [servers]);

  const refreshServers = useCallback(async () => {
    try {
      // Fetch remote server list from the LOCAL backend — the one that owns
      // ~/.flockctlrc. When the active server is remote we still want the list
      // to come from local, so temporarily hit the local URL directly.
      const localBase = import.meta.env.VITE_API_URL ?? "";
      const res = await fetch(`${localBase}/meta/remote-servers`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const remote = (await res.json()) as RemoteServerDTO[];
      setServers([
        LOCAL_SERVER,
        ...remote.map((s) => ({
          id: s.id,
          name: s.name,
          url: s.url,
          is_local: false,
          has_token: s.has_token,
        })),
      ]);
    } catch {
      setServers([LOCAL_SERVER]);
    }
  }, []);

  useEffect(() => {
    void refreshServers();
  }, [refreshServers]);

  const performHealthCheck = useCallback(async () => {
    if (activeServer.is_local) {
      // Hit current-origin /health; an empty base URL resolves against origin.
      const ok = await checkServerHealth(getApiBaseUrl() || "");
      setConnectionStatus(ok ? "connected" : "error");
      return;
    }
    const ok = await checkServerHealth(activeServer.url);
    setConnectionStatus(ok ? "connected" : "error");
  }, [activeServer]);

  // On active-server change: fetch token (if any), then probe /health.
  useEffect(() => {
    let cancelled = false;
    setConnectionStatus("checking");

    async function prepare() {
      if (!activeServer.is_local && activeServer.has_token) {
        try {
          const localBase = import.meta.env.VITE_API_URL ?? "";
          const res = await fetch(
            `${localBase}/meta/remote-servers/${activeServer.id}/proxy-token`,
            { method: "POST" },
          );
          if (res.ok) {
            const body = (await res.json()) as { token: string | null };
            if (body.token) cacheToken(activeServer.id, body.token);
          }
        } catch {
          // non-fatal — will show as connection error below
        }
      } else if (!activeServer.is_local) {
        clearCachedToken(activeServer.id);
      }
      if (cancelled) return;
      await performHealthCheck();
    }

    void prepare();
    return () => {
      cancelled = true;
    };
  }, [activeServer.id, activeServer.is_local, activeServer.has_token, performHealthCheck]);

  // Periodic health check for the active server
  useEffect(() => {
    if (healthTimerRef.current) clearInterval(healthTimerRef.current);
    healthTimerRef.current = setInterval(() => {
      void performHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);
    return () => {
      if (healthTimerRef.current) clearInterval(healthTimerRef.current);
    };
  }, [performHealthCheck]);

  const switchServer = useCallback(
    (id: string) => {
      if (id === activeServerId) return;
      persistActiveServerId(id);
      setActiveId(id);
      queryClient.clear();
    },
    [activeServerId, queryClient],
  );

  const testConnection = useCallback(async () => {
    setConnectionStatus("checking");
    await performHealthCheck();
  }, [performHealthCheck]);

  const value = useMemo<ServerContextValue>(
    () => ({
      servers,
      activeServer,
      connectionStatus,
      switchServer,
      refreshServers,
      testConnection,
    }),
    [servers, activeServer, connectionStatus, switchServer, refreshServers, testConnection],
  );

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServerContext(): ServerContextValue {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error("useServerContext must be used within ServerProvider");
  return ctx;
}

// Re-export for convenience
export { LOCAL_SERVER_ID };

// Tiny helper components — keep colocated so callers don't need to remember the hook.
export function useActiveServer(): ServerConnection {
  return useServerContext().activeServer;
}
