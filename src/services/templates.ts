/**
 * File-backed task templates.
 *
 * Templates live on disk as JSON files, organised by scope:
 *
 *   ~/flockctl/templates/<name>.json                       — global
 *   <workspace.path>/.flockctl/templates/<name>.json       — workspace
 *   <project.path>/.flockctl/templates/<name>.json         — project
 *
 * Names are unique within a scope (filesystem-enforced). Cross-scope
 * duplicates are allowed because resolution is always explicit — every
 * caller (schedule, UI action) carries the scope + ids, so there is no
 * ambiguity and no merge/precedence rule.
 *
 * `assignedKeyId` intentionally does NOT live on the template — it is
 * stored on the `schedules` row instead, so a single template can be
 * reused with different AI keys.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { getGlobalTemplatesDir } from "../config/index.js";
import { getDb } from "../db/index.js";
import { projects, workspaces } from "../db/schema.js";
import { eq } from "drizzle-orm";

export type TemplateScope = "global" | "workspace" | "project";

export interface Template {
  /** Filename without `.json`; matches the on-disk entry. */
  name: string;
  scope: TemplateScope;
  /** Present when scope = 'workspace'. */
  workspaceId?: number;
  /** Present when scope = 'project'. */
  projectId?: number;
  description?: string | null;
  prompt?: string | null;
  agent?: string | null;
  model?: string | null;
  image?: string | null;
  workingDir?: string | null;
  envVars?: Record<string, string> | null;
  timeoutSeconds?: number | null;
  labelSelector?: string | null;
  /** Absolute path to the backing JSON file. */
  sourcePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateInput {
  name: string;
  scope: TemplateScope;
  workspaceId?: number;
  projectId?: number;
  description?: string | null;
  prompt?: string | null;
  agent?: string | null;
  model?: string | null;
  image?: string | null;
  workingDir?: string | null;
  envVars?: Record<string, string> | null;
  timeoutSeconds?: number | null;
  labelSelector?: string | null;
}

export interface TemplatePatch {
  description?: string | null;
  prompt?: string | null;
  agent?: string | null;
  model?: string | null;
  image?: string | null;
  workingDir?: string | null;
  envVars?: Record<string, string> | null;
  timeoutSeconds?: number | null;
  labelSelector?: string | null;
}

export interface TemplateFilter {
  scope?: TemplateScope;
  workspaceId?: number;
  projectId?: number;
}

export class TemplateError extends Error {
  constructor(message: string, public readonly code: "invalid_name" | "not_found" | "already_exists" | "missing_scope_ref" | "invalid_scope") {
    super(message);
    this.name = "TemplateError";
  }
}

// Names must be safe as filesystem entries. No separators, no dots, no spaces.
// Matches the convention used by skills directories.
const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function assertValidName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new TemplateError(
      `Invalid template name: ${JSON.stringify(name)}. Use 1-64 chars of [a-zA-Z0-9_-].`,
      "invalid_name",
    );
  }
}

function resolveWorkspacePath(workspaceId: number): string {
  const db = getDb();
  const ws = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!ws?.path) {
    throw new TemplateError(`Workspace ${workspaceId} not found or has no path`, "missing_scope_ref");
  }
  return ws.path;
}

function resolveProjectPath(projectId: number): string {
  const db = getDb();
  const p = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!p?.path) {
    throw new TemplateError(`Project ${projectId} not found or has no path`, "missing_scope_ref");
  }
  return p.path;
}

/**
 * Returns the directory that holds templates for the given scope.
 * Creates nothing — caller `ensureDir`s before writing.
 */
export function templatesDirFor(scope: TemplateScope, ids: { workspaceId?: number; projectId?: number }): string {
  switch (scope) {
    case "global":
      return getGlobalTemplatesDir();
    case "workspace": {
      if (!ids.workspaceId) {
        throw new TemplateError("workspaceId is required for scope=workspace", "missing_scope_ref");
      }
      return join(resolveWorkspacePath(ids.workspaceId), ".flockctl", "templates");
    }
    case "project": {
      if (!ids.projectId) {
        throw new TemplateError("projectId is required for scope=project", "missing_scope_ref");
      }
      return join(resolveProjectPath(ids.projectId), ".flockctl", "templates");
    }
    default:
      throw new TemplateError(`Unknown scope: ${scope}`, "invalid_scope");
  }
}

interface StoredTemplate {
  description?: string | null;
  prompt?: string | null;
  agent?: string | null;
  model?: string | null;
  image?: string | null;
  workingDir?: string | null;
  envVars?: Record<string, string> | null;
  timeoutSeconds?: number | null;
  labelSelector?: string | null;
}

