import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import {
  tasks,
  usageRecords,
  chats,
  chatMessages,
  schedules,
  aiProviderKeys,
} from "../../db/schema.js";
import Database from "better-sqlite3";

let db: FlockctlDb;
let sqlite: Database.Database;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
});

afterAll(() => {
  sqlite.close();
});

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM schedules;
    DELETE FROM chat_messages;
    DELETE FROM chats;
    DELETE FROM usage_records;
    DELETE FROM task_logs;
    DELETE FROM tasks;
    DELETE FROM ai_provider_keys;
  `);
});

describe("GET /metrics/overview — branch coverage", () => {
  // ─── buildDateFilters — invalid/edge period ───
  it("ignores period with unrecognized unit letter", async () => {
    db.insert(tasks).values({ status: "completed" } as any).run();
    const res = await app.request("/metrics/overview?period=5x");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.productivity.tasksByStatus.total).toBe(1);
  });

  // Covers the `unit === "m"` (months) branch in buildDateFilters.
  it("accepts period with month unit", async () => {
    db.insert(tasks).values({ status: "completed" } as any).run();
    const res = await app.request("/metrics/overview?period=3m");
    expect(res.status).toBe(200);
  });

  // Covers the `unit === "h"` (hours) branch in buildDateFilters.
  it("accepts period with hour unit", async () => {
    db.insert(tasks).values({ status: "completed" } as any).run();
    const res = await app.request("/metrics/overview?period=2h");
    expect(res.status).toBe(200);
  });

  // Covers `unit === "d"` (days) branch in buildDateFilters.
  it("accepts period with day unit", async () => {
    db.insert(tasks).values({ status: "completed" } as any).run();
    const res = await app.request("/metrics/overview?period=7d");
    expect(res.status).toBe(200);
  });

  it("accepts date_from only", async () => {
    db.insert(tasks).values({ status: "completed", createdAt: "2025-06-01T00:00:00.000Z" } as any).run();
    const res = await app.request("/metrics/overview?date_from=2025-01-01");
    expect(res.status).toBe(200);
  });

  it("accepts date_to only", async () => {
    db.insert(tasks).values({ status: "completed", createdAt: "2025-01-01T00:00:00.000Z" } as any).run();
    const res = await app.request("/metrics/overview?date_to=2025-12-31");
    expect(res.status).toBe(200);
  });

  // ─── median branches ───
  it("median over an EVEN number of durations averages the middle pair", async () => {
    // 4 tasks → len even → mid=2, averages [1] and [2]
    db.insert(tasks).values([
      { status: "completed", startedAt: "2025-01-01T10:00:00.000Z", completedAt: "2025-01-01T10:00:10.000Z" },
      { status: "completed", startedAt: "2025-01-01T10:00:00.000Z", completedAt: "2025-01-01T10:00:20.000Z" },
      { status: "completed", startedAt: "2025-01-01T10:00:00.000Z", completedAt: "2025-01-01T10:00:30.000Z" },
      { status: "completed", startedAt: "2025-01-01T10:00:00.000Z", completedAt: "2025-01-01T10:00:40.000Z" },
    ] as any).run();
    const res = await app.request("/metrics/overview");
    const body = await res.json();
    // median = avg(20, 30) = 25
    expect(body.time.medianDurationSeconds).toBeCloseTo(25, 0);
  });

  it("median of odd-length series returns middle value", async () => {
    db.insert(tasks).values([
      { status: "completed", startedAt: "2025-01-01T10:00:00.000Z", completedAt: "2025-01-01T10:00:10.000Z" },
      { status: "completed", startedAt: "2025-01-01T10:00:00.000Z", completedAt: "2025-01-01T10:00:20.000Z" },
      { status: "completed", startedAt: "2025-01-01T10:00:00.000Z", completedAt: "2025-01-01T10:00:30.000Z" },
    ] as any).run();
    const res = await app.request("/metrics/overview");
    const body = await res.json();
    expect(body.time.medianDurationSeconds).toBeCloseTo(20, 0);
  });

  // ─── key-scope with empty taskIds / chatIds list ───
  it("key-scope with matching task but no chat — chatIds empty → 1=0 path", async () => {
    const key = db
      .insert(aiProviderKeys)
      .values({ provider: "a", providerType: "api", label: "k", priority: 1 } as any)
      .returning()
      .get()!;
    const t1 = db.insert(tasks).values({ status: "completed", assignedKeyId: key.id } as any).returning().get()!;
    // usage record tied to task but NOT to any chatMessage — chatIds is empty.
    db.insert(usageRecords).values({
      taskId: t1.id, provider: "a", model: "m", aiProviderKeyId: key.id, totalCostUsd: 1,
    } as any).run();
    const res = await app.request(`/metrics/overview?ai_provider_key_id=${key.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chats.totalChats).toBe(0);
  });

  it("key-scope with nullable chatMessage.chatId is filtered out", async () => {
    const key = db
      .insert(aiProviderKeys)
      .values({ provider: "a", providerType: "api", label: "k" } as any)
      .returning()
      .get()!;
    // insert a chatMessages row with NULL chatId is not possible (FK), skip.
    // Instead insert a usage record WITHOUT chatMessageId — it won't join.
    db.insert(usageRecords).values({
      provider: "a", model: "m", aiProviderKeyId: key.id, totalCostUsd: 0.5,
    } as any).run();
    const res = await app.request(`/metrics/overview?ai_provider_key_id=${key.id}`);
    expect(res.status).toBe(200);
  });

  // ─── status outside known set ───
  it("ignores status values outside the tracked set", async () => {
    db.insert(tasks).values([
      { status: "completed" },
      { status: "weird_status" },
    ] as any).run();
    const res = await app.request("/metrics/overview");
    const body = await res.json();
    // total tracks all rows
    expect(body.productivity.tasksByStatus.total).toBe(2);
    expect(body.productivity.tasksByStatus.completed).toBe(1);
  });

  // ─── successRate null when nothing finished ───
  it("successRate stays null when only queued tasks exist", async () => {
    db.insert(tasks).values({ status: "queued" } as any).run();
    const res = await app.request("/metrics/overview");
    const body = await res.json();
    expect(body.productivity.successRate).toBeNull();
    expect(body.productivity.effectiveSuccessRate).toBeNull();
  });

  // ─── retryRate null when total=0 ───
  it("retryRate null when no tasks exist", async () => {
    const res = await app.request("/metrics/overview");
    const body = await res.json();
    expect(body.productivity.retryRate).toBeNull();
  });

  // ─── gitAgg total=0 branch ───
  it("codeChangeRate null when no tasks", async () => {
    const res = await app.request("/metrics/overview");
    const body = await res.json();
    expect(body.productivity.codeChangeRate).toBeNull();
  });

  // ─── cacheHitRate null branch ───
  it("cacheHitRate null when totalTokens=0", async () => {
    db.insert(usageRecords).values({
      provider: "a", model: "m", totalCostUsd: 0, inputTokens: 0, outputTokens: 0,
    } as any).run();
    const res = await app.request("/metrics/overview");
    const body = await res.json();
    expect(body.cost.cacheHitRate).toBeNull();
  });

  // ─── avgCostPerTask null when no task-tagged usage ───
  it("avgCostPerTask null when usage rows have no taskId", async () => {
    db.insert(usageRecords).values({
      provider: "a", model: "m", totalCostUsd: 1, inputTokens: 5, outputTokens: 5,
    } as any).run();
    const res = await app.request("/metrics/overview");
    const body = await res.json();
    expect(body.cost.avgCostPerTask).toBeNull();
  });

  // ─── burnRatePerDay null when no daily costs ───
  it("burnRatePerDay null when no usage records", async () => {
    const res = await app.request("/metrics/overview");
    const body = await res.json();
    expect(body.cost.burnRatePerDay).toBeNull();
  });

  // ─── chat metrics — avgMessagesPerChat null when no messages ───
  it("avgMessagesPerChat null when no chat messages", async () => {
    db.insert(chats).values({ title: "empty chat" } as any).run();
    const res = await app.request("/metrics/overview");
    const body = await res.json();
    expect(body.chats.totalChats).toBe(1);
    expect(body.chats.avgMessagesPerChat).toBeNull();
  });

  // ─── chat durations filtered to msgCount>1 & >0s ───
  it("avgChatDurationSeconds null when chats have only one message", async () => {
    const c1 = db.insert(chats).values({ title: "one" } as any).returning().get()!;
    db.insert(chatMessages).values({
      chatId: c1.id, role: "user", content: "only", createdAt: "2025-01-01T00:00:00Z",
    } as any).run();
    const res = await app.request("/metrics/overview");
    const body = await res.json();
    expect(body.chats.avgChatDurationSeconds).toBeNull();
  });

  it("avgChatDurationSeconds null when duration is zero (same timestamps)", async () => {
    const c1 = db.insert(chats).values({ title: "zero-dur" } as any).returning().get()!;
    const ts = "2025-01-01T00:00:00.000Z";
    db.insert(chatMessages).values([
      { chatId: c1.id, role: "user", content: "a", createdAt: ts },
      { chatId: c1.id, role: "assistant", content: "b", createdAt: ts },
    ] as any).run();
    const res = await app.request("/metrics/overview");
    const body = await res.json();
    expect(body.chats.avgChatDurationSeconds).toBeNull();
  });

  // ─── avgTasksPerDay null when no completed tasks ───
  it("avgTasksPerDay null when no completed tasks", async () => {
    db.insert(tasks).values({ status: "queued" } as any).run();
    const res = await app.request("/metrics/overview");
    const body = await res.json();
    expect(body.productivity.avgTasksPerDay).toBeNull();
  });

  // ─── schedules — empty ───
  it("schedule counts zero when no schedules", async () => {
    const res = await app.request("/metrics/overview");
    const body = await res.json();
    expect(body.schedules.total).toBe(0);
    expect(body.schedules.active).toBe(0);
    expect(body.schedules.paused).toBe(0);
  });

  // ─── dateFrom + period combined — both conditions stack ───
  it("combines date_from with period", async () => {
    const now = new Date();
    const recent = now.toISOString();
    db.insert(tasks).values([
      { status: "completed", createdAt: "2020-01-01T00:00:00.000Z" },
      { status: "completed", createdAt: recent },
    ] as any).run();
    const res = await app.request("/metrics/overview?date_from=2020-01-01&period=1d");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.productivity.tasksByStatus.total).toBe(1);
  });
});
