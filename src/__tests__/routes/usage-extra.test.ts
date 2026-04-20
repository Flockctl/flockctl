import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM budget_limits;
    DELETE FROM usage_records;
    DELETE FROM chat_messages;
    DELETE FROM chats;
    DELETE FROM projects;
    DELETE FROM workspaces;
  `);
});

describe("Usage — budget CRUD", () => {
  it("GET /usage/budgets returns empty summary", async () => {
    const res = await app.request("/usage/budgets");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("POST creates a budget limit", async () => {
    const res = await app.request("/usage/budgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        period: "daily",
        limitUsd: 10,
        action: "pause",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.scope).toBe("global");
    expect(body.limitUsd).toBe(10);
  });

  it("POST rejects invalid scope", async () => {
    const res = await app.request("/usage/budgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "nonexistent", period: "daily", limitUsd: 5 }),
    });
    expect(res.status).toBe(422);
  });

  it("POST rejects invalid period", async () => {
    const res = await app.request("/usage/budgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", period: "yearly", limitUsd: 5 }),
    });
    expect(res.status).toBe(422);
  });

  it("POST rejects non-positive limitUsd", async () => {
    const res = await app.request("/usage/budgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", period: "daily", limitUsd: 0 }),
    });
    expect(res.status).toBe(422);
  });

  it("POST rejects invalid action", async () => {
    const res = await app.request("/usage/budgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", period: "daily", limitUsd: 5, action: "nuke" }),
    });
    expect(res.status).toBe(422);
  });

  it("PATCH updates a budget limit", async () => {
    const created = db.insert(schema.budgetLimits).values({
      scope: "global",
      period: "daily",
      limitUsd: 10,
    } as any).returning().get()!;

    const res = await app.request(`/usage/budgets/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limitUsd: 20, isActive: false }),
    });
    expect(res.status).toBe(200);

    const updated = db.select().from(schema.budgetLimits).get()!;
    expect(updated.limitUsd).toBe(20);
    expect(updated.isActive).toBe(false);
  });

  it("PATCH rejects invalid action", async () => {
    const created = db.insert(schema.budgetLimits).values({
      scope: "global", period: "daily", limitUsd: 10,
    } as any).returning().get()!;
    const res = await app.request(`/usage/budgets/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "bogus" }),
    });
    expect(res.status).toBe(422);
  });

  it("PATCH 404 for missing budget", async () => {
    const res = await app.request("/usage/budgets/9999", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limitUsd: 5 }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE removes a budget limit", async () => {
    const created = db.insert(schema.budgetLimits).values({
      scope: "global", period: "daily", limitUsd: 10,
    } as any).returning().get()!;
    const res = await app.request(`/usage/budgets/${created.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const rem = db.select().from(schema.budgetLimits).all();
    expect(rem.length).toBe(0);
  });

  it("DELETE 404 for missing budget", async () => {
    const res = await app.request("/usage/budgets/9999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("Usage — filters", () => {
  it("filters by period=7d", async () => {
    const now = Date.now();
    const old = new Date(now - 10 * 86400_000).toISOString();
    const recent = new Date(now - 2 * 86400_000).toISOString();

    db.insert(schema.usageRecords).values([
      { provider: "a", model: "m", totalCostUsd: 1, createdAt: old },
      { provider: "a", model: "m", totalCostUsd: 2, createdAt: recent },
    ] as any).run();

    const res = await app.request("/usage/summary?period=7d");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalCostUsd).toBeCloseTo(2, 2);
  });

  it("filters by period=1h", async () => {
    const now = Date.now();
    const old = new Date(now - 3 * 3600_000).toISOString();
    const recent = new Date(now - 10 * 60_000).toISOString();
    db.insert(schema.usageRecords).values([
      { provider: "a", model: "m", totalCostUsd: 1, createdAt: old },
      { provider: "a", model: "m", totalCostUsd: 2, createdAt: recent },
    ] as any).run();
    const res = await app.request("/usage/summary?period=1h");
    const body = await res.json();
    expect(body.totalCostUsd).toBeCloseTo(2, 2);
  });

  it("filters by period=1m (months)", async () => {
    const now = Date.now();
    const old = new Date(now - 60 * 86400_000).toISOString();
    const recent = new Date(now - 10 * 86400_000).toISOString();
    db.insert(schema.usageRecords).values([
      { provider: "a", model: "m", totalCostUsd: 1, createdAt: old },
      { provider: "a", model: "m", totalCostUsd: 2, createdAt: recent },
    ] as any).run();
    const res = await app.request("/usage/summary?period=1m");
    const body = await res.json();
    expect(body.totalCostUsd).toBeCloseTo(2, 2);
  });

  it("filters by workspace_id", async () => {
    const ws = db.insert(schema.workspaces).values({ name: "ws-usage", path: "/tmp/ws-usage" }).returning().get()!;
    const proj = db.insert(schema.projects).values({
      workspaceId: ws.id, name: "p", path: "/tmp/p",
    }).returning().get()!;
    db.insert(schema.usageRecords).values({
      projectId: proj.id, provider: "a", model: "m", totalCostUsd: 0.5,
    } as any).run();
    db.insert(schema.usageRecords).values({
      projectId: null, provider: "a", model: "m", totalCostUsd: 10,
    } as any).run();

    const res = await app.request(`/usage/summary?workspace_id=${ws.id}`);
    const body = await res.json();
    expect(body.totalCostUsd).toBeCloseTo(0.5, 2);
  });

  it("workspace_id with no projects returns empty", async () => {
    const ws = db.insert(schema.workspaces).values({ name: "empty-ws", path: "/tmp/e" }).returning().get()!;
    const res = await app.request(`/usage/summary?workspace_id=${ws.id}`);
    const body = await res.json();
    expect(body.totalCostUsd).toBe(0);
  });

  it("filters by task_id and chat_id", async () => {
    db.insert(schema.usageRecords).values([
      { taskId: 1, provider: "a", model: "m", totalCostUsd: 1 },
      { chatMessageId: 5, provider: "a", model: "m", totalCostUsd: 2 },
    ] as any).run();

    const r1 = await app.request("/usage/summary?task_id=1");
    expect((await r1.json()).totalCostUsd).toBeCloseTo(1);

    const r2 = await app.request("/usage/summary?chat_id=5");
    expect((await r2.json()).totalCostUsd).toBeCloseTo(2);
  });

  it("filters by date_from and date_to", async () => {
    db.insert(schema.usageRecords).values([
      { provider: "a", model: "m", totalCostUsd: 1, createdAt: "2024-01-01T00:00:00Z" },
      { provider: "a", model: "m", totalCostUsd: 2, createdAt: "2025-06-01T00:00:00Z" },
    ] as any).run();
    const res = await app.request("/usage/summary?date_from=2025-01-01&date_to=2025-12-31");
    const body = await res.json();
    expect(body.totalCostUsd).toBeCloseTo(2);
  });
});

describe("Usage — aggregation", () => {
  beforeEach(() => {
    sqlite.exec("DELETE FROM usage_records;");
  });

  it("summary.byProvider and byModel populated", async () => {
    db.insert(schema.usageRecords).values([
      { provider: "anthropic", model: "claude-opus", inputTokens: 100, outputTokens: 50, totalCostUsd: 1 },
      { provider: "openai", model: "gpt-4", inputTokens: 50, outputTokens: 25, totalCostUsd: 0.5 },
    ] as any).run();

    const res = await app.request("/usage/summary");
    const body = await res.json();
    expect(body.byProvider.anthropic.costUsd).toBeCloseTo(1);
    expect(body.byProvider.openai.costUsd).toBeCloseTo(0.5);
    expect(body.byModel["claude-opus"]).toBeDefined();
    expect(body.byModel["gpt-4"]).toBeDefined();
  });

  it("breakdown default (no group) paginates records", async () => {
    db.insert(schema.usageRecords).values([
      { provider: "a", model: "m", totalCostUsd: 1 },
      { provider: "a", model: "m", totalCostUsd: 2 },
      { provider: "a", model: "m", totalCostUsd: 3 },
    ] as any).run();

    const res = await app.request("/usage/breakdown?per_page=2");
    const body = await res.json();
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(3);
  });
});
