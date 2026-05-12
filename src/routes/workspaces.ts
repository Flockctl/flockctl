import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { workspaces, projects, tasks, usageRecords } from "../db/schema.js";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
import { paginationParams } from "../lib/pagination.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { parseIdParam, parseIdQuery, parseJsonBodySafe } from "../lib/route-params.js";
import { computeEtag, etagMatches } from "../lib/etag.js";
import { requireRow } from "../lib/db-helpers.js";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { slugify } from "../lib/slugify.js";
import { assertSafeWritePath, defaultWorkspacePath } from "../lib/safe-fs-path.js";
import { listMilestones, getProjectTree } from "../services/plan-store/index.js";
import { execa } from "execa";
import { parsePermissionModeBody } from "./_permission-mode.js";
import {
  parseRequiredAllowedKeyIdsOnCreate,
  parseRequiredAllowedKeyIdsOnUpdate,
} from "./_allowed-keys.js";
import {
  parseGitignoreToggles,
  hasGitignoreToggles,
} from "./_gitignore-toggles.js";
import { loadWorkspaceConfig, saveWorkspaceConfig } from "../services/workspace-config.js";
import {
  reconcileClaudeSkillsForWorkspace,
  reconcileAllProjectsInWorkspace,
} from "../services/claude/skills-sync.js";
import {
  reconcileMcpForWorkspace,
  reconcileAllMcpInWorkspace,
} from "../services/claude/mcp-sync.js";
import {
  readAllWorkspaceLayers,
  writeWorkspaceLayer,
} from "../services/claude/agents-io.js";
import { loadWorkspaceAgentGuidance } from "../services/agent-session/agent-guidance-loader.js";
import { getFlockctlHome } from "../config/paths.js";
import { ensureClaudeMdSymlink } from "../services/claude/claude-md-symlink.js";
import { deleteSecretsForScope } from "../services/secrets.js";
import {
  loadTodoFile,
  saveTodoFile,
  initTodoFile,
  TODO_FILE_MAX_BYTES,
} from "../services/todo-file.js";
import { getWorkspaceOrThrow } from "../lib/db-helpers.js";
import { makeGitRouteHandlers } from "./git-route-handlers.js";
import { makeFsRouteHandlers } from "./fs-route-handlers.js";
import { listWorkspacesWithStats } from "../services/workspaces/list.js";

export const workspaceRoutes = new Hono();

// GET /workspaces
//
// Each row carries `active_task_count` — running tasks across every project
// owned by the workspace. The aggregate is computed in a single correlated
// subquery (see `services/workspaces/list.ts`) so a workspace list with N
// rows costs one round-trip, not N+1.
workspaceRoutes.get("/", (c) => {
  const { page, perPage, offset } = paginationParams(c);
  const { items, total } = listWorkspacesWithStats(perPage, offset);
  return c.json({ items, total, page, perPage });
});

// GET /workspaces/:id
workspaceRoutes.get("/:id", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);

  const wsProjects = db.select().from(projects).where(eq(projects.workspaceId, id)).all();
  return c.json({ ...ws, projects: wsProjects });
});

