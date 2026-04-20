import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { projects, tasks, schedules, taskTemplates, usageRecords } from "../db/schema.js";
import { eq, and, sql, desc } from "drizzle-orm";
import { paginationParams } from "../lib/pagination.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { slugify } from "../lib/slugify.js";
import { join } from "path";
import { homedir } from "os";
import { listMilestones, listSlices, getProjectTree } from "../services/plan-store.js";
import { loadProjectConfig, saveProjectConfig, type ProjectConfig } from "../services/project-config.js";
import { parsePermissionModeBody } from "./_permission-mode.js";
import { reconcileClaudeSkillsForProject } from "../services/claude-skills-sync.js";
import { reconcileMcpForProject } from "../services/claude-mcp-sync.js";
import {
  loadProjectAgentsSource,
  loadProjectAgentsEffective,
  saveProjectAgentsSource,
  reconcileAgentsForProject,
} from "../services/claude-agents-sync.js";
import { deleteSecretsForScope } from "../services/secrets.js";
import {
  scanProjectPath,
  applyImportActions,
  type ImportAction,
} from "../services/project-import.js";

const AGENTS_MD_MAX_BYTES = 256 * 1024;

const CONFIG_KEYS = [
  "model",
  "planningModel",
  "baseBranch",
  "testCommand",
  "defaultTimeout",
  "maxConcurrentTasks",
  "budgetDailyUsd",
  "requiresApproval",
  "allowedProviders",
  "env",
  "permissionMode",
  "disabledSkills",
  "disabledMcpServers",
] as const;

function extractConfigFromBody(body: Record<string, unknown>): Partial<ProjectConfig> {
  const out: Record<string, unknown> = {};
  for (const k of CONFIG_KEYS) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out as Partial<ProjectConfig>;
}

function mergeProjectConfig(path: string, incoming: Partial<ProjectConfig>): void {
  if (Object.keys(incoming).length === 0) return;
  const existing = loadProjectConfig(path);
  const merged: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) {
      delete merged[k];
    } else {
      merged[k] = v;
    }
  }
  saveProjectConfig(path, merged as ProjectConfig);
}

function queueProjectReconcile(projectId: number) {
  setImmediate(() => {
    try {
      reconcileClaudeSkillsForProject(projectId);
      reconcileMcpForProject(projectId);
      reconcileAgentsForProject(projectId);
    } catch (err) {
      console.error(`[projects] reconcile ${projectId} failed:`, err);
    }
  });
}

export const projectRoutes = new Hono();

// POST /projects/scan — dry-run detection of what would happen if this path
// were imported. Body: { path: string }.
projectRoutes.post("/scan", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const path = typeof body?.path === "string" ? body.path.trim() : "";
  if (!path) throw new ValidationError("path is required");
  return c.json(scanProjectPath(path));
});

// GET /projects
projectRoutes.get("/", (c) => {
  const db = getDb();
  const { page, perPage, offset } = paginationParams(c);

  const items = db.select().from(projects).orderBy(desc(projects.createdAt)).limit(perPage).offset(offset).all();
  const total = db.select({ count: sql<number>`count(*)` }).from(projects).get()?.count ?? 0;

  return c.json({ items, total, page, perPage });
});

// GET /projects/:id
projectRoutes.get("/:id", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) throw new NotFoundError("Project");

  const ms = project.path ? listMilestones(project.path) : [];
  return c.json({ ...project, milestones: ms });
});

