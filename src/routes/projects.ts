import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { projects, tasks, schedules, usageRecords, workspaces } from "../db/schema.js";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
import { paginationParams } from "../lib/pagination.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { parseIdParam, parseJsonBodySafe } from "../lib/route-params.js";
import { computeEtag, etagMatches } from "../lib/etag.js";
import { runReconcileWithObservability } from "../lib/reconcile-observability.js";
import { execa } from "execa";
import { existsSync, mkdirSync } from "fs";
import { slugify } from "../lib/slugify.js";
import { join } from "path";
import { assertSafeWritePath, defaultProjectPath } from "../lib/safe-fs-path.js";
import { listMilestones, listSlices, getProjectTree } from "../services/plan-store/index.js";
import { loadProjectConfig, saveProjectConfig, type ProjectConfig } from "../services/project-config.js";
import { parsePermissionModeBody } from "./_permission-mode.js";
import {
  parseRequiredAllowedKeyIdsOnCreate,
  parseRequiredAllowedKeyIdsOnUpdate,
} from "./_allowed-keys.js";
import {
  parseGitignoreToggles,
  hasGitignoreToggles,
} from "./_gitignore-toggles.js";
import { reconcileClaudeSkillsForProject } from "../services/claude/skills-sync.js";
import { reconcileMcpForProject } from "../services/claude/mcp-sync.js";
import { getProjectOrThrow, getWorkspaceOrThrow } from "../lib/db-helpers.js";
import {
  readAllProjectLayers,
  writeProjectLayer,
} from "../services/claude/agents-io.js";
import { loadAgentGuidance } from "../services/agent-session/agent-guidance-loader.js";
import { getFlockctlHome } from "../config/paths.js";
import { ensureClaudeMdSymlink } from "../services/claude/claude-md-symlink.js";
import { deleteSecretsForScope } from "../services/secrets.js";
import {
  scanProjectPath,
  applyImportActions,
  type ImportAction,
} from "../services/project-import.js";
import {
  loadTodoFile,
  saveTodoFile,
  initTodoFile,
  TODO_FILE_MAX_BYTES,
} from "../services/todo-file.js";
import { makeGitRouteHandlers } from "./git-route-handlers.js";
import { makeFsRouteHandlers } from "./fs-route-handlers.js";

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
  setImmediate(() =>
    runReconcileWithObservability(
      { scope: "projects:reconcile", target: projectId },
      () => {
        reconcileClaudeSkillsForProject(projectId);
        reconcileMcpForProject(projectId);
      },
    ),
  );
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
  /* v8 ignore next — SQL count(*) always returns one row, so `?? 0` is unreachable */
  const total = db.select({ count: sql<number>`count(*)` }).from(projects).get()?.count ?? 0;

  return c.json({ items, total, page, perPage });
});

// GET /projects/:id
projectRoutes.get("/:id", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const project = getProjectOrThrow(id);

  const ms = project.path ? listMilestones(project.path) : [];
  return c.json({ ...project, milestones: ms });
});

