import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { createTestDb } from "../helpers.js";

// Migration 0042 added three columns to agent_questions for harness-style
// multiple-choice prompts (`options` / `multi_select` / `header`) without
// breaking the original free-form shape. The two cases below pin both halves
// of the contract: a fully-populated row round-trips, and a row that omits
// every new field still inserts cleanly with the documented defaults.
describe("agent_questions schema (0042 additive columns)", () => {
  const { db, sqlite } = createTestDb();
  afterAll(() => sqlite.close());

  // Need parent rows for the FK targets used by the question rows below.
  // agent_questions's CHECK constraint is XOR(task_id, chat_id), so each
  // case picks exactly one parent.
  db.insert(schema.workspaces).values({ name: "ws", path: "/tmp/ws" }).run();
  db.insert(schema.projects).values({ name: "proj", workspaceId: 1 }).run();
  db.insert(schema.tasks).values({ projectId: 1, prompt: "p", taskType: "execution" }).run();
  db.insert(schema.chats).values({ projectId: 1, title: "c" }).run();

  it("round-trips a multi-choice row with options/multi_select/header populated", () => {
    const optionsJson = JSON.stringify([{ label: "a" }, { label: "b" }]);

    db.insert(schema.agentQuestions).values({
      requestId: "req-mc-1",
      taskId: 1,
      toolUseId: "toolu_mc",
      question: "Pick something",
      options: optionsJson,
      multiSelect: true,
      header: "Pick one",
    }).run();

    const row = db
      .select()
      .from(schema.agentQuestions)
      .where(eq(schema.agentQuestions.requestId, "req-mc-1"))
      .get();

    expect(row).toBeDefined();
    expect(row!.options).toBe(optionsJson);
    // Drizzle decodes the integer column into a real boolean when mode:'boolean'.
    expect(row!.multiSelect).toBe(true);
    expect(row!.header).toBe("Pick one");

    // The originally-required fields must still survive untouched.
    expect(row!.question).toBe("Pick something");
    expect(row!.toolUseId).toBe("toolu_mc");
    expect(row!.status).toBe("pending");

    // Sanity-check the JSON shape we expect downstream consumers to see.
    const parsed = JSON.parse(row!.options!);
    expect(parsed).toEqual([{ label: "a" }, { label: "b" }]);
  });

  it("inserts a free-form row with all new fields omitted (backward compat)", () => {
    db.insert(schema.agentQuestions).values({
      requestId: "req-free-1",
      chatId: 1,
      toolUseId: "toolu_free",
      question: "What now?",
    }).run();

    const row = db
      .select()
      .from(schema.agentQuestions)
      .where(eq(schema.agentQuestions.requestId, "req-free-1"))
      .get();

    expect(row).toBeDefined();
    expect(row!.options).toBeNull();
    expect(row!.multiSelect).toBe(false); // default 0 → false
    expect(row!.header).toBeNull();
    expect(row!.status).toBe("pending");
    expect(row!.question).toBe("What now?");
  });
});
