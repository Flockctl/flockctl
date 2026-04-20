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
 * - `auto` uses SDK `default` + a `canUseTool` handler (path-scoped).
 * - `default` uses SDK `default` + prompts for every tool.
 * - `acceptEdits` / `plan` / `bypassPermissions` pass through.
 */
export function modeToSdkOptions(mode: PermissionMode): SdkPermissionOptions {
  switch (mode) {
    case "bypassPermissions":
      return {
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        useCanUseTool: false,
      };
    case "acceptEdits":
      return { permissionMode: "acceptEdits", useCanUseTool: false };
    case "plan":
      return { permissionMode: "plan", useCanUseTool: false };
    case "default":
      return { permissionMode: "default", useCanUseTool: true };
    case "auto":
    default:
      return { permissionMode: "default", useCanUseTool: true };
  }
}
