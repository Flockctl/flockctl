/**
 * Templates REST API — thin wrapper over the file-backed templates service.
 *
 * Templates live on disk (see `src/services/templates.ts`); routes here just
 * translate HTTP shape into service calls. Identity is `(scope, name)` plus
 * an optional workspace or project id for non-global scopes. There is no
 * numeric id.
 *
 * Endpoints:
 *   GET    /templates                — list (filter by scope/workspace_id/project_id)
 *   GET    /templates/:scope/:name   — fetch one (workspace_id/project_id via query)
 *   POST   /templates                — create (scope + name + ids in body)
 *   PATCH  /templates/:scope/:name   — update (workspace_id/project_id via query)
 *   DELETE /templates/:scope/:name   — delete
 */
import { Hono } from "hono";
import { paginationParams } from "../lib/pagination.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../lib/errors.js";
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  TemplateError,
  updateTemplate,
  type TemplateScope,
} from "../services/templates.js";

export const templateRoutes = new Hono();

const VALID_SCOPES: ReadonlySet<TemplateScope> = new Set<TemplateScope>(["global", "workspace", "project"]);

function parseScope(value: unknown, label = "scope"): TemplateScope {
  if (typeof value !== "string" || !VALID_SCOPES.has(value as TemplateScope)) {
    throw new ValidationError(`${label} must be one of 'global' | 'workspace' | 'project'`);
  }
  return value as TemplateScope;
}

function parseOptionalInt(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`${label} must be a positive integer`);
  }
  return n;
}

function toTemplateError(err: unknown): never {
  if (err instanceof TemplateError) {
    switch (err.code) {
      case "not_found":
        throw new NotFoundError("Template");
      case "already_exists":
        throw new ConflictError(err.message);
      case "invalid_name":
      case "invalid_scope":
      case "missing_scope_ref":
        throw new BadRequestError(err.message);
    }
  }
  throw err;
}

// GET /templates
templateRoutes.get("/", (c) => {
  const { page, perPage, offset } = paginationParams(c);

  const scopeQ = c.req.query("scope");
  const scope = scopeQ ? parseScope(scopeQ) : undefined;
  const workspaceId = parseOptionalInt(c.req.query("workspace_id"), "workspace_id");
  const projectId = parseOptionalInt(c.req.query("project_id"), "project_id");

  let all;
  try {
    all = listTemplates({ scope, workspaceId, projectId });
  } catch (err) {
    toTemplateError(err);
  }

  const total = all!.length;
  const items = all!.slice(offset, offset + perPage);
  return c.json({ items, total, page, perPage });
});

// GET /templates/:scope/:name
templateRoutes.get("/:scope/:name", (c) => {
  const scope = parseScope(c.req.param("scope"));
  const name = c.req.param("name");
  const workspaceId = parseOptionalInt(c.req.query("workspace_id"), "workspace_id");
  const projectId = parseOptionalInt(c.req.query("project_id"), "project_id");

  let template;
  try {
    template = getTemplate(scope, name, { workspaceId, projectId });
  } catch (err) {
    toTemplateError(err);
  }
  if (!template) throw new NotFoundError("Template");
  return c.json(template);
});

// POST /templates
// Body accepts either camelCase (workspaceId, timeoutSeconds, …) or the
// snake_case shape the UI uses (workspace_id, timeout_seconds, …). We
// normalise here so callers on either side stay ergonomic.
templateRoutes.post("/", async (c) => {
  const body = await c.req.json();
  if (!body || typeof body !== "object") throw new ValidationError("Body is required");
  if (typeof body.name !== "string" || body.name.length === 0) {
    throw new ValidationError("name is required");
  }
  const scope = parseScope(body.scope, "scope");
  const workspaceId = parseOptionalInt(body.workspaceId ?? body.workspace_id, "workspaceId");
  const projectId = parseOptionalInt(body.projectId ?? body.project_id, "projectId");

  try {
    const tpl = createTemplate({
      name: body.name,
      scope,
      workspaceId,
      projectId,
      description: body.description ?? null,
      prompt: body.prompt ?? null,
      agent: body.agent ?? null,
      model: body.model ?? null,
      image: body.image ?? null,
      workingDir: body.workingDir ?? body.working_dir ?? null,
      envVars: body.envVars ?? body.env_vars ?? null,
      timeoutSeconds: body.timeoutSeconds ?? body.timeout_seconds ?? null,
      labelSelector: body.labelSelector ?? body.label_selector ?? null,
    });
    return c.json(tpl, 201);
  } catch (err) {
    toTemplateError(err);
  }
});

// PATCH /templates/:scope/:name
templateRoutes.patch("/:scope/:name", async (c) => {
  const scope = parseScope(c.req.param("scope"));
  const name = c.req.param("name");
  const workspaceId = parseOptionalInt(c.req.query("workspace_id"), "workspace_id");
  const projectId = parseOptionalInt(c.req.query("project_id"), "project_id");

  const body = await c.req.json();
  if (!body || typeof body !== "object") throw new ValidationError("Body is required");

  // Accept both camelCase (workingDir, timeoutSeconds, …) and snake_case
  // (working_dir, timeout_seconds, …) — matches the POST normalisation.
  // Use `in` checks so an explicit `null` (which means "clear the field")
  // is preserved instead of falling through to the snake_case alias.
  const workingDir = "workingDir" in body ? body.workingDir : body.working_dir;
  const envVars = "envVars" in body ? body.envVars : body.env_vars;
  const timeoutSeconds = "timeoutSeconds" in body ? body.timeoutSeconds : body.timeout_seconds;
  const labelSelector = "labelSelector" in body ? body.labelSelector : body.label_selector;

  try {
    const updated = updateTemplate(scope, name, { workspaceId, projectId }, {
      ...(body.description !== undefined && { description: body.description }),
      ...(body.prompt !== undefined && { prompt: body.prompt }),
      ...(body.agent !== undefined && { agent: body.agent }),
      ...(body.model !== undefined && { model: body.model }),
      ...(body.image !== undefined && { image: body.image }),
      ...(workingDir !== undefined && { workingDir }),
      ...(envVars !== undefined && { envVars }),
      ...(timeoutSeconds !== undefined && { timeoutSeconds }),
      ...(labelSelector !== undefined && { labelSelector }),
    });
    return c.json(updated);
  } catch (err) {
    toTemplateError(err);
  }
});

// DELETE /templates/:scope/:name
templateRoutes.delete("/:scope/:name", (c) => {
  const scope = parseScope(c.req.param("scope"));
  const name = c.req.param("name");
  const workspaceId = parseOptionalInt(c.req.query("workspace_id"), "workspace_id");
  const projectId = parseOptionalInt(c.req.query("project_id"), "project_id");

  let deleted: boolean;
  try {
    deleted = deleteTemplate(scope, name, { workspaceId, projectId });
  } catch (err) {
    toTemplateError(err);
  }
  if (!deleted!) throw new NotFoundError("Template");
  return c.json({ deleted: true });
});
