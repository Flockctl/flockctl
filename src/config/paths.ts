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
  // Pass mode in the open() syscall so the rc file (which carries bearer
  // tokens once `flockctl token add --save` writes it) never exists with
  // anything looser than 0o600. Eliminates the TOCTOU window between
  // writeFileSync and a follow-up chmod.
  writeFileSync(RC_FILE, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  // Belt-and-braces: writeFileSync respects existing perms when the file
  // already exists, so re-chmod handles the (rare) overwrite path. Failure
  // is non-fatal — Windows is unsupported per CLAUDE.md rule 6 anyway.
  try {
    chmodSync(RC_FILE, 0o600);
  } catch {
    /* v8 ignore next — non-POSIX filesystems may reject chmod; the open() mode bits already applied. */
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

// ─── Workspace / project `.flockctl/` helpers ────────────────────────
//
// Both workspaces and projects own a `<root>/.flockctl/` directory that
// holds per-scope MCP servers, skills, templates, and plan files. The
// concrete sub-directory names (`mcp`, `skills`, `templates`, `plan`)
// were repeated as string literals across ~20 callsites in
// routes/{mcp,skills,workspaces}.ts and services/plan-store/. Centralising
// them makes a future rename (or path-jail tweak) a one-line change and
// removes the chance of typos like ".flockcl/mcp".
//
// The helpers are deliberately scope-agnostic — both `getProjectMcpDir`
// and `getWorkspaceMcpDir` are aliases for the same `<root>/.flockctl/mcp`
// shape. We expose them under separate names so call sites read
// naturally, but neither does any path-validation: it's the caller's
// job to make sure `root` is a real workspace or project path.
const FLOCKCTL_SUBDIR = ".flockctl";

export function getFlockctlDir(root: string): string {
  return join(root, FLOCKCTL_SUBDIR);
}

export function getMcpDir(root: string): string {
  return join(root, FLOCKCTL_SUBDIR, "mcp");
}

export function getSkillsDir(root: string): string {
  return join(root, FLOCKCTL_SUBDIR, "skills");
}

export function getTemplatesDir(root: string): string {
  return join(root, FLOCKCTL_SUBDIR, "templates");
}

// Note: there is intentionally NO `getPlanDir` here. The plan store
// already owns its own copy at `services/plan-store/md-io.ts::getPlanDir`
// and re-exports it from the plan-store barrel; layering plan-store on
// top of `paths.ts` would push the FS layer up the dependency graph
// for every consumer of `getFlockctlHome()`, including the CLI client.
// Two copies of a one-line `join(p, ".flockctl/plan")` is the lesser
// cost.
