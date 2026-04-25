import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  renameSync,
} from "fs";
import { join } from "path";

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

const VALID_LEVELS: ReadonlySet<DisableLevel> = new Set<DisableLevel>([
  "global",
  "workspace",
  "project",
]);

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
      configCache.set(workspacePath, { config, mtime: stat.mtimeMs });
      return config;
    } catch (err) {
      console.error(`[workspace-config] failed to read ${jsonPath}:`, err);
      return {};
    }
  }

  return {};
}

export function validateWorkspaceConfig(raw: any): WorkspaceConfig {
  if (!raw || typeof raw !== "object") return {};

  const config: WorkspaceConfig = {};

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

export function saveWorkspaceConfig(workspacePath: string, config: WorkspaceConfig): void {
  const configDir = join(workspacePath, ".flockctl");
  mkdirSync(configDir, { recursive: true });
  const finalPath = join(configDir, "config.json");
  const tmpPath = finalPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, finalPath);
  configCache.delete(workspacePath);
}

export function _resetWorkspaceConfigCache() {
  configCache.clear();
}
