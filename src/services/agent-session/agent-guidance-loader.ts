import { lstatSync, readFileSync, realpathSync, statSync } from "fs";
import { join } from "path";

export type LayerName = "user" | "workspace-public" | "project-public";

export interface LayerResult {
  layer: LayerName;
  path: string;
  bytes: number;
  content: string;
  truncated: boolean;
}

export interface LoaderInput {
  /** Flockctl home directory (e.g. `~/flockctl`). Hosts the user-global layer. */
  flockctlHome: string;
  /** Workspace root, or null for sessions without a workspace context. */
  workspacePath: string | null;
  /** Project root, or null for sessions that don't scope to a single project. */
  projectPath: string | null;
}

export interface LoaderOutput {
  layers: LayerResult[];
  totalBytes: number;
  truncatedLayers: LayerName[];
  /** Ready-to-inject string with layer-header banners; empty when no layers present. */
  mergedWithHeaders: string;
}

/** Per-layer cap: 256 KiB. Matches the existing API write limit in agents-sync. */
export const PER_LAYER_CAP = 256 * 1024;
/** Total merged cap: 1 MiB. Later layers get dropped when budget runs out. */
export const TOTAL_CAP = 1024 * 1024;

/**
 * Read layered agent-guidance files and merge them into a single string for
 * injection into the agent SDK's system prompt.
 *
 * Layers (read in order; later layers append to earlier):
 *   1. user              `<flockctlHome>/AGENTS.md`
 *   2. workspace-public  `<workspacePath>/AGENTS.md`
 *   3. project-public    `<projectPath>/AGENTS.md`
 *
 * Skips (returns no layer entry for):
 *   - Missing files, directories named `AGENTS.md`, zero-byte files.
 *   - Symlinks whose realpath resolves outside the containing root (traversal guard).
 *   - Files the process cannot read (permission denied / I/O error).
 *
 * Caps:
 *   - Per-layer content > 256 KiB is truncated with a `<!-- flockctl:truncated ... -->` marker.
 *   - Cumulative merged size capped at 1 MiB; layers that overflow the budget
 *     are either truncated to fit or skipped entirely, and listed in `truncatedLayers`.
 *
 * Pure function — no DB, no logging. Sync I/O matches the surrounding
 * `injectIncidents` / `injectStateMachines` / `injectWorkspaceProjects` chain
 * in `AgentSession.run()`.
 */
export function loadAgentGuidance(input: LoaderInput): LoaderOutput {
  const candidates: Array<{
    layer: LayerName;
    path: string;
    containingRoot: string;
  }> = [
    {
      layer: "user",
      path: join(input.flockctlHome, "AGENTS.md"),
      containingRoot: input.flockctlHome,
    },
  ];

  if (input.workspacePath) {
    candidates.push({
      layer: "workspace-public",
      path: join(input.workspacePath, "AGENTS.md"),
      containingRoot: input.workspacePath,
    });
  }

  if (input.projectPath) {
    candidates.push({
      layer: "project-public",
      path: join(input.projectPath, "AGENTS.md"),
      containingRoot: input.projectPath,
    });
  }

  const layers: LayerResult[] = [];
  const truncatedLayers: LayerName[] = [];
  let totalBytes = 0;

  for (const c of candidates) {
    const read = readLayerSafely(c.layer, c.path, c.containingRoot);
    if (read === null) continue;

    let finalContent = read.content;
    let finalTruncated = read.truncated;

    // Enforce total cap. `remaining` is the byte budget left for this layer;
    // if the layer doesn't fit, truncate to remaining and stamp a total-cap
    // marker. Subsequent layers see remaining <= 0 and skip.
    const layerBytes = Buffer.byteLength(finalContent, "utf8");
    const remaining = TOTAL_CAP - totalBytes;
    /* v8 ignore start — PER_LAYER_CAP * 3 layers (768 KiB) < TOTAL_CAP (1 MiB), so these total-cap branches cannot fire through the public loader */
    if (remaining <= 0) {
      truncatedLayers.push(c.layer);
      continue;
    }
    if (layerBytes > remaining) {
      const cutMarker =
        `\n<!-- flockctl:truncated layer=${c.layer} original_bytes=${read.originalBytes} reason=total-cap -->`;
      const keep = Math.max(0, remaining - Buffer.byteLength(cutMarker, "utf8"));
      finalContent = safeSliceUtf8(finalContent, keep) + cutMarker;
      finalTruncated = true;
    }
    /* v8 ignore stop */

    if (finalTruncated && !truncatedLayers.includes(c.layer)) {
      truncatedLayers.push(c.layer);
    }

    const bytes = Buffer.byteLength(finalContent, "utf8");
    layers.push({
      layer: c.layer,
      path: c.path,
      bytes,
      content: finalContent,
      truncated: finalTruncated,
    });
    totalBytes += bytes;
  }

  const mergedWithHeaders = buildMerged(layers, totalBytes, truncatedLayers);
  return { layers, totalBytes, truncatedLayers, mergedWithHeaders };
}