// POST /workspaces — create workspace (local dir or git clone + .flockctl/ scaffold)
workspaceRoutes.post("/", async (c) => {
  const db = getDb();
  const body = await parseJsonBodySafe(c);

  // Audit-round-7: trim + cap name; reject whitespace-only.
  if (typeof body.name !== "string" || !body.name.trim()) {
    throw new ValidationError("name is required");
  }
  body.name = body.name.trim().slice(0, 200);
  if (typeof body.description === "string") {
    body.description = body.description.slice(0, 10_000);
  }

  // Key selection is mandatory on create — pick at least one active key.
  // See src/routes/_allowed-keys.ts for the exact contract and why PATCH
  // still accepts null (relax the restriction post-creation).
  const allowedKeyIds = parseRequiredAllowedKeyIdsOnCreate(body.allowedKeyIds);

  // Path safety: if the caller supplied a `path`, validate it is not a system
  // directory before any FS write or `git clone` happens. The default fallback
  // (~/flockctl/workspaces/<slug>) is always safe by construction.
  const wsPath: string = body.path || defaultWorkspacePath(slugify(body.name));
  if (body.path) assertSafeWritePath(wsPath);
  let resolvedRepoUrl: string | null = body.repoUrl ?? null;

  if (body.repoUrl) {
    if (existsSync(wsPath) && existsSync(join(wsPath, ".git"))) {
      throw new ValidationError("Directory already contains a git repository");
    }

    try {
      // execa (no shell) — argv passed directly to git, so repoUrl
      // cannot be interpreted as shell metacharacters even if it contains
      // quotes, semicolons, or backticks. Async variant so a slow remote
      // clone doesn't block the event loop for up to 120 s — other
      // concurrent requests (health, status, /tasks list) keep flowing.
      await execa("git", ["clone", "--", body.repoUrl, wsPath], { timeout: 120_000 });
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      throw new ValidationError(`Git clone failed: ${(typeof e.stderr === "string" && e.stderr.trim()) || e.message || "unknown error"}`);
    }
  } else {
    const dirExists = existsSync(wsPath);
    const hasGit = dirExists && existsSync(join(wsPath, ".git"));

    if (!dirExists) {
      await mkdir(wsPath, { recursive: true });
    }

    if (!hasGit) {
      try {
        await execa("git", ["init"], { cwd: wsPath });
      } catch {
        // Non-fatal: git might not be installed
      }
    /* v8 ignore start — the else-if branch cannot fire: the outer `else` runs only when body.repoUrl is falsy, so resolvedRepoUrl is null, so `!resolvedRepoUrl` is always true; the `false` side is structurally unreachable. The body below is covered when hasGit && outer-else both hold (e.g. adopting an existing repo into a pre-created workspace). */
    } else if (!resolvedRepoUrl) {
      try {
        const { stdout } = await execa("git", ["remote", "get-url", "origin"], { cwd: wsPath });
        const remoteUrl = (typeof stdout === "string" ? stdout : "").trim();
        if (remoteUrl) resolvedRepoUrl = remoteUrl;
      } catch {
        // No 'origin' remote — leave repoUrl null
      }
    }
    /* v8 ignore stop */
  }

  // Create .flockctl scaffold (audit-round-5: async fs/promises so the
  // event loop keeps serving while the OS hits the disk; mkdir
  // `recursive: true` is idempotent so the explicit existsSync gates
  // can be dropped — they were optimisation noise anyway).
  const flockctlDir = join(wsPath, ".flockctl");
  await mkdir(flockctlDir, { recursive: true });
  const skillsDir = join(flockctlDir, "skills");
  await mkdir(skillsDir, { recursive: true });
  const configPath = join(flockctlDir, "config.json");
  if (!existsSync(configPath)) {
    await writeFile(configPath, JSON.stringify({ skills: {} }, null, 2));
  }
  // Seed a root-level TODO.md. No-op if the directory already had one
  // (cloned repo, previously-existing workspace).
  initTodoFile(wsPath);

  const permissionMode = parsePermissionModeBody(body);
  const gitignoreToggles = parseGitignoreToggles(body);
  const result = db.insert(workspaces).values({
    name: body.name,
    description: body.description ?? null,
    path: wsPath,
    repoUrl: resolvedRepoUrl,
    allowedKeyIds: JSON.stringify(allowedKeyIds),
    // ─── API-level defaults for gitignore toggles ───
    // Mirror POST /projects: hide `.flockctl/` and TODO.md by default, keep
    // AGENTS.md visible. The same `DEFAULT_GITIGNORE_TOGGLES` constant on
    // the UI side seeds both create dialogs, so server-side defaults stay
    // symmetric with the form.
    gitignoreFlockctl: gitignoreToggles.gitignoreFlockctl ?? true,
    gitignoreTodo: gitignoreToggles.gitignoreTodo ?? true,
    gitignoreAgentsMd: gitignoreToggles.gitignoreAgentsMd ?? false,
  }).returning().get();

  if (permissionMode !== undefined && permissionMode !== null) {
    const cfg = loadWorkspaceConfig(wsPath);
    cfg.permissionMode = permissionMode;
    saveWorkspaceConfig(wsPath, cfg);
  }

  setImmediate(() => {
    try {
      reconcileClaudeSkillsForWorkspace(result.id);
      reconcileMcpForWorkspace(result.id);
    } catch (err) {
      console.error(`[workspaces] initial reconcile for ${result.id} failed:`, err);
    }
  });

  // Idempotent: create <root>/CLAUDE.md -> AGENTS.md symlink iff AGENTS.md
  // already exists at the workspace root.
  await ensureClaudeMdSymlink(wsPath);

  return c.json(result, 201);
});

