import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import * as schema from "../../db/schema.js";
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

describe("Usage routes", () => {
  it("GET /usage/summary returns zeros when empty", async () => {
    const res = await app.request("/usage/summary");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalInputTokens).toBe(0);
    expect(body.totalOutputTokens).toBe(0);
    expect(body.totalCostUsd).toBe(0);
  });

  it("GET /usage/breakdown returns empty list", async () => {
    const res = await app.request("/usage/breakdown");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  it("GET /usage/breakdown with group_by=provider works", async () => {
    const res = await app.request("/usage/breakdown?group_by=provider");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  it("GET /usage/breakdown with group_by=model works", async () => {
    const res = await app.request("/usage/breakdown?group_by=model");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  it("GET /usage/breakdown with group_by=day works", async () => {
    const res = await app.request("/usage/breakdown?group_by=day");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  it("GET /usage/summary supports filters", async () => {
    const res = await app.request("/usage/summary?provider=anthropic&model=claude-3");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalCostUsd).toBe(0);
  });

  it("group_by=project: project chat costs appear under the project", async () => {
    // Setup: workspace → project → chat → message → usage
    const ws = db.insert(schema.workspaces).values({ name: "ws-cost-test", path: "/tmp/ws-cost-test" }).returning().get();
    const proj = db.insert(schema.projects).values({ workspaceId: ws.id, name: "MyProject", path: "/tmp/proj" }).returning().get();
    const chat = db.insert(schema.chats).values({ projectId: proj.id, workspaceId: ws.id, title: "proj chat" }).returning().get();
    const msg = db.insert(schema.chatMessages).values({ chatId: chat.id, role: "assistant", content: "hi" }).returning().get();
    db.insert(schema.usageRecords).values({
      chatMessageId: msg.id, projectId: proj.id,
      provider: "anthropic", model: "claude-sonnet-4-20250514",
      inputTokens: 100, outputTokens: 50, totalCostUsd: 0.5,
    }).run();

    const res = await app.request("/usage/breakdown?group_by=project");
    expect(res.status).toBe(200);
    const body = await res.json();
    const item = body.items.find((i: any) => i.scopeId === String(proj.id));
    expect(item).toBeDefined();
    expect(item.scopeLabel).toBe("MyProject");
    expect(item.costUsd).toBeCloseTo(0.5);
  });

  it("group_by=project: workspace chat costs appear under the workspace name", async () => {
    // Setup: workspace → chat (no project) → message → usage
    const ws = db.insert(schema.workspaces).values({ name: "ws-chat-cost", path: "/tmp/ws-chat-cost" }).returning().get();
    const chat = db.insert(schema.chats).values({ workspaceId: ws.id, title: "ws chat" }).returning().get();
    const msg = db.insert(schema.chatMessages).values({ chatId: chat.id, role: "assistant", content: "hello" }).returning().get();
    db.insert(schema.usageRecords).values({
      chatMessageId: msg.id, projectId: null,
      provider: "anthropic", model: "claude-sonnet-4-20250514",
      inputTokens: 200, outputTokens: 100, totalCostUsd: 1.0,
    }).run();

    const res = await app.request("/usage/breakdown?group_by=project");
    expect(res.status).toBe(200);
    const body = await res.json();
    const item = body.items.find((i: any) => i.scopeLabel === "ws-chat-cost");
    expect(item).toBeDefined();
    expect(item.scopeId).toBe(`ws_${ws.id}`);
    expect(item.costUsd).toBeCloseTo(1.0);
  });

  it("group_by=project: deleted project shows 'Deleted project #N'", async () => {
    // Insert usage for a project that doesn't exist
    db.insert(schema.usageRecords).values({
      projectId: 99999,
      provider: "anthropic", model: "claude-sonnet-4-20250514",
      inputTokens: 50, outputTokens: 25, totalCostUsd: 0.2,
    }).run();

    const res = await app.request("/usage/breakdown?group_by=project");
    expect(res.status).toBe(200);
    const body = await res.json();
    const item = body.items.find((i: any) => i.scopeId === "99999");
    expect(item).toBeDefined();
    expect(item.scopeLabel).toBe("Deleted project #99999");
  });

  it("group_by=project: orphan records show 'Other chats'", async () => {
    // Insert usage with no project and no chat message
    db.insert(schema.usageRecords).values({
      projectId: null, chatMessageId: null,
      provider: "anthropic", model: "claude-sonnet-4-20250514",
      inputTokens: 10, outputTokens: 5, totalCostUsd: 0.05,
    }).run();

    const res = await app.request("/usage/breakdown?group_by=project");
    expect(res.status).toBe(200);
    const body = await res.json();
    const item = body.items.find((i: any) => i.scopeId === "other");
    expect(item).toBeDefined();
    expect(item.scopeLabel).toBe("Other chats");
  });
});
