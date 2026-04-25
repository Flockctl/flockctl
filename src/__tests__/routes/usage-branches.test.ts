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

describe("usage routes — branch gaps", () => {
  it("period shorthand with invalid format is ignored (no filter applied)", async () => {
    db.insert(schema.usageRecords).values({
      provider: "a", model: "m", totalCostUsd: 7,
      createdAt: new Date(Date.now() - 365 * 86400_000).toISOString(),
    } as any).run();
    // Invalid shape — no match means condition not pushed
    const res = await app.request("/usage/summary?period=banana");
    const body = await res.json();
    expect(body.totalCostUsd).toBeCloseTo(7);
  });

  it("ai_provider_key_id filter selects matching records only", async () => {
    const k = db.insert(schema.aiProviderKeys).values({
      provider: "anthropic",
      providerType: "api_key",
      keyValue: "sk-ant-abcd1234567890",
    } as any).returning().get()!;
    db.insert(schema.usageRecords).values([
      { aiProviderKeyId: k.id, provider: "a", model: "m", totalCostUsd: 3 },
      { aiProviderKeyId: null, provider: "a", model: "m", totalCostUsd: 9 },
    ] as any).run();
    const res = await app.request(`/usage/summary?ai_provider_key_id=${k.id}`);
    const body = await res.json();
    expect(body.totalCostUsd).toBeCloseTo(3);
  });

  it("GET /usage/summary with project_id filter", async () => {
    const p = db.insert(schema.projects).values({ name: "p" }).returning().get()!;
    db.insert(schema.usageRecords).values([
      { projectId: p.id, provider: "a", model: "m", totalCostUsd: 1 },
      { projectId: null, provider: "a", model: "m", totalCostUsd: 5 },
    ] as any).run();
    const res = await app.request(`/usage/summary?project_id=${p.id}`);
    const body = await res.json();
    expect(body.totalCostUsd).toBeCloseTo(1);
  });

  it("GET /usage/summary with provider and model filter", async () => {
    db.insert(schema.usageRecords).values([
      { provider: "anthropic", model: "opus", totalCostUsd: 1 },
      { provider: "openai", model: "gpt4", totalCostUsd: 2 },
    ] as any).run();
    const byProv = await (await app.request(`/usage/summary?provider=anthropic`)).json();
    expect(byProv.totalCostUsd).toBeCloseTo(1);
    const byModel = await (await app.request(`/usage/summary?model=gpt4`)).json();
    expect(byModel.totalCostUsd).toBeCloseTo(2);
  });

  it("GET /usage/breakdown?group_by=provider groups by provider", async () => {
    db.insert(schema.usageRecords).values([
      { provider: "anthropic", model: "opus", inputTokens: 100, outputTokens: 50, totalCostUsd: 1 },
      { provider: "anthropic", model: "sonnet", inputTokens: 20, outputTokens: 10, totalCostUsd: 0.5 },
      { provider: "openai", model: "gpt4", inputTokens: 30, outputTokens: 15, totalCostUsd: 0.7 },
    ] as any).run();
    const res = await app.request("/usage/breakdown?group_by=provider");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    const anthro = body.items.find((i: any) => i.scopeId === "anthropic");
    expect(anthro.costUsd).toBeCloseTo(1.5);
  });

  it("GET /usage/breakdown?group_by=model groups by model", async () => {
    db.insert(schema.usageRecords).values([
      { provider: "a", model: "opus", totalCostUsd: 2 },
      { provider: "a", model: "opus", totalCostUsd: 3 },
      { provider: "b", model: "sonnet", totalCostUsd: 4 },
    ] as any).run();
    const res = await app.request("/usage/breakdown?group_by=model");
    const body = await res.json();
    const opus = body.items.find((i: any) => i.scopeId === "opus");
    expect(opus.costUsd).toBeCloseTo(5);
  });

  it("GET /usage/breakdown?group_by=day groups by createdAt date", async () => {
    db.insert(schema.usageRecords).values([
      { provider: "a", model: "m", totalCostUsd: 1, createdAt: "2025-01-01T10:00:00Z" },
      { provider: "a", model: "m", totalCostUsd: 2, createdAt: "2025-01-01T14:00:00Z" },
      { provider: "a", model: "m", totalCostUsd: 3, createdAt: "2025-01-02T10:00:00Z" },
    ] as any).run();
    const res = await app.request("/usage/breakdown?group_by=day");
    const body = await res.json();
    const day1 = body.items.find((i: any) => i.scopeId === "2025-01-01");
    expect(day1.costUsd).toBeCloseTo(3);
    const day2 = body.items.find((i: any) => i.scopeId === "2025-01-02");
    expect(day2.costUsd).toBeCloseTo(3);
  });

  it("GET /usage/breakdown?group_by=project distinguishes active vs deleted vs orphan", async () => {
    const ws = db.insert(schema.workspaces).values({ name: "w", path: "/tmp/w-gb" }).returning().get()!;
    const p = db.insert(schema.projects).values({ name: "active-proj" }).returning().get()!;
    const chat = db.insert(schema.chats).values({ title: "c", workspaceId: ws.id } as any).returning().get()!;
    const msg = db.insert(schema.chatMessages).values({ chatId: chat.id, role: "user", content: "hi" } as any).returning().get()!;

    db.insert(schema.usageRecords).values([
      { projectId: p.id, provider: "a", model: "m", totalCostUsd: 1 },
      { projectId: 999999, provider: "a", model: "m", totalCostUsd: 2 }, // deleted/missing
      { chatMessageId: msg.id, provider: "a", model: "m", totalCostUsd: 3 }, // workspace
      { provider: "a", model: "m", totalCostUsd: 4 }, // orphan
    ] as any).run();

    const res = await app.request("/usage/breakdown?group_by=project");
    const body = await res.json();
    const labels = new Set(body.items.map((i: any) => i.scopeLabel));
    expect(labels.has("active-proj")).toBe(true);
    expect([...labels].some((l) => typeof l === "string" && l.startsWith("Deleted project #"))).toBe(true);
    expect(labels.has("w")).toBe(true);
    expect(labels.has("Other chats")).toBe(true);
  });

  it("POST /usage/budgets uses default action=pause when action omitted", async () => {
    const res = await app.request("/usage/budgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", period: "daily", limitUsd: 10 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.action).toBe("pause");
  });

  it("POST /usage/budgets rejects non-number limitUsd", async () => {
    const res = await app.request("/usage/budgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", period: "daily", limitUsd: "not-a-number" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /usage/budgets accepts scopeId=null default", async () => {
    const res = await app.request("/usage/budgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", period: "daily", limitUsd: 5 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.scopeId).toBeNull();
  });

  it("PATCH /usage/budgets/:id with only limitUsd leaves action unchanged", async () => {
    const created = db.insert(schema.budgetLimits).values({
      scope: "global", period: "daily", limitUsd: 10, action: "pause",
    } as any).returning().get()!;
    const res = await app.request(`/usage/budgets/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limitUsd: 99 }),
    });
    expect(res.status).toBe(200);
    const row = db.select().from(schema.budgetLimits).get()!;
    expect(row.limitUsd).toBe(99);
    expect(row.action).toBe("pause");
  });

  it("PATCH /usage/budgets/:id with empty body updates only updatedAt", async () => {
    const created = db.insert(schema.budgetLimits).values({
      scope: "global", period: "daily", limitUsd: 10,
    } as any).returning().get()!;
    const before = db.select().from(schema.budgetLimits).get()!;
    const res = await app.request(`/usage/budgets/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const after = db.select().from(schema.budgetLimits).get()!;
    expect(after.limitUsd).toBe(before.limitUsd);
    expect(after.action).toBe(before.action);
  });
});