// PATCH /workspaces/:id
workspaceRoutes.patch("/:id", async (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const existing = getWorkspaceOrThrow(id);

  const body = await parseJsonBodySafe(c);
  const permissionMode = parsePermissionModeBody(body);
  const gitignoreToggles = parseGitignoreToggles(body);
  // Same mandatory-keys rule as POST, but only when the caller actually
  // sends the field — an omitted field means "leave it alone." Explicitly
  // passing null / [] is rejected so the create-time gate can't be undone
  // one PATCH later.
  const validatedAllowedKeyIds = parseRequiredAllowedKeyIdsOnUpdate(
    body.allowedKeyIds,
    Object.prototype.hasOwnProperty.call(body, "allowedKeyIds"),
  );
  db.update(workspaces)
    .set({
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.repoUrl !== undefined && { repoUrl: body.repoUrl || null }),
      ...(validatedAllowedKeyIds !== undefined && {
        allowedKeyIds: JSON.stringify(validatedAllowedKeyIds),
      }),
      ...(gitignoreToggles.gitignoreFlockctl !== undefined && { gitignoreFlockctl: gitignoreToggles.gitignoreFlockctl }),
      ...(gitignoreToggles.gitignoreTodo !== undefined && { gitignoreTodo: gitignoreToggles.gitignoreTodo }),
      ...(gitignoreToggles.gitignoreAgentsMd !== undefined && { gitignoreAgentsMd: gitignoreToggles.gitignoreAgentsMd }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(workspaces.id, id))
    .run();

  const gitignoreChanged = hasGitignoreToggles(gitignoreToggles);

  if (permissionMode !== undefined && existing.path) {
    const cfg = loadWorkspaceConfig(existing.path);
    if (permissionMode === null) delete cfg.permissionMode;
    else cfg.permissionMode = permissionMode;
    saveWorkspaceConfig(existing.path, cfg);
  }

  // Reconcile whenever permissionMode changed OR any gitignore toggle was
  // touched. The reconciler is the single writer of `.gitignore`, so the new
  // flags only take effect after it runs.
  if ((permissionMode !== undefined || gitignoreChanged) && existing.path) {
    setImmediate(() => {
      try {
        reconcileClaudeSkillsForWorkspace(id);
        reconcileMcpForWorkspace(id);
      } catch (err) {
        console.error(`[workspaces] reconcile after PATCH ${id} failed:`, err);
      }
    });
  }

  // Re-fetch the post-update row. Surfaces 404 instead of an undefined
  // body if the workspace was concurrently deleted between the UPDATE
  // above and this SELECT — extremely rare in single-tenant Flockctl,
  // but the ?? null default + c.json undefined was technically incorrect.
  const updated = requireRow(
    db.select().from(workspaces).where(eq(workspaces.id, id)).get(),
    "Workspace",
    id,
  );
  return c.json(updated);
});

// DELETE /workspaces/:id — delete workspace + all projects inside
workspaceRoutes.delete("/:id", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const existing = getWorkspaceOrThrow(id);

  deleteSecretsForScope("workspace", id);
  // Projects' workspaceId is SET NULL on cascade by the DB schema
  db.delete(workspaces).where(eq(workspaces.id, id)).run();
  return c.json({ deleted: true });
});

