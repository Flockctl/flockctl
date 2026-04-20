import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { tasks, usageRecords, chats, chatMessages, schedules, taskTemplates } from "../db/schema.js";
import { sql, and, gte, lte, eq, inArray } from "drizzle-orm";

export const metricsRoutes = new Hono();

function buildDateFilters(c: any, table: { createdAt: any }): any[] {
  const conditions: any[] = [];
  const dateFrom = c.req.query("date_from");
  const dateTo = c.req.query("date_to");
  const period = c.req.query("period");

  if (dateFrom) conditions.push(gte(table.createdAt, dateFrom));
  if (dateTo) conditions.push(lte(table.createdAt, dateTo));

  if (period) {
    const match = period.match(/^(\d+)([dhm])$/);
    if (match) {
      const amount = parseInt(match[1]);
      const unit = match[2];
      const now = new Date();
      if (unit === "d") now.setDate(now.getDate() - amount);
      else if (unit === "h") now.setHours(now.getHours() - amount);
      else if (unit === "m") now.setMonth(now.getMonth() - amount);
      conditions.push(gte(table.createdAt, now.toISOString()));
    }
  }

  return conditions;
}

function getKeyScope(c: any): {
  keyId: number;
  taskIds: number[];
  templateIds: number[];
  chatIds: number[];
} | null {
  const aiProviderKeyId = c.req.query("ai_provider_key_id");
  if (!aiProviderKeyId) return null;
  const keyId = parseInt(aiProviderKeyId);
  const db = getDb();

  const taskRows = db.select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.assignedKeyId, keyId))
    .all();
  const taskIds = taskRows.map(r => r.id);

  const templateRows = db.select({ id: taskTemplates.id })
    .from(taskTemplates)
    .where(eq(taskTemplates.assignedKeyId, keyId))
    .all();
  const templateIds = templateRows.map(r => r.id);

  // Chats whose messages produced any usage record tagged with this key.
  const chatRows = db.select({ chatId: chatMessages.chatId })
    .from(usageRecords)
    .innerJoin(chatMessages, eq(usageRecords.chatMessageId, chatMessages.id))
    .where(eq(usageRecords.aiProviderKeyId, keyId))
    .groupBy(chatMessages.chatId)
    .all();
  const chatIds = chatRows.map(r => r.chatId).filter((id): id is number => id != null);

  return { keyId, taskIds, templateIds, chatIds };
}

