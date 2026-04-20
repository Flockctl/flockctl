import { getDb } from "../db/index.js";
import { budgetLimits, usageRecords, projects } from "../db/schema.js";
import { eq, and, gte, sql, inArray } from "drizzle-orm";

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

  for (const limit of limits) {
    if (limit.scope === "project" && limit.scopeId !== projectId) continue;
    if (limit.scope === "workspace" && projectWorkspaceId !== limit.scopeId) continue;

    const spent = getSpentForPeriod(limit.scope, limit.scopeId, limit.period);
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

function getSpentForPeriod(scope: string, scopeId: number | null, period: string): number {
  const db = getDb();
  const dateFrom = getPeriodStart(period);

  const conditions: any[] = [];
  if (dateFrom) conditions.push(gte(usageRecords.createdAt, dateFrom));

  if (scope === "project" && scopeId != null) {
    conditions.push(eq(usageRecords.projectId, scopeId));
  } else if (scope === "workspace" && scopeId != null) {
    const projectIds = db.select({ id: projects.id })
      .from(projects)
      .where(eq(projects.workspaceId, scopeId))
      .all()
      .map(p => p.id);

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

  return limits.map((limit) => {
    const spent = getSpentForPeriod(limit.scope, limit.scopeId, limit.period);
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
