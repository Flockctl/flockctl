import { join, dirname } from "path";
import { homedir } from "os";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  cpSync,
  writeFileSync,
  chmodSync,
  statSync,
} from "fs";
import { fileURLToPath } from "url";
import { randomUUID, timingSafeEqual } from "crypto";

const RC_FILE = join(homedir(), ".flockctlrc");

let _rcCache: Record<string, any> | null = null;
let _rcCacheMs = 0;
const RC_CACHE_TTL = 5_000;

/** @internal — reset for tests only */
export function _resetRcCache() {
  _rcCache = null;
  _rcCacheMs = 0;
}

function loadRc(): Record<string, any> {
  const now = Date.now();
  if (_rcCache !== null && now - _rcCacheMs < RC_CACHE_TTL) return _rcCache;
  _rcCacheMs = now;
  let result: Record<string, any>;
  try {
    const parsed = JSON.parse(readFileSync(RC_FILE, "utf-8"));
    result = (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    result = {};
  }
  _rcCache = result;
  return result;
}

function saveRc(data: Record<string, any>): void {
  writeFileSync(RC_FILE, JSON.stringify(data, null, 2), "utf-8");
  try {
    chmodSync(RC_FILE, 0o600);
  } catch {
    // chmod may fail on some filesystems (Windows) — non-fatal
  }
  _rcCache = data;
  _rcCacheMs = Date.now();
}

/** Warn if .flockctlrc has insecure permissions */
export function checkRcPermissions(): { secure: boolean; message?: string } {
  try {
    const stat = statSync(RC_FILE);
    const mode = stat.mode & 0o777;
    if (mode & 0o077) {
      return {
        secure: false,
        message: `~/.flockctlrc has permissions ${mode.toString(8)}, expected 600. Run: chmod 600 ~/.flockctlrc`,
      };
    }
    return { secure: true };
  } catch {
    return { secure: true };
  }
}

export function getFlockctlHome(): string {
  // 1. FLOCKCTL_HOME env var
  if (process.env.FLOCKCTL_HOME) return process.env.FLOCKCTL_HOME;

  // 2. ~/.flockctlrc file
  const rc = loadRc();
  if (rc.home) return rc.home;

  // 3. Default: ~/flockctl
  return join(homedir(), "flockctl");
}

export function getDefaultModel(): string {
  return loadRc().defaultModel ?? "claude-sonnet-4-6";
}

export function getPlanningModel(): string {
  return loadRc().planningModel ?? "claude-opus-4-7";
}

export function getDefaultAgent(): string {
  return loadRc().defaultAgent ?? "claude-code";
}

/** Default AI Provider Key id (numeric). Returns null when unset. */
export function getDefaultKeyId(): number | null {
  const raw = loadRc().defaultKeyId;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  return null;
}

/**
 * Update one or more global defaults in ~/.flockctlrc. Pass `null` to clear a
 * field; omit a key to leave it untouched.
 */
export function setGlobalDefaults(input: {
  defaultModel?: string | null;
  defaultKeyId?: number | null;
}): void {
  const rc = { ...loadRc() };
  if (input.defaultModel !== undefined) {
    if (input.defaultModel === null || input.defaultModel === "") {
      delete rc.defaultModel;
    } else {
      rc.defaultModel = input.defaultModel;
    }
  }
  if (input.defaultKeyId !== undefined) {
    if (input.defaultKeyId === null) {
      delete rc.defaultKeyId;
    } else {
      rc.defaultKeyId = input.defaultKeyId;
    }
  }
  saveRc(rc);
}

export function getWorkspacesDir(): string {
  return join(getFlockctlHome(), "workspaces");
}

export function getGlobalSkillsDir(): string {
  return join(getFlockctlHome(), "skills");
}

export function getGlobalMcpDir(): string {
  return join(getFlockctlHome(), "mcp");
}

// --- Remote server config ---

export interface RemoteServerConfig {
  id: string;
  name: string;
  url: string;
  token?: string;
}

const MIN_TOKEN_LENGTH = 32;

export function getRemoteServers(): RemoteServerConfig[] {
  const rc = loadRc();
  const servers = rc.remoteServers;
  if (!Array.isArray(servers)) return [];
  return servers.filter((s) => s && typeof s.id === "string" && typeof s.url === "string");
}

export function saveRemoteServers(servers: RemoteServerConfig[]): void {
  const rc = { ...loadRc() };
  rc.remoteServers = servers;
  saveRc(rc);
}

export function addRemoteServer(input: { name: string; url: string; token?: string }): RemoteServerConfig {
  const server: RemoteServerConfig = {
    id: randomUUID(),
    name: input.name,
    url: input.url.replace(/\/$/, ""),
    token: input.token || undefined,
  };
  const servers = getRemoteServers();
  servers.push(server);
  saveRemoteServers(servers);
  return server;
}

export function updateRemoteServer(
  id: string,
  input: { name?: string; url?: string; token?: string | null },
): RemoteServerConfig | null {
  const servers = getRemoteServers();
  const idx = servers.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const current = servers[idx];
  const updated: RemoteServerConfig = {
    id: current.id,
    name: input.name !== undefined ? input.name : current.name,
    url: input.url !== undefined ? input.url.replace(/\/$/, "") : current.url,
    token:
      input.token === null
        ? undefined
        : input.token !== undefined
          ? input.token || undefined
          : current.token,
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

export interface RemoteAccessToken {
  label: string;
  token: string;
}

/**
 * Merge the legacy single-token field (`remoteAccessToken`) with the new
 * labeled-array field (`remoteAccessTokens`). Both sources are filtered for
 * minimum length; short tokens emit one warning per invalid entry.
 *
 * Legacy single token becomes `{label: "default", token}`. If both the legacy
 * field and an array entry labeled "default" exist, the array entry wins
 * (the user has explicitly migrated).
 */
export function getConfiguredTokens(): RemoteAccessToken[] {
  const rc = loadRc();
  const out: RemoteAccessToken[] = [];
  const seenLabels = new Set<string>();

  if (Array.isArray(rc.remoteAccessTokens)) {
    for (const entry of rc.remoteAccessTokens) {
      if (!entry || typeof entry !== "object") continue;
      const label = typeof entry.label === "string" ? entry.label : null;
      const token = typeof entry.token === "string" ? entry.token : null;
      if (!label || !token) continue;
      if (token.length < MIN_TOKEN_LENGTH) {
        console.warn(
          `[SECURITY] remoteAccessTokens[${label}] is too short ` +
            `(${token.length} chars, min ${MIN_TOKEN_LENGTH}). Skipping. ` +
            `Generate a secure token with: flockctl token generate`,
        );
        continue;
      }
      if (seenLabels.has(label)) continue;
      seenLabels.add(label);
      out.push({ label, token });
    }
  }

  if (typeof rc.remoteAccessToken === "string" && !seenLabels.has("default")) {
    const token = rc.remoteAccessToken;
    if (token.length >= MIN_TOKEN_LENGTH) {
      out.push({ label: "default", token });
    } else if (token.length > 0) {
      console.warn(
        `[SECURITY] remoteAccessToken is too short (${token.length} chars, ` +
          `min ${MIN_TOKEN_LENGTH}). Generate a secure token with: flockctl token generate`,
      );
    }
  }

  return out;
}

export function hasRemoteAuth(): boolean {
  return getConfiguredTokens().length > 0;
}

/**
 * Timing-safe comparison of `provided` against every configured token.
 * Iterates the full list unconditionally so the loop's runtime does not
 * depend on where (or whether) a match exists.
 */
export function findMatchingToken(provided: string): { label: string } | null {
  if (typeof provided !== "string") return null;
  const tokens = getConfiguredTokens();
  let match: { label: string } | null = null;
  for (const { label, token } of tokens) {
    if (provided.length !== token.length) continue;
    let eq = false;
    try {
      eq = timingSafeEqual(Buffer.from(provided, "utf-8"), Buffer.from(token, "utf-8"));
    } catch {
      /* v8 ignore next — defensive: timingSafeEqual only throws on length mismatch which we already filter */
      eq = false;
    }
    if (eq && match === null) match = { label };
  }
  return match;
}

/** @deprecated prefer `hasRemoteAuth()` / `findMatchingToken()` */
export function getRemoteAccessToken(): string | null {
  const tokens = getConfiguredTokens();
  return tokens.length > 0 ? tokens[0].token : null;
}

export function addRemoteAccessToken(label: string, token: string): void {
  if (!label || typeof label !== "string") {
    throw new Error("Token label is required");
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`Token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const rc = { ...loadRc() };
  const existing: Array<{ label: string; token: string }> = Array.isArray(rc.remoteAccessTokens)
    ? rc.remoteAccessTokens.filter(
        (e: any) =>
          e && typeof e === "object" && typeof e.label === "string" && typeof e.token === "string",
      )
    : [];
  if (existing.some((e) => e.label === label)) {
    throw new Error(`A token labeled "${label}" already exists. Revoke it first.`);
  }
  existing.push({ label, token });

  if (typeof rc.remoteAccessToken === "string" && rc.remoteAccessToken.length > 0) {
    if (!existing.some((e) => e.label === "default")) {
      existing.unshift({ label: "default", token: rc.remoteAccessToken });
    }
    delete rc.remoteAccessToken;
  }

  rc.remoteAccessTokens = existing;
  saveRc(rc);
}

export function removeRemoteAccessToken(label: string): boolean {
  const rc = { ...loadRc() };
  let removed = false;

  if (Array.isArray(rc.remoteAccessTokens)) {
    const before = rc.remoteAccessTokens.length;
    rc.remoteAccessTokens = rc.remoteAccessTokens.filter(
      (e: any) => !(e && typeof e === "object" && e.label === label),
    );
    if (rc.remoteAccessTokens.length !== before) removed = true;
  }

  if (label === "default" && typeof rc.remoteAccessToken === "string") {
    delete rc.remoteAccessToken;
    removed = true;
  }

  if (removed) saveRc(rc);
  return removed;
}

export function getCorsAllowedOrigins(): string[] | null {
  const rc = loadRc();
  if (Array.isArray(rc.corsOrigins) && rc.corsOrigins.every((v) => typeof v === "string")) {
    return rc.corsOrigins;
  }
  return null;
}

/**
 * Copy bundled skills to ~/flockctl/skills/ on first startup.
 * Skips skills that already exist (preserves user customizations).
 */
export function seedBundledSkills(): void {
  const globalDir = getGlobalSkillsDir();
  // bundled-skills/ sits next to this file in the dist/ or src/ tree
  const bundledDir = join(dirname(fileURLToPath(import.meta.url)), "bundled-skills");
  if (!existsSync(bundledDir)) return;

  mkdirSync(globalDir, { recursive: true });

  for (const entry of readdirSync(bundledDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dest = join(globalDir, entry.name);
    if (existsSync(dest)) continue; // don't overwrite user customizations
    cpSync(join(bundledDir, entry.name), dest, { recursive: true });
  }
}

