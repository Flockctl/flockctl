import {
  readFileSync,
  existsSync,
  statSync,
} from "fs";
import { join } from "path";
import { z } from "zod";
import { writeFileAtomic } from "../lib/fs-safe.js";

export type DisableLevel = "global" | "workspace" | "project";

export interface DisableEntry {
  name: string;
  level: DisableLevel;
}

export interface WorkspaceConfig {
  permissionMode?: string;
  disabledSkills?: DisableEntry[];
  disabledMcpServers?: DisableEntry[];
}

/**
 * Disable-entry shape: either a bare string (legacy shorthand for
 * "globally-installed skill/server, disable everywhere") or a
 * `{ name, level }` object. Zod's `.transform` normalises both into
 * the canonical object form so consumers don't have to discriminate.
 *
 * Exported via {@link disabledEntryArray} as a tolerant array schema
 * — invalid entries are silently dropped per-item so a typo in one
 * row doesn't invalidate the whole `disabledSkills` list.
 */
const disableEntrySchema = z.union([
  z
    .string()
    .min(1)
    .transform((name): DisableEntry => ({ name, level: "global" })),
  z.object({
    name: z.string().min(1),
    level: z.enum(["global", "workspace", "project"]),
  }),
]);

/**
 * Tolerant array of disable entries — preserves the legacy validator's
 * "drop bad entries silently" behaviour. Maps each input through
 * `.safeParse` and keeps only the successes; the array itself is never
 * rejected.
 */
const disabledEntryArray = z
  .array(z.unknown())
  .optional()
  .transform((arr) => {
    if (arr === undefined) return undefined;
    const out: DisableEntry[] = [];
    for (const item of arr) {
      const parsed = disableEntrySchema.safeParse(item);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  });

/**
 * Workspace config schema. Every field optional — the file ships
 * partial configs and we layer them on top of project / global
 * defaults. Unknown keys are silently dropped (`.passthrough()` is
 * deliberately NOT used) so a typo in `permissoinMode` surfaces as
 * "this didn't take effect" instead of "stored alongside the real
 * field, hard to debug".
 *
 * `.catch({})` makes parsing total: any malformed file or any field
 * that fails the shape check falls back to the empty config rather
 * than throwing — same as the previous hand-rolled validator's
 * behaviour, and the desired posture for boot-time config reads
 * (a borked config should not prevent the daemon from starting).
 */
const workspaceConfigSchema = z
  .object({
    permissionMode: z.string().optional(),
    disabledSkills: disabledEntryArray,
    disabledMcpServers: disabledEntryArray,
  })
  .catch({ disabledSkills: undefined, disabledMcpServers: undefined });

// Bounded cache — same rationale as project-config.ts. Audit-round-3
// finding: without a cap, every workspace path ever loaded accumulates
// an entry. 128 is more than enough for any realistic local-daemon
// workload; oldest-eviction keeps the cache warm for active workspaces.
const MAX_WS_CONFIG_CACHE_ENTRIES = 128;
const configCache = new Map<string, { config: WorkspaceConfig; mtime: number }>();

export function loadWorkspaceConfig(workspacePath: string): WorkspaceConfig {
  const flockctlDir = join(workspacePath, ".flockctl");
  const jsonPath = join(flockctlDir, "config.json");

  if (existsSync(jsonPath)) {
    try {
      const stat = statSync(jsonPath);
      const cached = configCache.get(workspacePath);
      if (cached && cached.mtime === stat.mtimeMs) return cached.config;

      const raw = readFileSync(jsonPath, "utf-8");
      const parsed = JSON.parse(raw);
      const config = validateWorkspaceConfig(parsed);
      if (
        configCache.size >= MAX_WS_CONFIG_CACHE_ENTRIES &&
        !configCache.has(workspacePath)
      ) {
        const oldest = configCache.keys().next().value;
        if (oldest !== undefined) configCache.delete(oldest);
      }
      configCache.set(workspacePath, { config, mtime: stat.mtimeMs });
      return config;
    } catch (err) {
      console.error(`[workspace-config] failed to read ${jsonPath}:`, err);
      return {};
    }
  }

  return {};
}

export function validateWorkspaceConfig(raw: unknown): WorkspaceConfig {
  return workspaceConfigSchema.parse(raw);
}

export function saveWorkspaceConfig(workspacePath: string, config: WorkspaceConfig): void {
  const finalPath = join(workspacePath, ".flockctl", "config.json");
  // writeFileAtomic creates the parent directory (`.flockctl/`) and runs the
  // tmp+rename sequence so a concurrent reader never sees a partial write.
  writeFileAtomic(finalPath, JSON.stringify(config, null, 2) + "\n");
  configCache.delete(workspacePath);
}

export function _resetWorkspaceConfigCache() {
  configCache.clear();
}