// POST /workspaces/:id/projects — add project to workspace
// Two modes:
//   1. ?project_id=N  → link existing project to this workspace
//   2. JSON body with name → create a new project inside the workspace
workspaceRoutes.post("/:id/projects", async (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);

  // Mode 1: link existing project
  const projectId = parseIdQuery(c, "project_id");
  if (projectId !== undefined) {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) throw new NotFoundError("Project");

    db.update(projects)
      .set({ workspaceId: id, updatedAt: new Date().toISOString() })
      .where(eq(projects.id, projectId))
      .run();

    const updated = requireRow(
      db.select().from(projects).where(eq(projects.id, projectId)).get(),
      "Project",
      projectId,
    );
    return c.json(updated, 200);
  }

  // Mode 2: create new project
  const body = await parseJsonBodySafe(c);
  if (!body.name) throw new ValidationError("name is required");

  // Key selection is mandatory on project create — same rule as POST /projects.
  const allowedKeyIds = parseRequiredAllowedKeyIdsOnCreate(body.allowedKeyIds);
  const projGitignoreToggles = parseGitignoreToggles(body);

  const projectPath = body.path ?? join(ws.path, slugify(body.name));
  if (body.path) assertSafeWritePath(projectPath);

  // Create directory if needed — async + idempotent recursive mkdir.
  await mkdir(projectPath, { recursive: true });

  // Git init if no .git
  if (!existsSync(join(projectPath, ".git"))) {
    try {
      await execa("git", ["init"], { cwd: projectPath });
    } catch { /* non-fatal */ }
  }

  // Create .flockctl/skills/ inside project
  const projSkillsDir = join(projectPath, ".flockctl", "skills");
  await mkdir(projSkillsDir, { recursive: true });

  // Seed TODO.md at the nested project root so the UI always has something
  // to open. Idempotent: existing files are never overwritten.
  initTodoFile(projectPath);

  const result = db.insert(projects).values({
    workspaceId: id,
    name: body.name,
    description: body.description ?? null,
    path: projectPath,
    repoUrl: body.repoUrl ?? null,
    allowedKeyIds: JSON.stringify(allowedKeyIds),
    // ─── API-level defaults for gitignore toggles ───
    // Mirror POST /projects: hide `.flockctl/` and TODO.md by default,
    // keep AGENTS.md visible. See projects.ts for the rationale.
    gitignoreFlockctl: projGitignoreToggles.gitignoreFlockctl ?? true,
    gitignoreTodo: projGitignoreToggles.gitignoreTodo ?? true,
    gitignoreAgentsMd: projGitignoreToggles.gitignoreAgentsMd ?? false,
    // Project `.claude/skills/` opt-in (migration 0045) — default off.
    useProjectClaudeSkills: body.useProjectClaudeSkills === true,
  }).returning().get();

  // Idempotent: create <root>/CLAUDE.md -> AGENTS.md symlink iff AGENTS.md
  // already exists at the project root.
  await ensureClaudeMdSymlink(projectPath);

  return c.json(result, 201);
});

// GET /workspaces/:id/config — read workspace config from .flockctl/config.yaml
workspaceRoutes.get("/:id/config", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);

  if (!ws.path) return c.json({});
  const config = loadWorkspaceConfig(ws.path);
  return c.json(config);
});

// PUT /workspaces/:id/config — write workspace config to .flockctl/config.json
workspaceRoutes.put("/:id/config", async (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);

  if (!ws.path) throw new ValidationError("Workspace has no path — cannot save config file");

  const body = await parseJsonBodySafe(c);

  const existing = loadWorkspaceConfig(ws.path);
  const merged: Record<string, any> = { ...existing };

  let touchedSkills = false;
  let touchedMcp = false;
  for (const key of ["permissionMode", "disabledSkills", "disabledMcpServers"]) {
    if (body[key] !== undefined) {
      if (body[key] === null || body[key] === "" || (Array.isArray(body[key]) && body[key].length === 0)) {
        delete merged[key];
      } else {
        merged[key] = body[key];
      }
      if (key === "disabledSkills") touchedSkills = true;
      if (key === "disabledMcpServers") touchedMcp = true;
    }
  }

  saveWorkspaceConfig(ws.path, merged);

  if (touchedSkills || touchedMcp) {
    setImmediate(() => {
      try {
        if (touchedSkills) reconcileAllProjectsInWorkspace(id);
        if (touchedMcp) reconcileAllMcpInWorkspace(id);
      } catch (err) {
        /* v8 ignore next — defensive: reconcilers handle their own errors */
        console.error(`[workspaces] config reconcile ${id} failed:`, err);
      }
    });
  }

  return c.json(merged);
});

// GET /workspaces/:id/agents-md — per-layer contents.
// Shape: { layers: { "workspace-public": LayerContent } }. Kept as an
// object (not `{ content }`) for symmetry with project-level AGENTS.md.
workspaceRoutes.get("/:id/agents-md", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);

  if (!ws.path) {
    return c.json({
      layers: {
        "workspace-public": { present: false, bytes: 0, content: "" },
      },
    });
  }
  return c.json({ layers: readAllWorkspaceLayers(ws.path) });
});

