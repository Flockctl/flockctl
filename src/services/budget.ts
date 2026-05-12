import { getDb } from "../db/index.js";
import { budgetLimits, usageRecords, projects } from "../db/schema.js";
import { eq, and, gte, sql, inArray, type SQL } from "drizzle-orm";

export interface BudgetCheckResult {
  allowed: boolean;
  exceededLimits: Array<{
    id: number;
    scope: string;
    period: string;
    limitUsd: number;
    spentUsd: number;
    action: string;
  }>;
}

/**
 * Check if a task can run within budget limits.
 *
 * Audit-round-4: the previous shape walked `limits.forEach(getSpentForPeriod)`
 * with each call running 1-2 queries (workspace scope did an extra
 * project-ids lookup). For N active limits that's up to 2N queries per
 * task spawn. We now pre-fetch the workspace → projectIds map ONCE for
 * any workspace-scope limit referenced and pass it into the helper so
 * each iteration runs exactly one SUM query.
 */
export function checkBudget(projectId: number | null): BudgetCheckResult {
  const db = getDb();
  const exceeded: BudgetCheckResult["exceededLimits"] = [];

  const limits = db.select().from(budgetLimits)
    .where(eq(budgetLimits.isActive, true))
    .all();

  // Resolve workspace once to avoid N+1 queries inside the loop
  const projectWorkspaceId = projectId
    ? db.select({ workspaceId: projects.workspaceId }).from(projects).where(eq(projects.id, projectId)).get()?.workspaceId ?? null
    : null;

  // ─── Pre-fetch workspace → projectIds for every workspace-scope limit
  // we'll actually evaluate ───
  //
  // Without this, `getSpentForPeriod` runs a `SELECT projects WHERE
  // workspaceId = ?` query INSIDE the per-limit loop for every
  // workspace-scope limit. Collapse to one `inArray(workspaceIds)`
  // query up front.
  const workspaceLimitIds = new Set<number>();
  for (const limit of limits) {
    if (
      limit.scope === "workspace" &&
      limit.scopeId !== null &&
      projectWorkspaceId === limit.scopeId
    ) {
      workspaceLimitIds.add(limit.scopeId);
    }
  }
  const projectIdsByWorkspace = new Map<number, number[]>();
  if (workspaceLimitIds.size > 0) {
    const rows = db
      .select({ id: projects.id, workspaceId: projects.workspaceId })
      .from(projects)
      .where(inArray(projects.workspaceId, Array.from(workspaceLimitIds)))
      .all();
    for (const r of rows) {
      if (r.workspaceId === null) continue;
      const bucket = projectIdsByWorkspace.get(r.workspaceId);
      if (bucket) bucket.push(r.id);
      else projectIdsByWorkspace.set(r.workspaceId, [r.id]);
    }
  }

  for (const limit of limits) {
    if (limit.scope === "project" && limit.scopeId !== projectId) continue;
    if (limit.scope === "workspace" && projectWorkspaceId !== limit.scopeId) continue;

    const spent = getSpentForPeriod(
      limit.scope,
      limit.scopeId,
      limit.period,
      projectIdsByWorkspace,
    );
    if (spent >= limit.limitUsd) {
      exceeded.push({
        id: limit.id,
        scope: limit.scope,
        period: limit.period,
        limitUsd: limit.limitUsd,
        spentUsd: spent,
        action: limit.action ?? "pause",
      });
    }
  }

  const blocking = exceeded.filter((e) => e.action === "pause");
  return { allowed: blocking.length === 0, exceededLimits: exceeded };
}

