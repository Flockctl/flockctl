import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  renameSync,
} from "fs";
import { join } from "path";
import type { DisableEntry, DisableLevel } from "./workspace-config.js";

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

const VALID_LEVELS: ReadonlySet<DisableLevel> = new Set<DisableLevel>([
  "global",
  "workspace",
  "project",
]);

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
      configCache.set(projectPath, { config, mtime: stat.mtimeMs });
      return config;
    } catch (err) {
      console.error(`[project-config] failed to read ${jsonPath}:`, err);
      return {};
    }
  }

  return {};
}

export function validateConfig(raw: any): ProjectConfig {
  if (!raw || typeof raw !== "object") return {};

  const config: ProjectConfig = {};

  if (typeof raw.model === "string") config.model = raw.model;
  if (typeof raw.planningModel === "string") config.planningModel = raw.planningModel;
  if (Array.isArray(raw.allowedProviders)) {
    config.allowedProviders = raw.allowedProviders.filter((p: any) => typeof p === "string");
  }
  if (typeof raw.baseBranch === "string") config.baseBranch = raw.baseBranch;
  if (typeof raw.testCommand === "string") config.testCommand = raw.testCommand;
  if (typeof raw.defaultTimeout === "number") config.defaultTimeout = raw.defaultTimeout;
  if (typeof raw.maxConcurrentTasks === "number") config.maxConcurrentTasks = raw.maxConcurrentTasks;
  if (typeof raw.requiresApproval === "boolean") config.requiresApproval = raw.requiresApproval;
  if (typeof raw.budgetDailyUsd === "number") config.budgetDailyUsd = raw.budgetDailyUsd;
  if (raw.env && typeof raw.env === "object") {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env)) {
      if (typeof k === "string" && typeof v === "string") {
        env[k] = v;
      }
    }
    config.env = env;
  }
  if (typeof raw.permissionMode === "string") config.permissionMode = raw.permissionMode;
  if (Array.isArray(raw.disabledSkills)) {
    config.disabledSkills = normalizeDisableEntries(raw.disabledSkills);
  }
  if (Array.isArray(raw.disabledMcpServers)) {
    config.disabledMcpServers = normalizeDisableEntries(raw.disabledMcpServers);
  }

  return config;
}

function normalizeDisableEntries(input: any[]): DisableEntry[] {
  const result: DisableEntry[] = [];
  for (const item of input) {
    if (typeof item === "string") {
      result.push({ name: item, level: "global" });
    } else if (item && typeof item === "object" && typeof item.name === "string") {
      const level = item.level;
      if (typeof level === "string" && VALID_LEVELS.has(level as DisableLevel)) {
        result.push({ name: item.name, level: level as DisableLevel });
      }
    }
  }
  return result;
}

export function saveProjectConfig(projectPath: string, config: ProjectConfig): void {
  const configDir = join(projectPath, ".flockctl");
  mkdirSync(configDir, { recursive: true });
  const finalPath = join(configDir, "config.json");
  const tmpPath = finalPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, finalPath);
  configCache.delete(projectPath);
}

export function _resetConfigCache() {
  configCache.clear();
}