// PUT /workspaces/:id/agents-md — body: { content: string }.
// Writes the single public layer (`<workspace>/AGENTS.md`). Never cascades to
// child project files. Empty content deletes the file; >256 KiB returns 413.
workspaceRoutes.put("/:id/agents-md", async (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);
  if (!ws.path) throw new ValidationError("Workspace has no path — cannot save AGENTS.md");

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const content = typeof body.content === "string" ? (body.content as string) : "";

  writeWorkspaceLayer(ws.path, content);

  if (content.length > 0) {
    await ensureClaudeMdSymlink(ws.path);
  }

  return c.json({
    layer: "workspace-public",
    present: content.length > 0,
    bytes: Buffer.byteLength(content, "utf-8"),
  });
});

// GET /workspaces/:id/agents-md/effective — merged guidance a session rooted
// at this workspace would see. Resolves layers 1-2 (user, workspace-public);
// there is no project scope at the workspace level, so the project layer is
// intentionally skipped.
workspaceRoutes.get("/:id/agents-md/effective", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);

  const flockctlHome = getFlockctlHome();
  /* v8 ignore next — workspaces.path is NOT NULL in the schema, so `?? ""` is defensive */
  const result = loadWorkspaceAgentGuidance(ws.path ?? "", flockctlHome);
  return c.json(result);
});

// GET /workspaces/:id/todo — read workspace root TODO.md.
// Semantics match the project variant: empty path means no filesystem root;
// missing file returns { content: "", path } so the UI can still edit.
workspaceRoutes.get("/:id/todo", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);

  if (!ws.path) return c.json({ content: "", path: "" });
  return c.json(loadTodoFile(ws.path));
});

// PUT /workspaces/:id/todo — body: { content: string }
// Plain file write. No cascade, no reconcile — TODO.md is user-scoped
// notes, not agent config.
workspaceRoutes.put("/:id/todo", async (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);
  if (!ws.path) throw new ValidationError("Workspace has no path — cannot save TODO.md");

  const body = await parseJsonBodySafe(c);
  const content = typeof body?.content === "string" ? body.content : "";
  if (Buffer.byteLength(content, "utf-8") > TODO_FILE_MAX_BYTES) {
    throw new ValidationError(`TODO.md exceeds ${TODO_FILE_MAX_BYTES} bytes`);
  }

  return c.json(saveTodoFile(ws.path, content));
});

// DELETE /workspaces/:id/projects/:projectId
workspaceRoutes.delete("/:id/projects/:projectId", (c) => {
  const db = getDb();
  const wsId = parseIdParam(c);
  const projectId = parseIdParam(c, "projectId");

  const ws = getWorkspaceOrThrow(wsId);

  const project = db.select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, wsId)))
    .get();
  if (!project) throw new NotFoundError("Project in workspace");

  db.update(projects)
    .set({ workspaceId: null, updatedAt: new Date().toISOString() })
    .where(eq(projects.id, projectId))
    .run();
  return c.json({ removed: true });
});

// GET /workspaces/:id/allowed-keys — effective key allow-list for this workspace.
//
// Mirrors `GET /projects/:id/allowed-keys`: returns
//   - { allowedKeyIds: null, source: "none" } when no whitelist is configured
//     (callers should treat this as "all active keys are allowed");
//   - { allowedKeyIds: number[], source: "workspace" } otherwise.
//
// Used by the chat key picker on workspace-only chats (started from the
// workspace page) so the dropdown is filtered the same way it is for
// project-scoped chats. Without this endpoint, a workspace with a strict
// whitelist would still let the user pick any active key on the workspace
// chat — visually, with no error — and only fail with a 422 at send time.
workspaceRoutes.get("/:id/allowed-keys", (c) => {
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);

  const parse = (raw: string | null | undefined): number[] | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      return parsed
        .map((v) => (typeof v === "number" ? v : parseInt(String(v), 10)))
        .filter((n) => Number.isFinite(n));
    } catch {
      return null;
    }
  };

  const ids = parse(ws.allowedKeyIds);
  if (ids && ids.length > 0) {
    return c.json({ allowedKeyIds: ids, source: "workspace" });
  }
  return c.json({ allowedKeyIds: null, source: "none" });
});

