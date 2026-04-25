/**
 * Covers the chat_permission branch and emitAttentionChanged helper that
 * attention.test.ts doesn't reach.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createTestDb } from "../helpers.js";
import {
  collectAttentionItems,
  emitAttentionChanged,
  type AttentionItem,
  type AttentionSessionRegistry,
  type AttentionBroadcaster,
} from "../../services/attention.js";
import { chats, projects } from "../../db/schema.js";
import type { AgentSession } from "../../services/agent-session/index.js";

function fakeSession(entries: Array<{ tool: string; requestId: string; createdAt: Date }>): AgentSession {
  return {
    pendingPermissionEntries: () =>
      entries.map((e) => ({
        request: {
          requestId: e.requestId,
          toolName: e.tool,
          toolInput: {},
          toolUseID: "u-" + e.requestId,
        },
        createdAt: e.createdAt,
      })),
  } as unknown as AgentSession;
}

function brokenSession(): AgentSession {
  return {
    pendingPermissionEntries: () => {
      throw new Error("chat session broken");
    },
  } as unknown as AgentSession;
}

class FakeRegistry implements AttentionSessionRegistry {
  taskPairs: Array<[number, AgentSession]> = [];
  chatPairs: Array<[number, AgentSession]> = [];
  activeTaskSessions() {
    return this.taskPairs;
  }
  activeChatSessions() {
    return this.chatPairs;
  }
}

describe("collectAttentionItems — chat_permission branch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits chat_permission items for each pending permission on an active chat session", () => {
    const { db, sqlite } = createTestDb();
    db.insert(projects).values({ name: "p" }).run();
    const chat = db
      .insert(chats)
      .values({ projectId: 1, title: "c" })
      .returning()
      .get()!;
    const registry = new FakeRegistry();
    registry.chatPairs.push([
      chat.id,
      fakeSession([
        { tool: "Bash", requestId: "cr1", createdAt: new Date("2099-01-05T00:00:00Z") },
        { tool: "Edit", requestId: "cr2", createdAt: new Date("2099-01-06T00:00:00Z") },
      ]),
    ]);
    const items = collectAttentionItems(db, registry);
    const perms = items.filter((i): i is Extract<AttentionItem, { kind: "chat_permission" }> => i.kind === "chat_permission");
    expect(perms).toHaveLength(2);
    expect(perms.every((p) => p.chatId === chat.id)).toBe(true);
    expect(perms.map((p) => p.tool).sort()).toEqual(["Bash", "Edit"]);
    sqlite.close();
  });

  it("sets projectId=null when the chat has no project", () => {
    const { db, sqlite } = createTestDb();
    const chat = db
      .insert(chats)
      .values({ projectId: null, title: "u" })
      .returning()
      .get()!;
    const registry = new FakeRegistry();
    registry.chatPairs.push([
      chat.id,
      fakeSession([
        { tool: "Read", requestId: "cr1", createdAt: new Date("2099-03-01T00:00:00Z") },
      ]),
    ]);
    const items = collectAttentionItems(db, registry);
    const perms = items.filter((i) => i.kind === "chat_permission");
    expect(perms).toHaveLength(1);
    expect(perms[0]).toMatchObject({ kind: "chat_permission", chatId: chat.id, projectId: null });
    sqlite.close();
  });

  it("sets projectId=null when the chat row has vanished (registry out-of-sync)", () => {
    const { db, sqlite } = createTestDb();
    const registry = new FakeRegistry();
    // Register a chat session for an id that doesn't exist in the DB.
    registry.chatPairs.push([
      9_999,
      fakeSession([
        { tool: "Bash", requestId: "cr1", createdAt: new Date("2099-04-01T00:00:00Z") },
      ]),
    ]);
    const items = collectAttentionItems(db, registry);
    const perms = items.filter((i) => i.kind === "chat_permission");
    expect(perms).toHaveLength(1);
    expect(perms[0]).toMatchObject({ kind: "chat_permission", chatId: 9_999, projectId: null });
    sqlite.close();
  });

  it("skips a chat session whose pendingPermissionEntries throws, warns, then continues", () => {
    const { db, sqlite } = createTestDb();
    const registry = new FakeRegistry();
    registry.chatPairs.push([42, brokenSession()]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const items = collectAttentionItems(db, registry);
    expect(items.filter((i) => i.kind === "chat_permission")).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skipping chat session 42"),
      expect.any(Error),
    );
    sqlite.close();
  });

  it("skips a task session whose task row is missing or has null projectId", () => {
    const { db, sqlite } = createTestDb();
    const registry = new FakeRegistry();
    // Register a task session for an id that doesn't exist in the DB — the
    // aggregator must drop it (not error).
    registry.taskPairs.push([
      9_999,
      fakeSession([
        { tool: "Bash", requestId: "tr1", createdAt: new Date("2099-05-01T00:00:00Z") },
      ]),
    ]);
    const items = collectAttentionItems(db, registry);
    expect(items.filter((i) => i.kind === "task_permission")).toHaveLength(0);
    sqlite.close();
  });

  it("skips sessions with zero pending entries (no item emitted, no warnings)", () => {
    const { db, sqlite } = createTestDb();
    const registry = new FakeRegistry();
    registry.chatPairs.push([1, fakeSession([])]);
    registry.taskPairs.push([1, fakeSession([])]);
    const items = collectAttentionItems(db, registry);
    expect(items).toEqual([]);
    sqlite.close();
  });
});

describe("emitAttentionChanged", () => {
  it("calls broadcaster.broadcastAll with the expected payload", () => {
    const calls: Array<Record<string, unknown>> = [];
    const broadcaster: AttentionBroadcaster = {
      broadcastAll(data) {
        calls.push(data);
      },
    };
    emitAttentionChanged(broadcaster);
    expect(calls).toEqual([{ type: "attention_changed", payload: {} }]);
  });
});

describe("task_approval title derivation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("derives the title from the first non-empty prompt line when label is null", async () => {
    const { db, sqlite } = createTestDb();
    db.insert(projects).values({ name: "p" }).run();
    const { tasks: tasksTable } = await import("../../db/schema.js");
    db.insert(tasksTable)
      .values({
        projectId: 1,
        prompt: "\n\n  first real line  \nsecond",
        status: "pending_approval",
      })
      .run();
    const items = collectAttentionItems(db, new FakeRegistry());
    const app = items.find((i) => i.kind === "task_approval")!;
    expect(app.kind === "task_approval" && app.title).toBe("first real line");
    sqlite.close();
  });

  it("truncates very long first lines to 117 chars + ellipsis", async () => {
    const { db, sqlite } = createTestDb();
    db.insert(projects).values({ name: "p" }).run();
    const { tasks: tasksTable } = await import("../../db/schema.js");
    const longLine = "x".repeat(200);
    db.insert(tasksTable)
      .values({ projectId: 1, prompt: longLine, status: "pending_approval" })
      .run();
    const items = collectAttentionItems(db, new FakeRegistry());
    const app = items.find((i) => i.kind === "task_approval")!;
    expect(app.kind === "task_approval" && app.title.endsWith("...")).toBe(true);
    expect(app.kind === "task_approval" && app.title.length).toBe(120);
    sqlite.close();
  });

  it('falls back to "" when the prompt is entirely empty / null', async () => {
    const { db, sqlite } = createTestDb();
    db.insert(projects).values({ name: "p" }).run();
    const { tasks: tasksTable } = await import("../../db/schema.js");
    db.insert(tasksTable).values({ projectId: 1, prompt: "", status: "pending_approval" }).run();
    db.insert(tasksTable).values({ projectId: 1, prompt: "   \n \t\n", status: "pending_approval" }).run();
    const items = collectAttentionItems(db, new FakeRegistry());
    const approvals = items.filter((i) => i.kind === "task_approval");
    expect(approvals).toHaveLength(2);
    for (const a of approvals) expect(a.kind === "task_approval" && a.title).toBe("");
    sqlite.close();
  });

  it("skips pending_approval tasks with projectId=null", async () => {
    const { db, sqlite } = createTestDb();
    const { tasks: tasksTable } = await import("../../db/schema.js");
    // projectId null → entire row must be skipped.
    db.insert(tasksTable)
      .values({ projectId: null, prompt: "x", status: "pending_approval" })
      .run();
    const items = collectAttentionItems(db, new FakeRegistry());
    expect(items.filter((i) => i.kind === "task_approval")).toHaveLength(0);
    sqlite.close();
  });
});
