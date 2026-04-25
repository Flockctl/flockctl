import { randomUUID } from "crypto";
import { loadRc, saveRc } from "./paths.js";

// --- Remote server config ---
//
// SSH-only remote servers. Every entry describes how to reach a remote
// Flockctl daemon over SSH; the HTTP URL is never persisted — it's
// computed at runtime from the tunnel's local port when the tunnel is
// brought up (slice 00 / 03). `token` and `tokenLabel` are populated by
// the bootstrap flow (slice 02) and are never direct user input.

export interface RemoteServerConfig {
  id: string;
  name: string;
  ssh: {
    host: string;              // required — "user@host" or ~/.ssh/config alias
    user?: string;             // optional override if not embedded in host
    port?: number;             // default 22
    identityFile?: string;     // absolute path; else ssh-agent / ssh_config
    remotePort?: number;       // default 52077
  };
  token?: string;              // runtime — set by bootstrap; never user-input
  tokenLabel?: string;         // runtime — the label used on the remote
}

function isValidEntry(s: unknown): s is RemoteServerConfig {
  if (!s || typeof s !== "object") return false;
  const r = s as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string") return false;
  const ssh = r.ssh as Record<string, unknown> | undefined;
  if (!ssh || typeof ssh !== "object") return false;
  return typeof ssh.host === "string" && ssh.host.length > 0;
}

export function getRemoteServers(): RemoteServerConfig[] {
  const rc = loadRc();
  const servers = rc.remoteServers;
  if (!Array.isArray(servers)) return [];
  return servers.filter(isValidEntry);
}

export function saveRemoteServers(servers: RemoteServerConfig[]): void {
  const rc = { ...loadRc() };
  rc.remoteServers = servers;
  saveRc(rc);
}

export interface RemoteServerCreateInput {
  name: string;
  ssh: RemoteServerConfig["ssh"];
}

export function addRemoteServer(input: RemoteServerCreateInput): RemoteServerConfig {
  const server: RemoteServerConfig = {
    id: randomUUID(),
    name: input.name,
    ssh: { ...input.ssh },
  };
  const servers = getRemoteServers();
  servers.push(server);
  saveRemoteServers(servers);
  return server;
}

/**
 * Single-shot variant of {@link addRemoteServer} that also persists a
 * bootstrap-minted bearer token and its label in the same rc write.
 *
 * Used by the `POST /meta/remote-servers` create pipeline (slice 03): the
 * handler generates the `id` before invoking the remote bootstrap so the
 * token can be associated with a stable identity in telemetry, then hands
 * both the id and the freshly-captured token here for a single 0o600 write.
 *
 * Rejects an id collision (shouldn't happen with `crypto.randomUUID()`, but
 * the check is cheap and catches test-fixture bugs). Every other malformed
 * input is the caller's responsibility — we trust the Zod-parsed shape.
 */
export function addRemoteServerWithToken(input: {
  id: string;
  name: string;
  ssh: RemoteServerConfig["ssh"];
  token: string;
  tokenLabel: string;
}): RemoteServerConfig {
  const server: RemoteServerConfig = {
    id: input.id,
    name: input.name,
    ssh: { ...input.ssh },
    token: input.token,
    tokenLabel: input.tokenLabel,
  };
  const servers = getRemoteServers();
  if (servers.some((s) => s.id === server.id)) {
    throw new Error(`remote server id collision: ${server.id}`);
  }
  servers.push(server);
  saveRemoteServers(servers);
  return server;
}

export interface RemoteServerUpdateInput {
  name?: string;
  ssh?: Partial<RemoteServerConfig["ssh"]>;
  token?: string | null;
  tokenLabel?: string | null;
}

export function updateRemoteServer(
  id: string,
  input: RemoteServerUpdateInput,
): RemoteServerConfig | null {
  const servers = getRemoteServers();
  const idx = servers.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const current = servers[idx]!;

  let ssh = current.ssh;
  if (input.ssh !== undefined) {
    const merged = { ...current.ssh, ...input.ssh };
    // `ssh.host` must remain a non-empty string.
    if (!merged.host || typeof merged.host !== "string") {
      merged.host = current.ssh.host;
    }
    ssh = merged;
  }

  const updated: RemoteServerConfig = {
    id: current.id,
    name: input.name !== undefined ? input.name : current.name,
    ssh,
    token:
      input.token === null
        ? undefined
        : input.token !== undefined
          ? input.token || undefined
          : current.token,
    tokenLabel:
      input.tokenLabel === null
        ? undefined
        : input.tokenLabel !== undefined
          ? input.tokenLabel || undefined
          : current.tokenLabel,
  };
  servers[idx] = updated;
  saveRemoteServers(servers);
  return updated;
}

export function deleteRemoteServer(id: string): boolean {
  const before = getRemoteServers();
  const after = before.filter((s) => s.id !== id);
  if (after.length === before.length) return false;
  saveRemoteServers(after);
  return true;
}

/**
 * Drop legacy direct-HTTP remote server entries from `~/.flockctlrc`.
 *
 * Pre-SSH remote servers lived as `{ id, name, url, token }`; after the
 * SSH-only migration every valid entry must carry `ssh.host`. Anything
 * without a non-empty `ssh.host` is unreachable by the current client and
 * is stripped on boot so the UI doesn't list phantom servers.
 *
 * Intentionally narrow: only filters the `remoteServers` array. Tokens
 * live in `remoteAccessTokens` and are left untouched.
 *
 * Logs the removed entry NAMES only — never the token string — so the
 * startup log doesn't leak secrets into terminal scrollback or journald.
 */
export function purgeLegacyRemoteServers(): { removed: string[] } {
  const rc = loadRc();
  const original = Array.isArray(rc.remoteServers) ? rc.remoteServers : [];
  if (original.length === 0) return { removed: [] };

  const valid = original.filter(
    (e: unknown) => {
      if (!e || typeof e !== "object") return false;
      const ssh = (e as { ssh?: unknown }).ssh as Record<string, unknown> | undefined;
      return !!ssh && typeof ssh.host === "string" && ssh.host.length > 0;
    },
  );
  const removedEntries = original.filter((e: unknown) => !valid.includes(e));
  if (removedEntries.length === 0) return { removed: [] };

  const removed = removedEntries.map((e: unknown) => {
    const name = (e as { name?: unknown } | null)?.name;
    return typeof name === "string" && name.length > 0 ? name : "(unnamed)";
  });

  const next = { ...rc, remoteServers: valid };
  saveRc(next); // saveRc already enforces 0o600
  console.warn(
    `[flockctl] Removed ${removed.length} legacy remote server(s) (direct-HTTP no longer supported): ${removed.join(", ")}. Recreate them via the UI.`,
  );
  return { removed };
}
