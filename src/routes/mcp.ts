import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { workspaces, projects } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { resolveMcpServersForProject } from "../services/mcp.js";
import { loadMcpServersFromDir } from "../services/mcp.js";
import { getGlobalMcpDir } from "../config.js";
import {
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  type DisableEntry,
  type DisableLevel,
} from "../services/workspace-config.js";
import { loadProjectConfig, saveProjectConfig } from "../services/project-config.js";
import {
  reconcileMcpForWorkspace,
  reconcileMcpForProject,
  reconcileAllMcpInWorkspace,
  reconcileAllMcp,
} from "../services/claude-mcp-sync.js";
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";

function validateName(name: string): void {
  if (!name || /[\/\\]/.test(name) || name.includes("..") || name === "." || name === "..") {
    throw new ValidationError("Invalid name: must not contain path separators or '..'");
  }
}

const VALID_LEVELS: ReadonlySet<DisableLevel> = new Set<DisableLevel>([
  "global",
  "workspace",
  "project",
]);

function validateDisableBody(body: any, allowedLevels: DisableLevel[]): DisableEntry {
  if (!body || typeof body !== "object") throw new ValidationError("body required");
  if (typeof body.name !== "string" || !body.name) throw new ValidationError("name is required");
  if (typeof body.level !== "string" || !VALID_LEVELS.has(body.level as DisableLevel)) {
    throw new ValidationError("level must be one of 'global' | 'workspace' | 'project'");
  }
  const level = body.level as DisableLevel;
  if (!allowedLevels.includes(level)) {
    throw new ValidationError(`level '${level}' is not addressable from this config scope`);
  }
  return { name: body.name, level };
}

function entriesAddUnique(entries: DisableEntry[], entry: DisableEntry): DisableEntry[] {
  if (entries.some((e) => e.name === entry.name && e.level === entry.level)) return entries;
  return [...entries, entry];
}

function entriesRemove(entries: DisableEntry[], entry: DisableEntry): DisableEntry[] {
  return entries.filter((e) => !(e.name === entry.name && e.level === entry.level));
}

export const mcpRoutes = new Hono();

// GET /mcp/global — list global MCP servers
mcpRoutes.get("/global", (c) => {
  const globalDir = getGlobalMcpDir();
  const servers = loadMcpServersFromDir(globalDir, "global");
  return c.json(servers);
});

// GET /mcp/resolved?projectId=X — resolved MCP servers for project
mcpRoutes.get("/resolved", (c) => {
  const projectId = c.req.query("projectId");
  const pid = projectId ? parseInt(projectId) : null;
  const servers = resolveMcpServersForProject(pid);
  return c.json(servers);
});

// POST /mcp/global — create/update global MCP server
mcpRoutes.post("/global", async (c) => {
  const body = await c.req.json();
  if (!body.name) throw new ValidationError("name is required");
  validateName(body.name);
  if (!body.config) throw new ValidationError("config is required");

  const globalDir = getGlobalMcpDir();
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, `${body.name}.json`), JSON.stringify(body.config, null, 2));

  queueGlobalMcpReconcile();
  return c.json({ name: body.name, level: "global", saved: true }, 201);
});

// DELETE /mcp/global/:name
mcpRoutes.delete("/global/:name", (c) => {
  const name = c.req.param("name");
  validateName(name);
  const globalDir = getGlobalMcpDir();
  const filePath = join(globalDir, `${name}.json`);
  if (!existsSync(filePath)) throw new NotFoundError("MCP server");
  unlinkSync(filePath);
  queueGlobalMcpReconcile();
  return c.json({ deleted: true });
});

// GET /mcp/workspaces/:id/servers — list workspace MCP servers
mcpRoutes.get("/workspaces/:id/servers", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const ws = db.select().from(workspaces).where(eq(workspaces.id, id)).get();
  if (!ws) throw new NotFoundError("Workspace");

  const mcpDir = join(ws.path, ".flockctl", "mcp");
  const servers = loadMcpServersFromDir(mcpDir, "workspace");
  return c.json(servers);
});