// GET /workspaces/:id/dashboard
workspaceRoutes.get("/:id/dashboard", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const ws = getWorkspaceOrThrow(id);

  const wsProjects = db.select().from(projects).where(eq(projects.workspaceId, id)).all();
  const projectIds = wsProjects.map(p => p.id);

  if (projectIds.length === 0) {
    return c.json({
      project_count: 0,
      active_tasks: 0,
      completed_tasks: 0,
      failed_tasks: 0,
      pending_milestones: 0,
      active_milestones: 0,
      completed_milestones: 0,
      total_cost_usd: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      cost_by_project: [],
      recent_activity: [],
      project_summaries: [],
    });
  }

  // ─── Task status counts ───
  //
  // Audit-round-3 finding: the previous shape ran THREE sequential
  // `count(*)` queries (running / completed / failed) — each scanned
  // the same task rows with a different WHERE filter. Collapsed into
  // a single GROUP BY so SQLite reads the rows once and buckets them
  // in-place. Counts for statuses that didn't appear default to 0
  // via the destructuring below.
  const statusCounts = db
    .select({ status: tasks.status, count: sql<number>`count(*)` })
    .from(tasks)
    .where(
      and(
        inArray(tasks.projectId, projectIds),
        sql`${tasks.status} IN ('running', 'completed', 'failed')`,
      ),
    )
    .groupBy(tasks.status)
    .all();
  let activeTasks = 0;
  let completedTasks = 0;
  let failedTasks = 0;
  for (const row of statusCounts) {
    if (row.status === "running") activeTasks = row.count;
    else if (row.status === "completed") completedTasks = row.count;
    else if (row.status === "failed") failedTasks = row.count;
  }

  // Milestone counts from filesystem
  const allMilestones = wsProjects.flatMap(p => p.path ? listMilestones(p.path) : []);
  const pendingMilestones = allMilestones.filter(m => m.status === "pending").length;
  const activeMilestones = allMilestones.filter(m => m.status === "active" || m.status === "in_progress").length;
  const completedMilestones = allMilestones.filter(m => m.status === "completed").length;

  // Cost/token aggregation
  const costAgg = db.select({
    totalCostUsd: sql<number>`COALESCE(SUM(${usageRecords.totalCostUsd}), 0)`,
    totalInputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)`,
    totalOutputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)`,
  }).from(usageRecords)
    .where(inArray(usageRecords.projectId, projectIds))
    .get();

  const costByProject = db.select({
    projectId: sql<string>`CAST(${usageRecords.projectId} AS TEXT)`,
    projectName: projects.name,
    costUsd: sql<number>`COALESCE(SUM(${usageRecords.totalCostUsd}), 0)`,
  }).from(usageRecords)
    .leftJoin(projects, eq(usageRecords.projectId, projects.id))
    .where(inArray(usageRecords.projectId, projectIds))
    .groupBy(usageRecords.projectId)
    .all();

  // Recent completed/failed tasks as activity
  const recentTasks = db.select().from(tasks)
    .where(and(
      inArray(tasks.projectId, projectIds),
      sql`${tasks.status} IN ('completed', 'failed')`,
    ))
    .orderBy(desc(tasks.completedAt))
    .limit(10)
    .all();

  const recentActivity = recentTasks.map(t => ({
    type: t.status === "completed" ? "task_completed" as const : "task_failed" as const,
    entityId: t.id,
    title: t.label ?? `Task #${t.id}`,
    timestamp: t.completedAt ?? t.updatedAt ?? "",
  }));

  const project_summaries = wsProjects.map(p => {
    const tree = p.path ? getProjectTree(p.path) : { milestones: [] };
    return {
      project_id: p.id,
      project_name: p.name,
      milestone_count: tree.milestones.length,
      tree,
    };
  });

  const dashboardBody = {
    project_count: projectIds.length,
    active_tasks: activeTasks,
    completed_tasks: completedTasks,
    failed_tasks: failedTasks,
    pending_milestones: pendingMilestones,
    active_milestones: activeMilestones,
    completed_milestones: completedMilestones,
    /* v8 ignore next 3 — COALESCE(SUM(..),0) aggregate always returns a single row */
    total_cost_usd: costAgg?.totalCostUsd ?? 0,
    total_input_tokens: costAgg?.totalInputTokens ?? 0,
    total_output_tokens: costAgg?.totalOutputTokens ?? 0,
    cost_by_project: costByProject,
    recent_activity: recentActivity,
    project_summaries,
  };
  // ETag/304 — dashboard is polled on a 30s cadence; the payload is
  // deterministic relative to underlying state so repeat-fetches save
  // body bytes when nothing has changed.
  const tag = computeEtag(dashboardBody);
  if (etagMatches(c, tag)) {
    return new Response(null, { status: 304, headers: { ETag: tag } });
  }
  c.header("ETag", tag);
  return c.json(dashboardBody);
});