// POST /projects
projectRoutes.post("/", async (c) => {
  const db = getDb();
  const body = await c.req.json();

  if (!body.name) throw new ValidationError("name is required");

  // Auto-derive path if not provided
  const hasExplicitPath = !!body.path;
  let projectPath: string = body.path ?? "";
  if (!projectPath) {
    if (body.workspaceId) {
      const { workspaces } = await import("../db/schema.js");
      const ws = db.select().from(workspaces).where(eq(workspaces.id, body.workspaceId)).get();
      if (ws?.path) {
        projectPath = join(ws.path, slugify(body.name));
      }
    }
    if (!projectPath) {
      projectPath = join(homedir(), "flockctl", "projects", slugify(body.name));
    }
  }

  let resolvedRepoUrl: string | null = body.repoUrl ?? null;

  if (body.repoUrl && !hasExplicitPath) {
    if (existsSync(projectPath) && existsSync(join(projectPath, ".git"))) {
      throw new ValidationError("Directory already contains a git repository");
    }
    try {
      execSync(`git clone ${JSON.stringify(body.repoUrl)} ${JSON.stringify(projectPath)}`, { stdio: "pipe", timeout: 120_000 });
    } catch (err: any) {
      throw new ValidationError(`Git clone failed: ${err.stderr?.toString().trim() || err.message}`);
    }
  } else {
    const dirExists = existsSync(projectPath);
    const hasGit = dirExists && existsSync(join(projectPath, ".git"));

    if (!dirExists) {
      mkdirSync(projectPath, { recursive: true });
    }

    if (!hasGit) {
      try {
        execSync("git init", { cwd: projectPath, stdio: "pipe" });
      } catch {
        // Non-fatal
      }
    } else if (!resolvedRepoUrl) {
      try {
        const remoteUrl = execSync("git remote get-url origin", { cwd: projectPath, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
        if (remoteUrl) resolvedRepoUrl = remoteUrl;
      } catch {
        // No 'origin' remote — leave repoUrl null
      }
    }
  }

  const createPerm = parsePermissionModeBody(body);
  const result = db.insert(projects).values({
    name: body.name,
    description: body.description ?? null,
    workspaceId: body.workspaceId ?? null,
    path: projectPath,
    repoUrl: resolvedRepoUrl,
  }).returning().get();

  // Persist config fields (including permissionMode) into <project>/.flockctl/config.json
  const patch = extractConfigFromBody(body);
  if (createPerm !== undefined) (patch as Record<string, unknown>).permissionMode = createPerm;
  mergeProjectConfig(projectPath, patch);

  // Run import actions *before* touching AGENTS.md or kicking reconcile, so
  // adopted content is in place when the reconciler regenerates root files.
  const importActions = parseImportActions(body.importActions);
  if (importActions.length > 0) {
    try {
      applyImportActions(projectPath, importActions);
    } catch (err) {
      console.error(`[projects] import actions failed for ${projectPath}:`, err);
    }
  }

  // Touch empty .flockctl/AGENTS.md so the reconciler has a source to read
  // and the editor in the UI shows a real file (not a 404).
  if (!loadProjectAgentsSource(projectPath)) {
    saveProjectAgentsSource(projectPath, "");
  }

  queueProjectReconcile(result.id);

  return c.json(result, 201);
});

function parseImportActions(input: unknown): ImportAction[] {
  if (!Array.isArray(input)) return [];
  const out: ImportAction[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const kind = (raw as { kind?: unknown }).kind;
    switch (kind) {
      case "adoptAgentsMd":
      case "mergeClaudeMd":
      case "importMcpJson":
        out.push({ kind });
        break;
      case "importClaudeSkill": {
        const name = (raw as { name?: unknown }).name;
        if (typeof name === "string" && name.length > 0) {
          out.push({ kind: "importClaudeSkill", name });
        }
        break;
      }
    }
  }
  return out;
}

// PATCH /projects/:id
projectRoutes.patch("/:id", async (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const existing = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!existing) throw new NotFoundError("Project");

  const body = await c.req.json();
  const permissionMode = parsePermissionModeBody(body);
  db.update(projects)
    .set({
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.path !== undefined && { path: body.path }),
      ...(body.repoUrl !== undefined && { repoUrl: body.repoUrl }),
      ...(body.providerFallbackChain !== undefined && { providerFallbackChain: body.providerFallbackChain ? JSON.stringify(body.providerFallbackChain) : null }),
      ...(body.allowedKeyIds !== undefined && { allowedKeyIds: body.allowedKeyIds ? JSON.stringify(body.allowedKeyIds) : null }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(projects.id, id))
    .run();

  // Merge config fields (model, baseBranch, permissionMode, …) into
  // <project>/.flockctl/config.json — the single source of truth for project config.
  const updated = db.select().from(projects).where(eq(projects.id, id)).get();
  if (updated?.path) {
    const patch = extractConfigFromBody(body);
    if (permissionMode !== undefined) (patch as Record<string, unknown>).permissionMode = permissionMode;
    mergeProjectConfig(updated.path, patch);
    if (Object.keys(patch).length > 0) queueProjectReconcile(id);
  }

  return c.json(updated);
});

// DELETE /projects/:id
projectRoutes.delete("/:id", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const existing = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!existing) throw new NotFoundError("Project");

  deleteSecretsForScope("project", id);
  db.delete(projects).where(eq(projects.id, id)).run();
  return c.json({ deleted: true });
});

// GET /projects/:id/tree — full task tree (from filesystem)
projectRoutes.get("/:id/tree", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) throw new NotFoundError("Project");

  if (!project.path) return c.json({ project, milestones: [] });
  const tree = getProjectTree(project.path);
  return c.json({ project, milestones: tree.milestones });
});

