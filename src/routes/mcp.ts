import { Hono } from "hono";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { parseIdParam, parseIdQuery, parseJsonBodySafe } from "../lib/route-params.js";
import { getWorkspaceOrThrow, getProjectOrThrow } from "../lib/db-helpers.js";
import { assertSafeName } from "../lib/validate-name.js";
import { resolveMcpServersForProject } from "../services/mcp.js";
import { loadMcpServersFromDirAsync } from "../services/mcp.js";
import { getGlobalMcpDir, getMcpDir } from "../config/index.js";
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
} from "../services/claude/mcp-sync.js";
import { existsSync } from "fs";
import { mkdir, writeFile, unlink } from "fs/promises";
import { join } from "path";
import { runReconcileWithObservability } from "../lib/reconcile-observability.js";

// `validateDisableBody`, `entriesAddUnique`, `entriesRemove` lifted to
// `lib/disable-entries.ts` (audit-round-7) — skills.ts had the identical
// implementations.
import {
  validateDisableBody,
  entriesAddUnique,
  entriesRemove,
} from "../lib/disable-entries.js";

export const mcpRoutes = new Hono();

// GET /mcp/global — list global MCP servers
mcpRoutes.get("/global", async (c) => {
  const globalDir = getGlobalMcpDir();
  const servers = await loadMcpServersFromDirAsync(globalDir, "global");
  return c.json(servers);
});

// GET /mcp/resolved?projectId=X — resolved MCP servers for project
mcpRoutes.get("/resolved", (c) => {
  const pid = parseIdQuery(c, "projectId") ?? null;
  const servers = resolveMcpServersForProject(pid);
  return c.json(servers);
});

// POST /mcp/global — create/update global MCP server
mcpRoutes.post("/global", async (c) => {
  const body = await parseJsonBodySafe(c);
  if (!body.name) throw new ValidationError("name is required");
  assertSafeName(body.name);
  if (!body.config) throw new ValidationError("config is required");

  const globalDir = getGlobalMcpDir();
  // Async fs/promises — see skills.ts for rationale (event loop must
  // keep serving concurrent requests during disk IO).
  await mkdir(globalDir, { recursive: true });
  await writeFile(
    join(globalDir, `${body.name}.json`),
    JSON.stringify(body.config, null, 2),
  );

  queueGlobalMcpReconcile();
  return c.json({ name: body.name, level: "global", saved: true }, 201);
});

// DELETE /mcp/global/:name
mcpRoutes.delete("/global/:name", async (c) => {
  const name = c.req.param("name");
  assertSafeName(name);
  const globalDir = getGlobalMcpDir();
  const filePath = join(globalDir, `${name}.json`);
  if (!existsSync(filePath)) throw new NotFoundError("MCP server");
  await unlink(filePath);
  queueGlobalMcpReconcile();
  return c.json({ deleted: true });
});

// GET /mcp/workspaces/:id/servers — list workspace MCP servers
mcpRoutes.get("/workspaces/:id/servers", async (c) => {
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);

  const mcpDir = getMcpDir(ws.path);
  const servers = await loadMcpServersFromDirAsync(mcpDir, "workspace");
  return c.json(servers);
});

// POST /mcp/workspaces/:id/servers — create/update workspace MCP server
mcpRoutes.post("/workspaces/:id/servers", async (c) => {
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);

  const body = await parseJsonBodySafe(c);
  if (!body.name) throw new ValidationError("name is required");
  assertSafeName(body.name);
  if (!body.config) throw new ValidationError("config is required");

  const mcpDir = getMcpDir(ws.path);
  await mkdir(mcpDir, { recursive: true });
  await writeFile(
    join(mcpDir, `${body.name}.json`),
    JSON.stringify(body.config, null, 2),
  );

  queueWorkspaceMcpReconcile(id);
  return c.json({ name: body.name, level: "workspace", saved: true }, 201);
});

// DELETE /mcp/workspaces/:id/servers/:name
mcpRoutes.delete("/workspaces/:id/servers/:name", async (c) => {
  const id = parseIdParam(c);
  const name = c.req.param("name");
  assertSafeName(name);
  const ws = getWorkspaceOrThrow(id);

  const filePath = join(getMcpDir(ws.path), `${name}.json`);
  if (!existsSync(filePath)) throw new NotFoundError("MCP server");
  await unlink(filePath);

  queueWorkspaceMcpReconcile(id);
  return c.json({ deleted: true });
});

// GET /mcp/workspaces/:wid/projects/:pid/servers — list project MCP servers
mcpRoutes.get("/workspaces/:wid/projects/:pid/servers", async (c) => {
  const pid = parseIdParam(c, "pid");
  const project = getProjectOrThrow(pid);
  if (!project.path) throw new NotFoundError("Project");

  const mcpDir = getMcpDir(project.path);
  const servers = await loadMcpServersFromDirAsync(mcpDir, "project");
  return c.json(servers);
});

// POST /mcp/workspaces/:wid/projects/:pid/servers — create/update project MCP server
mcpRoutes.post("/workspaces/:wid/projects/:pid/servers", async (c) => {
  const pid = parseIdParam(c, "pid");
  const project = getProjectOrThrow(pid);
  if (!project.path) throw new NotFoundError("Project");

  const body = await parseJsonBodySafe(c);
  if (!body.name) throw new ValidationError("name is required");
  assertSafeName(body.name);
  if (!body.config) throw new ValidationError("config is required");

  const mcpDir = getMcpDir(project.path);
  await mkdir(mcpDir, { recursive: true });
  await writeFile(
    join(mcpDir, `${body.name}.json`),
    JSON.stringify(body.config, null, 2),
  );

  queueProjectMcpReconcile(pid);
  return c.json({ name: body.name, level: "project", saved: true }, 201);
});

