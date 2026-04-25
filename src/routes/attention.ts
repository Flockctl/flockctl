import { Hono } from "hono";
import { getDb } from "../db/index.js";
import {
  collectAttentionItems,
  type AttentionSessionRegistry,
} from "../services/attention.js";
import { taskExecutor } from "../services/task-executor/index.js";
import { chatExecutor } from "../services/chat-executor.js";

/**
 * Adapter that exposes the in-memory session Maps of TaskExecutor and
 * ChatExecutor through the abstract shape expected by `collectAttentionItems`.
 * Kept as a plain object rather than a class — the aggregator only needs two
 * `Iterable` methods, so there is nothing to construct.
 */
const agentSessionRegistry: AttentionSessionRegistry = {
  activeTaskSessions() {
    return taskExecutor.activeSessions();
  },
  activeChatSessions() {
    return chatExecutor.activeSessions();
  },
};

export const attentionRoutes = new Hono();

// GET /attention — flat list of every blocker currently awaiting the user
// (pending-approval tasks + tool-permission prompts on active task/chat
// sessions). Read-only, no filters — the UI filters client-side.
attentionRoutes.get("/", (c) => {
  const db = getDb();
  const items = collectAttentionItems(db, agentSessionRegistry);
  return c.json({ items, total: items.length });
});
