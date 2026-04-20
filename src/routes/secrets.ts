import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { workspaces, projects } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import {
  listSecrets,
  upsertSecret,
  deleteSecret,
  type SecretScope,
} from "../services/secrets.js";
import {
  reconcileMcpForWorkspace,
  reconcileMcpForProject,
  reconcileAllMcpInWorkspace,
  reconcileAllMcp,
} from "../services/claude-mcp-sync.js";

export const secretRoutes = new Hono();

interface SecretBody {
  name?: unknown;
  value?: unknown;
  description?: unknown;
}

function parseBody(body: unknown): { name: string; value: string; description: string | null } {
  if (!body || typeof body !== "object") throw new ValidationError("body required");
  const b = body as SecretBody;
  if (typeof b.name !== "string" || !b.name) throw new ValidationError("name is required");
  if (typeof b.value !== "string") throw new ValidationError("value is required");
  const description =
    b.description == null ? null : typeof b.description === "string" ? b.description : null;
  return { name: b.name, value: b.value, description };
}

// ─── Global ───

secretRoutes.get("/global", (c) => {
  return c.json({ secrets: listSecrets("global", null) });
});

secretRoutes.post("/global", async (c) => {
  const body = await c.req.json();
  const parsed = parseBody(body);
  const record = upsertSecret({
    scope: "global",
    scopeId: null,
    name: parsed.name,
    value: parsed.value,
    description: parsed.description,
  });
  queueReconcileAll();
  return c.json(record);
});

secretRoutes.delete("/global/:name", (c) => {
  const name = c.req.param("name");
  const deleted = deleteSecret("global", null, name);
  if (!deleted) throw new NotFoundError("Secret");
  queueReconcileAll();
  return c.json({ deleted: true });
});

// ─── Workspace ───

secretRoutes.get("/workspaces/:id", (c) => {
  const id = parseInt(c.req.param("id"));
  requireWorkspace(id);
  return c.json({ secrets: listSecrets("workspace", id) });
});

secretRoutes.post("/workspaces/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  requireWorkspace(id);
  const body = await c.req.json();
  const parsed = parseBody(body);
  const record = upsertSecret({
    scope: "workspace",
    scopeId: id,
    name: parsed.name,
    value: parsed.value,
    description: parsed.description,
  });
  queueWorkspaceReconcile(id);
  return c.json(record);
});

secretRoutes.delete("/workspaces/:id/:name", (c) => {
  const id = parseInt(c.req.param("id"));
  requireWorkspace(id);
  const name = c.req.param("name");
  const deleted = deleteSecret("workspace", id, name);
  if (!deleted) throw new NotFoundError("Secret");
  queueWorkspaceReconcile(id);
  return c.json({ deleted: true });
});

// ─── Project ───

secretRoutes.get("/projects/:pid", (c) => {
  const pid = parseInt(c.req.param("pid"));
  requireProject(pid);
  return c.json({ secrets: listSecrets("project", pid) });
});

secretRoutes.post("/projects/:pid", async (c) => {
  const pid = parseInt(c.req.param("pid"));
  requireProject(pid);
  const body = await c.req.json();
  const parsed = parseBody(body);
  const record = upsertSecret({
    scope: "project",
    scopeId: pid,
    name: parsed.name,
    value: parsed.value,
    description: parsed.description,
  });
  queueProjectReconcile(pid);
  return c.json(record);
});

secretRoutes.delete("/projects/:pid/:name", (c) => {
  const pid = parseInt(c.req.param("pid"));
  requireProject(pid);
  const name = c.req.param("name");
  const deleted = deleteSecret("project", pid, name);
  if (!deleted) throw new NotFoundError("Secret");
  queueProjectReconcile(pid);
  return c.json({ deleted: true });
});

// ─── helpers ───

function requireWorkspace(id: number) {
  if (!Number.isFinite(id)) throw new ValidationError("invalid workspace id");
  const ws = getDb().select().from(workspaces).where(eq(workspaces.id, id)).get();
  if (!ws) throw new NotFoundError("Workspace");
}

function requireProject(id: number) {
  if (!Number.isFinite(id)) throw new ValidationError("invalid project id");
  const p = getDb().select().from(projects).where(eq(projects.id, id)).get();
  if (!p) throw new NotFoundError("Project");
}

function queueReconcileAll() {
  setImmediate(() => {
    try {
      reconcileAllMcp();
    } catch (err) {
      console.error("[secrets] global reconcile failed:", err);
    }
  });
}

function queueWorkspaceReconcile(workspaceId: number) {
  setImmediate(() => {
    try {
      reconcileMcpForWorkspace(workspaceId);
      reconcileAllMcpInWorkspace(workspaceId);
    } catch (err) {
      console.error(`[secrets] workspace ${workspaceId} reconcile failed:`, err);
    }
  });
}

function queueProjectReconcile(projectId: number) {
  setImmediate(() => {
    try {
      reconcileMcpForProject(projectId);
    } catch (err) {
      console.error(`[secrets] project ${projectId} reconcile failed:`, err);
    }
  });
}

export type { SecretScope };
