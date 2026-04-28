import { Hono } from "hono";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { parseIdParam } from "../lib/route-params.js";
import { getWorkspaceOrThrow, getProjectOrThrow } from "../lib/db-helpers.js";
import { resolveSkillsForProject } from "../services/skills.js";
import { getGlobalSkillsDir } from "../config/index.js";
import { loadWorkspaceConfig, saveWorkspaceConfig, type DisableEntry, type DisableLevel } from "../services/workspace-config.js";
import { loadProjectConfig, saveProjectConfig } from "../services/project-config.js";
import {
  reconcileClaudeSkillsForWorkspace,
  reconcileClaudeSkillsForProject,
  reconcileAllProjectsInWorkspace,
  reconcileAllProjects,
} from "../services/claude/skills-sync.js";
import {
  reconcileMcpForWorkspace,
  reconcileMcpForProject,
  reconcileAllMcpInWorkspace,
  reconcileAllMcp,
} from "../services/claude/mcp-sync.js";
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
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

export const skillRoutes = new Hono();

// GET /skills/global — list global skills
skillRoutes.get("/global", (c) => {
  const globalDir = getGlobalSkillsDir();
  const skills = readSkillsFromDir(globalDir, "global");
  return c.json(skills);
});

// GET /skills/resolved?projectId=X — resolved skills for project
skillRoutes.get("/resolved", (c) => {
  const projectId = c.req.query("projectId");
  const pid = projectId ? parseInt(projectId) : null;
  const skills = resolveSkillsForProject(pid);
  return c.json(skills);
});

// POST /skills/global — create/update global skill
skillRoutes.post("/global", async (c) => {
  const body = await c.req.json();
  if (!body.name) throw new ValidationError("name is required");
  validateName(body.name);
  if (!body.content) throw new ValidationError("content is required");

  const globalDir = getGlobalSkillsDir();
  const skillDir = join(globalDir, body.name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), body.content);

  queueGlobalReconcile();
  return c.json({ name: body.name, level: "global", saved: true }, 201);
});

// DELETE /skills/global/:name
skillRoutes.delete("/global/:name", (c) => {
  const name = c.req.param("name");
  validateName(name);
  const globalDir = getGlobalSkillsDir();
  const skillPath = join(globalDir, name, "SKILL.md");
  if (!existsSync(skillPath)) throw new NotFoundError("Skill");
  unlinkSync(skillPath);
  queueGlobalReconcile();
  return c.json({ deleted: true });
});

// GET /workspaces/:id/skills — list workspace skills
skillRoutes.get("/workspaces/:id/skills", (c) => {
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);

  const skillsDir = join(ws.path, ".flockctl", "skills");
  const skills = readSkillsFromDir(skillsDir, "workspace");
  return c.json(skills);
});

// POST /workspaces/:id/skills — create/update workspace skill
skillRoutes.post("/workspaces/:id/skills", async (c) => {
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);

  const body = await c.req.json();
  if (!body.name) throw new ValidationError("name is required");
  validateName(body.name);
  if (!body.content) throw new ValidationError("content is required");

  const skillDir = join(ws.path, ".flockctl", "skills", body.name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), body.content);

  queueWorkspaceReconcile(id);
  return c.json({ name: body.name, level: "workspace", saved: true }, 201);
});

// DELETE /workspaces/:id/skills/:name
skillRoutes.delete("/workspaces/:id/skills/:name", (c) => {
  const id = parseIdParam(c);
  const name = c.req.param("name");
  validateName(name);
  const ws = getWorkspaceOrThrow(id);

  const skillPath = join(ws.path, ".flockctl", "skills", name, "SKILL.md");
  if (!existsSync(skillPath)) throw new NotFoundError("Skill");
  unlinkSync(skillPath);

  queueWorkspaceReconcile(id);
  return c.json({ deleted: true });
});

// GET /workspaces/:wid/projects/:pid/skills — list project skills
skillRoutes.get("/workspaces/:wid/projects/:pid/skills", (c) => {
  const pid = parseIdParam(c, "pid");
  const project = getProjectOrThrow(pid);
  if (!project.path) throw new NotFoundError("Project");

  const skillsDir = join(project.path, ".flockctl", "skills");
  const skills = readSkillsFromDir(skillsDir, "project");
  return c.json(skills);
});

// POST /workspaces/:wid/projects/:pid/skills — create/update project skill
skillRoutes.post("/workspaces/:wid/projects/:pid/skills", async (c) => {
  const pid = parseIdParam(c, "pid");
  const project = getProjectOrThrow(pid);
  if (!project.path) throw new NotFoundError("Project");

  const body = await c.req.json();
  if (!body.name) throw new ValidationError("name is required");
  validateName(body.name);
  if (!body.content) throw new ValidationError("content is required");

  const skillDir = join(project.path, ".flockctl", "skills", body.name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), body.content);

  queueProjectReconcile(pid);
  return c.json({ name: body.name, level: "project", saved: true }, 201);
});

// DELETE /workspaces/:wid/projects/:pid/skills/:name
skillRoutes.delete("/workspaces/:wid/projects/:pid/skills/:name", (c) => {
  const pid = parseIdParam(c, "pid");
  const name = c.req.param("name");
  validateName(name);
  const project = getProjectOrThrow(pid);
  if (!project.path) throw new NotFoundError("Project");

  const skillPath = join(project.path, ".flockctl", "skills", name, "SKILL.md");
  if (!existsSync(skillPath)) throw new NotFoundError("Skill");
  unlinkSync(skillPath);

  queueProjectReconcile(pid);
  return c.json({ deleted: true });
});

