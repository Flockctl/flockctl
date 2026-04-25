import { homedir } from "node:os";
import { resolve, isAbsolute, relative } from "node:path";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "auto";

export const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "auto",
];

export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === "string" && (PERMISSION_MODES as string[]).includes(v);
}

export function normalizePermissionMode(v: unknown): PermissionMode | null {
  return isPermissionMode(v) ? v : null;
}

/**
 * Parse an incoming API field. Returns:
 *   - undefined → caller should leave the column unchanged
 *   - null → caller should clear the column (inherit from parent)
 *   - PermissionMode → store this value
 * Throws Error with a message the caller can wrap as ValidationError.
 */
export function parsePermissionModeField(
  value: unknown,
): PermissionMode | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (isPermissionMode(value)) return value;
  throw new Error(
    `permission_mode must be one of: ${PERMISSION_MODES.join(", ")}`,
  );
}

export interface ModeSources {
  task?: string | null;
  chat?: string | null;
  project?: string | null;
  workspace?: string | null;
}

export function resolvePermissionMode(sources: ModeSources): PermissionMode {
  const order: (keyof ModeSources)[] = ["task", "chat", "project", "workspace"];
  for (const key of order) {
    const mode = normalizePermissionMode(sources[key]);
    if (mode) return mode;
  }
  return DEFAULT_PERMISSION_MODE;
}

export function flockctlRoot(): string {
  return resolve(homedir(), "Flockctl");
}

export function allowedRoots(opts: {
  workspacePath?: string | null;
  projectPath?: string | null;
  workingDir?: string | null;
}): string[] {
  const roots = new Set<string>();
  roots.add(flockctlRoot());
  for (const p of [opts.workspacePath, opts.projectPath, opts.workingDir]) {
    if (p && typeof p === "string") {
      try {
        roots.add(resolve(p));
      } catch {
        // ignore invalid paths
      }
    }
  }
  return Array.from(roots);
}

function pathWithinRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function isPathWithinRoots(path: string, roots: string[]): boolean {
  if (!path) return false;
  let abs: string;
  try {
    abs = isAbsolute(path) ? resolve(path) : resolve(path);
  } catch {
    /* v8 ignore next — defensive: resolve() effectively never throws on string input */
    return false;
  }
  return roots.some((r) => abs === r || pathWithinRoot(abs, r));
}

// ─── Hard path denylist ───
//
// Files that must NEVER be read or written by an agent, regardless of
// permission mode. These contain either plaintext secrets (`.mcp.json` after
// reconciliation), the master encryption key (`secret.key`), or the SQLite
// database with encrypted secret values + metadata (`flockctl.db` + WAL/SHM
// sidecars). Allowing an agent to read any of them defeats the point of the
// secrets store.
//
// Scope rules:
// - `secret.key` and `flockctl.db*` live at `<flockctlRoot>/` — matched by
//   exact path.
// - `.mcp.json` is written at the root of each workspace/project by
//   `mcp-sync.ts`, so it is denied at the top level of any allowed root
//   (project/workspace path or workingDir).
//
// Not covered:
// - `Bash` — reliable shell-command parsing is out of scope. `Bash` remains
//   prompt-gated in `auto` mode; users on `bypassPermissions`/`acceptEdits`
//   can still `cat` these files. Document as a known gap in SECURITY.md.
// - `Grep` recursive scans — `ripgrep` respects `.gitignore` and `.mcp.json`
//   is always gitignored by `ensureGitignore()`, so recursive scans already
//   skip it in practice. We still deny explicit `Grep(path=…/.mcp.json)`.

/** Basenames denied at the top level of `flockctlRoot()`. */
const DENIED_IN_FLOCKCTL_ROOT = new Set([
  "secret.key",
  "flockctl.db",
  "flockctl.db-wal",
  "flockctl.db-shm",
]);

/** Basenames denied at the top level of any project/workspace allowed root. */
const DENIED_IN_PROJECT_ROOT = new Set([".mcp.json"]);

export interface DenyDecision {
  denied: boolean;
  reason?: string;
}

/**
 * Check a single path against the hard denylist. Returns `{denied: true,
 * reason}` if the path matches a sensitive Flockctl-managed file. Caller is
 * responsible for short-circuiting tool invocations that reference denied
 * paths (typically returning `{behavior: "deny", message: reason}` to the
 * Claude Code SDK's `canUseTool` hook).
 */