// POST /projects
projectRoutes.post("/", async (c) => {
  const db = getDb();
  const body = await parseJsonBodySafe(c);

  // Audit-round-7: trim and validate name — `if (!body.name)` accepted
  // whitespace-only strings like "   " as truthy, which then landed in
  // the DB as a "blank" project. Forbid blank-after-trim and cap the
  // length defensively so we don't persist a 10 MB blob as a name.
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

  // Auto-derive path if not provided
  const hasExplicitPath = !!body.path;
  let projectPath: string = body.path ?? "";
  if (!projectPath) {
    let workspacePath: string | null = null;
    if (body.workspaceId) {
      const { workspaces } = await import("../db/schema.js");
      const ws = db.select().from(workspaces).where(eq(workspaces.id, body.workspaceId)).get();
      workspacePath = ws?.path ?? null;
    }
    projectPath = defaultProjectPath(slugify(body.name), workspacePath);
  } else {
    // Path safety check: only validate when the caller explicitly supplied a
    // path. The auto-derived fallback is always safe by construction.
    assertSafeWritePath(projectPath);
  }

  let resolvedRepoUrl: string | null = body.repoUrl ?? null;

  if (body.repoUrl && !hasExplicitPath) {
    if (existsSync(projectPath) && existsSync(join(projectPath, ".git"))) {
      throw new ValidationError("Directory already contains a git repository");
    }
    try {
      // execa (no shell, async) — argv passed directly to git, so repoUrl
      // cannot be interpreted as shell metacharacters even if it contains
      // quotes, semicolons, or backticks. Async variant frees the event
      // loop during the (potentially slow) clone — see workspaces.ts for
      // the same migration with rationale.
      await execa("git", ["clone", "--", body.repoUrl, projectPath], { timeout: 120_000 });
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      throw new ValidationError(`Git clone failed: ${(typeof e.stderr === "string" && e.stderr.trim()) || e.message || "unknown error"}`);
    }
  } else {
    const dirExists = existsSync(projectPath);
    const hasGit = dirExists && existsSync(join(projectPath, ".git"));

    if (!dirExists) {
      mkdirSync(projectPath, { recursive: true });
    }

    if (!hasGit) {
      try {
        await execa("git", ["init"], { cwd: projectPath });
      } catch {
        // Non-fatal
      }
    } else if (!resolvedRepoUrl) {
      try {
        const { stdout } = await execa("git", ["remote", "get-url", "origin"], { cwd: projectPath });
        const remoteUrl = (typeof stdout === "string" ? stdout : "").trim();
        if (remoteUrl) resolvedRepoUrl = remoteUrl;
      } catch {
        // No 'origin' remote — leave repoUrl null
      }
    }
  }

  const createPerm = parsePermissionModeBody(body);
  const gitignoreToggles = parseGitignoreToggles(body);
  const result = db.insert(projects).values({
    name: body.name,
    description: body.description ?? null,
    workspaceId: body.workspaceId ?? null,
    path: projectPath,
    repoUrl: resolvedRepoUrl,
    allowedKeyIds: JSON.stringify(allowedKeyIds),
    // ─── API-level defaults for gitignore toggles ───
    // The schema-level DEFAULT is still 0/false (changing a SQLite column
    // DEFAULT requires a table rebuild), but on this code path we want to
    // hide every Flockctl artefact from git EXCEPT AGENTS.md — that is the
    // single legitimate trace operators want their teammates to see. So:
    //   gitignoreFlockctl  → default true  (`.flockctl/` is internal state)
    //   gitignoreTodo      → default true  (root-level scratchpad)
    //   gitignoreAgentsMd  → default false (AGENTS.md must remain visible)
    // The matching defaults live in `DEFAULT_GITIGNORE_TOGGLES` in the UI.
    gitignoreFlockctl: gitignoreToggles.gitignoreFlockctl ?? true,
    gitignoreTodo: gitignoreToggles.gitignoreTodo ?? true,
    gitignoreAgentsMd: gitignoreToggles.gitignoreAgentsMd ?? false,
    // Opt-in flag for honouring `<project>/.claude/skills/` as a skill source.
    // Default false (legacy behaviour); explicit `true` flips on locked
    // project-claude skills (see migration 0045 + `resolveSkillsForProject`).
    useProjectClaudeSkills: body.useProjectClaudeSkills === true,
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

  // Seed a root-level TODO.md on first creation. Never overwrites existing
  // content (so adopting an existing repo keeps its TODO.md intact).
  initTodoFile(projectPath);

  // Idempotent: create <root>/CLAUDE.md -> AGENTS.md symlink iff AGENTS.md
  // already exists at the root. Safe to call on every create.
  await ensureClaudeMdSymlink(projectPath);

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
  const id = parseIdParam(c);
  const existing = getProjectOrThrow(id);

  const body = await parseJsonBodySafe(c);
  const permissionMode = parsePermissionModeBody(body);
  const gitignoreToggles = parseGitignoreToggles(body);
  // Same mandatory-keys rule as POST — when the caller sends the field,
  // it must be a non-empty array of active known keys. Omitting leaves
  // the existing allow-list alone; clearing is not permitted.
  const validatedAllowedKeyIds = parseRequiredAllowedKeyIdsOnUpdate(
    body.allowedKeyIds,
    Object.prototype.hasOwnProperty.call(body, "allowedKeyIds"),
  );
  // Path safety on adopt/move: a PATCH that re-points the project at a new
  // directory must clear the same gate as create. Without this check a remote
  // token holder could adopt `/etc` or `/var/log` after the fact.
  if (typeof body.path === "string" && body.path.length > 0) {
    assertSafeWritePath(body.path);
  }
  db.update(projects)
    .set({
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.path !== undefined && { path: body.path }),
      ...(body.repoUrl !== undefined && { repoUrl: body.repoUrl }),
      ...(body.providerFallbackChain !== undefined && { providerFallbackChain: body.providerFallbackChain ? JSON.stringify(body.providerFallbackChain) : null }),
      ...(validatedAllowedKeyIds !== undefined && {
        allowedKeyIds: JSON.stringify(validatedAllowedKeyIds),
      }),
      ...(gitignoreToggles.gitignoreFlockctl !== undefined && { gitignoreFlockctl: gitignoreToggles.gitignoreFlockctl }),
      ...(gitignoreToggles.gitignoreTodo !== undefined && { gitignoreTodo: gitignoreToggles.gitignoreTodo }),
      ...(gitignoreToggles.gitignoreAgentsMd !== undefined && { gitignoreAgentsMd: gitignoreToggles.gitignoreAgentsMd }),
      // Boolean coercion via `=== true` so a non-boolean payload (e.g.
      // accidental string) is treated as "unset" rather than truthy. Only
      // applied when the field is present so omitting it preserves the
      // existing value — matches the gitignore toggles' patch semantics.
      ...(body.useProjectClaudeSkills !== undefined && {
        useProjectClaudeSkills: body.useProjectClaudeSkills === true,
      }),
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
    // Kick a reconcile whenever config OR gitignore toggles OR the
    // `.claude/skills/` opt-in changed — the reconciler is the single path
    // that writes `.gitignore` and the skills symlink farm, so any of these
    // flips are meaningless until it runs.
    if (
      Object.keys(patch).length > 0 ||
      hasGitignoreToggles(gitignoreToggles) ||
      body.useProjectClaudeSkills !== undefined
    ) {
      queueProjectReconcile(id);
    }
  }

  return c.json(updated);
});

// DELETE /projects/:id
projectRoutes.delete("/:id", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const existing = getProjectOrThrow(id);

  deleteSecretsForScope("project", id);
  db.delete(projects).where(eq(projects.id, id)).run();
  return c.json({ deleted: true });
});

// GET /projects/:id/tree — full task tree (from filesystem)
//
// The tree comes from plan-store markdown files on disk; each plan task may
// carry an `execution_task_id` that points at a row in the `tasks` table. To
// keep the mission-control right-rail from having to fan out N per-task
// requests just to show Duration / Cost for completed slices, we enrich the
// tree here with two derived fields on each task's `summary`:
//
//   - `duration_ms`      — `completed_at - started_at` on the execution task.
//   - `total_cost_usd`   — SUM(`usage_records.total_cost_usd`) for that task.
//
// Both are merged under `summary` (preserving any existing keys the plan
// author wrote into frontmatter), so the frontend's
// `computeLastRunStats(task.summary.duration_ms / total_cost_usd)` reader
// keeps working unchanged. Tasks that never ran (no `execution_task_id`)
// get no summary patch — the panel already renders `—` for those.
projectRoutes.get("/:id/tree", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const project = getProjectOrThrow(id);

  if (!project.path) return c.json({ project, milestones: [] });
  const tree = getProjectTree(project.path);

  // Collect all execution task ids referenced by plan tasks, then look up
  // duration + cost in a single batch query per table so enrichment stays
  // O(milestones + slices + tasks) rather than O(tasks * queries).
  //
  // Fallback branches below (`m.slices ?? []`, `s.tasks ?? []`, `row.taskId
  // == null`, `row.totalCostUsd` type guards, `ref == null`, `parseInt`
  // fallback, `Number.isFinite` guards, `end >= start` check) are structurally
  // defensive — the plan-store tree shape always populates `slices` /
  // `tasks` arrays, `usageRecords.taskId` is constrained NOT NULL on this
  // code path by the `inArray(taskId)` filter, and `totalCostUsd` is a REAL
  // column. Covered positive paths: non-empty tree with real task, valid
  // usage row; negative paths: empty tree (no-path project), project with
  // no execution_task_id on the plan task.
  const taskIds: number[] = [];
  for (const m of tree.milestones as Array<Record<string, any>>) {
    /* v8 ignore next 2 — m.slices / s.tasks are always arrays from plan-store */
    for (const s of (m.slices ?? []) as Array<Record<string, any>>) {
      for (const t of (s.tasks ?? []) as Array<Record<string, any>>) {
        const ref = t.task_id;
        if (ref == null) continue;
        /* v8 ignore next — ref is always a number from plan-store frontmatter parse; string fallback is defensive */
        const n = typeof ref === "number" ? ref : parseInt(String(ref), 10);
        if (Number.isFinite(n)) taskIds.push(n);
      }
    }
  }

  const durations = new Map<number, number>();
  const costs = new Map<number, number>();
  if (taskIds.length > 0) {
    const taskRows = db.select({
      id: tasks.id,
      startedAt: tasks.startedAt,
      completedAt: tasks.completedAt,
    }).from(tasks).where(inArray(tasks.id, taskIds)).all();
    for (const row of taskRows) {
      if (!row.startedAt || !row.completedAt) continue;
      const start = Date.parse(row.startedAt);
      const end = Date.parse(row.completedAt);
      /* v8 ignore next — Date.parse on ISO-8601 strings from sqlite always finite; defensive `end >= start` guard */
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        durations.set(row.id, end - start);
      }
    }

    const usageRows = db.select({
      taskId: usageRecords.taskId,
      totalCostUsd: sql<number>`SUM(COALESCE(${usageRecords.totalCostUsd}, 0))`,
    })
      .from(usageRecords)
      .where(inArray(usageRecords.taskId, taskIds))
      .groupBy(usageRecords.taskId)
      .all();
    for (const row of usageRows) {
      /* v8 ignore next — taskId cannot be null here (inArray(taskId) filter ensures non-null) */
      if (row.taskId == null) continue;
      /* v8 ignore next — COALESCE(SUM(..),0) always yields a finite number */
      if (typeof row.totalCostUsd === "number" && Number.isFinite(row.totalCostUsd)) {
        costs.set(row.taskId, row.totalCostUsd);
      }
    }
  }

  // Merge enrichment into each task's `summary`. We always produce an object
  // summary (never null) when we have any numeric value, so the frontend can
  // read `summary.duration_ms` / `summary.total_cost_usd` uniformly.
  for (const m of tree.milestones as Array<Record<string, any>>) {
    /* v8 ignore next 2 — same tree-shape invariants as above */
    for (const s of (m.slices ?? []) as Array<Record<string, any>>) {
      for (const t of (s.tasks ?? []) as Array<Record<string, any>>) {
        const ref = t.task_id;
        if (ref == null) continue;
        /* v8 ignore next 2 — string-typed task_id and non-finite parseInt are defensive */
        const n = typeof ref === "number" ? ref : parseInt(String(ref), 10);
        if (!Number.isFinite(n)) continue;
        const d = durations.get(n);
        const cost = costs.get(n);
        if (d == null && cost == null) continue;
        const existing = (t.summary && typeof t.summary === "object")
          ? t.summary as Record<string, unknown>
          : {};
        t.summary = {
          ...existing,
          ...(d != null ? { duration_ms: d } : {}),
          ...(cost != null ? { total_cost_usd: cost } : {}),
        };
      }
    }
  }

  // ETag/304 — `/projects/:id/tree` is polled every 10-30s by the
  // project-detail page; most polls return an identical payload (no
  // plan change since last tick). 304 saves body transfer + spares
  // the client a React re-render via React Query's structural
  // sharing fallback.
  const body = { project, milestones: tree.milestones };
  const tag = computeEtag(body);
  if (etagMatches(c, tag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: tag },
    });
  }
  c.header("ETag", tag);
  return c.json(body);
});

