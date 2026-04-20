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
    expect(names).toContain("task_templates");
    expect(names).toContain("schedules");
    expect(names).toContain("chats");
    expect(names).toContain("chat_messages");
    expect(names).toContain("budget_limits");
    expect(names).toContain("secrets");
    expect(names).toHaveLength(15);
  });
});