// DELETE /mcp/workspaces/:wid/projects/:pid/servers/:name
mcpRoutes.delete("/workspaces/:wid/projects/:pid/servers/:name", async (c) => {
  const pid = parseIdParam(c, "pid");
  const name = c.req.param("name");
  assertSafeName(name);
  const project = getProjectOrThrow(pid);
  if (!project.path) throw new NotFoundError("Project");

  const filePath = join(getMcpDir(project.path), `${name}.json`);
  if (!existsSync(filePath)) throw new NotFoundError("MCP server");
  await unlink(filePath);

  queueProjectMcpReconcile(pid);
  return c.json({ deleted: true });
});

// ─── Disable/Enable MCP servers (body-based {name, level}) ───

// POST /mcp/workspaces/:id/disabled-mcp — body: {name, level} with level ∈ {global, workspace}
mcpRoutes.post("/workspaces/:id/disabled-mcp", async (c) => {
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);
  if (!ws.path) throw new ValidationError("Workspace has no path");

  const body = await parseJsonBodySafe(c);
  const entry = validateDisableBody(body, ["global", "workspace"]);

  const cfg = loadWorkspaceConfig(ws.path);
  cfg.disabledMcpServers = entriesAddUnique(cfg.disabledMcpServers ?? [], entry);
  saveWorkspaceConfig(ws.path, cfg);
  queueWorkspaceMcpReconcile(id);
  return c.json({ disabledMcpServers: cfg.disabledMcpServers });
});

// DELETE /mcp/workspaces/:id/disabled-mcp — body: {name, level}
mcpRoutes.delete("/workspaces/:id/disabled-mcp", async (c) => {
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);
  if (!ws.path) throw new ValidationError("Workspace has no path");

  const body = await parseJsonBodySafe(c);
  const entry = validateDisableBody(body, ["global", "workspace"]);

  const cfg = loadWorkspaceConfig(ws.path);
  cfg.disabledMcpServers = entriesRemove(cfg.disabledMcpServers ?? [], entry);
  saveWorkspaceConfig(ws.path, cfg);
  queueWorkspaceMcpReconcile(id);
  return c.json({ disabledMcpServers: cfg.disabledMcpServers });
});

// GET /mcp/workspaces/:id/disabled-mcp — list disabled MCP servers for workspace
mcpRoutes.get("/workspaces/:id/disabled-mcp", (c) => {
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);

  const cfg = ws.path ? loadWorkspaceConfig(ws.path) : {};
  return c.json({ disabledMcpServers: cfg.disabledMcpServers ?? [] });
});

// POST /mcp/projects/:pid/disabled-mcp — body: {name, level} with level ∈ {global, workspace, project}
mcpRoutes.post("/projects/:pid/disabled-mcp", async (c) => {
  const pid = parseIdParam(c, "pid");
  const project = getProjectOrThrow(pid);
  if (!project.path) throw new ValidationError("Project has no path");

  const body = await parseJsonBodySafe(c);
  const entry = validateDisableBody(body, ["global", "workspace", "project"]);

  const cfg = loadProjectConfig(project.path);
  cfg.disabledMcpServers = entriesAddUnique(cfg.disabledMcpServers ?? [], entry);
  saveProjectConfig(project.path, cfg);
  queueProjectMcpReconcile(pid);
  return c.json({ disabledMcpServers: cfg.disabledMcpServers });
});

// DELETE /mcp/projects/:pid/disabled-mcp — body: {name, level}
mcpRoutes.delete("/projects/:pid/disabled-mcp", async (c) => {
  const pid = parseIdParam(c, "pid");
  const project = getProjectOrThrow(pid);
  if (!project.path) throw new ValidationError("Project has no path");

  const body = await parseJsonBodySafe(c);
  const entry = validateDisableBody(body, ["global", "workspace", "project"]);

  const cfg = loadProjectConfig(project.path);
  cfg.disabledMcpServers = entriesRemove(cfg.disabledMcpServers ?? [], entry);
  saveProjectConfig(project.path, cfg);
  queueProjectMcpReconcile(pid);
  return c.json({ disabledMcpServers: cfg.disabledMcpServers });
});

// GET /mcp/projects/:pid/disabled-mcp — list disabled MCP servers for project
mcpRoutes.get("/projects/:pid/disabled-mcp", (c) => {
  const pid = parseIdParam(c, "pid");
  const project = getProjectOrThrow(pid);

  const cfg = project.path ? loadProjectConfig(project.path) : {};
  return c.json({ disabledMcpServers: cfg.disabledMcpServers ?? [] });
});

// ─── Async reconcile queue helpers ───
//
// Wrapped through `runReconcileWithObservability` so failures both log
// AND broadcast a `reconcile_failed` WS envelope for UI visibility.

function queueGlobalMcpReconcile() {
  setImmediate(() =>
    runReconcileWithObservability({ scope: "mcp:global" }, () => {
      reconcileAllMcp();
    }),
  );
}

function queueWorkspaceMcpReconcile(workspaceId: number) {
  setImmediate(() =>
    runReconcileWithObservability(
      { scope: "mcp:workspace", target: workspaceId },
      () => {
        reconcileMcpForWorkspace(workspaceId);
        reconcileAllMcpInWorkspace(workspaceId);
      },
    ),
  );
}

function queueProjectMcpReconcile(projectId: number) {
  setImmediate(() =>
    runReconcileWithObservability(
      { scope: "mcp:project", target: projectId },
      () => {
        reconcileMcpForProject(projectId);
      },
    ),
  );
}