/**
 * Workspace-scoped variant of {@link loadAgentGuidance}. Only resolves the
 * first two layers (user, workspace-public) — there is no project path in a
 * workspace-level view, and passing `projectPath == workspacePath` to the full
 * loader would re-read the workspace-level file as a "project" layer.
 *
 * Used by `GET /workspaces/:id/agents-md/effective` so the UI can preview the
 * merged guidance a session rooted at the workspace would see.
 */
export function loadWorkspaceAgentGuidance(
  workspacePath: string,
  flockctlHome: string,
): LoaderOutput {
  return loadAgentGuidance({
    flockctlHome,
    workspacePath: workspacePath && workspacePath !== flockctlHome ? workspacePath : null,
    projectPath: null,
  });
}

interface ReadResult {
  content: string;
  originalBytes: number;
  truncated: boolean;
}

function readLayerSafely(
  layer: LayerName,
  path: string,
  containingRoot: string,
): ReadResult | null {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (st.isDirectory()) return null;

  // Symlink traversal guard. Resolve both the file and the containing root so
  // macOS /tmp → /private/tmp normalisation doesn't trip the startsWith check.
  if (st.isSymbolicLink()) {
    let realPath: string;
    let realRoot: string;
    try {
      realPath = realpathSync(path);
      realRoot = realpathSync(containingRoot);
    } catch {
      return null;
    }
    if (realPath !== realRoot && !realPath.startsWith(realRoot + "/")) {
      return null;
    }
    // Also reject if the symlink target is a directory.
    try {
      if (statSync(realPath).isDirectory()) return null;
    } catch {
      return null;
    }
  }

  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return null;
  }
  const originalBytes = buf.byteLength;
  if (originalBytes === 0) return null;

  let content: string;
  let truncated = false;
  if (originalBytes > PER_LAYER_CAP) {
    const keptUtf8 = buf.slice(0, PER_LAYER_CAP).toString("utf8");
    // `Buffer.slice(bytes).toString("utf8")` may leave a dangling multibyte
    // at the end; `toString` replaces it with U+FFFD. Strip any trailing U+FFFD
    // so the truncation marker starts on a clean line.
    const cleaned = keptUtf8.replace(/\uFFFD+$/u, "");
    content =
      cleaned +
      `\n<!-- flockctl:truncated layer=${layer} original_bytes=${originalBytes} reason=per-layer-cap -->`;
    truncated = true;
  } else {
    content = buf.toString("utf8");
  }

  return { content, originalBytes, truncated };
}

/**
 * Slice a utf-8 string to at most `maxBytes` bytes without splitting a
 * multibyte codepoint. Uses `Buffer.byteLength` probes because JS strings
 * index by UTF-16 code units, not bytes.
 */
/* v8 ignore start — only called from the unreachable total-cap branch in loadAgentGuidance (see note above) */
function safeSliceUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  const slice = buf.slice(0, maxBytes).toString("utf8");
  return slice.replace(/\uFFFD+$/u, "");
}
/* v8 ignore stop */

function buildMerged(
  layers: LayerResult[],
  totalBytes: number,
  truncatedLayers: LayerName[],
): string {
  if (layers.length === 0) return "";
  const parts: string[] = [];
  for (const l of layers) {
    const truncAttr = l.truncated ? " truncated=true" : "";
    parts.push(
      `<!-- flockctl:agent-guidance layer=${l.layer} path=${l.path} bytes=${l.bytes}${truncAttr} -->`,
    );
    parts.push(l.content);
  }
  const truncAttr =
    truncatedLayers.length > 0
      ? ` truncated_layers=${truncatedLayers.join(",")}`
      : "";
  parts.push(
    `<!-- flockctl:agent-guidance end total_bytes=${totalBytes}${truncAttr} -->`,
  );
  return parts.join("\n");
}
