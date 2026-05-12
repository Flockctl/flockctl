import { sql, desc } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { workspaces } from "../../db/schema.js";

/**
 * Workspace row as returned by `GET /workspaces`. Mirrors the columns of the
 * `workspaces` table plus an aggregate `active_task_count`: how many tasks
 * across all of the workspace's projects are currently in `status='running'`.
 *
 * The count is computed in a single correlated subquery so listing N
 * workspaces is one round-trip, not N+1 — see `listWorkspacesWithStats`
 * below for the SQL.
 */
export interface WorkspaceListItem {
  id: number;
  name: string;
  description: string | null;
  path: string;
  repoUrl: string | null;
  allowedKeyIds: string | null;
  gitignoreFlockctl: boolean;
  gitignoreTodo: boolean;
  gitignoreAgentsMd: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  active_task_count: number;
}

/**
 * List workspaces with a per-row `active_task_count` aggregate.
 *
 * Why a correlated subquery rather than an outer join + GROUP BY:
 *   - The outer query already paginates over `workspaces`, so the subquery is
 *     evaluated at most `perPage` times per request — bounded work.
 *   - GROUP BY would force every workspace column through the aggregate,
 *     either via SQLite's "first row wins" loose mode or via a wrapping
 *     aggregate function on each column. The subquery shape keeps the
 *     workspace columns identity-mapped and aggregates only the tasks join.
 *
 * Tasks → projects → workspaces is two hops; we walk the path explicitly to
 * avoid leaking through the orphaned-project case (project.workspace_id =
 * NULL after `ON DELETE SET NULL`) — a NULL workspace_id will not match the
 * outer workspace's id under SQL NULL semantics, so orphaned tasks naturally
 * drop out of every workspace's count.
 *
 * Status filter: only `tasks.status = 'running'` counts as "active". Queued,
 * completed, failed, cancelled, and timed-out tasks are excluded — those
 * are not work-in-progress for the dashboard's purposes.
 */
export function listWorkspacesWithStats(
  perPage: number,
  offset: number,
): {
  items: WorkspaceListItem[];
  total: number;
} {
  const db = getDb();

  const items = db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      description: workspaces.description,
      path: workspaces.path,
      repoUrl: workspaces.repoUrl,
      allowedKeyIds: workspaces.allowedKeyIds,
      gitignoreFlockctl: workspaces.gitignoreFlockctl,
      gitignoreTodo: workspaces.gitignoreTodo,
      gitignoreAgentsMd: workspaces.gitignoreAgentsMd,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
      // Raw column names rather than `${tasks}` / `${projects.id}` template
      // references — the latter cause Drizzle to lift the referenced tables
      // into the OUTER FROM clause, which then makes plain `id` ambiguous in
      // the projection. The subquery is fully self-contained, so spelling
      // the names out is both correct and easier to read.
      active_task_count: sql<number>`(
        SELECT COUNT(*)
        FROM tasks
        INNER JOIN projects ON projects.id = tasks.project_id
        WHERE projects.workspace_id = workspaces.id
          AND tasks.status = 'running'
      )`,
    })
    .from(workspaces)
    .orderBy(desc(workspaces.createdAt))
    .limit(perPage)
    .offset(offset)
    .all();

  /* v8 ignore next — SQL count(*) always returns one row, so `?? 0` is unreachable */
  const total = db.select({ count: sql<number>`count(*)` }).from(workspaces).get()?.count ?? 0;

  return { items, total };
}