export function isPathDenied(path: string, roots: string[]): DenyDecision {
  if (!path) return { denied: false };
  let abs: string;
  try {
    abs = resolve(path);
  } catch {
    /* v8 ignore next — defensive: resolve() effectively never throws on string input */
    return { denied: false };
  }
  const fRoot = flockctlRoot();
  for (const name of DENIED_IN_FLOCKCTL_ROOT) {
    if (abs === resolve(fRoot, name)) {
      return {
        denied: true,
        reason: `${name} is a Flockctl internal file (master key / database) and cannot be accessed by agents`,
      };
    }
  }
  for (const root of roots) {
    for (const name of DENIED_IN_PROJECT_ROOT) {
      if (abs === resolve(root, name)) {
        return {
          denied: true,
          reason: `${name} is auto-generated by Flockctl and contains plaintext secrets — access is blocked; edit sources under .flockctl/mcp/ instead`,
        };
      }
    }
  }
  return { denied: false };
}

/**
 * Check every path referenced by a tool invocation against the denylist.
 * Returns the first `denied` decision encountered, or `{denied: false}`.
 */
export function denyIfTouchesSensitivePath(
  toolName: string,
  input: Record<string, unknown>,
  roots: string[],
): DenyDecision {
  const paths = extractToolPaths(toolName, input);
  for (const p of paths) {
    const d = isPathDenied(p, roots);
    if (d.denied) return d;
  }
  return { denied: false };
}

/**
 * Read-only tools — always safe to auto-approve in "auto" mode.
 */
export const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "NotebookRead",
  "Skill",
]);

/**
 * File-writing tools — auto-approve in "auto" mode iff all paths are scoped.
 */
export const FILE_WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/**
 * Extract file paths referenced by a tool invocation for scope check.
 */
export function extractToolPaths(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  const paths: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.length > 0) paths.push(v);
  };
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
    case "NotebookRead":
      push(input.file_path ?? input.notebook_path ?? input.path);
      break;
    case "MultiEdit":
      push(input.file_path);
      break;
    case "Glob":
    case "Grep":
    case "LS":
      push(input.path);
      break;
    default:
      break;
  }
  return paths;
}

export type AutoDecision =
  | { behavior: "allow"; reason: string }
  | { behavior: "prompt"; reason: string };

/**
 * "auto" mode decision: read-only tools pass; file-write tools pass iff
 * every referenced path is inside an allowed root; everything else prompts.
 */
export function decideAuto(
  toolName: string,
  input: Record<string, unknown>,
  roots: string[],
): AutoDecision {
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { behavior: "allow", reason: "read-only tool" };
  }
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const paths = extractToolPaths(toolName, input);
    if (paths.length === 0) {
      return { behavior: "prompt", reason: "no path provided" };
    }
    const outside = paths.filter((p) => !isPathWithinRoots(p, roots));
    if (outside.length === 0) {
      return { behavior: "allow", reason: "all paths within allowed roots" };
    }
    return {
      behavior: "prompt",
      reason: `path outside allowed roots: ${outside[0]}`,
    };
  }
  return { behavior: "prompt", reason: `tool ${toolName} requires approval` };
}

export interface SdkPermissionOptions {
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  allowDangerouslySkipPermissions?: boolean;
  useCanUseTool: boolean;
}

/**
 * Map a Flockctl mode to the Claude Code SDK options it produces.
 *
 * `canUseTool` is wired for EVERY mode so the hard path denylist
 * (`denyIfTouchesSensitivePath`) runs universally. Mode-specific
 * allow-shortcuts are emulated inside the in-process handler:
 * - `auto` → SDK `default`, handler allows read-only + in-scope writes.
 * - `default` → SDK `default`, handler prompts for every tool.
 * - `acceptEdits` → SDK `acceptEdits`, handler allows reads + writes.
 * - `plan` → SDK `plan` (SDK enforces no-writes), handler allows reads.
 * - `bypassPermissions` → SDK `default`, handler allows every tool.
 *   The SDK's `allowDangerouslySkipPermissions` flag is intentionally NOT
 *   set here: it would make the SDK skip `canUseTool` entirely, defeating
 *   the denylist. The agent still sees bypass UX (no prompts) because the
 *   handler short-circuits to allow after the denylist check.
 */
export function modeToSdkOptions(mode: PermissionMode): SdkPermissionOptions {
  switch (mode) {
    case "bypassPermissions":
      return { permissionMode: "default", useCanUseTool: true };
    case "acceptEdits":
      return { permissionMode: "acceptEdits", useCanUseTool: true };
    case "plan":
      return { permissionMode: "plan", useCanUseTool: true };
    case "default":
      return { permissionMode: "default", useCanUseTool: true };
    case "auto":
    default:
      return { permissionMode: "default", useCanUseTool: true };
  }
}