// ─── Disable/Enable skills (body-based {name, level}) ───

// POST /skills/workspaces/:id/disabled — body: {name, level} with level ∈ {global, workspace}
skillRoutes.post("/workspaces/:id/disabled", async (c) => {
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);
  if (!ws.path) throw new ValidationError("Workspace has no path");

  const body = await c.req.json();
  const entry = validateDisableBody(body, ["global", "workspace"]);

  const cfg = loadWorkspaceConfig(ws.path);
  cfg.disabledSkills = entriesAddUnique(cfg.disabledSkills ?? [], entry);
  saveWorkspaceConfig(ws.path, cfg);
  queueWorkspaceReconcile(id);
  return c.json({ disabledSkills: cfg.disabledSkills });
});

// DELETE /skills/workspaces/:id/disabled — body: {name, level}
skillRoutes.delete("/workspaces/:id/disabled", async (c) => {
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);
  if (!ws.path) throw new ValidationError("Workspace has no path");

  const body = await c.req.json();
  const entry = validateDisableBody(body, ["global", "workspace"]);

  const cfg = loadWorkspaceConfig(ws.path);
  cfg.disabledSkills = entriesRemove(cfg.disabledSkills ?? [], entry);
  saveWorkspaceConfig(ws.path, cfg);
  queueWorkspaceReconcile(id);
  return c.json({ disabledSkills: cfg.disabledSkills });
});

// GET /skills/workspaces/:id/disabled — list disabled skills for workspace
skillRoutes.get("/workspaces/:id/disabled", (c) => {
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);

  const cfg = ws.path ? loadWorkspaceConfig(ws.path) : {};
  return c.json({ disabledSkills: cfg.disabledSkills ?? [] });
});

// POST /skills/projects/:pid/disabled — body: {name, level} with level ∈ {global, workspace, project}
skillRoutes.post("/projects/:pid/disabled", async (c) => {
  const pid = parseIdParam(c, "pid");
  const project = getProjectOrThrow(pid);
  if (!project.path) throw new ValidationError("Project has no path");

  const body = await c.req.json();
  const entry = validateDisableBody(body, ["global", "workspace", "project"]);

  const cfg = loadProjectConfig(project.path);
  cfg.disabledSkills = entriesAddUnique(cfg.disabledSkills ?? [], entry);
  saveProjectConfig(project.path, cfg);
  queueProjectReconcile(pid);
  return c.json({ disabledSkills: cfg.disabledSkills });
});

// DELETE /skills/projects/:pid/disabled — body: {name, level}
skillRoutes.delete("/projects/:pid/disabled", async (c) => {
  const pid = parseIdParam(c, "pid");
  const project = getProjectOrThrow(pid);
  if (!project.path) throw new ValidationError("Project has no path");

  const body = await c.req.json();
  const entry = validateDisableBody(body, ["global", "workspace", "project"]);

  const cfg = loadProjectConfig(project.path);
  cfg.disabledSkills = entriesRemove(cfg.disabledSkills ?? [], entry);
  saveProjectConfig(project.path, cfg);
  queueProjectReconcile(pid);
  return c.json({ disabledSkills: cfg.disabledSkills });
});

// GET /skills/projects/:pid/disabled — list disabled skills for project
skillRoutes.get("/projects/:pid/disabled", (c) => {
  const pid = parseIdParam(c, "pid");
  const project = getProjectOrThrow(pid);

  const cfg = project.path ? loadProjectConfig(project.path) : {};
  return c.json({ disabledSkills: cfg.disabledSkills ?? [] });
});

// Helper: read skills from a directory (for REST responses only; reconciler has its own path)
function readSkillsFromDir(dir: string, level: "global" | "workspace" | "project") {
  if (!existsSync(dir)) return [];
  const skills: { name: string; level: string; content: string }[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(dir, entry.name, "SKILL.md");
    if (existsSync(skillFile)) {
      skills.push({
        name: entry.name,
        level,
        content: readFileSync(skillFile, "utf-8"),
      });
    }
  }
  return skills;
}

// Async queue helpers — reconcile doesn't block the HTTP response.
function queueGlobalReconcile() {
  setImmediate(() => {
    try {
      reconcileAllMcp();
      reconcileAllProjects();
    } catch (err) {
      console.error("[skills] global reconcile failed:", err);
    }
  });
}

function queueWorkspaceReconcile(workspaceId: number) {
  setImmediate(() => {
    try {
      reconcileClaudeSkillsForWorkspace(workspaceId);
      reconcileMcpForWorkspace(workspaceId);
      reconcileAllProjectsInWorkspace(workspaceId);
      reconcileAllMcpInWorkspace(workspaceId);
    } catch (err) {
      console.error(`[skills] workspace ${workspaceId} reconcile failed:`, err);
    }
  });
}

function queueProjectReconcile(projectId: number) {
  setImmediate(() => {
    try {
      reconcileClaudeSkillsForProject(projectId);
      reconcileMcpForProject(projectId);
    } catch (err) {
      console.error(`[skills] project ${projectId} reconcile failed:`, err);
    }
  });
}
