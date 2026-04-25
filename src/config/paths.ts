import { join } from "path";
import { homedir } from "os";
import {
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
} from "fs";

export const RC_FILE = join(homedir(), ".flockctlrc");

let _rcCache: Record<string, any> | null = null;
let _rcCacheMs = 0;
const RC_CACHE_TTL = 5_000;

/** @internal — reset for tests only */
export function _resetRcCache() {
  _rcCache = null;
  _rcCacheMs = 0;
}

export function loadRc(): Record<string, any> {
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

export function saveRc(data: Record<string, any>): void {
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

export function getWorkspacesDir(): string {
  return join(getFlockctlHome(), "workspaces");
}

export function getGlobalSkillsDir(): string {
  return join(getFlockctlHome(), "skills");
}

export function getGlobalMcpDir(): string {
  return join(getFlockctlHome(), "mcp");
}

export function getGlobalTemplatesDir(): string {
  return join(getFlockctlHome(), "templates");
}