// POST /mcp/workspaces/:id/servers — create/update workspace MCP server
mcpRoutes.post("/workspaces/:id/servers", async (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const ws = db.select().from(workspaces).where(eq(workspaces.id, id)).get();
  if (!ws) throw new NotFoundError("Workspace");

  const body = await c.req.json();
  if (!body.name) throw new ValidationError("name is required");
  validateName(body.name);
  if (!body.config) throw new ValidationError("config is required");

  const mcpDir = join(ws.path, ".flockctl", "mcp");
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(join(mcpDir, `${body.name}.json`), JSON.stringify(body.config, null, 2));

  queueWorkspaceMcpReconcile(id);
  return c.json({ name: body.name, level: "workspace", saved: true }, 201);
});

// DELETE /mcp/workspaces/:id/servers/:name
mcpRoutes.delete("/workspaces/:id/servers/:name", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const name = c.req.param("name");
  validateName(name);
  const ws = db.select().from(workspaces).where(eq(workspaces.id, id)).get();
  if (!ws) throw new NotFoundError("Workspace");

  const filePath = join(ws.path, ".flockctl", "mcp", `${name}.json`);
  if (!existsSync(filePath)) throw new NotFoundError("MCP server");
  unlinkSync(filePath);

  queueWorkspaceMcpReconcile(id);
  return c.json({ deleted: true });
});

// GET /mcp/workspaces/:wid/projects/:pid/servers — list project MCP servers
mcpRoutes.get("/workspaces/:wid/projects/:pid/servers", (c) => {
  const db = getDb();
  const pid = parseInt(c.req.param("pid"));
  const project = db.select().from(projects).where(eq(projects.id, pid)).get();
  if (!project?.path) throw new NotFoundError("Project");

  const mcpDir = join(project.path, ".flockctl", "mcp");
  const servers = loadMcpServersFromDir(mcpDir, "project");
  return c.json(servers);
});

// POST /mcp/workspaces/:wid/projects/:pid/servers — create/update project MCP server
mcpRoutes.post("/workspaces/:wid/projects/:pid/servers", async (c) => {
  const db = getDb();
  const pid = parseInt(c.req.param("pid"));
  const project = db.select().from(projects).where(eq(projects.id, pid)).get();
  if (!project?.path) throw new NotFoundError("Project");

  const body = await c.req.json();
  if (!body.name) throw new ValidationError("name is required");
  validateName(body.name);
  if (!body.config) throw new ValidationError("config is required");

  const mcpDir = join(project.path, ".flockctl", "mcp");
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(join(mcpDir, `${body.name}.json`), JSON.stringify(body.config, null, 2));

  queueProjectMcpReconcile(pid);
  return c.json({ name: body.name, level: "project", saved: true }, 201);
});

// DELETE /mcp/workspaces/:wid/projects/:pid/servers/:name
mcpRoutes.delete("/workspaces/:wid/projects/:pid/servers/:name", (c) => {
  const db = getDb();
  const pid = parseInt(c.req.param("pid"));
  const name = c.req.param("name");
  validateName(name);
  const project = db.select().from(projects).where(eq(projects.id, pid)).get();
  if (!project?.path) throw new NotFoundError("Project");

  const filePath = join(project.path, ".flockctl", "mcp", `${name}.json`);
  if (!existsSync(filePath)) throw new NotFoundError("MCP server");
  unlinkSync(filePath);

  queueProjectMcpReconcile(pid);
  return c.json({ deleted: true });
});

// ─── Disable/Enable MCP servers (body-based {name, level}) ───

// POST /mcp/workspaces/:id/disabled-mcp — body: {name, level} with level ∈ {global, workspace}
mcpRoutes.post("/workspaces/:id/disabled-mcp", async (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const ws = db.select().from(workspaces).where(eq(workspaces.id, id)).get();
  if (!ws) throw new NotFoundError("Workspace");
  if (!ws.path) throw new ValidationError("Workspace has no path");

  const body = await c.req.json();
  const entry = validateDisableBody(body, ["global", "workspace"]);

  const cfg = loadWorkspaceConfig(ws.path);
  cfg.disabledMcpServers = entriesAddUnique(cfg.disabledMcpServers ?? [], entry);
  saveWorkspaceConfig(ws.path, cfg);
  queueWorkspaceMcpReconcile(id);
  return c.json({ disabledMcpServers: cfg.disabledMcpServers });
});

