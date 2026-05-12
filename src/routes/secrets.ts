import { Hono } from "hono";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { parseIdParam, parseJsonBodySafe } from "../lib/route-params.js";
import { getProjectOrThrow, getWorkspaceOrThrow } from "../lib/db-helpers.js";
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
} from "../services/claude/mcp-sync.js";

export const secretRoutes = new Hono();

interface SecretBody {
  name?: unknown;
  value?: unknown;
  description?: unknown;
}

// Length caps — keep secrets to the size of real-world tokens / API keys.
// A 64 KiB value cap is well above any legitimate secret (the longest known
// API keys are <4 KiB) but blocks a caller from POSTing a multi-megabyte
// payload that would be unconditionally AES-encrypted (sync, blocks the loop)
// and stored in SQLite.
const MAX_NAME_BYTES = 128;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_DESCRIPTION_BYTES = 1024;

function parseBody(body: unknown): { name: string; value: string; description: string | null } {
  if (!body || typeof body !== "object") throw new ValidationError("body required");
  const b = body as SecretBody;
  if (typeof b.name !== "string" || !b.name) throw new ValidationError("name is required");
  if (b.name.length > MAX_NAME_BYTES)
    throw new ValidationError(`name exceeds ${MAX_NAME_BYTES} bytes`);
  if (typeof b.value !== "string") throw new ValidationError("value is required");
  if (b.value.length > MAX_VALUE_BYTES)
    throw new ValidationError(`value exceeds ${MAX_VALUE_BYTES} bytes`);
  // Description is permissive: a non-string value is normalised to null
  // (matches the pre-existing route contract — clients sometimes send
  // `description: 42` and expect it to be silently dropped rather than a
  // 422). String descriptions are length-capped to bound DB row size.
  let description: string | null = null;
  if (typeof b.description === "string") {
    if (b.description.length > MAX_DESCRIPTION_BYTES)
      throw new ValidationError(`description exceeds ${MAX_DESCRIPTION_BYTES} bytes`);
    description = b.description;
  }
  return { name: b.name, value: b.value, description };
}

// ─── Global ───

secretRoutes.get("/global", (c) => {
  return c.json({ secrets: listSecrets("global", null) });
});

secretRoutes.post("/global", async (c) => {
  const body = await parseJsonBodySafe(c);
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
  const id = parseIdParam(c);
  requireWorkspace(id);
  return c.json({ secrets: listSecrets("workspace", id) });
});

secretRoutes.post("/workspaces/:id", async (c) => {
  const id = parseIdParam(c);
  requireWorkspace(id);
  const body = await parseJsonBodySafe(c);
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
  const id = parseIdParam(c);
  requireWorkspace(id);
  const name = c.req.param("name");
  const deleted = deleteSecret("workspace", id, name);
  if (!deleted) throw new NotFoundError("Secret");
  queueWorkspaceReconcile(id);
  return c.json({ deleted: true });
});

// ─── Project ───

secretRoutes.get("/projects/:pid", (c) => {
  const pid = parseIdParam(c, "pid");
  requireProject(pid);
  return c.json({ secrets: listSecrets("project", pid) });
});

secretRoutes.post("/projects/:pid", async (c) => {
  const pid = parseIdParam(c, "pid");
  requireProject(pid);
  const body = await parseJsonBodySafe(c);
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
  const pid = parseIdParam(c, "pid");
  requireProject(pid);
  const name = c.req.param("name");
  const deleted = deleteSecret("project", pid, name);
  if (!deleted) throw new NotFoundError("Secret");
  queueProjectReconcile(pid);
  return c.json({ deleted: true });
});

// ─── helpers ───
//
// The `requireWorkspace` / `requireProject` indirections used to wrap an
// inline `db.select(...).get()` + 404 check. They now delegate to the shared
// `get{Workspace,Project}OrThrow` helpers in `lib/db-helpers.ts` so the 404
// envelope is consistent with the rest of the API. The `Number.isFinite`
// guard stays because `parseIdParam` upstream already rejects malformed
// segments — this is belt-and-braces against direct programmatic callers.

function requireWorkspace(id: number) {
  if (!Number.isFinite(id)) throw new ValidationError("invalid workspace id");
  getWorkspaceOrThrow(id);
}

function requireProject(id: number) {
  if (!Number.isFinite(id)) throw new ValidationError("invalid project id");
  getProjectOrThrow(id);
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