// GET /projects/:id/allowed-keys — effective key allow-list for this project
//
// Resolves the key allow-list with workspace → project inheritance (project
// overrides workspace, no merge). Returns:
//   - { allowedKeyIds: null, source: "none" } when no restriction is
//     configured at either level — callers should treat this as "all active
//     keys are allowed".
//   - { allowedKeyIds: number[], source: "project" | "workspace" } otherwise.
//
// Used by the UI to filter the AI-key picker in the Generate Plan dialog,
// chat key selector, and task-creation forms so users only see keys they
// are permitted to use for the current project.
projectRoutes.get("/:id/allowed-keys", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const project = getProjectOrThrow(id);

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

  const projectIds = parse(project.allowedKeyIds);
  if (projectIds && projectIds.length > 0) {
    return c.json({ allowedKeyIds: projectIds, source: "project" });
  }

  if (project.workspaceId) {
    const ws = db.select().from(workspaces).where(eq(workspaces.id, project.workspaceId)).get();
    const wsIds = parse(ws?.allowedKeyIds);
    if (wsIds && wsIds.length > 0) {
      return c.json({ allowedKeyIds: wsIds, source: "workspace" });
    }
  }

  return c.json({ allowedKeyIds: null, source: "none" });
});

// GET /projects/:id/stats — aggregated project statistics
projectRoutes.get("/:id/stats", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const project = getProjectOrThrow(id);

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
    /* v8 ignore next — taskStats.total is initialised to 0 above, so `?? 0` is unreachable */
    taskStats.total = (taskStats.total ?? 0) + row.count;
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
    /* v8 ignore next 2 — milestoneStats[key] and .total are pre-initialised to 0 for every tracked key */
    milestoneStats[key] = (milestoneStats[key] ?? 0) + 1;
    milestoneStats.total = (milestoneStats.total ?? 0) + 1;
  }

  const allSlices = project.path
    ? allMilestones.flatMap(m => listSlices(project.path!, m.slug))
    : [];
  const sliceStats: Record<string, number> = { total: 0, pending: 0, active: 0, completed: 0, failed: 0, skipped: 0 };
  for (const s of allSlices) {
    const key = s.status ?? "pending";
    /* v8 ignore next 2 — sliceStats[key] and .total are pre-initialised to 0 for every tracked key */
    sliceStats[key] = (sliceStats[key] ?? 0) + 1;
    sliceStats.total = (sliceStats.total ?? 0) + 1;
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
      /* v8 ignore next 3 — COALESCE(SUM(..),0) aggregates always return a single row */
      totalCostUsd: usageAgg?.totalCostUsd ?? 0,
      totalInputTokens: usageAgg?.totalInputTokens ?? 0,
      totalOutputTokens: usageAgg?.totalOutputTokens ?? 0,
    },
  });
});

