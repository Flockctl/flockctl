import { describe, it, expect, afterAll } from "vitest";
import { createTestDb } from "./helpers.js";

describe("Database connection", () => {
  const { db, sqlite } = createTestDb();
  afterAll(() => sqlite.close());

  it("connects and creates all core tables", () => {
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain("tasks");
    expect(names).toContain("projects");
    expect(names).toContain("milestones");
    expect(names).toContain("ai_provider_keys");
    expect(names).toContain("workspaces");
    expect(names).toContain("usage_records");
    expect(names).toContain("plan_slices");
    expect(names).toContain("plan_tasks");
    expect(names).toContain("task_logs");
    // task_templates is gone — templates now live on disk. See migration 0037.
    expect(names).not.toContain("task_templates");
    expect(names).toContain("schedules");
    expect(names).toContain("chats");
    expect(names).toContain("chat_messages");
    expect(names).toContain("budget_limits");
    expect(names).toContain("secrets");
    expect(names).toContain("incidents");
    expect(names).toContain("chat_attachments");
    expect(names).toContain("chat_todos");
    expect(names).toContain("agent_questions");
    // FTS5 virtual table for incidents + its 4 shadow tables
    // (incidents_fts_data / idx / docsize / config) are also registered
    // as tables by SQLite. Total is 18 real + 1 virtual + 4 shadow = 23
    // (task_templates was removed in migration 0037).
    expect(names).toContain("incidents_fts");
    expect(names).toHaveLength(23);
  });
});
