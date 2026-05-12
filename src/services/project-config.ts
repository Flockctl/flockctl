import {
  readFileSync,
  existsSync,
  statSync,
} from "fs";
import { join } from "path";
import { z } from "zod";
import { writeFileAtomic } from "../lib/fs-safe.js";
import type { DisableEntry } from "./workspace-config.js";

export type { DisableEntry, DisableLevel } from "./workspace-config.js";

export interface ProjectConfig {
  model?: string;
  planningModel?: string;
  allowedProviders?: string[];
  baseBranch?: string;
  testCommand?: string;
  defaultTimeout?: number;
  maxConcurrentTasks?: number;
  requiresApproval?: boolean;
  budgetDailyUsd?: number;
  env?: Record<string, string>;
  permissionMode?: string;
  disabledSkills?: DisableEntry[];
  disabledMcpServers?: DisableEntry[];
}

/** Same shorthand → object normalisation as in workspace-config. */
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

/** Tolerant array of disable entries — invalid items are silently
 * dropped per-row, mirroring the legacy validator's behaviour. */
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
 * Project config schema. Same `.catch({})` total-parse posture as the
 * workspace variant — boot-time config reads must be infallible.
 *
 * `env` accepts any string/string record; non-string values are
 * filtered out via a `.transform()` so a stray `env.VERBOSE: true`
 * doesn't pollute the env vars passed to spawned subprocesses.
 *
 * `allowedProviders` filters non-string entries similarly so a
 * malformed `["openai", 42]` surfaces as `["openai"]` rather than a
 * type error downstream.
 */
const projectConfigSchema = z
  .object({
    model: z.string().optional(),
    planningModel: z.string().optional(),
    allowedProviders: z
      .array(z.unknown())
      .optional()
      .transform((arr) =>
        arr === undefined
          ? undefined
          : arr.filter((v): v is string => typeof v === "string"),
      ),
    baseBranch: z.string().optional(),
    testCommand: z.string().optional(),
    defaultTimeout: z.number().optional(),
    maxConcurrentTasks: z.number().optional(),
    requiresApproval: z.boolean().optional(),
    budgetDailyUsd: z.number().optional(),
    env: z
      .record(z.string(), z.unknown())
      .optional()
      .transform((rec) => {
        if (rec === undefined) return undefined;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(rec)) {
          if (typeof v === "string") out[k] = v;
        }
        return out;
      }),
    permissionMode: z.string().optional(),
    disabledSkills: disabledEntryArray,
    disabledMcpServers: disabledEntryArray,
  })
  // The `.transform()` calls on allowedProviders / env / disabled*
  // make those keys `present-but-undefined` in the parsed output
  // type, so the catch default has to include them. Functionally
  // equivalent to `{}` — undefined values get pruned by callers.
  .catch({
    allowedProviders: undefined,
    env: undefined,
    disabledSkills: undefined,
    disabledMcpServers: undefined,
  });

// Bounded mtime-keyed cache. Without the cap, a daemon that loads
// hundreds of project configs over its lifetime would grow this Map
// unbounded. 256 entries comfortably covers any single-user workload;
// oldest-eviction (Map iteration order = insertion order per spec) keeps
// the cache warm for projects in active use. Audit-round-3 finding.
const MAX_CONFIG_CACHE_ENTRIES = 256;
const configCache = new Map<string, { config: ProjectConfig; mtime: number }>();

export function loadProjectConfig(projectPath: string): ProjectConfig {
  const flockctlDir = join(projectPath, ".flockctl");
  const jsonPath = join(flockctlDir, "config.json");

  if (existsSync(jsonPath)) {
    try {
      const stat = statSync(jsonPath);
      const cached = configCache.get(projectPath);
      if (cached && cached.mtime === stat.mtimeMs) return cached.config;

      const raw = readFileSync(jsonPath, "utf-8");
      const parsed = JSON.parse(raw);
      const config = validateConfig(parsed);
      if (configCache.size >= MAX_CONFIG_CACHE_ENTRIES && !configCache.has(projectPath)) {
        const oldest = configCache.keys().next().value;
        if (oldest !== undefined) configCache.delete(oldest);
      }
      configCache.set(projectPath, { config, mtime: stat.mtimeMs });
      return config;
    } catch (err) {
      console.error(`[project-config] failed to read ${jsonPath}:`, err);
      return {};
    }
  }

  return {};
}

export function validateConfig(raw: unknown): ProjectConfig {
  return projectConfigSchema.parse(raw);
}

export function saveProjectConfig(projectPath: string, config: ProjectConfig): void {
  const finalPath = join(projectPath, ".flockctl", "config.json");
  // writeFileAtomic creates the parent directory (`.flockctl/`) and runs the
  // tmp+rename sequence so a concurrent reader never sees a partial write.
  writeFileAtomic(finalPath, JSON.stringify(config, null, 2) + "\n");
  configCache.delete(projectPath);
}

export function _resetConfigCache() {
  configCache.clear();
}