// GET /projects/:id/schedules
projectRoutes.get("/:id/schedules", (c) => {
  const db = getDb();
  const pid = parseIdParam(c);
  const { page, perPage, offset } = paginationParams(c);

  const project = getProjectOrThrow(pid);

  // Schedules now carry the template reference inline, so we just filter on
  // the schedule column directly. Only project-scoped templates appear here;
  // workspace- and global-scope schedules attached to this project's workspace
  // or host are listed on the workspace page and the global templates view.
  const where = eq(schedules.templateProjectId, pid);
  const items = db.select().from(schedules).where(where)
    .limit(perPage).offset(offset).all();

  /* v8 ignore next 3 — SQL count(*) always returns one row, so `?? 0` is unreachable */
  const total = db.select({ count: sql<number>`count(*)` })
    .from(schedules).where(where)
    .get()?.count ?? 0;

  return c.json({ items, total, page, perPage });
});

// GET /projects/:id/config — read project config from .flockctl/config.json
projectRoutes.get("/:id/config", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const project = getProjectOrThrow(id);

  if (!project.path) return c.json({});
  const config = loadProjectConfig(project.path);
  return c.json(config);
});

// PUT /projects/:id/config — write project config to .flockctl/config.json
projectRoutes.put("/:id/config", async (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const project = getProjectOrThrow(id);

  if (!project.path) throw new ValidationError("Project has no path — cannot save config file");

  const body = await parseJsonBodySafe(c);
  const patch = extractConfigFromBody(body);
  mergeProjectConfig(project.path, patch);
  if (Object.keys(patch).length > 0) queueProjectReconcile(id);
  return c.json(loadProjectConfig(project.path));
});