// GET /projects/:id/stats — aggregated project statistics
projectRoutes.get("/:id/stats", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) throw new NotFoundError("Project");

  // Task counts by status
  const taskRows = db.select({
    status: tasks.status,
    count: sql<number>`count(*)`,
  }).from(tasks).where(eq(tasks.projectId, id)).groupBy(tasks.status).all();

  const taskStats: Record<string, number> = {
    total: 0, queued: 0, assigned: 0, running: 0,
    completed: 0, done: 0, failed: 0, timed_out: 0, cancelled: 0,
  };
  for (const row of taskRows) {
    taskStats[row.status] = row.count;
    taskStats.total += row.count;
  }

  // Average task duration
  const durationAgg = db.select({
    avgDuration: sql<number>`AVG(
      CAST((julianday(${tasks.completedAt}) - julianday(${tasks.startedAt})) * 86400 AS REAL)
    )`,
  }).from(tasks)
    .where(and(
      eq(tasks.projectId, id),
      sql`${tasks.startedAt} IS NOT NULL AND ${tasks.completedAt} IS NOT NULL`,
    ))
    .get();

  // Milestone & slice counts from filesystem
  const allMilestones = project.path ? listMilestones(project.path) : [];
  const milestoneStats: Record<string, number> = { total: 0, pending: 0, active: 0, completed: 0, failed: 0 };
  for (const m of allMilestones) {
    const key = m.status ?? "pending";
    milestoneStats[key] = (milestoneStats[key] ?? 0) + 1;
    milestoneStats.total++;
  }

  const allSlices = project.path
    ? allMilestones.flatMap(m => listSlices(project.path!, m.slug))
    : [];
  const sliceStats: Record<string, number> = { total: 0, pending: 0, active: 0, completed: 0, failed: 0, skipped: 0 };
  for (const s of allSlices) {
    const key = s.status ?? "pending";
    sliceStats[key] = (sliceStats[key] ?? 0) + 1;
    sliceStats.total++;
  }

  // Usage totals
  const usageAgg = db.select({
    totalCostUsd: sql<number>`COALESCE(SUM(${usageRecords.totalCostUsd}), 0)`,
    totalInputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)`,
    totalOutputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)`,
  }).from(usageRecords).where(eq(usageRecords.projectId, id)).get();

  return c.json({
    tasks: taskStats,
    avgTaskDurationSeconds: durationAgg?.avgDuration ?? null,
    milestones: milestoneStats,
    slices: sliceStats,
    usage: {
      totalCostUsd: usageAgg?.totalCostUsd ?? 0,
      totalInputTokens: usageAgg?.totalInputTokens ?? 0,
      totalOutputTokens: usageAgg?.totalOutputTokens ?? 0,
    },
  });
});

// GET /projects/:id/schedules
projectRoutes.get("/:id/schedules", (c) => {
  const db = getDb();
  const pid = parseInt(c.req.param("id"));
  const { page, perPage, offset } = paginationParams(c);

  const project = db.select().from(projects).where(eq(projects.id, pid)).get();
  if (!project) throw new NotFoundError("Project");

  const items = db.select({ schedule: schedules })
    .from(schedules)
    .innerJoin(taskTemplates, eq(schedules.templateId, taskTemplates.id))
    .where(eq(taskTemplates.projectId, pid))
    .limit(perPage).offset(offset).all()
    .map(r => r.schedule);

  const total = db.select({ count: sql<number>`count(*)` })
    .from(schedules)
    .innerJoin(taskTemplates, eq(schedules.templateId, taskTemplates.id))
    .where(eq(taskTemplates.projectId, pid))
    .get()?.count ?? 0;

  return c.json({ items, total, page, perPage });
});

// GET /projects/:id/config — read project config from .flockctl/config.json
projectRoutes.get("/:id/config", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) throw new NotFoundError("Project");

  if (!project.path) return c.json({});
  const config = loadProjectConfig(project.path);
  return c.json(config);
});

// PUT /projects/:id/config — write project config to .flockctl/config.json
projectRoutes.put("/:id/config", async (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) throw new NotFoundError("Project");

  if (!project.path) throw new ValidationError("Project has no path — cannot save config file");

  const body = await c.req.json();
  const patch = extractConfigFromBody(body);
  mergeProjectConfig(project.path, patch);
  if (Object.keys(patch).length > 0) queueProjectReconcile(id);
  return c.json(loadProjectConfig(project.path));
});

// GET /projects/:id/agents-md — { source, effective }
//   source    = .flockctl/AGENTS.md (editable)
//   effective = root AGENTS.md (what agents read; merge of workspace + project)
projectRoutes.get("/:id/agents-md", (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) throw new NotFoundError("Project");

  if (!project.path) return c.json({ source: "", effective: "" });
  return c.json({
    source: loadProjectAgentsSource(project.path),
    effective: loadProjectAgentsEffective(project.path),
  });
});

// PUT /projects/:id/agents-md — body: { content: string }
projectRoutes.put("/:id/agents-md", async (c) => {
  const db = getDb();
  const id = parseInt(c.req.param("id"));
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) throw new NotFoundError("Project");
  if (!project.path) throw new ValidationError("Project has no path — cannot save AGENTS.md");

  const body = await c.req.json();
  const content = typeof body?.content === "string" ? body.content : "";
  if (Buffer.byteLength(content, "utf-8") > AGENTS_MD_MAX_BYTES) {
    throw new ValidationError(`AGENTS.md exceeds ${AGENTS_MD_MAX_BYTES} bytes`);
  }

  saveProjectAgentsSource(project.path, content);
  setImmediate(() => {
    try {
      reconcileAgentsForProject(id);
    } catch (err) {
      console.error(`[projects] agents reconcile ${id} failed:`, err);
    }
  });

  return c.json({
    source: loadProjectAgentsSource(project.path),
    effective: loadProjectAgentsEffective(project.path),
  });
});
