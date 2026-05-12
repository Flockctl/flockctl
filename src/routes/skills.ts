import { Hono } from "hono";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { parseIdParam, parseIdQuery, parseJsonBodySafe } from "../lib/route-params.js";
import { getWorkspaceOrThrow, getProjectOrThrow } from "../lib/db-helpers.js";
import { assertSafeName } from "../lib/validate-name.js";
import { resolveSkillsForProject } from "../services/skills.js";
import { getGlobalSkillsDir, getSkillsDir } from "../config/index.js";
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
import { mkdir, readdir, readFile, writeFile, unlink } from "fs/promises";
import { join } from "path";
import { runReconcileWithObservability } from "../lib/reconcile-observability.js";

// `validateDisableBody`, `entriesAddUnique`, `entriesRemove` lifted to
// `lib/disable-entries.ts` (audit-round-7) — mcp.ts had the identical
// implementations.
import {
  validateDisableBody,
  entriesAddUnique,
  entriesRemove,
} from "../lib/disable-entries.js";

export const skillRoutes = new Hono();

// GET /skills/global — list global skills
skillRoutes.get("/global", async (c) => {
  const globalDir = getGlobalSkillsDir();
  const skills = await readSkillsFromDir(globalDir, "global");
  return c.json(skills);
});

// GET /skills/resolved?projectId=X — resolved skills for project
skillRoutes.get("/resolved", (c) => {
  const pid = parseIdQuery(c, "projectId") ?? null;
  const skills = resolveSkillsForProject(pid);
  return c.json(skills);
});

// POST /skills/global — create/update global skill
skillRoutes.post("/global", async (c) => {
  const body = await parseJsonBodySafe(c);
  if (!body.name) throw new ValidationError("name is required");
  assertSafeName(body.name);
  if (!body.content) throw new ValidationError("content is required");

  const globalDir = getGlobalSkillsDir();
  const skillDir = join(globalDir, body.name);
  // Async fs/promises so the event loop isn't blocked while we write
  // the SKILL.md (typical size is small, but the daemon serves other
  // requests concurrently and a slow disk would queue everyone).
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), body.content);

  queueGlobalReconcile();
  return c.json({ name: body.name, level: "global", saved: true }, 201);
});

// DELETE /skills/global/:name
skillRoutes.delete("/global/:name", async (c) => {
  const name = c.req.param("name");
  assertSafeName(name);
  const globalDir = getGlobalSkillsDir();
  const skillPath = join(globalDir, name, "SKILL.md");
  // `existsSync` is a cheap stat — fine to keep sync; the unlink is
  // where IO actually happens.
  if (!existsSync(skillPath)) throw new NotFoundError("Skill");
  await unlink(skillPath);
  queueGlobalReconcile();
  return c.json({ deleted: true });
});

// GET /workspaces/:id/skills — list workspace skills
skillRoutes.get("/workspaces/:id/skills", async (c) => {
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);

  const skillsDir = getSkillsDir(ws.path);
  const skills = await readSkillsFromDir(skillsDir, "workspace");
  return c.json(skills);
});

// POST /workspaces/:id/skills — create/update workspace skill
skillRoutes.post("/workspaces/:id/skills", async (c) => {
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);

  const body = await parseJsonBodySafe(c);
  if (!body.name) throw new ValidationError("name is required");
  assertSafeName(body.name);
  if (!body.content) throw new ValidationError("content is required");

  const skillDir = join(getSkillsDir(ws.path), body.name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), body.content);

  queueWorkspaceReconcile(id);
  return c.json({ name: body.name, level: "workspace", saved: true }, 201);
});

// DELETE /workspaces/:id/skills/:name
skillRoutes.delete("/workspaces/:id/skills/:name", async (c) => {
  const id = parseIdParam(c);
  const name = c.req.param("name");
  assertSafeName(name);
  const ws = getWorkspaceOrThrow(id);

  const skillPath = join(getSkillsDir(ws.path), name, "SKILL.md");
  if (!existsSync(skillPath)) throw new NotFoundError("Skill");
  await unlink(skillPath);

  queueWorkspaceReconcile(id);
  return c.json({ deleted: true });
});

// GET /workspaces/:wid/projects/:pid/skills — list project skills
skillRoutes.get("/workspaces/:wid/projects/:pid/skills", async (c) => {
  const pid = parseIdParam(c, "pid");
  const project = getProjectOrThrow(pid);
  if (!project.path) throw new NotFoundError("Project");

  const skillsDir = getSkillsDir(project.path);
  const skills = await readSkillsFromDir(skillsDir, "project");
  return c.json(skills);
});