// GET /metrics/overview — comprehensive analytics overview
metricsRoutes.get("/overview", (c) => {
  const db = getDb();
  const keyScope = getKeyScope(c);

  const makeInOrEmpty = (column: any, ids: number[]) =>
    ids.length > 0 ? inArray(column, ids) : sql`1 = 0`;

  const taskKeyCondition = keyScope ? makeInOrEmpty(tasks.id, keyScope.taskIds) : null;
  const scheduleKeyCondition = keyScope ? makeInOrEmpty(schedules.templateId, keyScope.templateIds) : null;
  const chatKeyCondition = keyScope ? makeInOrEmpty(chats.id, keyScope.chatIds) : null;
  const usageKeyCondition = keyScope ? eq(usageRecords.aiProviderKeyId, keyScope.keyId) : null;

  const dateConditions = buildDateFilters(c, tasks);
  if (taskKeyCondition) dateConditions.push(taskKeyCondition);
  const dateWhere = dateConditions.length > 0 ? and(...dateConditions) : undefined;

  // --- Time metrics ---

  // Total agent work time (sum of completedAt - startedAt for finished tasks)
  const timeAgg = db.select({
    totalWorkSeconds: sql<number>`COALESCE(SUM(
      CAST((julianday(${tasks.completedAt}) - julianday(${tasks.startedAt})) * 86400 AS REAL)
    ), 0)`,
    avgDurationSeconds: sql<number>`AVG(
      CAST((julianday(${tasks.completedAt}) - julianday(${tasks.startedAt})) * 86400 AS REAL)
    )`,
    medianDurationSeconds: sql<number>`0`,
    avgQueueWaitSeconds: sql<number>`AVG(
      CAST((julianday(${tasks.startedAt}) - julianday(${tasks.createdAt})) * 86400 AS REAL)
    )`,
    taskCount: sql<number>`count(*)`,
  }).from(tasks)
    .where(and(
      ...(dateWhere ? [dateWhere] : []),
      sql`${tasks.startedAt} IS NOT NULL AND ${tasks.completedAt} IS NOT NULL`,
    ))
    .get();

  // Median calculation (SQLite doesn't have native MEDIAN)
  const durationExpr = sql`CAST((julianday(${tasks.completedAt}) - julianday(${tasks.startedAt})) * 86400 AS REAL)`;
  const durations = db.select({
    d: sql<number>`${durationExpr}`,
  }).from(tasks)
    .where(and(
      ...(dateWhere ? [dateWhere] : []),
      sql`${tasks.startedAt} IS NOT NULL AND ${tasks.completedAt} IS NOT NULL`,
    ))
    .orderBy(durationExpr)
    .all();

  let medianDurationSeconds: number | null = null;
  if (durations.length > 0) {
    const mid = Math.floor(durations.length / 2);
    medianDurationSeconds = durations.length % 2 !== 0
      ? durations[mid].d
      : (durations[mid - 1].d + durations[mid].d) / 2;
  }

  // --- Productivity metrics ---

  const taskStatusAgg = db.select({
    status: tasks.status,
    count: sql<number>`count(*)`,
  }).from(tasks)
    .where(dateWhere)
    .groupBy(tasks.status)
    .all();

  const statusCounts: Record<string, number> = {
    total: 0, queued: 0, assigned: 0, running: 0,
    completed: 0, done: 0, failed: 0, timed_out: 0, cancelled: 0,
  };
  for (const row of taskStatusAgg) {
    statusCounts[row.status] = row.count;
    statusCounts.total += row.count;
  }

  const successCount = statusCounts.completed + statusCounts.done;
  const failureCount = statusCounts.failed + statusCounts.timed_out;
  const finishedCount = successCount + failureCount;
  const successRate = finishedCount > 0 ? successCount / finishedCount : null;

  // Retry rate
  const retryAgg = db.select({
    withRetries: sql<number>`SUM(CASE WHEN ${tasks.retryCount} > 0 THEN 1 ELSE 0 END)`,
    total: sql<number>`count(*)`,
  }).from(tasks)
    .where(dateWhere)
    .get();

  const retryRate = (retryAgg?.total ?? 0) > 0
    ? (retryAgg?.withRetries ?? 0) / retryAgg!.total
    : null;

  // Tasks with code changes
  const gitAgg = db.select({
    withCommits: sql<number>`SUM(CASE WHEN ${tasks.gitCommitAfter} IS NOT NULL THEN 1 ELSE 0 END)`,
    total: sql<number>`count(*)`,
  }).from(tasks)
    .where(dateWhere)
    .get();

  // --- Cost metrics ---
  const usageDateConditions = buildDateFilters(c, usageRecords);
  if (usageKeyCondition) usageDateConditions.push(usageKeyCondition);
  const usageDateWhere = usageDateConditions.length > 0 ? and(...usageDateConditions) : undefined;

  const costAgg = db.select({
    totalCostUsd: sql<number>`COALESCE(SUM(${usageRecords.totalCostUsd}), 0)`,
    totalInputTokens: sql<number>`COALESCE(SUM(${usageRecords.inputTokens}), 0)`,
    totalOutputTokens: sql<number>`COALESCE(SUM(${usageRecords.outputTokens}), 0)`,
    totalCacheCreation: sql<number>`COALESCE(SUM(${usageRecords.cacheCreationInputTokens}), 0)`,
    totalCacheRead: sql<number>`COALESCE(SUM(${usageRecords.cacheReadInputTokens}), 0)`,
    recordCount: sql<number>`count(*)`,
  }).from(usageRecords)
    .where(usageDateWhere)
    .get();

  const totalTokens = (costAgg?.totalInputTokens ?? 0) + (costAgg?.totalOutputTokens ?? 0);
  const cacheHitRate = totalTokens > 0
    ? (costAgg?.totalCacheRead ?? 0) / totalTokens
    : null;

  // Average cost per task — aggregate per task, then average in JS
  const costByTask = db.select({
    taskId: usageRecords.taskId,
    taskCost: sql<number>`SUM(${usageRecords.totalCostUsd})`,
  }).from(usageRecords)
    .where(and(
      ...(usageDateWhere ? [usageDateWhere] : []),
      sql`${usageRecords.taskId} IS NOT NULL`,
    ))
    .groupBy(usageRecords.taskId)
    .all();
  const avgCostPerTask = costByTask.length > 0
    ? costByTask.reduce((acc, r) => acc + r.taskCost, 0) / costByTask.length
    : null;

  // Cost per successful vs failed task
  const costByOutcome = db.select({
    status: tasks.status,
    avgCost: sql<number>`AVG(${usageRecords.totalCostUsd})`,
    totalCost: sql<number>`COALESCE(SUM(${usageRecords.totalCostUsd}), 0)`,
    taskCount: sql<number>`count(DISTINCT ${tasks.id})`,
  }).from(usageRecords)
    .innerJoin(tasks, eq(usageRecords.taskId, tasks.id))
    .where(and(
      ...(usageDateWhere ? [usageDateWhere] : []),
      sql`${tasks.status} IN ('completed', 'done', 'failed', 'timed_out')`,
    ))
    .groupBy(sql`CASE WHEN ${tasks.status} IN ('completed', 'done') THEN 'success' ELSE 'failed' END`)
    .all();

  // Burn rate (cost per day over the period)
  const dailyCosts = db.select({
    day: sql<string>`date(${usageRecords.createdAt})`,
    cost: sql<number>`SUM(${usageRecords.totalCostUsd})`,
  }).from(usageRecords)
    .where(usageDateWhere)
    .groupBy(sql`date(${usageRecords.createdAt})`)
    .orderBy(sql`date(${usageRecords.createdAt})`)
    .all();

  const burnRatePerDay = dailyCosts.length > 0
    ? (costAgg?.totalCostUsd ?? 0) / dailyCosts.length
    : null;

  // --- Chat metrics ---
  const chatDateConditions = buildDateFilters(c, chats);
  if (chatKeyCondition) chatDateConditions.push(chatKeyCondition);
  const chatDateWhere = chatDateConditions.length > 0 ? and(...chatDateConditions) : undefined;

  const chatAgg = db.select({
    totalChats: sql<number>`count(*)`,
  }).from(chats)
    .where(chatDateWhere)
    .get();

  const chatMsgCounts = db.select({
    chatId: chatMessages.chatId,
    msgCount: sql<number>`COUNT(*)`,
  }).from(chatMessages)
    .innerJoin(chats, eq(chatMessages.chatId, chats.id))
    .where(chatDateWhere)
    .groupBy(chatMessages.chatId)
    .all();
  const avgMessagesPerChat = chatMsgCounts.length > 0
    ? chatMsgCounts.reduce((acc, r) => acc + r.msgCount, 0) / chatMsgCounts.length
    : null;

  // Chat duration (time from first to last message)
  const chatDurations = db.select({
    chatId: chatMessages.chatId,
    durationSec: sql<number>`CAST((julianday(MAX(${chatMessages.createdAt})) - julianday(MIN(${chatMessages.createdAt}))) * 86400 AS REAL)`,
    msgCount: sql<number>`COUNT(*)`,
  }).from(chatMessages)
    .innerJoin(chats, eq(chatMessages.chatId, chats.id))
    .where(chatDateWhere)
    .groupBy(chatMessages.chatId)
    .all()
    .filter(r => r.msgCount > 1 && r.durationSec > 0);

  const avgChatDurationSeconds = chatDurations.length > 0
    ? chatDurations.reduce((acc, r) => acc + r.durationSec, 0) / chatDurations.length
    : null;
  const totalChatTimeSeconds = chatDurations.reduce((acc, r) => acc + r.durationSec, 0);

  // --- Schedule metrics ---
  const scheduleAgg = db.select({
    totalSchedules: sql<number>`count(*)`,
    activeSchedules: sql<number>`SUM(CASE WHEN ${schedules.status} = 'active' THEN 1 ELSE 0 END)`,
    pausedSchedules: sql<number>`SUM(CASE WHEN ${schedules.status} = 'paused' THEN 1 ELSE 0 END)`,
  }).from(schedules)
    .where(scheduleKeyCondition ?? undefined)
    .get();

  // --- Peak hours (tasks by hour of day) ---
  const peakHours = db.select({
    hour: sql<number>`CAST(strftime('%H', ${tasks.createdAt}) AS INTEGER)`,
    count: sql<number>`count(*)`,
  }).from(tasks)
    .where(dateWhere)
    .groupBy(sql`strftime('%H', ${tasks.createdAt})`)
    .orderBy(sql`strftime('%H', ${tasks.createdAt})`)
    .all();

  // --- Tasks per day (throughput) ---
  const tasksPerDay = db.select({
    day: sql<string>`date(${tasks.completedAt})`,
    count: sql<number>`count(*)`,
  }).from(tasks)
    .where(and(
      ...(dateWhere ? [dateWhere] : []),
      sql`${tasks.completedAt} IS NOT NULL`,
    ))
    .groupBy(sql`date(${tasks.completedAt})`)
    .orderBy(sql`date(${tasks.completedAt})`)
    .all();

  const avgTasksPerDay = tasksPerDay.length > 0
    ? tasksPerDay.reduce((acc, r) => acc + r.count, 0) / tasksPerDay.length
    : null;

  return c.json({
    time: {
      totalWorkSeconds: timeAgg?.totalWorkSeconds ?? 0,
      avgDurationSeconds: timeAgg?.avgDurationSeconds ?? null,
      medianDurationSeconds,
      avgQueueWaitSeconds: timeAgg?.avgQueueWaitSeconds ?? null,
      peakHours,
    },
    productivity: {
      tasksByStatus: statusCounts,
      successRate,
      retryRate,
      tasksWithCodeChanges: gitAgg?.withCommits ?? 0,
      codeChangeRate: (gitAgg?.total ?? 0) > 0 ? (gitAgg?.withCommits ?? 0) / gitAgg!.total : null,
      avgTasksPerDay,
      tasksPerDay,
    },
    cost: {
      totalCostUsd: costAgg?.totalCostUsd ?? 0,
      totalInputTokens: costAgg?.totalInputTokens ?? 0,
      totalOutputTokens: costAgg?.totalOutputTokens ?? 0,
      totalCacheCreation: costAgg?.totalCacheCreation ?? 0,
      totalCacheRead: costAgg?.totalCacheRead ?? 0,
      cacheHitRate,
      avgCostPerTask,
      costByOutcome: costByOutcome.map(r => ({
        outcome: r.status,
        avgCost: r.avgCost,
        totalCost: r.totalCost,
        taskCount: r.taskCount,
      })),
      burnRatePerDay,
      dailyCosts,
    },
    chats: {
      totalChats: chatAgg?.totalChats ?? 0,
      avgMessagesPerChat,
      avgChatDurationSeconds,
      totalChatTimeSeconds,
    },
    schedules: {
      total: scheduleAgg?.totalSchedules ?? 0,
      active: scheduleAgg?.activeSchedules ?? 0,
      paused: scheduleAgg?.pausedSchedules ?? 0,
    },
  });
});
