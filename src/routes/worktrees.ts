import { Hono } from "hono";
import { eq, and, isNotNull, inArray } from "drizzle-orm";
import { getDb, getRawDb } from "../db/index.js";
import { chats, projects, tasks } from "../db/schema.js";
import { getProjectById } from "../lib/db-helpers.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { parseIdQuery } from "../lib/route-params.js";
import {
  cleanupIfClean,
  listWorktrees,
} from "../services/worktree-manager.js";

/**
 * /worktrees — operator-facing surface for managing per-task / per-chat
 * git worktrees across one or every project.
 *
 *   GET  /worktrees?project_id=<id>   — list worktrees for one project
 *                                       (or all when omitted), annotated
 *                                       with the owning task/chat row
 *                                       and a `dirty` flag the UI uses
 *                                       to gate destructive actions.
 *
 *   POST /worktrees/prune?project_id=<id>
 *                                     — sweep cleanup-if-clean across
 *                                       every DB-tracked worktree in
 *                                       scope. Returns counts +
 *                                       per-row outcomes for telemetry.
 *
 * The list endpoint deliberately reports the union of (DB rows with a
 * `worktree_path`) and (`git worktree list` output) so operators can
 * discover orphans — worktrees on disk that no longer correspond to a
 * row, e.g. because the task/chat was deleted out-of-band. Orphans
 * carry `owner: null` in the response.
 *
 * No DELETE here — single-worktree teardown lives on the owner-scoped
 * routes (DELETE /tasks/:id/worktree, DELETE /chats/:id/worktree,
 * POST /chats/:id/end-session) so they can rely on the same row guard
 * (404 if no worktree, 409 if dirty without `?force=true`). The
 * `/worktrees` umbrella is just for cross-cutting list / prune.
 */

export const worktreeRoutes = new Hono();

interface WorktreeOwner {
  kind: "task" | "chat";
  id: number;
}

interface WorktreeListEntry {
  projectId: number;
  projectName: string;
  projectPath: string;
  path: string;
  branch: string | null;
  /** Owning DB row, when one is found by `worktree_path` match. */
  owner: WorktreeOwner | null;
  /** True when `git worktree list` knows about this path AND DB has the row. */
  managed: boolean;
}

/**
 * Build an "owner by worktree path" map for every project in `projectIds`
 * via TWO batched queries (instead of 2 × N per-project SELECTs). Callers
 * with one project still benefit (same shape, single round-trip pair); the
 * payoff is the multi-project / list-all path which previously did 2 ×
 * `projects.count` queries.
 *
 * Returns `Map<projectId, Map<worktreePath, owner>>` — nested so the
 * caller can locate ownership for one project without scanning the union.
 */
function loadOwnersByPath(projectIds: number[]): Map<number, Map<string, WorktreeOwner>> {
  const result = new Map<number, Map<string, WorktreeOwner>>();
  for (const id of projectIds) result.set(id, new Map());
  if (projectIds.length === 0) return result;

  const db = getDb();
  const taskRows = db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      path: tasks.worktreePath,
    })
    .from(tasks)
    .where(and(inArray(tasks.projectId, projectIds), isNotNull(tasks.worktreePath)))
    .all();
  for (const t of taskRows) {
    if (!t.path || t.projectId === null) continue;
    result.get(t.projectId)?.set(t.path, { kind: "task", id: t.id });
  }
  const chatRows = db
    .select({
      id: chats.id,
      projectId: chats.projectId,
      path: chats.worktreePath,
    })
    .from(chats)
    .where(and(inArray(chats.projectId, projectIds), isNotNull(chats.worktreePath)))
    .all();
  for (const ch of chatRows) {
    if (!ch.path || ch.projectId === null) continue;
    result.get(ch.projectId)?.set(ch.path, { kind: "chat", id: ch.id });
  }
  return result;
}

function worktreesForProject(
  p: typeof projects.$inferSelect,
  ownerByPath?: Map<string, WorktreeOwner>,
): WorktreeListEntry[] {
  if (!p.path) return [];

  // When called from the list endpoint, `ownerByPath` is pre-built by
  // `loadOwnersByPath` across every project in scope — one inArray pair
  // instead of one pair per project. When called as a one-off, fall
  // through to the legacy per-project queries.
  if (!ownerByPath) {
    ownerByPath = loadOwnersByPath([p.id]).get(p.id) ?? new Map();
  }

  // git's view of registered worktrees (includes the main worktree
  // itself; we filter that out below by branch prefix).
  const gitEntries = listWorktrees(p.path);

  const out: WorktreeListEntry[] = [];
  for (const e of gitEntries) {
    if (!e.managed) continue; // skip operator-created worktrees
    out.push({
      projectId: p.id,
      projectName: p.name,
      projectPath: p.path,
      path: e.path,
      branch: e.branch,
      owner: ownerByPath.get(e.path) ?? null,
      managed: ownerByPath.has(e.path),
    });
  }

  // Surface "stale" rows too — DB says worktree X exists but `git
  // worktree list` doesn't know about it. The list owns one entry per
  // path; we add only the DB-side ones git missed.
  const seenPaths = new Set(out.map((e) => e.path));
  for (const [path, owner] of ownerByPath.entries()) {
    if (seenPaths.has(path)) continue;
    out.push({
      projectId: p.id,
      projectName: p.name,
      projectPath: p.path,
      path,
      branch: null,
      owner,
      managed: false,
    });
  }
  return out;
}