function getSpentForPeriod(
  scope: string,
  scopeId: number | null,
  period: string,
  /**
   * Optional pre-fetched workspace → projectIds map. When the caller
   * batched the lookup (`checkBudget` does), the helper skips the
   * per-call SELECT. Falls back to the inline query when omitted
   * (e.g. `getBudgetSummary`).
   */
  projectIdsByWorkspace?: ReadonlyMap<number, number[]>,
): number {
  const db = getDb();
  const dateFrom = getPeriodStart(period);

  // Typed (audit-round-8): the `any[]` here was a maintenance smell —
  // Drizzle's `and(...)` accepts `SQL[]` natively.
  const conditions: SQL[] = [];
  if (dateFrom) conditions.push(gte(usageRecords.createdAt, dateFrom));

  if (scope === "project" && scopeId != null) {
    conditions.push(eq(usageRecords.projectId, scopeId));
  } else if (scope === "workspace" && scopeId != null) {
    const cached = projectIdsByWorkspace?.get(scopeId);
    const projectIds = cached ?? db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.workspaceId, scopeId))
      .all()
      .map((p) => p.id);

    if (projectIds.length === 0) return 0;

    conditions.push(inArray(usageRecords.projectId, projectIds));
  }
  // scope === "global" — no project filter

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const row = db.select({
    total: sql<number>`COALESCE(SUM(${usageRecords.totalCostUsd}), 0)`,
  }).from(usageRecords).where(where).get();

  return row?.total ?? 0;
}

function getPeriodStart(period: string): string | null {
  // Use SQLite's `datetime('now')` format ("YYYY-MM-DD HH:MM:SS", UTC) so
  // string comparisons against stored createdAt values are correct.
  const now = new Date();
  if (period === "daily") {
    return `${now.toISOString().slice(0, 10)} 00:00:00`;
  }
  if (period === "monthly") {
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `${yyyy}-${mm}-01 00:00:00`;
  }
  return null; // "total" — no date filter
}

/**
 * Budget summary with current spend vs limits.
 *
 * Audit-round-N: previously `limits.map(getSpentForPeriod(...))` called the
 * helper without the workspace→projectIds batch — each workspace-scope
 * limit re-ran the `SELECT projects WHERE workspaceId = ?` lookup inline.
 * Same fix as `checkBudget` above: pre-fetch every workspace's project IDs
 * with ONE inArray query, then thread the map through.
 */
export function getBudgetSummary(): Array<{
  id: number;
  scope: string;
  scopeId: number | null;
  period: string;
  limitUsd: number;
  spentUsd: number;
  percentUsed: number;
  action: string;
}> {
  const db = getDb();
  const limits = db.select().from(budgetLimits)
    .where(eq(budgetLimits.isActive, true))
    .all();

  // Pre-fetch workspace→projectIds for every workspace-scope limit. Mirrors
  // checkBudget's batch pass — without this `getSpentForPeriod` fires a
  // `SELECT projects WHERE workspaceId = ?` query per workspace-scope limit
  // on every `/usage/budgets` GET (polled by the dashboard).
  const workspaceLimitIds = new Set<number>();
  for (const limit of limits) {
    if (limit.scope === "workspace" && limit.scopeId !== null) {
      workspaceLimitIds.add(limit.scopeId);
    }
  }
  const projectIdsByWorkspace = new Map<number, number[]>();
  if (workspaceLimitIds.size > 0) {
    const rows = db
      .select({ id: projects.id, workspaceId: projects.workspaceId })
      .from(projects)
      .where(inArray(projects.workspaceId, Array.from(workspaceLimitIds)))
      .all();
    for (const r of rows) {
      if (r.workspaceId === null) continue;
      const bucket = projectIdsByWorkspace.get(r.workspaceId);
      if (bucket) bucket.push(r.id);
      else projectIdsByWorkspace.set(r.workspaceId, [r.id]);
    }
  }

  return limits.map((limit) => {
    const spent = getSpentForPeriod(
      limit.scope,
      limit.scopeId,
      limit.period,
      projectIdsByWorkspace,
    );
    return {
      id: limit.id,
      scope: limit.scope,
      scopeId: limit.scopeId,
      period: limit.period,
      limitUsd: limit.limitUsd,
      spentUsd: Math.round(spent * 1_000_000) / 1_000_000,
      percentUsed: limit.limitUsd > 0 ? Math.round((spent / limit.limitUsd) * 100) : 0,
      action: limit.action ?? "pause",
    };
  });
}
