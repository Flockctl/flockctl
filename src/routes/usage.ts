import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { usageRecords, projects, budgetLimits, chatMessages, chats, workspaces } from "../db/schema.js";
import { eq, and, sql, desc, gte, lte, inArray } from "drizzle-orm";
import { paginationParams } from "../lib/pagination.js";
import { getBudgetSummary } from "../services/budget.js";
import { BudgetScope, BudgetPeriod, BudgetAction } from "../lib/types.js";
import { ValidationError, NotFoundError } from "../lib/errors.js";

export const usageRoutes = new Hono();

// GET /usage/summary — aggregated tokens and cost
usageRoutes.get("/summary", (c) => {
  const db = getDb();
  const conditions = buildFilters(c);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const agg = db.select({
    totalInputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)`,
    totalOutputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)`,
    totalCacheCreationTokens: sql<number>`COALESCE(SUM(${usageRecords.cacheCreationInputTokens}), 0)`,
    totalCacheReadTokens: sql<number>`COALESCE(SUM(${usageRecords.cacheReadInputTokens}), 0)`,
    totalCostUsd: sql<number>`COALESCE(SUM(${usageRecords.totalCostUsd}), 0)`,
    recordCount: sql<number>`count(*)`,
  }).from(usageRecords).where(where).get();

  // By provider
  const byProvider = db.select({
    provider: usageRecords.provider,
    tokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}) + SUM(${usageRecords.outputTokens}), 0)`,
    costUsd: sql<number>`COALESCE(SUM(${usageRecords.totalCostUsd}), 0)`,
  }).from(usageRecords).where(where).groupBy(usageRecords.provider).all();

  // By model
  const byModel = db.select({
    model: usageRecords.model,
    tokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}) + SUM(${usageRecords.outputTokens}), 0)`,
    costUsd: sql<number>`COALESCE(SUM(${usageRecords.totalCostUsd}), 0)`,
  }).from(usageRecords).where(where).groupBy(usageRecords.model).all();

  const byProviderMap: Record<string, { tokens: number; costUsd: number }> = {};
  for (const p of byProvider) {
    byProviderMap[p.provider] = { tokens: p.tokens, costUsd: p.costUsd };
  }

  const byModelMap: Record<string, { tokens: number; costUsd: number }> = {};
  for (const m of byModel) {
    byModelMap[m.model] = { tokens: m.tokens, costUsd: m.costUsd };
  }

  return c.json({
    ...agg,
    byProvider: byProviderMap,
    byModel: byModelMap,
  });
});