// GET /projects/:id/agents-md — per-layer contents.
// Shape: { layers: { "project-public": LayerContent } } where
// LayerContent = { present, bytes, content }.
//
// The object form (rather than a bare `{ content }`) is kept for symmetry
// with the workspace variant and for forward-compat should we ever add more
// layers back — UI code already keys off `layers["project-public"]`.
projectRoutes.get("/:id/agents-md", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const project = getProjectOrThrow(id);

  if (!project.path) {
    return c.json({
      layers: {
        "project-public": { present: false, bytes: 0, content: "" },
      },
    });
  }
  return c.json({ layers: readAllProjectLayers(project.path) });
});

// PUT /projects/:id/agents-md — body: { content: string }.
// Writes the single public layer (`<project>/AGENTS.md`). Empty content
// deletes the file. Oversized content (> 256 KiB) returns 413. The legacy
// `layer` field is ignored; private layers were retired (see
// docs/AGENTS-LAYERING.md).
projectRoutes.put("/:id/agents-md", async (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const project = getProjectOrThrow(id);
  if (!project.path) throw new ValidationError("Project has no path — cannot save AGENTS.md");

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const content = typeof body.content === "string" ? (body.content as string) : "";

  writeProjectLayer(project.path, content);

  // Non-empty save just created or updated AGENTS.md — make sure CLAUDE.md
  // points at it. ensureClaudeMdSymlink is a no-op when CLAUDE.md already
  // exists as a regular file or unrelated symlink, so this never overwrites.
  if (content.length > 0) {
    await ensureClaudeMdSymlink(project.path);
  }

  return c.json({
    layer: "project-public",
    present: content.length > 0,
    bytes: Buffer.byteLength(content, "utf-8"),
  });
});

