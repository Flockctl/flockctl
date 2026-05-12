import { readFileSync, existsSync, readdirSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { getDb } from "../db/index.js";
import { workspaces } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { getGlobalMcpDir } from "../config/index.js";
import { getProjectById } from "../lib/db-helpers.js";
import { loadWorkspaceConfig } from "./workspace-config.js";
import { loadProjectConfig } from "./project-config.js";
import type { DisableEntry } from "./workspace-config.js";

export type McpLevel = "global" | "workspace" | "project";

export interface McpServer {
  name: string;
  level: McpLevel;
  config: McpServerConfig;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  [key: string]: unknown;
}

/**
 * Load MCP server configs from a directory. Accepts two layouts:
 *   1. {dir}/{name}.json — one file per server (preferred)
 *   2. {dir}/mcp.json — legacy combined file with "mcpServers" map
 *
 * For per-server files: a sibling "{name}.local.json" (gitignored) override
 * shallow-merges on top of "{name}.json" so secrets stay off disk in git.
 */
export function loadMcpServersFromDir(dir: string, level: McpLevel): McpServer[] {
  if (!existsSync(dir)) return [];
  const servers: McpServer[] = [];

  const combinedPath = join(dir, "mcp.json");
  if (existsSync(combinedPath)) {
    try {
      const parsed = JSON.parse(readFileSync(combinedPath, "utf-8"));
      const mcpServers = parsed.mcpServers ?? parsed;
      if (mcpServers && typeof mcpServers === "object") {
        for (const [name, config] of Object.entries(mcpServers)) {
          if (typeof config === "object" && config !== null) {
            servers.push({ name, level, config: config as McpServerConfig });
          }
        }
      }
    } catch (err) {
      /* v8 ignore next — JSON.parse / readFileSync throw Error subclasses,
         so String(err) is defensive glue only. */
      console.warn(`[mcp] failed to parse ${combinedPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .filter((e) => e.name !== "mcp.json" && e.name !== "config.json")
      .filter((e) => !e.name.endsWith(".local.json"));

    for (const entry of entries) {
      const name = entry.name.replace(/\.json$/, "");
      if (servers.some((s) => s.name === name)) continue;

      let config: McpServerConfig;
      try {
        config = JSON.parse(readFileSync(join(dir, entry.name), "utf-8"));
      } catch (err) {
        /* v8 ignore next — JSON.parse/readFileSync throw Error subclasses; the
           String(err) fallback is defensive glue only. */
        console.warn(`[mcp] failed to parse ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const overridePath = join(dir, `${name}.local.json`);
      if (existsSync(overridePath)) {
        try {
          const override = JSON.parse(readFileSync(overridePath, "utf-8"));
          if (override && typeof override === "object") {
            config = mergeLocalOverride(config, override);
          }
        } catch (err) {
          /* v8 ignore next — JSON.parse/readFileSync throw Error subclasses;
             the String(err) fallback is defensive glue only. */
          console.warn(`[mcp] failed to parse override ${overridePath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      servers.push({ name, level, config });
    }
  } catch {
    // dir unreadable
  }

  return servers;
}

/**
 * Async sibling of {@link loadMcpServersFromDir}. Mirrors the same
 * combined-file + per-server + override-merge semantics but runs the
 * disk reads through `fs/promises` and parallelises per-file reads
 * with `Promise.all`.
 *
 * Used from REST GET handlers (route-level) so the event loop isn't
 * blocked while we walk dozens of MCP server JSON files. The sync
 * variant remains for the `resolveMcpServersForProject` path, which
 * is called from multiple sync contexts that aren't trivially
 * async-able (AgentSession bootstrap, MCP sync).
 *
 * Audit-round-5 finding.
 */
export async function loadMcpServersFromDirAsync(
  dir: string,
  level: McpLevel,
): Promise<McpServer[]> {
  if (!existsSync(dir)) return [];
  const servers: McpServer[] = [];

  const combinedPath = join(dir, "mcp.json");
  if (existsSync(combinedPath)) {
    try {
      const raw = await readFile(combinedPath, "utf-8");
      const parsed = JSON.parse(raw);
      const mcpServers = parsed.mcpServers ?? parsed;
      if (mcpServers && typeof mcpServers === "object") {
        for (const [name, config] of Object.entries(mcpServers)) {
          if (typeof config === "object" && config !== null) {
            servers.push({ name, level, config: config as McpServerConfig });
          }
        }
      }
    } catch (err) {
      console.warn(
        `[mcp] failed to parse ${combinedPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return servers;
  }

  // Build a parallel-fetch plan over per-server files, applying the
  // same filtering rules as the sync path. Each task resolves to a
  // `McpServer | null` so we can filter post-await.
  const candidates = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .filter((e) => e.name !== "mcp.json" && e.name !== "config.json")
    .filter((e) => !e.name.endsWith(".local.json"));

  const reads = candidates.map(async (entry): Promise<McpServer | null> => {
    const name = entry.name.replace(/\.json$/, "");
    if (servers.some((s) => s.name === name)) return null;
    let config: McpServerConfig;
    try {
      config = JSON.parse(await readFile(join(dir, entry.name), "utf-8"));
    } catch (err) {
      console.warn(
        `[mcp] failed to parse ${entry.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    const overridePath = join(dir, `${name}.local.json`);
    if (existsSync(overridePath)) {
      try {
        const override = JSON.parse(await readFile(overridePath, "utf-8"));
        if (override && typeof override === "object") {
          config = mergeLocalOverride(config, override);
        }
      } catch (err) {
        console.warn(
          `[mcp] failed to parse override ${overridePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { name, level, config };
  });

  const results = await Promise.all(reads);
  for (const r of results) if (r !== null) servers.push(r);
  return servers;
}

function mergeLocalOverride(base: McpServerConfig, override: Record<string, unknown>): McpServerConfig {
  const merged: McpServerConfig = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (k === "env" && v && typeof v === "object" && !Array.isArray(v)) {
      merged.env = { ...(base.env ?? {}), ...(v as Record<string, string>) };
    } else {
      (merged as Record<string, unknown>)[k] = v;
    }
  }
  return merged;
}

function disabledNamesForLevel(entries: DisableEntry[] | undefined, level: McpLevel): Set<string> {
  const result = new Set<string>();
  if (!entries) return result;
  for (const e of entries) if (e.level === level) result.add(e.name);
  return result;
}

/**
 * Resolve the effective MCP server set for a project.
 * Precedence: project > workspace > global.
 */
export function resolveMcpServersForProject(projectId?: number | null): McpServer[] {
  const out = new Map<string, McpServer>();

  const globalDir = getGlobalMcpDir();
  for (const s of loadMcpServersFromDir(globalDir, "global")) out.set(s.name, s);

  if (!projectId) return [...out.values()];

  const db = getDb();
  const project = getProjectById(projectId);
  if (!project) return [...out.values()];

  if (project.workspaceId) {
    const workspace = db.select().from(workspaces).where(eq(workspaces.id, project.workspaceId)).get();
    if (workspace?.path) {
      const wsConfig = loadWorkspaceConfig(workspace.path);
      const wsDisabledGlobal = disabledNamesForLevel(wsConfig.disabledMcpServers, "global");
      const wsDisabledWorkspace = disabledNamesForLevel(wsConfig.disabledMcpServers, "workspace");

      for (const name of wsDisabledGlobal) {
        const s = out.get(name);
        if (s && s.level === "global") out.delete(name);
      }

      const wsMcpDir = join(workspace.path, ".flockctl", "mcp");
      for (const s of loadMcpServersFromDir(wsMcpDir, "workspace")) {
        if (!wsDisabledWorkspace.has(s.name)) out.set(s.name, s);
      }
    }
  }

  if (project.path) {
    const projConfig = loadProjectConfig(project.path);
    const projDisabledGlobal = disabledNamesForLevel(projConfig.disabledMcpServers, "global");
    const projDisabledWorkspace = disabledNamesForLevel(projConfig.disabledMcpServers, "workspace");
    const projDisabledProject = disabledNamesForLevel(projConfig.disabledMcpServers, "project");

    for (const name of projDisabledGlobal) {
      const s = out.get(name);
      if (s && s.level === "global") out.delete(name);
    }
    for (const name of projDisabledWorkspace) {
      const s = out.get(name);
      if (s && s.level === "workspace") out.delete(name);
    }

    const projMcpDir = join(project.path, ".flockctl", "mcp");
    for (const s of loadMcpServersFromDir(projMcpDir, "project")) {
      if (!projDisabledProject.has(s.name)) out.set(s.name, s);
    }
  }

  return [...out.values()];
}

/**
 * Async sibling of `resolveMcpServersForProject`. Fans the three layer
 * reads (global / workspace / project) out in parallel via
 * `loadMcpServersFromDirAsync`, so a session bootstrap doesn't block the
 * event loop on sync FS reads of N MCP server files. The precedence
 * semantics are identical: global → workspace → project, with merging
 * via `Map<name, McpServer>` so later layers replace earlier on the same
 * name.
 *
 * The merge order is preserved by awaiting each layer separately AFTER
 * the parallel reads — only the read fan-out is parallel; the Map
 * insertions remain ordered.
 */
export async function resolveMcpServersForProjectAsync(
  projectId?: number | null,
): Promise<McpServer[]> {
  const out = new Map<string, McpServer>();
  const globalDir = getGlobalMcpDir();

  if (!projectId) {
    for (const s of await loadMcpServersFromDirAsync(globalDir, "global")) {
      out.set(s.name, s);
    }
    return [...out.values()];
  }

  const db = getDb();
  const project = getProjectById(projectId);
  if (!project) {
    for (const s of await loadMcpServersFromDirAsync(globalDir, "global")) {
      out.set(s.name, s);
    }
    return [...out.values()];
  }

  // Fire all three layer reads concurrently. Each `loadMcpServersFromDirAsync`
  // does its own `Promise.all` fan-out over the files in its dir, so the
  // total wall-time becomes the slowest single-layer read instead of the
  // sum across layers.
  const wsMcpDir =
    project.workspaceId !== null && project.workspaceId !== undefined
      ? (() => {
          const ws = db
            .select()
            .from(workspaces)
            .where(eq(workspaces.id, project.workspaceId!))
            .get();
          return ws?.path ? join(ws.path, ".flockctl", "mcp") : null;
        })()
      : null;
  const wsConfigPath = wsMcpDir
    ? join(wsMcpDir, "..", "..")
    : null;
  const projMcpDir = project.path ? join(project.path, ".flockctl", "mcp") : null;

  const [globalServers, wsServers, projServers] = await Promise.all([
    loadMcpServersFromDirAsync(globalDir, "global"),
    wsMcpDir ? loadMcpServersFromDirAsync(wsMcpDir, "workspace") : Promise.resolve([]),
    projMcpDir ? loadMcpServersFromDirAsync(projMcpDir, "project") : Promise.resolve([]),
  ]);

  for (const s of globalServers) out.set(s.name, s);

  if (wsConfigPath) {
    const wsConfig = loadWorkspaceConfig(wsConfigPath);
    const wsDisabledGlobal = disabledNamesForLevel(wsConfig.disabledMcpServers, "global");
    const wsDisabledWorkspace = disabledNamesForLevel(wsConfig.disabledMcpServers, "workspace");
    for (const name of wsDisabledGlobal) {
      const s = out.get(name);
      if (s && s.level === "global") out.delete(name);
    }
    for (const s of wsServers) {
      if (!wsDisabledWorkspace.has(s.name)) out.set(s.name, s);
    }
  }

  if (project.path) {
    const projConfig = loadProjectConfig(project.path);
    const projDisabledGlobal = disabledNamesForLevel(projConfig.disabledMcpServers, "global");
    const projDisabledWorkspace = disabledNamesForLevel(projConfig.disabledMcpServers, "workspace");
    const projDisabledProject = disabledNamesForLevel(projConfig.disabledMcpServers, "project");
    for (const name of projDisabledGlobal) {
      const s = out.get(name);
      if (s && s.level === "global") out.delete(name);
    }
    for (const name of projDisabledWorkspace) {
      const s = out.get(name);
      if (s && s.level === "workspace") out.delete(name);
    }
    for (const s of projServers) {
      if (!projDisabledProject.has(s.name)) out.set(s.name, s);
    }
  }

  return [...out.values()];
}

/**
 * Resolve the effective MCP server set at the workspace level.
 */
export function resolveMcpServersForWorkspace(workspaceId: number): McpServer[] {
  const out = new Map<string, McpServer>();

  const globalDir = getGlobalMcpDir();
  for (const s of loadMcpServersFromDir(globalDir, "global")) out.set(s.name, s);

  const db = getDb();
  const workspace = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!workspace?.path) return [...out.values()];

  const wsConfig = loadWorkspaceConfig(workspace.path);
  const wsDisabledGlobal = disabledNamesForLevel(wsConfig.disabledMcpServers, "global");
  const wsDisabledWorkspace = disabledNamesForLevel(wsConfig.disabledMcpServers, "workspace");

  for (const name of wsDisabledGlobal) {
    const s = out.get(name);
    if (s && s.level === "global") out.delete(name);
  }

  const wsMcpDir = join(workspace.path, ".flockctl", "mcp");
  for (const s of loadMcpServersFromDir(wsMcpDir, "workspace")) {
    if (!wsDisabledWorkspace.has(s.name)) out.set(s.name, s);
  }

  return [...out.values()];
}
