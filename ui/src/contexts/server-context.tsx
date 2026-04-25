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
  getActiveServerId,
  setActiveServerId as persistActiveServerId,
  setServerMap,
} from "@/lib/server-store";
import type {
  ConnectionStatus,
  ServerConnection,
  ServerErrorCode,
} from "@/lib/types";

/**
 * Shape of a single entry from `GET /meta/remote-servers`. Mirrors the
 * `toEnriched` serializer in `src/routes/meta.ts` — keep the two in sync.
 */
interface RemoteServerDTO {
  id: string;
  name: string;
  ssh: {
    host: string;
    user?: string;
    port?: number;
    identityFile?: string;
    remotePort?: number;
  };
  tunnelStatus: "starting" | "ready" | "error" | "stopped";
  tunnelPort: number | null;
  tunnelLastError: string | null;
  errorCode: ServerErrorCode | null;
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

async function checkServerHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    const base = getApiBaseUrl();
    const res = await fetch(`${base}/health`, {
      method: "GET",
      headers: { ...getAuthHeaders() },
      signal,
    });
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

  // Keep the api-layer tunnel-port map in sync with the context state.
  useEffect(() => {
    setServerMap(
      servers
        .filter((s) => !s.is_local)
        .map((s) => ({ id: s.id, tunnelPort: s.tunnelPort })),
    );
  }, [servers]);

  const refreshServers = useCallback(async () => {
    try {
      // The remote-server list is owned by the LOCAL daemon — it's the one
      // that holds ~/.flockctlrc. Even when the active server is remote we
      // want the enumeration to come from local.
      const localBase =
        (import.meta.env.VITE_API_URL as string | undefined) ??
        "http://127.0.0.1:52077";
      const res = await fetch(`${localBase}/meta/remote-servers`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const remote = (await res.json()) as RemoteServerDTO[];
      setServers([
        LOCAL_SERVER,
        ...remote.map<ServerConnection>((s) => ({
          id: s.id,
          name: s.name,
          is_local: false,
          ssh: s.ssh,
          tunnelStatus: s.tunnelStatus,
          tunnelPort: s.tunnelPort ?? undefined,
          tunnelLastError: s.tunnelLastError ?? undefined,
          errorCode: s.errorCode ?? undefined,
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
    // A remote server with no live tunnel has no loopback endpoint to probe,
    // so getApiBaseUrl() would throw. Treat that as "error" without attempting
    // the fetch.
    if (!activeServer.is_local && activeServer.tunnelStatus !== "ready") {
      setConnectionStatus("error");
      return;
    }
    const ok = await checkServerHealth();
    setConnectionStatus(ok ? "connected" : "error");
  }, [activeServer.is_local, activeServer.tunnelStatus]);

  // Re-probe /health whenever the active server (or its tunnel state) changes.
  useEffect(() => {
    let cancelled = false;
    setConnectionStatus("checking");

    (async () => {
      if (cancelled) return;
      await performHealthCheck();
    })();

    return () => {
      cancelled = true;
    };
  }, [activeServer.id, performHealthCheck]);

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
