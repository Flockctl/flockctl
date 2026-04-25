import { describe, it, expect, afterAll } from "vitest";
import * as schema from "../db/schema.js";
import { createTestDb } from "./helpers.js";

describe("Schema: insert/query for each table", () => {
  const { db, sqlite } = createTestDb();
  afterAll(() => sqlite.close());

  it("inserts and queries ai_provider_keys", () => {
    db.insert(schema.aiProviderKeys).values({ provider: "anthropic", providerType: "api_key", keyValue: "sk-test" }).run();
    const rows = db.select().from(schema.aiProviderKeys).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("anthropic");
  });

  it("inserts and queries workspaces", () => {
    db.insert(schema.workspaces).values({ name: "my-ws", path: "/tmp/ws" }).run();
    const rows = db.select().from(schema.workspaces).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("my-ws");
  });

  it("inserts and queries projects", () => {
    db.insert(schema.projects).values({ name: "proj1", workspaceId: 1 }).run();
    const rows = db.select().from(schema.projects).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("proj1");
  });

  it("inserts and queries tasks", () => {
    db.insert(schema.tasks).values({ projectId: 1, prompt: "Do something", taskType: "execution" }).run();
    const rows = db.select().from(schema.tasks).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt).toBe("Do something");
  });

  it("inserts and queries task_logs", () => {
    db.insert(schema.taskLogs).values({ taskId: 1, content: "log line", streamType: "stdout" }).run();
    const rows = db.select().from(schema.taskLogs).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("log line");
  });

  it("inserts and queries schedules (global scope)", () => {
    db.insert(schema.schedules).values({
      templateScope: "global",
      templateName: "tpl1",
      scheduleType: "cron",
      cronExpression: "0 * * * *",
    }).run();
    const rows = db.select().from(schema.schedules).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].cronExpression).toBe("0 * * * *");
    expect(rows[0].templateScope).toBe("global");
    expect(rows[0].templateName).toBe("tpl1");
  });

  // Prove the CHECK constraint on schedules rejects inconsistent template
  // scope + id combinations. Matches migration 0037 & schema.ts.
  it("rejects schedule with scope=global but non-null workspace/project ids", () => {
    expect(() => db.insert(schema.schedules).values({
      templateScope: "global",
      templateName: "bad",
      templateWorkspaceId: 1,
      scheduleType: "cron",
      cronExpression: "0 * * * *",
    }).run()).toThrow(/CHECK constraint/i);
  });

  it("rejects schedule with scope=project but null templateProjectId", () => {
    expect(() => db.insert(schema.schedules).values({
      templateScope: "project",
      templateName: "bad",
      scheduleType: "cron",
      cronExpression: "0 * * * *",
    }).run()).toThrow(/CHECK constraint/i);
  });

  it("inserts and queries chats", () => {
    db.insert(schema.chats).values({ projectId: 1, title: "Chat 1" }).run();
    const rows = db.select().from(schema.chats).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Chat 1");
  });

  it("inserts and queries chat_messages", () => {
    db.insert(schema.chatMessages).values({ chatId: 1, role: "user", content: "Hello" }).run();
    const rows = db.select().from(schema.chatMessages).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("Hello");
  });

  it("inserts and queries usage_records", () => {
    db.insert(schema.usageRecords).values({ provider: "anthropic", model: "claude-sonnet-4-20250514", inputTokens: 100, outputTokens: 200, totalCostUsd: 0.01 }).run();
    const rows = db.select().from(schema.usageRecords).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].inputTokens).toBe(100);
  });
});

describe("Types", () => {
  it("validates task status transitions", async () => {
    const { validateTaskTransition } = await import("../lib/types.js");
    expect(validateTaskTransition("queued", "running")).toBe(true);
    expect(validateTaskTransition("queued", "done")).toBe(false);
    expect(validateTaskTransition("running", "done")).toBe(true);
    expect(validateTaskTransition("running", "failed")).toBe(true);
    expect(validateTaskTransition("done", "running")).toBe(false);
    expect(validateTaskTransition("failed", "queued")).toBe(true);
  });
});