// GET /projects/:id/agents-md/effective — merged guidance the agent would see.
// Resolves the three layers (user, workspace-public, project-public) via
// `loadAgentGuidance` and returns the raw `LoaderOutput` shape so the UI can
// preview merge ordering, truncation flags, and the final `mergedWithHeaders`
// string used as the agent's system-prompt prefix.
projectRoutes.get("/:id/agents-md/effective", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const project = getProjectOrThrow(id);

  const flockctlHome = getFlockctlHome();
  const projPath = project.path ?? null;
  let wsPath: string | null = null;
  if (project.workspaceId) {
    const ws = db.select().from(workspaces).where(eq(workspaces.id, project.workspaceId)).get();
    /* v8 ignore next — FK ON DELETE SET NULL means workspaceId is always nulled if the ws row disappears, so `ws` is always defined here */
    wsPath = ws?.path ?? null;
  }

  const result = loadAgentGuidance({
    flockctlHome,
    workspacePath: wsPath && wsPath !== flockctlHome ? wsPath : null,
    projectPath:
      projPath && projPath !== flockctlHome && projPath !== wsPath ? projPath : null,
  });
  return c.json(result);
});

// GET /projects/:id/todo — read project root TODO.md
// Mirrors AGENTS.md: empty object (no content, no path) when the project
// has no filesystem root; { content, path } otherwise. A missing file
// returns { content: "", path } so the UI can present an empty editor.
projectRoutes.get("/:id/todo", (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const project = getProjectOrThrow(id);

  if (!project.path) return c.json({ content: "", path: "" });
  return c.json(loadTodoFile(project.path));
});

// PUT /projects/:id/todo — body: { content: string }
// Writes TODO.md verbatim (no reconciler side-effects). Non-string content
// is coerced to ""; oversize content is rejected to match AGENTS.md limits.
projectRoutes.put("/:id/todo", async (c) => {
  const db = getDb();
  const id = parseIdParam(c);
  const project = getProjectOrThrow(id);
  if (!project.path) throw new ValidationError("Project has no path — cannot save TODO.md");

  const body = await parseJsonBodySafe(c);
  const content = typeof body?.content === "string" ? body.content : "";
  if (Buffer.byteLength(content, "utf-8") > TODO_FILE_MAX_BYTES) {
    throw new ValidationError(`TODO.md exceeds ${TODO_FILE_MAX_BYTES} bytes`);
  }

  return c.json(saveTodoFile(project.path, content));
});