// POST /workspaces/:wid/projects/:pid/skills — create/update project skill
skillRoutes.post("/workspaces/:wid/projects/:pid/skills", async (c) => {
  const pid = parseIdParam(c, "pid");
  const project = getProjectOrThrow(pid);
  if (!project.path) throw new NotFoundError("Project");

  const body = await parseJsonBodySafe(c);
  if (!body.name) throw new ValidationError("name is required");
  assertSafeName(body.name);
  if (!body.content) throw new ValidationError("content is required");

  const skillDir = join(getSkillsDir(project.path), body.name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), body.content);

  queueProjectReconcile(pid);
  return c.json({ name: body.name, level: "project", saved: true }, 201);
});

// DELETE /workspaces/:wid/projects/:pid/skills/:name
skillRoutes.delete("/workspaces/:wid/projects/:pid/skills/:name", async (c) => {
  const pid = parseIdParam(c, "pid");
  const name = c.req.param("name");
  assertSafeName(name);
  const project = getProjectOrThrow(pid);
  if (!project.path) throw new NotFoundError("Project");

  const skillPath = join(getSkillsDir(project.path), name, "SKILL.md");
  if (!existsSync(skillPath)) throw new NotFoundError("Skill");
  await unlink(skillPath);

  queueProjectReconcile(pid);
  return c.json({ deleted: true });
});

// ─── Disable/Enable skills (body-based {name, level}) ───

// POST /skills/workspaces/:id/disabled — body: {name, level} with level ∈ {global, workspace}
skillRoutes.post("/workspaces/:id/disabled", async (c) => {
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);
  if (!ws.path) throw new ValidationError("Workspace has no path");

  const body = await parseJsonBodySafe(c);
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

  const body = await parseJsonBodySafe(c);
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

  const body = await parseJsonBodySafe(c);
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

  const body = await parseJsonBodySafe(c);
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

// Helper: read skills from a directory (for REST responses only;
// reconciler has its own path).
//
// Async fs/promises throughout so the route handler doesn't block the
// event loop while we walk dozens of skill directories and read each
// SKILL.md (audit-round-5 finding). The existsSync at the top is fine
// — it's a cheap stat the kernel resolves immediately and lets us
// bail without touching userspace allocators for an empty dir.
async function readSkillsFromDir(
  dir: string,
  level: "global" | "workspace" | "project",
): Promise<Array<{ name: string; level: string; content: string }>> {
  if (!existsSync(dir)) return [];
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    // `encoding: "utf8"` selects the overload that returns Dirent<string>
    // rather than Dirent<Buffer>, so entry.name is a string we can pass
    // straight into `path.join`.
    entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }

  // Read every SKILL.md in parallel so a slow disk doesn't serialise
  // the requests. The dir is small (dozens of skills per scope) so
  // unbounded parallelism is fine; backpressure would be worth adding
  // only if individual skill files were large.
  type SkillRow = { name: string; level: string; content: string };
  const reads = entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry): Promise<SkillRow | null> => {
      const skillFile = join(dir, entry.name, "SKILL.md");
      try {
        const content = await readFile(skillFile, "utf-8");
        return { name: entry.name, level, content };
      } catch {
        // Missing / unreadable SKILL.md → skip this skill silently;
        // it's the normal shape for partial / WIP skill directories.
        return null;
      }
    });
  const results = await Promise.all(reads);
  return results.filter((r): r is SkillRow => r !== null);
}

// Async queue helpers — reconcile doesn't block the HTTP response.
// Wrapped through `runReconcileWithObservability` so failures both log
// (forensics) AND broadcast a `reconcile_failed` WS envelope (UI toast).
function queueGlobalReconcile() {
  setImmediate(() =>
    runReconcileWithObservability({ scope: "skills:global" }, () => {
      reconcileAllMcp();
      reconcileAllProjects();
    }),
  );
}

function queueWorkspaceReconcile(workspaceId: number) {
  setImmediate(() =>
    runReconcileWithObservability(
      { scope: "skills:workspace", target: workspaceId },
      () => {
        reconcileClaudeSkillsForWorkspace(workspaceId);
        reconcileMcpForWorkspace(workspaceId);
        reconcileAllProjectsInWorkspace(workspaceId);
        reconcileAllMcpInWorkspace(workspaceId);
      },
    ),
  );
}

function queueProjectReconcile(projectId: number) {
  setImmediate(() =>
    runReconcileWithObservability(
      { scope: "skills:project", target: projectId },
      () => {
        reconcileClaudeSkillsForProject(projectId);
        reconcileMcpForProject(projectId);
      },
    ),
  );
}
