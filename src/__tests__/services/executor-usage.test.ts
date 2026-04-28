// ─── executor-usage — unit tests ───
//
// Pins the saveUsage / inferProvider contract:
//   • inferProvider returns the right provider for each known model family
//   • inferProvider falls back to "anthropic" for an unknown model name
//     (default branch — Claude Code SDK)
//   • flat-rate provider keys override the inferred provider
//   • saveUsage swallows DB insert errors so a usage-record blip cannot
//     break a task's terminal write path

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { usageRecords } from "../../db/schema.js";
import {
  inferProvider,
  saveUsage,
} from "../../services/task-executor/executor-usage.js";

let dbHandle: ReturnType<typeof createTestDb>;

beforeAll(() => {
  dbHandle = createTestDb();
  setDb(dbHandle.db, dbHandle.sqlite);
});

afterAll(() => {
  dbHandle.sqlite.close();
});

beforeEach(() => {
  dbHandle.sqlite.exec("DELETE FROM usage_records;");
});

describe("inferProvider", () => {
  it("maps claude/haiku/sonnet/opus → anthropic", () => {
    expect(inferProvider("claude-opus-4.7")).toBe("anthropic");
    expect(inferProvider("haiku-4.5")).toBe("anthropic");
    expect(inferProvider("sonnet-4.6")).toBe("anthropic");
    expect(inferProvider("opus-4.5")).toBe("anthropic");
  });

  it("maps gpt/o1/o3 → openai", () => {
    expect(inferProvider("gpt-4o-mini")).toBe("openai");
    expect(inferProvider("o1-preview")).toBe("openai");
    expect(inferProvider("o3-pro")).toBe("openai");
  });

  it("maps gemini → google", () => {
    expect(inferProvider("gemini-2.5-pro")).toBe("google");
  });

  it("maps mistral/codestral → mistral", () => {
    expect(inferProvider("mistral-large")).toBe("mistral");
    expect(inferProvider("codestral-2024")).toBe("mistral");
  });

  // Hits the default-fallback branch on line 11 — an unknown model name
  // that matches none of the family checks falls through to "anthropic".
  it("falls back to anthropic for unknown model names", () => {
    expect(inferProvider("totally-unknown-model")).toBe("anthropic");
    expect(inferProvider("")).toBe("anthropic");
    expect(inferProvider("custom-finetune")).toBe("anthropic");
  });
});

describe("saveUsage", () => {
  const baseMetrics = {
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalCostUsd: 0,
    turns: 1,
    durationMs: 1000,
  };

  it("inserts a usage record with provider inferred from model", () => {
    saveUsage({
      taskId: 1,
      projectId: null,
      aiProviderKeyId: null,
      keyProvider: null,
      model: "gpt-4o-mini",
      metrics: baseMetrics,
    });
    const rows = dbHandle.db.select().from(usageRecords).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("openai");
    expect(rows[0].model).toBe("gpt-4o-mini");
    expect(rows[0].inputTokens).toBe(100);
  });

  it("flat-rate keyProvider overrides the model-derived provider", () => {
    // Model name is `claude-...` (would normally infer anthropic) but the
    // key is a Copilot flat-rate subscription — usage must record under
    // `github_copilot`.
    saveUsage({
      taskId: 2,
      projectId: null,
      aiProviderKeyId: 1,
      keyProvider: "github_copilot",
      model: "claude-opus-4.7",
      metrics: baseMetrics,
    });
    const rows = dbHandle.db.select().from(usageRecords).all();
    expect(rows[0].provider).toBe("github_copilot");

    dbHandle.sqlite.exec("DELETE FROM usage_records;");
    saveUsage({
      taskId: 3,
      projectId: null,
      aiProviderKeyId: 1,
      keyProvider: "claude_cli",
      model: "claude-opus-4.7",
      metrics: baseMetrics,
    });
    expect(dbHandle.db.select().from(usageRecords).all()[0].provider).toBe(
      "claude_cli",
    );
  });

  it("non-flat-rate keyProvider falls through to inferProvider", () => {
    // Anthropic-labeled key, but the model is gpt-* → inferProvider wins
    // (the override only applies for the flat-rate set).
    saveUsage({
      taskId: 4,
      projectId: null,
      aiProviderKeyId: 1,
      keyProvider: "anthropic",
      model: "gpt-4o-mini",
      metrics: baseMetrics,
    });
    expect(dbHandle.db.select().from(usageRecords).all()[0].provider).toBe(
      "openai",
    );
  });

  // Hits the catch on line 60 — a DB insert failure must NOT propagate;
  // the function logs and returns. Without this swallow, a usage-record
  // write blip would bubble up into the task-executor terminal path.
  it("swallows DB insert errors and logs to console.error", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Drop the table out from under saveUsage so the INSERT throws.
    dbHandle.sqlite.exec("DROP TABLE usage_records;");

    expect(() =>
      saveUsage({
        taskId: 99,
        projectId: null,
        aiProviderKeyId: null,
        keyProvider: null,
        model: "claude-opus-4.7",
        metrics: baseMetrics,
      }),
    ).not.toThrow();

    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0][0]).toContain("Failed to save usage record");

    // Re-create the table so subsequent tests aren't poisoned.
    dbHandle.sqlite.exec(`
      CREATE TABLE usage_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        project_id INTEGER,
        ai_provider_key_id INTEGER,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_creation_input_tokens INTEGER DEFAULT 0,
        cache_read_input_tokens INTEGER DEFAULT 0,
        total_cost_usd REAL,
        timestamp TEXT DEFAULT (datetime('now'))
      );
    `);
    errSpy.mockRestore();
  });

  it("swallows non-Error throws via String(err) in the catch", () => {
    // Make insert fail with a non-Error value to exercise the
    // `String(err)` branch of the ternary on line 60.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    dbHandle.sqlite.exec("DROP TABLE usage_records;");

    saveUsage({
      taskId: 100,
      projectId: null,
      aiProviderKeyId: null,
      keyProvider: null,
      model: "claude-opus-4.7",
      metrics: baseMetrics,
    });
    expect(errSpy).toHaveBeenCalled();

    dbHandle.sqlite.exec(`
      CREATE TABLE usage_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        project_id INTEGER,
        ai_provider_key_id INTEGER,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_creation_input_tokens INTEGER DEFAULT 0,
        cache_read_input_tokens INTEGER DEFAULT 0,
        total_cost_usd REAL,
        timestamp TEXT DEFAULT (datetime('now'))
      );
    `);
    errSpy.mockRestore();
  });
});
