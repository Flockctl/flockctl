import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { projects, workspaces } from "../../db/schema.js";
import {
  resolveMcpServersForProject,
  resolveMcpServersForWorkspace,
  type McpServer,
} from "../mcp.js";
import { ensureGitignore, gitignoreOptionsFromRow } from "./skills-sync.js";
import {
  resolveSecretValue,
  resolveSecretForWorkspace,
  substitutePlaceholders,
} from "../secrets.js";

interface ManifestEntry {
  name: string;
  level: "global" | "workspace" | "project";
}

/**
 * Reconcile MCP state for a project: writes merged <project>/.mcp.json
 * (what Claude Code reads) and a byte-stable manifest at
 * <project>/.flockctl/mcp-state.json.
 */
export function reconcileMcpForProject(projectId: number): void {
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project?.path || !existsSync(project.path)) return;

  const servers = resolveMcpServersForProject(projectId);
  const resolved = resolveServerSecrets(servers, (name) => resolveSecretValue(name, projectId));
  const flockctlDir = join(project.path, ".flockctl");

  writeMergedMcpJson(project.path, resolved);
  writeMcpManifest(flockctlDir, resolved);
  writeLocalMcpReconcileMarker(flockctlDir);
  ensureGitignore(project.path, gitignoreOptionsFromRow(project));
}

/**
 * Reconcile MCP state at the workspace level (global + workspace minus
 * workspace-scoped disables).
 */
export function reconcileMcpForWorkspace(workspaceId: number): void {
  const db = getDb();
  const workspace = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!workspace?.path || !existsSync(workspace.path)) return;

  const servers = resolveMcpServersForWorkspace(workspaceId);
  const resolved = resolveServerSecrets(servers, (name) => resolveSecretForWorkspace(name, workspaceId));
  const flockctlDir = join(workspace.path, ".flockctl");

  writeMergedMcpJson(workspace.path, resolved);
  writeMcpManifest(flockctlDir, resolved);
  writeLocalMcpReconcileMarker(flockctlDir);
  ensureGitignore(workspace.path, gitignoreOptionsFromRow(workspace));
}

export function reconcileAllMcp(): void {
  const db = getDb();
  const allWorkspaces = db.select().from(workspaces).all();
  for (const ws of allWorkspaces) {
    try {
      reconcileMcpForWorkspace(ws.id);
    } catch (err) {
      /* v8 ignore next — defensive: per-workspace reconciler shouldn't throw */
      console.error(`[mcp-sync] workspace ${ws.id} failed:`, err);
    }
  }

  const allProjects = db.select().from(projects).all();
  for (const p of allProjects) {
    try {
      reconcileMcpForProject(p.id);
    } catch (err) {
      /* v8 ignore next — defensive: per-project reconciler shouldn't throw */
      console.error(`[mcp-sync] project ${p.id} failed:`, err);
    }
  }
}

export function reconcileAllMcpInWorkspace(workspaceId: number): void {
  try {
    reconcileMcpForWorkspace(workspaceId);
  } catch (err) {
    /* v8 ignore next — defensive: workspace reconciler shouldn't throw */
    console.error(`[mcp-sync] workspace ${workspaceId} failed:`, err);
  }

  const db = getDb();
  const children = db.select().from(projects).where(eq(projects.workspaceId, workspaceId)).all();
  for (const p of children) {
    try {
      reconcileMcpForProject(p.id);
    } catch (err) {
      /* v8 ignore next — defensive: per-project reconciler shouldn't throw */
      console.error(`[mcp-sync] project ${p.id} failed:`, err);
    }
  }
}

/**
 * Substitute `${secret:NAME}` placeholders in env values and top-level string
 * args using the provided lookup. Missing secrets are logged and the
 * placeholder is left intact so drift is visible in the generated `.mcp.json`.
 */
function resolveServerSecrets(
  servers: McpServer[],
  lookup: (name: string) => string | null,
): McpServer[] {
  return servers.map((s) => {
    const nextEnv: Record<string, string> | undefined = s.config.env
      ? { ...s.config.env }
      : undefined;
    if (nextEnv) {
      for (const [k, v] of Object.entries(nextEnv)) {
        if (typeof v !== "string" || !v.includes("${secret:")) continue;
        const { value, missing } = substitutePlaceholders(v, lookup);
        nextEnv[k] = value;
        for (const name of missing) {
          console.warn(
            `[mcp-sync] server '${s.name}' env '${k}' references unknown secret '${name}' — placeholder kept`,
          );
        }
      }
    }
    return { ...s, config: { ...s.config, env: nextEnv } };
  });
}

function writeMergedMcpJson(targetDir: string, servers: McpServer[]): void {
  const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name));
  const mcpServers: Record<string, unknown> = {};
  for (const s of sorted) mcpServers[s.name] = s.config;

  const content = JSON.stringify({ mcpServers }, null, 2) + "\n";
  const finalPath = join(targetDir, ".mcp.json");

  try {
    if (existsSync(finalPath) && readFileSync(finalPath, "utf-8") === content) return;
  } catch {
    // fall through
  }

  const tmpPath = finalPath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, finalPath);
}

function writeMcpManifest(flockctlDir: string, servers: McpServer[]): void {
  mkdirSync(flockctlDir, { recursive: true });

  const entries: ManifestEntry[] = servers
    .map((s) => ({ name: s.name, level: s.level }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const content = JSON.stringify({ mcpServers: entries }, null, 2) + "\n";
  const finalPath = join(flockctlDir, "mcp-state.json");

  try {
    if (existsSync(finalPath) && readFileSync(finalPath, "utf-8") === content) return;
  } catch {
    // fall through
  }

  const tmpPath = finalPath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, finalPath);
}

function writeLocalMcpReconcileMarker(flockctlDir: string): void {
  mkdirSync(flockctlDir, { recursive: true });
  const finalPath = join(flockctlDir, ".mcp-reconcile");
  const content = JSON.stringify({ reconciled_at: new Date().toISOString() }, null, 2) + "\n";
  const tmpPath = finalPath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, finalPath);
}