// GET /usage/breakdown — paginated records with grouping
usageRoutes.get("/breakdown", (c) => {
  const db = getDb();
  const { page, perPage, offset } = paginationParams(c);
  const conditions = buildFilters(c);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const groupBy = c.req.query("group_by"); // provider | model | project | day

  // Helper to build totals for breakdown responses
  const buildTotals = () => db.select({
    totalInputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)`,
    totalOutputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)`,
    totalCostUsd: sql<number>`COALESCE(SUM(${usageRecords.totalCostUsd}), 0)`,
    totalRecordCount: sql<number>`count(*)`,
  }).from(usageRecords).where(where).get();

  if (groupBy === "provider") {
    const items = db.select({
      scopeId: usageRecords.provider,
      scopeLabel: usageRecords.provider,
      inputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)`,
      costUsd: sql<number>`COALESCE(SUM(${usageRecords.totalCostUsd}), 0)`,
      recordCount: sql<number>`count(*)`,
    }).from(usageRecords).where(where).groupBy(usageRecords.provider).limit(perPage).offset(offset).all();
    return c.json({ ...buildTotals(), items, page, perPage });
  }

  if (groupBy === "model") {
    const items = db.select({
      scopeId: usageRecords.model,
      scopeLabel: usageRecords.model,
      inputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)`,
      costUsd: sql<number>`COALESCE(SUM(${usageRecords.totalCostUsd}), 0)`,
      recordCount: sql<number>`count(*)`,
    }).from(usageRecords).where(where).groupBy(usageRecords.model).limit(perPage).offset(offset).all();
    return c.json({ ...buildTotals(), items, page, perPage });
  }

  if (groupBy === "project") {
    // Build a scope label that distinguishes:
    // 1. Active project → project name
    // 2. Deleted project (projectId set but no matching row) → "Deleted project #N"
    // 3. Chat with workspace (no project) → workspace name
    // 4. Orphan records (no project, no resolvable workspace) → "Other chats"
    const scopeIdExpr = sql<string>`CASE
      WHEN ${usageRecords.projectId} IS NOT NULL THEN CAST(${usageRecords.projectId} AS TEXT)
      WHEN ${chats.workspaceId} IS NOT NULL THEN 'ws_' || CAST(${chats.workspaceId} AS TEXT)
      ELSE 'other'
    END`;
    const scopeLabelExpr = sql<string>`CASE
      WHEN ${usageRecords.projectId} IS NOT NULL AND ${projects.name} IS NOT NULL THEN ${projects.name}
      WHEN ${usageRecords.projectId} IS NOT NULL THEN 'Deleted project #' || ${usageRecords.projectId}
      WHEN ${workspaces.name} IS NOT NULL THEN ${workspaces.name}
      ELSE 'Other chats'
    END`;
    const items = db.select({
      scopeId: scopeIdExpr,
      scopeLabel: scopeLabelExpr,
      inputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)`,
      costUsd: sql<number>`COALESCE(SUM(${usageRecords.totalCostUsd}), 0)`,
      recordCount: sql<number>`count(*)`,
    }).from(usageRecords)
      .leftJoin(projects, eq(usageRecords.projectId, projects.id))
      .leftJoin(chatMessages, eq(usageRecords.chatMessageId, chatMessages.id))
      .leftJoin(chats, eq(chatMessages.chatId, chats.id))
      .leftJoin(workspaces, eq(chats.workspaceId, workspaces.id))
      .where(where)
      .groupBy(scopeIdExpr)
      .limit(perPage).offset(offset).all();
    return c.json({ ...buildTotals(), items, page, perPage });
  }

  if (groupBy === "day") {
    const items = db.select({
      scopeId: sql<string>`date(${usageRecords.createdAt})`,
      scopeLabel: sql<string>`date(${usageRecords.createdAt})`,
      inputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)`,
      costUsd: sql<number>`COALESCE(SUM(${usageRecords.totalCostUsd}), 0)`,
      recordCount: sql<number>`count(*)`,
    }).from(usageRecords).where(where)
      .groupBy(sql`date(${usageRecords.createdAt})`)
      .orderBy(sql`date(${usageRecords.createdAt})`)
      .limit(perPage).offset(offset).all();
    return c.json({ ...buildTotals(), items, page, perPage });
  }

  // Default: individual records
  const items = db.select().from(usageRecords).where(where).orderBy(desc(usageRecords.createdAt)).limit(perPage).offset(offset).all();
  const total = db.select({ count: sql<number>`count(*)` }).from(usageRecords).where(where).get()?.count ?? 0;

  return c.json({ items, total, page, perPage });
});