// ─── Workspace-scoped git routes (pull / commit / push) ────────────────────
//
// Sibling of the project-router git mounts in `routes/projects.ts`. Both
// surfaces share the same factory so the wire contract is byte-identical:
// HTTP 200 with a `{ ok, ... }` discriminated body on git outcomes (success
// or recoverable failure), 4xx only for shape errors before git runs at all
// (404 missing workspace, 422 missing path / malformed body).
//
// The attribution closure is the only thing that differs between the two
// mounts: workspace invocations key the `git_audit_log` row on
// `workspace_id` (project_id stays NULL); project invocations do the
// reverse. The CHECK constraint on the audit table requires exactly one of
// the two to be set, and the per-side recency indexes assume the asymmetry
// is preserved — see `migrations/0046_git_audit_log.sql`.
const workspaceGit = makeGitRouteHandlers({
  resourceLabel: "Workspace",
  getEntity: (id) => getWorkspaceOrThrow(id),
  attribution: (workspace) => ({ workspaceId: workspace.id }),
});

workspaceRoutes.get("/:id/git-status", workspaceGit.status);
workspaceRoutes.get("/:id/git-log", workspaceGit.log);
workspaceRoutes.get("/:id/git-diff", workspaceGit.diff);
workspaceRoutes.get("/:id/git-show", workspaceGit.show);
workspaceRoutes.post("/:id/git-pull", workspaceGit.pull);
workspaceRoutes.post("/:id/git-commit", workspaceGit.commit);
workspaceRoutes.post("/:id/git-push", workspaceGit.push);
workspaceRoutes.post("/:id/git-discard", workspaceGit.discard);
workspaceRoutes.post("/:id/git-fetch", workspaceGit.fetch);

// Branch operations: same factory as the project router. See projects.ts
// for the rationale on the `:name{.+}` wildcard.
workspaceRoutes.get("/:id/git-branches", workspaceGit.branchList);
workspaceRoutes.post("/:id/git-checkout", workspaceGit.checkout);
workspaceRoutes.delete("/:id/git-branches/:name{.+}", workspaceGit.branchDelete);

// Stash operations: same factory as the project router. See projects.ts
// for the rationale on the `:ref{.+}` wildcard.
workspaceRoutes.post("/:id/git-stash-push", workspaceGit.stashPush);
workspaceRoutes.get("/:id/git-stash-list", workspaceGit.stashList);
workspaceRoutes.post("/:id/git-stash-pop", workspaceGit.stashPop);
workspaceRoutes.delete("/:id/git-stash/:ref{.+}", workspaceGit.stashDrop);

// Filesystem read endpoints. Same factory as the project router; the only
// runtime difference is the audit-attribution scope (workspace_id vs
// project_id), wired via the closure passed to `makeFsRouteHandlers`.
const workspaceFs = makeFsRouteHandlers({
  resourceLabel: "Workspace",
  entityType: "workspace",
  getEntity: (id) => getWorkspaceOrThrow(id),
  attribution: (workspace) => ({ workspaceId: workspace.id }),
});

workspaceRoutes.get("/:id/fs/list", workspaceFs.list);
workspaceRoutes.get("/:id/fs/file", workspaceFs.readFile);

// Flat-path enumeration. Same factory as projects.ts; the only difference
// is the audit-attribution scope (workspace_id vs project_id).
workspaceRoutes.get("/:id/fs/index", workspaceFs.index);

// Optimistic-concurrency write. Same factory as projects.ts so the wire
// contract is byte-identical between the two routers; the only difference
// is the audit-row attribution (workspace_id vs project_id).
workspaceRoutes.put("/:id/fs/file", workspaceFs.writeFile);

// Mutations: mkdir / create / rename / delete via a single discriminated
// endpoint. Same factory as the project router; the only runtime difference
// is the audit-attribution scope (workspace_id vs project_id).
workspaceRoutes.post("/:id/fs/op", workspaceFs.op);