// DELETE /mcp/workspaces/:id/disabled-mcp — body: {name, level}
mcpRoutes.delete("/workspaces/:id/disabled-mcp", async (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const ws = db.select().from(workspaces).where(eq(workspaces.id, id)).get();
  if (!ws) throw new NotFoundError("Workspace");
  if (!ws.path) throw new ValidationError("Workspace has no path");

  const body = await c.req.json();
  const entry = validateDisableBody(body, ["global", "workspace"]);

  const cfg = loadWorkspaceConfig(ws.path);
  cfg.disabledMcpServers = entriesRemove(cfg.disabledMcpServers ?? [], entry);
  saveWorkspaceConfig(ws.path, cfg);
  queueWorkspaceMcpReconcile(id);
  return c.json({ disabledMcpServers: cfg.disabledMcpServers });
});

// GET /mcp/workspaces/:id/disabled-mcp — list disabled MCP servers for workspace
mcpRoutes.get("/workspaces/:id/disabled-mcp", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const ws = db.select().from(workspaces).where(eq(workspaces.id, id)).get();
  if (!ws) throw new NotFoundError("Workspace");

  const cfg = ws.path ? loadWorkspaceConfig(ws.path) : {};
  return c.json({ disabledMcpServers: cfg.disabledMcpServers ?? [] });
});

// POST /mcp/projects/:pid/disabled-mcp — body: {name, level} with level ∈ {global, workspace, project}
mcpRoutes.post("/projects/:pid/disabled-mcp", async (c) => {
  const db = getDb();
  const pid = parseInt(c.req.param("pid"));
  const project = db.select().from(projects).where(eq(projects.id, pid)).get();
  if (!project) throw new NotFoundError("Project");
  if (!project.path) throw new ValidationError("Project has no path");

  const body = await c.req.json();
  const entry = validateDisableBody(body, ["global", "workspace", "project"]);

  const cfg = loadProjectConfig(project.path);
  cfg.disabledMcpServers = entriesAddUnique(cfg.disabledMcpServers ?? [], entry);
  saveProjectConfig(project.path, cfg);
  queueProjectMcpReconcile(pid);
  return c.json({ disabledMcpServers: cfg.disabledMcpServers });
});

// DELETE /mcp/projects/:pid/disabled-mcp — body: {name, level}
mcpRoutes.delete("/projects/:pid/disabled-mcp", async (c) => {
  const db = getDb();
  const pid = parseInt(c.req.param("pid"));
  const project = db.select().from(projects).where(eq(projects.id, pid)).get();
  if (!project) throw new NotFoundError("Project");
  if (!project.path) throw new ValidationError("Project has no path");

  const body = await c.req.json();
  const entry = validateDisableBody(body, ["global", "workspace", "project"]);

  const cfg = loadProjectConfig(project.path);
  cfg.disabledMcpServers = entriesRemove(cfg.disabledMcpServers ?? [], entry);
  saveProjectConfig(project.path, cfg);
  queueProjectMcpReconcile(pid);
  return c.json({ disabledMcpServers: cfg.disabledMcpServers });
});

// GET /mcp/projects/:pid/disabled-mcp — list disabled MCP servers for project
mcpRoutes.get("/projects/:pid/disabled-mcp", (c) => {
  const db = getDb();
  const pid = parseInt(c.req.param("pid"));
  const project = db.select().from(projects).where(eq(projects.id, pid)).get();
  if (!project) throw new NotFoundError("Project");

  const cfg = project.path ? loadProjectConfig(project.path) : {};
  return c.json({ disabledMcpServers: cfg.disabledMcpServers ?? [] });
});

// ─── Async reconcile queue helpers ───

function queueGlobalMcpReconcile() {
  setImmediate(() => {
    try {
      reconcileAllMcp();
    } catch (err) {
      console.error("[mcp] global reconcile failed:", err);
    }
  });
}

function queueWorkspaceMcpReconcile(workspaceId: number) {
  setImmediate(() => {
    try {
      reconcileMcpForWorkspace(workspaceId);
      reconcileAllMcpInWorkspace(workspaceId);
    } catch (err) {
      console.error(`[mcp] workspace ${workspaceId} reconcile failed:`, err);
    }
  });
}

function queueProjectMcpReconcile(projectId: number) {
  setImmediate(() => {
    try {
      reconcileMcpForProject(projectId);
    } catch (err) {
      console.error(`[mcp] project ${projectId} reconcile failed:`, err);
    }
  });
}