function readTemplateFile(
  file: string,
  scope: TemplateScope,
  ids: { workspaceId?: number; projectId?: number },
): Template | null {
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as StoredTemplate;
    const stat = statSync(file);
    const name = file.split("/").pop()!.replace(/\.json$/, "");
    return {
      name,
      scope,
      workspaceId: scope === "workspace" || scope === "project" ? ids.workspaceId : undefined,
      projectId: scope === "project" ? ids.projectId : undefined,
      description: parsed.description ?? null,
      prompt: parsed.prompt ?? null,
      agent: parsed.agent ?? null,
      model: parsed.model ?? null,
      image: parsed.image ?? null,
      workingDir: parsed.workingDir ?? null,
      envVars: parsed.envVars ?? null,
      timeoutSeconds: parsed.timeoutSeconds ?? null,
      labelSelector: parsed.labelSelector ?? null,
      sourcePath: file,
      createdAt: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
      updatedAt: new Date(stat.mtimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

function listInDir(
  dir: string,
  scope: TemplateScope,
  ids: { workspaceId?: number; projectId?: number },
): Template[] {
  if (!existsSync(dir)) return [];
  const out: Template[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const tpl = readTemplateFile(join(dir, entry.name), scope, ids);
    if (tpl) out.push(tpl);
  }
  return out;
}

/**
 * List templates. Behaviour:
 *
 *  - `scope` omitted and no id → returns **all** templates: globals plus
 *    every workspace- and project-scoped template on disk. We enumerate
 *    workspaces/projects from the DB and read each one's
 *    `.flockctl/templates/` directory. This is the "All" view on the
 *    Templates page; cost scales with the number of registered
 *    workspaces/projects, which is small in practice.
 *  - `scope="workspace"` with no `workspaceId` → aggregates across every
 *    workspace in the DB. Same for `scope="project"`.
 *  - With explicit `workspaceId`/`projectId` → scoped to that one only
 *    (unchanged from before).
 */
export function listTemplates(filter: TemplateFilter = {}): Template[] {
  const { scope, workspaceId, projectId } = filter;
  const out: Template[] = [];

  const wantGlobal = !scope || scope === "global";
  const wantWorkspace = !scope || scope === "workspace";
  const wantProject = !scope || scope === "project";

  if (wantGlobal) {
    out.push(...listInDir(getGlobalTemplatesDir(), "global", {}));
  }

  if (wantWorkspace) {
    if (workspaceId !== undefined) {
      out.push(
        ...listInDir(templatesDirFor("workspace", { workspaceId }), "workspace", { workspaceId }),
      );
    } else {
      // Aggregate across every workspace on record. Path lookups for unknown
      // ids would throw, so we drive the loop off the DB directly.
      const db = getDb();
      const allWorkspaces = db.select().from(workspaces).all();
      for (const ws of allWorkspaces) {
        if (!ws.path) continue;
        const dir = join(ws.path, ".flockctl", "templates");
        out.push(...listInDir(dir, "workspace", { workspaceId: ws.id }));
      }
    }
  }

  if (wantProject) {
    if (projectId !== undefined) {
      out.push(
        ...listInDir(templatesDirFor("project", { projectId }), "project", { projectId }),
      );
    } else {
      const db = getDb();
      const allProjects = db.select().from(projects).all();
      for (const p of allProjects) {
        if (!p.path) continue;
        const dir = join(p.path, ".flockctl", "templates");
        out.push(...listInDir(dir, "project", { projectId: p.id }));
      }
    }
  }

  // Stable sort: scope (global→workspace→project), then name.
  const order: Record<TemplateScope, number> = { global: 0, workspace: 1, project: 2 };
  out.sort((a, b) => order[a.scope] - order[b.scope] || a.name.localeCompare(b.name));
  return out;
}

export function getTemplate(
  scope: TemplateScope,
  name: string,
  ids: { workspaceId?: number; projectId?: number } = {},
): Template | null {
  assertValidName(name);
  const dir = templatesDirFor(scope, ids);
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) return null;
  return readTemplateFile(file, scope, ids);
}

function writeTemplateFile(file: string, data: StoredTemplate): void {
  const dir = file.substring(0, file.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmp, file);
}

function pickStored(input: TemplateInput | TemplatePatch): StoredTemplate {
  return {
    description: input.description ?? null,
    prompt: input.prompt ?? null,
    agent: input.agent ?? null,
    model: input.model ?? null,
    image: input.image ?? null,
    workingDir: input.workingDir ?? null,
    envVars: input.envVars ?? null,
    timeoutSeconds: input.timeoutSeconds ?? null,
    labelSelector: input.labelSelector ?? null,
  };
}

export function createTemplate(input: TemplateInput): Template {
  assertValidName(input.name);
  const dir = templatesDirFor(input.scope, { workspaceId: input.workspaceId, projectId: input.projectId });
  const file = join(dir, `${input.name}.json`);
  if (existsSync(file)) {
    throw new TemplateError(
      `Template "${input.name}" already exists in scope=${input.scope}`,
      "already_exists",
    );
  }
  writeTemplateFile(file, pickStored(input));
  const tpl = readTemplateFile(file, input.scope, { workspaceId: input.workspaceId, projectId: input.projectId });
  if (!tpl) {
    throw new TemplateError("Failed to re-read template after write", "not_found");
  }
  return tpl;
}

export function updateTemplate(
  scope: TemplateScope,
  name: string,
  ids: { workspaceId?: number; projectId?: number },
  patch: TemplatePatch,
): Template {
  assertValidName(name);
  const existing = getTemplate(scope, name, ids);
  if (!existing) {
    throw new TemplateError(`Template "${name}" not found in scope=${scope}`, "not_found");
  }
  const merged: StoredTemplate = pickStored({
    description: patch.description !== undefined ? patch.description : existing.description,
    prompt: patch.prompt !== undefined ? patch.prompt : existing.prompt,
    agent: patch.agent !== undefined ? patch.agent : existing.agent,
    model: patch.model !== undefined ? patch.model : existing.model,
    image: patch.image !== undefined ? patch.image : existing.image,
    workingDir: patch.workingDir !== undefined ? patch.workingDir : existing.workingDir,
    envVars: patch.envVars !== undefined ? patch.envVars : existing.envVars,
    timeoutSeconds: patch.timeoutSeconds !== undefined ? patch.timeoutSeconds : existing.timeoutSeconds,
    labelSelector: patch.labelSelector !== undefined ? patch.labelSelector : existing.labelSelector,
  });
  writeTemplateFile(existing.sourcePath, merged);
  return getTemplate(scope, name, ids)!;
}

export function deleteTemplate(
  scope: TemplateScope,
  name: string,
  ids: { workspaceId?: number; projectId?: number } = {},
): boolean {
  assertValidName(name);
  const dir = templatesDirFor(scope, ids);
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}
