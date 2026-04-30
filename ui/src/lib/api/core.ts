import {
  getActiveServerId,
  getServerTunnelPort,
  LOCAL_SERVER_ID,
} from "../server-store";

/**
 * Local daemon address. Remote servers are reached through an SSH tunnel
 * bound to a loopback port, so every request the UI makes — local or remote
 * — goes to 127.0.0.1. `VITE_API_URL` is an escape hatch for dev setups
 * that need to point at a non-default port.
 */
const LOCAL_API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:52077";

/**
 * Resolve the HTTP base URL for the active server.
 *
 *   • Local → `http://127.0.0.1:52077` (or `VITE_API_URL`).
 *   • Remote → `http://127.0.0.1:${tunnelPort}` — the SSH tunnel terminates
 *     at the remote daemon's own loopback interface, which does not require
 *     a bearer token.
 *
 * Throws if the active server is remote but no tunnel port is registered.
 * Callers should not invoke this until the server's tunnel has reported
 * `ready`; a throw here is a programmer error, not a recoverable state.
 */
export function getApiBaseUrl(): string {
  const id = getActiveServerId();
  if (id === LOCAL_SERVER_ID) return LOCAL_API_URL;
  const port = getServerTunnelPort(id);
  if (port === undefined) {
    throw new Error(
      `getApiBaseUrl: no tunnel port for server '${id}' — the caller should not have invoked us before the tunnel is ready`,
    );
  }
  return `http://127.0.0.1:${port}`;
}

/**
 * Auth headers for outgoing requests. Always empty: the SSH tunnel is
 * transparent to HTTP and the loopback endpoint accepts unauthenticated
 * requests, so the UI has nothing to add.
 */
export function getAuthHeaders(): Record<string, string> {
  return {};
}


// --- Key conversion utilities ---

function camelToSnake(str: string): string {
  // Leave strings alone that are already in a snake-shaped form so that
  // user-defined identifiers (env var names, secret references, header
  // names, …) survive deep traversal in `toSnakeKeys`.
  //
  //   - No uppercase → already snake_case or plain lowercase → no-op.
  //   - No lowercase → SCREAMING_SNAKE_CASE / acronym → no-op. Without
  //     this guard, `ALBS_JWT_TOKEN` would get rewritten to
  //     `_a_l_b_s__j_w_t__t_o_k_e_n` because the regex blindly inserts
  //     an underscore before every uppercase letter, including ones
  //     that are already preceded by an underscore.
  if (!/[A-Z]/.test(str) || !/[a-z]/.test(str)) return str;
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/** Deep-convert keys camelCase → snake_case and parse JSON-encoded strings */
function toSnakeKeys(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map(toSnakeKeys);
  if (typeof val === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      const snakeKey = camelToSnake(k);
      let converted = toSnakeKeys(tryParseJsonString(v));
      // DB returns integer PKs/FKs but frontend types expect string IDs
      if (typeof converted === "number" && (snakeKey === "id" || snakeKey.endsWith("_id"))) {
        converted = String(converted);
      }
      result[snakeKey] = converted;
    }
    return result;
  }
  return val;
}

/** Deep-convert keys snake_case → camelCase (for outgoing request bodies) */
function toCamelKeys(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map(toCamelKeys);
  if (typeof val === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      result[snakeToCamel(k)] = v;
    }
    return result;
  }
  return val;
}

/** Try to parse a string as JSON array/object; return original if not JSON */
function tryParseJsonString(val: unknown): unknown {
  if (typeof val !== "string" || val.length < 2) return val;
  const c = val[0];
  if (c === "[" || c === "{") {
    try {
      const parsed = JSON.parse(val);
      if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch { /* not JSON */ }
  }
  return val;
}

// --- Generic API fetcher (no auth — local tool) ---

export async function apiFetch<T>(
  path: string,
  options?: RequestInit & { rawKeys?: boolean },
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...getAuthHeaders(),
    ...(options?.headers as Record<string, string>),
  };

  // Convert outgoing body keys: snake_case → camelCase (unless rawKeys)
  let body = options?.body;
  if (typeof body === "string" && !options?.rawKeys) {
    try {
      const parsed = JSON.parse(body);
      body = JSON.stringify(toCamelKeys(parsed));
    } catch { /* not JSON, leave as-is */ }
  }

  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    ...options,
    headers,
    body,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(errBody.error ?? errBody.detail ?? `API error ${res.status}`);
  }

  // Convert incoming response keys: camelCase → snake_case + parse JSON strings
  const text = await res.text();
  if (!text) return undefined as T;
  const json = JSON.parse(text);
  if (options?.rawKeys) return json as T;
  return toSnakeKeys(json) as T;
}