function buildFilters(c: any): any[] {
  const db = getDb();
  const conditions: any[] = [];
  const projectId = c.req.query("project_id");
  const taskId = c.req.query("task_id");
  const chatId = c.req.query("chat_id");
  const provider = c.req.query("provider");
  const model = c.req.query("model");
  const dateFrom = c.req.query("date_from");
  const dateTo = c.req.query("date_to");
  const period = c.req.query("period");
  const workspaceId = c.req.query("workspace_id");
  const aiProviderKeyId = c.req.query("ai_provider_key_id");

  if (projectId) conditions.push(eq(usageRecords.projectId, parseInt(projectId)));
  if (taskId) conditions.push(eq(usageRecords.taskId, parseInt(taskId)));
  if (chatId) conditions.push(eq(usageRecords.chatMessageId, parseInt(chatId)));
  if (provider) conditions.push(eq(usageRecords.provider, provider));
  if (model) conditions.push(eq(usageRecords.model, model));
  if (dateFrom) conditions.push(gte(usageRecords.createdAt, dateFrom));
  if (dateTo) conditions.push(lte(usageRecords.createdAt, dateTo));

  if (aiProviderKeyId) {
    conditions.push(eq(usageRecords.aiProviderKeyId, parseInt(aiProviderKeyId)));
  }

  // Period shorthand: "30d", "7d", "90d" etc.
  if (period) {
    const match = period.match(/^(\d+)([dhm])$/);
    if (match) {
      const amount = parseInt(match[1]);
      const unit = match[2];
      const now = new Date();
      if (unit === "d") now.setDate(now.getDate() - amount);
      else if (unit === "h") now.setHours(now.getHours() - amount);
      else if (unit === "m") now.setMonth(now.getMonth() - amount);
      conditions.push(gte(usageRecords.createdAt, now.toISOString()));
    }
  }

  // Workspace filter: find all project IDs in the workspace
  if (workspaceId) {
    const wsProjects = db.select({ id: projects.id })
      .from(projects)
      .where(eq(projects.workspaceId, parseInt(workspaceId)))
      .all();
    const projectIds = wsProjects.map(p => p.id);
    if (projectIds.length > 0) {
      conditions.push(inArray(usageRecords.projectId, projectIds));
    } else {
      // No projects in workspace — return nothing
      conditions.push(sql`1 = 0`);
    }
  }

  return conditions;
}

// ─── Budget Limits ───

// GET /usage/budgets — list all limits with current spend
usageRoutes.get("/budgets", (c) => {
  return c.json(getBudgetSummary());
});

// POST /usage/budgets — create a budget limit
usageRoutes.post("/budgets", async (c) => {
  const body = await c.req.json();
  const { scope, scopeId, period, limitUsd, action } = body;

  const validScopes = Object.values(BudgetScope);
  const validPeriods = Object.values(BudgetPeriod);
  const validActions = Object.values(BudgetAction);

  if (!validScopes.includes(scope)) {
    throw new ValidationError(`Invalid scope: must be ${validScopes.join(", ")}`);
  }
  if (!validPeriods.includes(period)) {
    throw new ValidationError(`Invalid period: must be ${validPeriods.join(", ")}`);
  }
  if (typeof limitUsd !== "number" || limitUsd <= 0) {
    throw new ValidationError("limitUsd must be a positive number");
  }
  if (action !== undefined && !validActions.includes(action)) {
    throw new ValidationError(`Invalid action: must be ${validActions.join(", ")}`);
  }

  const db = getDb();
  const result = db.insert(budgetLimits).values({
    scope,
    scopeId: scopeId ?? null,
    period,
    limitUsd,
    action: action ?? BudgetAction.PAUSE,
  }).returning().get();

  return c.json(result, 201);
});

// PATCH /usage/budgets/:id — update a budget limit
usageRoutes.patch("/budgets/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json();
  const db = getDb();

  const existing = db.select().from(budgetLimits).where(eq(budgetLimits.id, id)).get();
  if (!existing) throw new NotFoundError("Budget limit");

  if (body.action !== undefined && !Object.values(BudgetAction).includes(body.action)) {
    throw new ValidationError(`Invalid action: must be ${Object.values(BudgetAction).join(", ")}`);
  }

  const updates: { updatedAt: string; limitUsd?: number; action?: string; isActive?: boolean } = {
    updatedAt: new Date().toISOString(),
  };
  if (body.limitUsd !== undefined) updates.limitUsd = body.limitUsd;
  if (body.action !== undefined) updates.action = body.action;
  if (body.isActive !== undefined) updates.isActive = body.isActive;

  db.update(budgetLimits).set(updates).where(eq(budgetLimits.id, id)).run();
  return c.json({ ok: true });
});

// DELETE /usage/budgets/:id — remove a budget limit
usageRoutes.delete("/budgets/:id", (c) => {
  const id = parseInt(c.req.param("id"));
  const db = getDb();
  const existing = db.select().from(budgetLimits).where(eq(budgetLimits.id, id)).get();
  if (!existing) throw new NotFoundError("Budget limit");
  db.delete(budgetLimits).where(eq(budgetLimits.id, id)).run();
  return c.json({ ok: true });
});
