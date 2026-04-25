import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { AppError } from "../../lib/errors.js";

// ---------------------------------------------------------------------------
// Per-layer AGENTS.md I/O — no merge logic, no reconciler side-effects.
//
// Layout:
//   <project>/AGENTS.md    → "project-public"
//   <workspace>/AGENTS.md  → "workspace-public"
//
// Private layers (`.flockctl/AGENTS.md`) were retired — the layering model is
// user + workspace-public + project-public only. The editable source is
// always the public file on disk; merging for the effective prompt happens
// in `agent-guidance-loader`.
// ---------------------------------------------------------------------------

export type ProjectLayer = "project-public";
export type WorkspaceLayer = "workspace-public";

export const AGENTS_MD_MAX_BYTES = 256 * 1024;

const AGENTS_FILENAME = "AGENTS.md";

export interface LayerContent {
  present: boolean;
  bytes: number;
  content: string;
}

/** Thrown when the caller sends a payload larger than {@link AGENTS_MD_MAX_BYTES}. */
export class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super(413, message);
    this.name = "PayloadTooLargeError";
  }
}

// ---------------------------------------------------------------------------
// Project layer
// ---------------------------------------------------------------------------

function projectLayerPath(projectPath: string): string {
  return join(projectPath, AGENTS_FILENAME);
}

export function readProjectLayer(projectPath: string): string {
  return readFileIfExists(projectLayerPath(projectPath));
}

export function writeProjectLayer(projectPath: string, content: string): void {
  const target = projectLayerPath(projectPath);
  writeLayerFile(projectPath, target, content);
}

export function readAllProjectLayers(
  projectPath: string,
): Record<ProjectLayer, LayerContent> {
  return {
    "project-public": describeFile(projectLayerPath(projectPath)),
  };
}

// ---------------------------------------------------------------------------
// Workspace layer
// ---------------------------------------------------------------------------

function workspaceLayerPath(workspacePath: string): string {
  return join(workspacePath, AGENTS_FILENAME);
}

export function readWorkspaceLayer(workspacePath: string): string {
  return readFileIfExists(workspaceLayerPath(workspacePath));
}

export function writeWorkspaceLayer(workspacePath: string, content: string): void {
  const target = workspaceLayerPath(workspacePath);
  writeLayerFile(workspacePath, target, content);
}

export function readAllWorkspaceLayers(
  workspacePath: string,
): Record<WorkspaceLayer, LayerContent> {
  return {
    "workspace-public": describeFile(workspaceLayerPath(workspacePath)),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readFileIfExists(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function describeFile(path: string): LayerContent {
  try {
    const content = readFileSync(path, "utf-8");
    const bytes = Buffer.byteLength(content, "utf-8");
    return { present: true, bytes, content };
  } catch {
    return { present: false, bytes: 0, content: "" };
  }
}

function enforceSizeLimit(content: string): void {
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > AGENTS_MD_MAX_BYTES) {
    throw new PayloadTooLargeError(
      `AGENTS.md exceeds ${AGENTS_MD_MAX_BYTES} bytes (${bytes})`,
    );
  }
}

/**
 * Empty-string content deletes the file (does NOT leave a zero-byte file
 * behind); non-empty content is written atomically via `.tmp` + rename so
 * readers never observe a partial file.
 */
function writeLayerFile(parentDir: string, finalPath: string, content: string): void {
  enforceSizeLimit(content);

  if (content.length === 0) {
    try {
      unlinkSync(finalPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code && code !== "ENOENT") throw err;
    }
    return;
  }

  mkdirSync(parentDir, { recursive: true });
  writeAtomic(finalPath, content);
}

/** Skip the write when bytes already match — preserves mtime on no-op PUTs. */
function writeAtomic(finalPath: string, content: string): void {
  try {
    if (existsSync(finalPath)) {
      const existing = readFileSync(finalPath, "utf-8");
      if (existing === content) return;
    }
  } catch {
    // fall through to write
  }
  const tmpPath = finalPath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, finalPath);
}

/** Exposed for tests that need to assert mtime has/hasn't moved. */
export function fileMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
