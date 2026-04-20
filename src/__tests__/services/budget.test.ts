import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { budgetLimits, usageRecords, projects, workspaces } from "../../db/schema.js";
import Database from "better-sqlite3";
import { checkBudget, getBudgetSummary } from "../../services/budget.js";

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
  // Clear tables to isolate tests
  sqlite.exec(`
    DELETE FROM budget_limits;
    DELETE FROM usage_records;
    DELETE FROM projects;
    DELETE FROM workspaces;
  `);
});

describe("checkBudget", () => {
  it("returns allowed=true when no limits exist", () => {
    const r = checkBudget(1);
    expect(r.allowed).toBe(true);
    expect(r.exceededLimits).toHaveLength(0);
  });

  it("returns allowed=true when spend is below limit", () => {
    db.insert(budgetLimits).values({
      scope: "global", scopeId: null, period: "total", limitUsd: 10, action: "pause", isActive: true,
    }).run();
    db.insert(usageRecords).values({
      provider: "anthropic", model: "claude-opus-4-7", totalCostUsd: 5,
    } as any).run();

    const r = checkBudget(null);
    expect(r.allowed).toBe(true);
    expect(r.exceededLimits).toHaveLength(0);
  });

  it("returns allowed=false when global total spend exceeds limit", () => {
    db.insert(budgetLimits).values({
      scope: "global", scopeId: null, period: "total", limitUsd: 10, action: "pause", isActive: true,
    }).run();
    db.insert(usageRecords).values({
      provider: "anthropic", model: "claude-opus-4-7", totalCostUsd: 15,
    } as any).run();

    const r = checkBudget(null);
    expect(r.allowed).toBe(false);
    expect(r.exceededLimits).toHaveLength(1);
    expect(r.exceededLimits[0].scope).toBe("global");
    expect(r.exceededLimits[0].spentUsd).toBe(15);
  });

  it("ignores inactive limits", () => {
    db.insert(budgetLimits).values({
      scope: "global", scopeId: null, period: "total", limitUsd: 1, action: "pause", isActive: false,
    }).run();
    db.insert(usageRecords).values({
      provider: "anthropic", model: "claude-opus-4-7", totalCostUsd: 100,
    } as any).run();

    const r = checkBudget(null);
    expect(r.allowed).toBe(true);
  });

  it("treats action=warn as non-blocking even if exceeded", () => {
    db.insert(budgetLimits).values({
      scope: "global", scopeId: null, period: "total", limitUsd: 1, action: "warn", isActive: true,
    }).run();
    db.insert(usageRecords).values({
      provider: "anthropic", model: "claude-opus-4-7", totalCostUsd: 5,
    } as any).run();

    const r = checkBudget(null);
    expect(r.allowed).toBe(true);
    expect(r.exceededLimits).toHaveLength(1);
  });

  it("filters by project scope", () => {
    const p1 = db.insert(projects).values({ name: "p1" }).returning().get()!;
    const p2 = db.insert(projects).values({ name: "p2" }).returning().get()!;

    db.insert(budgetLimits).values({
      scope: "project", scopeId: p1.id, period: "total", limitUsd: 5, action: "pause", isActive: true,
    }).run();
    db.insert(usageRecords).values({
      projectId: p1.id, provider: "anthropic", model: "m", totalCostUsd: 10,
    } as any).run();

    // Unrelated project p2 — limit should NOT apply
    expect(checkBudget(p2.id).allowed).toBe(true);
    // Correct project p1 — exceeded
    expect(checkBudget(p1.id).allowed).toBe(false);
  });

  it("filters by workspace scope", () => {
    const ws = db.insert(workspaces).values({ name: "ws", path: "/tmp/ws" }).returning().get()!;
    const p1 = db.insert(projects).values({ name: "p1", workspaceId: ws.id }).returning().get()!;
    const unrelated = db.insert(projects).values({ name: "solo" }).returning().get()!;

    db.insert(budgetLimits).values({
      scope: "workspace", scopeId: ws.id, period: "total", limitUsd: 2, action: "pause", isActive: true,
    }).run();
    db.insert(usageRecords).values({
      projectId: p1.id, provider: "a", model: "m", totalCostUsd: 5,
    } as any).run();

    expect(checkBudget(p1.id).allowed).toBe(false);
    expect(checkBudget(unrelated.id).allowed).toBe(true);
  });

  it("workspace limit returns 0 spent when workspace has no projects", () => {
    const ws = db.insert(workspaces).values({ name: "empty-ws", path: "/tmp/ew" }).returning().get()!;
    db.insert(budgetLimits).values({
      scope: "workspace", scopeId: ws.id, period: "total", limitUsd: 1, action: "pause", isActive: true,
    }).run();

    // projectId in a different workspace does not match
    const p = db.insert(projects).values({ name: "other" }).returning().get()!;
    const r = checkBudget(p.id);
    expect(r.allowed).toBe(true);
  });

  it("daily period resets at midnight — includes today's spend", () => {
    db.insert(budgetLimits).values({
      scope: "global", scopeId: null, period: "daily", limitUsd: 1, action: "pause", isActive: true,
    }).run();
    db.insert(usageRecords).values({
      provider: "a", model: "m", totalCostUsd: 5,
    } as any).run();

    const r = checkBudget(null);
    expect(r.allowed).toBe(false);
  });

  it("monthly period works", () => {
    db.insert(budgetLimits).values({
      scope: "global", scopeId: null, period: "monthly", limitUsd: 100, action: "pause", isActive: true,
    }).run();
    db.insert(usageRecords).values({
      provider: "a", model: "m", totalCostUsd: 150,
    } as any).run();

    expect(checkBudget(null).allowed).toBe(false);
  });
});

describe("getBudgetSummary", () => {
  it("returns empty array when no limits", () => {
    expect(getBudgetSummary()).toEqual([]);
  });

  it("returns limit rows with computed spent and percentUsed", () => {
    db.insert(budgetLimits).values({
      scope: "global", scopeId: null, period: "total", limitUsd: 20, action: "pause", isActive: true,
    }).run();
    db.insert(usageRecords).values({
      provider: "a", model: "m", totalCostUsd: 5,
    } as any).run();

    const summary = getBudgetSummary();
    expect(summary).toHaveLength(1);
    expect(summary[0].limitUsd).toBe(20);
    expect(summary[0].spentUsd).toBe(5);
    expect(summary[0].percentUsed).toBe(25);
    expect(summary[0].action).toBe("pause");
  });

  it("percentUsed is 0 when limit is 0", () => {
    db.insert(budgetLimits).values({
      scope: "global", scopeId: null, period: "total", limitUsd: 0, action: "pause", isActive: true,
    }).run();
    db.insert(usageRecords).values({
      provider: "a", model: "m", totalCostUsd: 5,
    } as any).run();

    const summary = getBudgetSummary();
    expect(summary[0].percentUsed).toBe(0);
  });

  it("excludes inactive limits", () => {
    db.insert(budgetLimits).values({
      scope: "global", scopeId: null, period: "total", limitUsd: 10, isActive: false,
    }).run();
    expect(getBudgetSummary()).toHaveLength(0);
  });

  it("defaults action to 'pause' when null on the limit row", () => {
    db.insert(budgetLimits).values({
      scope: "global", scopeId: null, period: "total", limitUsd: 1, action: null, isActive: true,
    } as any).run();
    db.insert(usageRecords).values({
      provider: "a", model: "m", totalCostUsd: 5,
    } as any).run();
    expect(getBudgetSummary()[0].action).toBe("pause");
    expect(checkBudget(null).exceededLimits[0].action).toBe("pause");
  });
});
