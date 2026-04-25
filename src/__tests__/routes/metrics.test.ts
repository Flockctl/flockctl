import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import {
  tasks, usageRecords, chats, chatMessages, schedules, aiProviderKeys,
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

describe("GET /metrics/overview", () => {
  it("returns zero metrics on empty DB", async () => {
    const res = await app.request("/metrics/overview");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.time).toBeDefined();
    expect(body.time.totalWorkSeconds).toBe(0);
    expect(body.time.avgDurationSeconds).toBeNull();
    expect(body.time.medianDurationSeconds).toBeNull();
    expect(Array.isArray(body.time.peakHours)).toBe(true);

    expect(body.productivity).toBeDefined();
    expect(body.productivity.tasksByStatus.total).toBe(0);
    expect(body.productivity.successRate).toBeNull();
    expect(body.productivity.effectiveSuccessRate).toBeNull();
    expect(body.productivity.buildAfterRerun).toBe(0);
    expect(body.productivity.supersededFailures).toBe(0);
    expect(body.productivity.retryRate).toBeNull();
    expect(body.productivity.codeChangeRate).toBeNull();

    expect(body.cost).toBeDefined();
    expect(body.cost.totalCostUsd).toBe(0);
    expect(body.cost.totalInputTokens).toBe(0);
    expect(body.cost.cacheHitRate).toBeNull();
    expect(body.cost.avgCostPerTask).toBeNull();
    expect(Array.isArray(body.cost.dailyCosts)).toBe(true);

    expect(body.chats.totalChats).toBe(0);
    expect(body.schedules.total).toBe(0);
  });

  it("computes time metrics from completed tasks", async () => {
    // Two tasks: durations 10s and 20s
    db.insert(tasks).values([
      { status: "completed", createdAt: "2025-01-01T10:00:00.000Z", startedAt: "2025-01-01T10:00:05.000Z", completedAt: "2025-01-01T10:00:15.000Z" },
      { status: "done", createdAt: "2025-01-01T11:00:00.000Z", startedAt: "2025-01-01T11:00:10.000Z", completedAt: "2025-01-01T11:00:30.000Z" },
    ] as any).run();

    const res = await app.request("/metrics/overview");
    const body = await res.json();

    expect(body.time.totalWorkSeconds).toBeGreaterThan(25);
    expect(body.time.totalWorkSeconds).toBeLessThan(35);
    expect(body.time.avgDurationSeconds).toBeCloseTo(15, 0);
    expect(body.time.medianDurationSeconds).toBeGreaterThan(0);
  });

  it("computes success rate, retry rate, code changes", async () => {
    db.insert(tasks).values([
      { status: "completed", retryCount: 0, gitCommitAfter: "abc123" },
      { status: "completed", retryCount: 1, gitCommitAfter: null },
      { status: "failed", retryCount: 2, gitCommitAfter: null },
      { status: "done", retryCount: 0, gitCommitAfter: "def456" },
    ] as any).run();

    const res = await app.request("/metrics/overview");
    const body = await res.json();

    expect(body.productivity.tasksByStatus.total).toBe(4);
    expect(body.productivity.tasksByStatus.completed).toBe(2);
    expect(body.productivity.tasksByStatus.done).toBe(1);
    expect(body.productivity.tasksByStatus.failed).toBe(1);
    // 3 success out of 4 finished => 0.75
    expect(body.productivity.successRate).toBeCloseTo(0.75, 2);
    // 2 with retries out of 4
    expect(body.productivity.retryRate).toBeCloseTo(0.5, 2);
    // 2 with gitCommit out of 4
    expect(body.productivity.codeChangeRate).toBeCloseTo(0.5, 2);
    expect(body.productivity.tasksWithCodeChanges).toBe(2);
  });

  it("counts build-after-rerun and superseded-failure metrics", async () => {
    // f1 → rescued by a successful rerun (`done`)     — bumps buildAfterRerun + supersededFailures
    // f2 → rescued by `completed` rerun via timed_out  — bumps buildAfterRerun + supersededFailures
    // f3 → dead failure, never re-run                  — just a plain failure
    // f4 → still-running rerun                         — NOT superseded yet
    const f1 = db.insert(tasks).values({ status: "failed" } as any).returning().get()!;
    const f2 = db.insert(tasks).values({ status: "timed_out" } as any).returning().get()!;
    db.insert(tasks).values({ status: "failed" } as any).run();
    const f4 = db.insert(tasks).values({ status: "failed" } as any).returning().get()!;
    db.insert(tasks).values({ status: "done", parentTaskId: f1.id } as any).run();
    db.insert(tasks).values({ status: "completed", parentTaskId: f2.id } as any).run();
    db.insert(tasks).values({ status: "running", parentTaskId: f4.id } as any).run();

    const res = await app.request("/metrics/overview");
    const body = await res.json();

    expect(body.productivity.buildAfterRerun).toBe(2);
    expect(body.productivity.supersededFailures).toBe(2);
    // 2 original successes folded with 2 superseded failures = 4 effective
    // successes out of 5 finished tasks (f1, f2, f3, f4 + 2 successful reruns
    // = 6 terminal, minus f4's rerun which is still running = but that's not
    // in finishedCount). finishedCount = done(2) + completed(0) + failed(3) +
    // timed_out(1) = 6. (done counts: reruns of f1/f2 + nothing else = 2).
    // effectiveSuccessRate = (2 success + 2 superseded) / 6 = 0.6666…
    expect(body.productivity.effectiveSuccessRate).toBeGreaterThan(body.productivity.successRate);
  });

  it("computes cost metrics and cache hit rate", async () => {
    const t1 = db.insert(tasks).values({ status: "completed" } as any).returning().get()!;
    db.insert(usageRecords).values([
      { taskId: t1.id, provider: "anthropic", model: "x", inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 10, cacheReadInputTokens: 50, totalCostUsd: 0.5 },
      { taskId: t1.id, provider: "anthropic", model: "x", inputTokens: 50, outputTokens: 50, cacheReadInputTokens: 50, totalCostUsd: 0.3 },
    ] as any).run();

    const res = await app.request("/metrics/overview");
    const body = await res.json();

    expect(body.cost.totalCostUsd).toBeCloseTo(0.8, 2);
    expect(body.cost.totalInputTokens).toBe(150);
    expect(body.cost.totalOutputTokens).toBe(100);
    expect(body.cost.totalCacheRead).toBe(100);
    // 100 cache reads / 250 total = 0.4
    expect(body.cost.cacheHitRate).toBeCloseTo(0.4, 2);
    expect(body.cost.avgCostPerTask).toBeCloseTo(0.8, 2);
    expect(body.cost.dailyCosts.length).toBeGreaterThan(0);
    expect(body.cost.burnRatePerDay).toBeGreaterThan(0);
  });

  it("returns costByOutcome grouped by success vs failed", async () => {
    const t1 = db.insert(tasks).values({ status: "completed" } as any).returning().get()!;
    const t2 = db.insert(tasks).values({ status: "failed" } as any).returning().get()!;
    db.insert(usageRecords).values([
      { taskId: t1.id, provider: "a", model: "m", totalCostUsd: 1.0 },
      { taskId: t2.id, provider: "a", model: "m", totalCostUsd: 2.0 },
    ] as any).run();

    const res = await app.request("/metrics/overview");
    const body = await res.json();
    expect(Array.isArray(body.cost.costByOutcome)).toBe(true);
  });

  it("computes chat metrics", async () => {
    const c1 = db.insert(chats).values({ title: "Chat 1" } as any).returning().get()!;
    db.insert(chatMessages).values([
      { chatId: c1.id, role: "user", content: "hi", createdAt: "2025-01-01T10:00:00.000Z" },
      { chatId: c1.id, role: "assistant", content: "hello", createdAt: "2025-01-01T10:01:00.000Z" },
      { chatId: c1.id, role: "user", content: "bye", createdAt: "2025-01-01T10:02:00.000Z" },
    ] as any).run();

    const res = await app.request("/metrics/overview");
    const body = await res.json();
    expect(body.chats.totalChats).toBe(1);
    expect(body.chats.avgMessagesPerChat).toBe(3);
    expect(body.chats.avgChatDurationSeconds).toBeGreaterThan(0);
    expect(body.chats.totalChatTimeSeconds).toBeGreaterThan(0);
  });

  it("computes schedule metrics", async () => {
    db.insert(schedules).values([
      { templateScope: "global", templateName: "t", scheduleType: "cron", cronExpression: "* * * * *", status: "active" },
      { templateScope: "global", templateName: "t", scheduleType: "cron", cronExpression: "* * * * *", status: "active" },
      { templateScope: "global", templateName: "t", scheduleType: "cron", cronExpression: "* * * * *", status: "paused" },
    ] as any).run();

    const res = await app.request("/metrics/overview");
    const body = await res.json();
    expect(body.schedules.total).toBe(3);
    expect(body.schedules.active).toBe(2);
    expect(body.schedules.paused).toBe(1);
  });

  it("respects date_from / date_to query params", async () => {
    db.insert(tasks).values([
      { status: "completed", createdAt: "2024-01-01T00:00:00.000Z" },
      { status: "completed", createdAt: "2025-06-01T00:00:00.000Z" },
    ] as any).run();

    const res = await app.request("/metrics/overview?date_from=2025-01-01&date_to=2025-12-31");
    const body = await res.json();
    expect(body.productivity.tasksByStatus.total).toBe(1);
  });

  it("respects period=1d query param", async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 25 * 3600_000).toISOString();
    const today = now.toISOString();

    db.insert(tasks).values([
      { status: "completed", createdAt: yesterday },
      { status: "completed", createdAt: today },
    ] as any).run();

    const res = await app.request("/metrics/overview?period=1d");
    const body = await res.json();
    expect(body.productivity.tasksByStatus.total).toBe(1);
  });

  it("period param with invalid format is ignored", async () => {
    db.insert(tasks).values({ status: "completed" } as any).run();
    const res = await app.request("/metrics/overview?period=garbage");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.productivity.tasksByStatus.total).toBe(1);
  });

  it("supports period unit hours (h)", async () => {
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 3600_000).toISOString();
    const tenMinAgo = new Date(now - 10 * 60_000).toISOString();

    db.insert(tasks).values([
      { status: "completed", createdAt: twoHoursAgo },
      { status: "completed", createdAt: tenMinAgo },
    ] as any).run();

    const res = await app.request("/metrics/overview?period=1h");
    const body = await res.json();
    expect(body.productivity.tasksByStatus.total).toBe(1);
  });

  it("supports period unit months (m)", async () => {
    const now = Date.now();
    const oldDate = new Date(now - 60 * 86400_000).toISOString();
    const recent = new Date(now - 10 * 86400_000).toISOString();

    db.insert(tasks).values([
      { status: "completed", createdAt: oldDate },
      { status: "completed", createdAt: recent },
    ] as any).run();

    const res = await app.request("/metrics/overview?period=1m");
    const body = await res.json();
    expect(body.productivity.tasksByStatus.total).toBe(1);
  });

  it("filters by ai_provider_key_id — scopes tasks, schedules, chats", async () => {
    const key = db.insert(aiProviderKeys).values({
      provider: "anthropic",
      providerType: "api_key",
      label: "scoped",
      priority: 1,
    } as any).returning().get()!;
    const t1 = db.insert(tasks).values({ status: "completed", assignedKeyId: key.id } as any).returning().get()!;
    db.insert(tasks).values({ status: "completed", assignedKeyId: 9999 } as any).run();
    // `assignedKeyId` moved off templates onto schedules — scope by a
    // schedule row that carries the key we're filtering for.
    db.insert(schedules).values({
      templateScope: "global",
      templateName: "scoped",
      scheduleType: "cron",
      cronExpression: "* * * * *",
      status: "active",
      assignedKeyId: key.id,
    } as any).run();
    const c1 = db.insert(chats).values({ title: "scoped-chat" } as any).returning().get()!;
    const cm = db.insert(chatMessages).values({ chatId: c1.id, role: "user", content: "x" } as any).returning().get()!;
    db.insert(usageRecords).values({
      taskId: t1.id,
      chatMessageId: cm.id,
      provider: "a",
      model: "m",
      totalCostUsd: 1,
      aiProviderKeyId: key.id,
    } as any).run();

    const res = await app.request(`/metrics/overview?ai_provider_key_id=${key.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.productivity.tasksByStatus.total).toBe(1);
    expect(body.cost.totalCostUsd).toBeCloseTo(1, 5);
  });

  it("ai_provider_key_id with no matches returns zeroes (empty-scope path)", async () => {
    db.insert(tasks).values({ status: "completed", assignedKeyId: 1 } as any).run();
    const res = await app.request("/metrics/overview?ai_provider_key_id=987654");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.productivity.tasksByStatus.total).toBe(0);
    expect(body.cost.totalCostUsd).toBe(0);
  });
});