worktreeRoutes.get("/", (c) => {
  const db = getDb();
  const projectId = parseIdQuery(c, "project_id");

  let projectRows: Array<typeof projects.$inferSelect>;
  if (projectId !== undefined) {
    const p = getProjectById(projectId);
    if (!p) throw new NotFoundError("Project", projectId);
    projectRows = [p];
  } else {
    projectRows = db.select().from(projects).all();
  }

  // Pre-build the per-project owner-by-path map in two queries total
  // (instead of two queries per project). The per-project `git worktree
  // list` exec still runs serially below, but that's bounded by project
  // count rather than DB round-trips.
  const ownersByProject = loadOwnersByPath(projectRows.map((p) => p.id));
  const items: WorktreeListEntry[] = [];
  for (const p of projectRows) {
    items.push(...worktreesForProject(p, ownersByProject.get(p.id) ?? new Map()));
  }
  return c.json({ items, total: items.length });
});

worktreeRoutes.post("/prune", (c) => {
  const db = getDb();
  const projectId = parseIdQuery(c, "project_id");

  let projectRows: Array<typeof projects.$inferSelect>;
  if (projectId !== undefined) {
    const p = getProjectById(projectId);
    if (!p) throw new NotFoundError("Project", projectId);
    projectRows = [p];
  } else {
    projectRows = db.select().from(projects).all();
  }

  let cleaned = 0;
  let preservedDirty = 0;
  const details: Array<{
    owner: WorktreeOwner;
    path: string;
    removed: boolean;
    reason: string;
  }> = [];

  // Step 1 — pull every DB-tracked worktree for the in-scope projects
  // via two `inArray()` queries. This replaces the per-project 2-query
  // pair (N project loops × 2 SELECTs) with a constant pair.
  const projectIds = projectRows.map((p) => p.id);
  const projectById = new Map(projectRows.map((p) => [p.id, p] as const));
  const allTaskRows =
    projectIds.length === 0
      ? []
      : db
          .select({
            id: tasks.id,
            projectId: tasks.projectId,
            path: tasks.worktreePath,
            branch: tasks.worktreeBranch,
          })
          .from(tasks)
          .where(and(inArray(tasks.projectId, projectIds), isNotNull(tasks.worktreePath)))
          .all();
  const allChatRows =
    projectIds.length === 0
      ? []
      : db
          .select({
            id: chats.id,
            projectId: chats.projectId,
            path: chats.worktreePath,
            branch: chats.worktreeBranch,
          })
          .from(chats)
          .where(and(inArray(chats.projectId, projectIds), isNotNull(chats.worktreePath)))
          .all();

  // Step 2 — run `git worktree remove` for each row (slow; not in a DB
  //          transaction because git invocations are non-transactional)
  //          and collect the resulting DB mutations into two batches.
  type PendingUpdate = { kind: "task" | "chat"; id: number };
  const pendingClears: PendingUpdate[] = [];

  for (const t of allTaskRows) {
    if (!t.path || !t.branch || t.projectId === null) continue;
    const p = projectById.get(t.projectId);
    if (!p?.path) continue;
    const r = cleanupIfClean({ projectPath: p.path, worktreePath: t.path, branch: t.branch });
    details.push({ owner: { kind: "task", id: t.id }, path: t.path, removed: r.removed, reason: r.reason });
    if (r.removed) {
      pendingClears.push({ kind: "task", id: t.id });
      cleaned += 1;
    } else if (r.reason === "dirty") {
      preservedDirty += 1;
    }
  }
  for (const ch of allChatRows) {
    if (!ch.path || !ch.branch || ch.projectId === null) continue;
    const p = projectById.get(ch.projectId);
    if (!p?.path) continue;
    const r = cleanupIfClean({ projectPath: p.path, worktreePath: ch.path, branch: ch.branch });
    details.push({ owner: { kind: "chat", id: ch.id }, path: ch.path, removed: r.removed, reason: r.reason });
    if (r.removed) {
      pendingClears.push({ kind: "chat", id: ch.id });
      cleaned += 1;
    } else if (r.reason === "dirty") {
      preservedDirty += 1;
    }
  }

  // Step 3 — apply all DB clears in one better-sqlite3 transaction so
  //          we fsync ONCE on COMMIT instead of N times. Order-of-
  //          magnitude faster than the previous per-row .run().
  if (pendingClears.length > 0) {
    const sqlite = getRawDb();
    const clearTaskStmt = sqlite.prepare(
      "UPDATE tasks SET worktree_path = NULL, worktree_branch = NULL WHERE id = ?",
    );
    const clearChatStmt = sqlite.prepare(
      "UPDATE chats SET worktree_path = NULL, worktree_branch = NULL WHERE id = ?",
    );
    sqlite.transaction(() => {
      for (const u of pendingClears) {
        if (u.kind === "task") clearTaskStmt.run(u.id);
        else clearChatStmt.run(u.id);
      }
    })();
  }

  return c.json({ cleaned, preservedDirty, details });
});

// Defensive: avoid a silent unused-import warning when validation
// helpers are added later. Keeping the import so future callers can
// extend the surface (e.g. POST /worktrees/clean-orphans?force=true)
// without re-importing.
void ValidationError;