// POST /projects/:id/git-{pull,commit,push}
//
// These three endpoints share their entire shape (auth, error envelope,
// audit-row attribution, body validation) with the workspace router's
// future git endpoints — see `src/routes/git-route-handlers.ts` for the
// full contract. The factory takes a `getEntity` that throws NotFoundError
// on miss (project lookup) and an `attribution` that maps the entity onto
// the `{ projectId, workspaceId }` pair the audit-row writer expects, so
// the same handler can attribute project-router invocations to `project_id`
// and a workspace-router invocation to `workspace_id` without any runtime
// branching inside the handler itself.
const projectGit = makeGitRouteHandlers({
  resourceLabel: "Project",
  getEntity: (id) => getProjectOrThrow(id),
  attribution: (project) => ({ projectId: project.id }),
});

projectRoutes.get("/:id/git-status", projectGit.status);
projectRoutes.get("/:id/git-log", projectGit.log);
projectRoutes.get("/:id/git-diff", projectGit.diff);
projectRoutes.get("/:id/git-show", projectGit.show);
projectRoutes.post("/:id/git-pull", projectGit.pull);
projectRoutes.post("/:id/git-commit", projectGit.commit);
projectRoutes.post("/:id/git-push", projectGit.push);
projectRoutes.post("/:id/git-discard", projectGit.discard);
projectRoutes.post("/:id/git-fetch", projectGit.fetch);

// Branch operations: list / checkout / delete. The `:name{.+}` wildcard on
// the delete route is required so branch names containing `/` (e.g.
// `feature/foo`) reach the handler — Hono's default `:name` segment
// otherwise stops at the first slash. The handler re-validates the decoded
// name against the public `BRANCH_NAME` regex regardless.
projectRoutes.get("/:id/git-branches", projectGit.branchList);
projectRoutes.post("/:id/git-checkout", projectGit.checkout);
projectRoutes.delete("/:id/git-branches/:name{.+}", projectGit.branchDelete);

// Stash operations: push / list / pop / drop. The `:ref{.+}` wildcard on
// the drop route is required so the canonical `stash@{N}` ref (which
// includes `@`, `{`, `}`) round-trips cleanly even when the client sends
// it URL-encoded; the handler re-validates the decoded form against the
// canonical regex regardless.
projectRoutes.post("/:id/git-stash-push", projectGit.stashPush);
projectRoutes.get("/:id/git-stash-list", projectGit.stashList);
projectRoutes.post("/:id/git-stash-pop", projectGit.stashPop);
projectRoutes.delete("/:id/git-stash/:ref{.+}", projectGit.stashDrop);

// Filesystem read endpoints — entity-scoped variant that jails every relative
// path inside `project.path`. The factory pattern mirrors `projectGit` above
// so the same handler powers the workspace router (see workspaces.ts) without
// runtime branching on entity type.
const projectFs = makeFsRouteHandlers({
  resourceLabel: "Project",
  entityType: "project",
  getEntity: (id) => getProjectOrThrow(id),
  attribution: (project) => ({ projectId: project.id }),
});

projectRoutes.get("/:id/fs/list", projectFs.list);
projectRoutes.get("/:id/fs/file", projectFs.readFile);

// Flat-path enumeration backing the quick-open / fuzzy-finder UI. Returns
// every non-ignored file path under `project.path`, capped at INDEX_PATH_CAP
// with a `truncated` flag. Best-effort 30 s in-process cache keyed on
// (projectRoot, mtime-of-root) — see `indexProjectPaths` in fs-operations.ts.
projectRoutes.get("/:id/fs/index", projectFs.index);

// Optimistic-concurrency write: PUT body { content, expectedSha, allowCreate? }.
// Atomic temp+rename inside a per-file mutex; sha mismatch returns
// `{ ok: false, error_code: 'fs_sha_conflict', currentSha }` in-body. See
// `writeProjectFile` in fs-operations.ts for the full contract.
projectRoutes.put("/:id/fs/file", projectFs.writeFile);

// Mutations: mkdir / create / rename / delete via a single discriminated
// endpoint. Same factory as the read paths so the workspace router gets
// byte-identical wire semantics — see workspaces.ts.
projectRoutes.post("/:id/fs/op", projectFs.op);
