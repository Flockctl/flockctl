import { existsSync } from "fs";
import { getRawDb } from "./index.js";
import {
  loadProjectConfig,
  saveProjectConfig,
  type ProjectConfig,
} from "../services/project-config.js";
import {
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  type WorkspaceConfig,
  type DisableEntry,
} from "../services/workspace-config.js";

type ColumnInfo = { name: string };

function tableColumns(table: string): Set<string> {
  const sqlite = getRawDb();
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return new Set(rows.map((r) => r.name));
}

function parseStringArray(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : undefined;
  } catch {
    return undefined;
  }
}

function parseLegacyDisableArray(value: unknown): DisableEntry[] | undefined {
  const names = parseStringArray(value);
  if (!names || names.length === 0) return undefined;
  return names.map((name) => ({ name, level: "global" as const }));
}

function parseEnvMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === "string" && typeof v === "string") out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Copy settings from DB rows into .flockctl/config.json — but only when the
 * JSON file is missing the key. JSON wins on conflict. Runs before drizzle
 * migrations drop the DB columns. Idempotent; a no-op on DBs where the
 * columns have already been dropped.
 */
export function backfillProjectConfigsFromDb(): void {
  const sqlite = getRawDb();
  const cols = tableColumns("projects");
  if (cols.size === 0) return;

  const candidateCols = [
    "path",
    "model",
    "planning_model",
    "allowed_providers",
    "base_branch",
    "test_command",
    "max_concurrent_tasks",
    "budget_daily_usd",
    "requires_approval",
    "env_vars",
    "disabled_skills",
    "disabled_mcp_servers",
    "permission_mode",
    "default_timeout_seconds",
  ].filter((c) => cols.has(c));

  if (!candidateCols.includes("path")) return;

  const selectList = candidateCols.join(", ");
  const rows = sqlite.prepare(`SELECT ${selectList} FROM projects`).all() as Record<string, unknown>[];

  for (const row of rows) {
    const path = row.path as string | null;
    if (!path || !existsSync(path)) continue;

    const existing = loadProjectConfig(path);
    const merged: ProjectConfig = { ...existing };
    let changed = false;

    const setIfMissing = <K extends keyof ProjectConfig>(key: K, value: ProjectConfig[K] | undefined) => {
      if (merged[key] === undefined && value !== undefined && value !== null) {
        merged[key] = value;
        changed = true;
      }
    };

    if (cols.has("model")) setIfMissing("model", (row.model as string) ?? undefined);
    if (cols.has("planning_model")) setIfMissing("planningModel", (row.planning_model as string) ?? undefined);
    if (cols.has("allowed_providers")) setIfMissing("allowedProviders", parseStringArray(row.allowed_providers));
    if (cols.has("base_branch")) setIfMissing("baseBranch", (row.base_branch as string) ?? undefined);
    if (cols.has("test_command")) setIfMissing("testCommand", (row.test_command as string) ?? undefined);
    if (cols.has("max_concurrent_tasks")) {
      const v = row.max_concurrent_tasks;
      setIfMissing("maxConcurrentTasks", typeof v === "number" ? v : undefined);
    }
    if (cols.has("budget_daily_usd")) {
      const v = row.budget_daily_usd;
      setIfMissing("budgetDailyUsd", typeof v === "number" ? v : undefined);
    }
    if (cols.has("requires_approval")) {
      const v = row.requires_approval;
      setIfMissing("requiresApproval", typeof v === "number" ? v === 1 : typeof v === "boolean" ? v : undefined);
    }
    if (cols.has("env_vars")) setIfMissing("env", parseEnvMap(row.env_vars));
    if (cols.has("disabled_skills")) setIfMissing("disabledSkills", parseLegacyDisableArray(row.disabled_skills));
    if (cols.has("disabled_mcp_servers")) setIfMissing("disabledMcpServers", parseLegacyDisableArray(row.disabled_mcp_servers));
    if (cols.has("permission_mode")) setIfMissing("permissionMode", (row.permission_mode as string) ?? undefined);
    if (cols.has("default_timeout_seconds")) {
      const v = row.default_timeout_seconds;
      setIfMissing("defaultTimeout", typeof v === "number" ? v : undefined);
    }

    if (changed) {
      try { saveProjectConfig(path, merged); }
      catch (err) { console.warn(`[config-backfill] project ${path}: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }
}

export function backfillWorkspaceConfigsFromDb(): void {
  const sqlite = getRawDb();
  const cols = tableColumns("workspaces");
  if (cols.size === 0) return;

  const candidateCols = [
    "path",
    "disabled_skills",
    "disabled_mcp_servers",
    "permission_mode",
  ].filter((c) => cols.has(c));

  if (!candidateCols.includes("path")) return;

  const selectList = candidateCols.join(", ");
  const rows = sqlite.prepare(`SELECT ${selectList} FROM workspaces`).all() as Record<string, unknown>[];

  for (const row of rows) {
    const path = row.path as string | null;
    if (!path || !existsSync(path)) continue;

    const existing = loadWorkspaceConfig(path);
    const merged: WorkspaceConfig = { ...existing };
    let changed = false;

    const setIfMissing = <K extends keyof WorkspaceConfig>(key: K, value: WorkspaceConfig[K] | undefined) => {
      if (merged[key] === undefined && value !== undefined && value !== null) {
        merged[key] = value;
        changed = true;
      }
    };

    if (cols.has("disabled_skills")) setIfMissing("disabledSkills", parseLegacyDisableArray(row.disabled_skills));
    if (cols.has("disabled_mcp_servers")) setIfMissing("disabledMcpServers", parseLegacyDisableArray(row.disabled_mcp_servers));
    if (cols.has("permission_mode")) setIfMissing("permissionMode", (row.permission_mode as string) ?? undefined);

    if (changed) {
      try { saveWorkspaceConfig(path, merged); }
      catch (err) { console.warn(`[config-backfill] workspace ${path}: ${err instanceof Error ? err.message : String(err)}`); }
    }
  }
}

export function backfillConfigsFromDb(): void {
  backfillProjectConfigsFromDb();
  backfillWorkspaceConfigsFromDb();
}
