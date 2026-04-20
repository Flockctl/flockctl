import type { ServerConnection } from "./types";

/**
 * Active-server id lives in localStorage so the choice survives reloads.
 * Tokens NEVER touch localStorage — they live only in the in-memory Maps below.
 */
const ACTIVE_KEY = "flockctl_active_server";

export const LOCAL_SERVER_ID = "local";

export const LOCAL_SERVER: ServerConnection = {
  id: LOCAL_SERVER_ID,
  name: "Local",
  url: "",
  is_local: true,
  has_token: false,
};

const tokenCache = new Map<string, string>();
const serverUrlMap = new Map<string, string>();

export function cacheToken(serverId: string, token: string): void {
  tokenCache.set(serverId, token);
}

export function clearCachedToken(serverId: string): void {
  tokenCache.delete(serverId);
}

export function getCachedToken(serverId: string): string | undefined {
  return tokenCache.get(serverId);
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

export function setServerMap(servers: Array<{ id: string; url: string }>): void {
  serverUrlMap.clear();
  for (const s of servers) serverUrlMap.set(s.id, s.url);
}

export function getServerUrl(id: string): string | undefined {
  return serverUrlMap.get(id);
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
}
