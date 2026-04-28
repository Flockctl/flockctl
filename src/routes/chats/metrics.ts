import type { Hono } from "hono";
import { getDb } from "../../db/index.js";
import { chatMessages, usageRecords } from "../../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { parseIdParam } from "../../lib/route-params.js";
import { getChatMetrics } from "./helpers.js";
import { getChatOrThrow } from "../../lib/db-helpers.js";

export function registerChatMetrics(router: Hono): void {
  // GET /chats/:id/metrics — full usage metrics for a single chat
  router.get("/:id/metrics", (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const chat = getChatOrThrow(id);

    const base = getChatMetrics(db, id);

    // Full metrics: also include cache tokens and models used
    const cacheUsage = db.select({
      totalCacheCreationTokens: sql<number>`COALESCE(SUM(${usageRecords.cacheCreationInputTokens}), 0)`,
      totalCacheReadTokens: sql<number>`COALESCE(SUM(${usageRecords.cacheReadInputTokens}), 0)`,
    }).from(usageRecords)
      .innerJoin(chatMessages, eq(usageRecords.chatMessageId, chatMessages.id))
      .where(eq(chatMessages.chatId, id))
      .get();

    const modelsUsed = db.selectDistinct({ model: usageRecords.model })
      .from(usageRecords)
      .innerJoin(chatMessages, eq(usageRecords.chatMessageId, chatMessages.id))
      .where(eq(chatMessages.chatId, id))
      .all()
      .map(r => r.model);

    return c.json({
      chatId: id,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      ...base,
      totalCacheCreationTokens: cacheUsage?.totalCacheCreationTokens ?? 0,
      totalCacheReadTokens: cacheUsage?.totalCacheReadTokens ?? 0,
      modelsUsed,
    });
  });
}
