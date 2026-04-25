import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../db/schema.js";
import { chatTodos, chats } from "../../db/schema.js";
import { eq } from "drizzle-orm";

/**
 * todo-store operates on the global DB handle (`getDb()`); we swap it for an
 * in-memory sqlite with the chat_todos schema taken verbatim from the 0025
 * migration. Two dependent tables (chats, tasks) are declared minimally so the
 * FK references resolve.
 */
function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE ai_provider_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT
    );
    CREATE TABLE chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER,
      project_id INTEGER,
      title TEXT,
      claude_session_id TEXT,
      entity_type TEXT,
      entity_id TEXT,
      permission_mode TEXT,
      ai_provider_key_id INTEGER REFERENCES ai_provider_keys(id) ON DELETE SET NULL,
      model TEXT,
      requires_approval INTEGER DEFAULT 0,
      approval_status TEXT,
      approved_at TEXT,
      approval_note TEXT,
      file_edits TEXT,
      thinking_enabled INTEGER DEFAULT 1 NOT NULL,
      effort TEXT,
      pinned INTEGER DEFAULT 0 NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER
    );
    CREATE TABLE chat_todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      parent_tool_use_id TEXT,
      todos_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_chat_todos_chat_created ON chat_todos (chat_id, created_at DESC);
    CREATE INDEX idx_chat_todos_chat_parent_created
      ON chat_todos (chat_id, parent_tool_use_id, created_at DESC);
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe("todo-store", () => {
  let dbModule: typeof import("../../db/index.js");
  let todoStore: typeof import("../../services/todo-store.js");
  let db: ReturnType<typeof freshDb>["db"];
  let sqlite: ReturnType<typeof freshDb>["sqlite"];
  let chatId: number;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    dbModule = await import("../../db/index.js");
    const fresh = freshDb();
    db = fresh.db;
    sqlite = fresh.sqlite;
    dbModule.setDb(db, sqlite);
    todoStore = await import("../../services/todo-store.js");

    const chat = db.insert(chats).values({ title: "c" }).returning().get()!;
    chatId = chat.id;

    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    dbModule.closeDb();
  });

  describe("computeCounts", () => {
    it("tallies statuses with in_progress/pending/completed buckets", () => {
      const counts = todoStore.computeCounts([
        { content: "a", status: "completed" },
        { content: "b", status: "completed" },
        { content: "c", status: "in_progress" },
        { content: "d", status: "pending" },
        { content: "e", status: "pending" },
      ]);
      expect(counts).toEqual({ total: 5, completed: 2, in_progress: 1, pending: 2 });
    });

    it("returns all-zero for an empty list", () => {
      expect(todoStore.computeCounts([])).toEqual({ total: 0, completed: 0, in_progress: 0, pending: 0 });
    });
  });

  describe("recordTodoWrite — valid snapshot", () => {
    it("inserts one row and returns counts", () => {
      const result = todoStore.recordTodoWrite({
        chatId,
        input: {
          todos: [
            { content: "Analyze codebase", status: "completed", activeForm: "Analyzing codebase" },
            { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
            { content: "Ship", status: "pending", activeForm: "Shipping" },
          ],
        },
      });

      expect(result).not.toBeNull();
      expect(result!.counts).toEqual({ total: 3, completed: 1, in_progress: 1, pending: 1 });

      const rows = db.select().from(chatTodos).all();
      expect(rows.length).toBe(1);
      expect(rows[0].chatId).toBe(chatId);
      const stored = JSON.parse(rows[0].todosJson);
      expect(stored).toHaveLength(3);
      expect(stored[0].content).toBe("Analyze codebase");
      expect(stored[0].status).toBe("completed");
      expect(stored[0].activeForm).toBe("Analyzing codebase");
    });

    it("accepts JSON-string input (some SDK paths deliver it unparsed)", () => {
      const input = JSON.stringify({
        todos: [{ content: "t1", status: "pending", activeForm: "doing t1" }],
      });
      const result = todoStore.recordTodoWrite({ chatId, input });
      expect(result).not.toBeNull();
      expect(result!.counts.total).toBe(1);
      expect(db.select().from(chatTodos).all().length).toBe(1);
    });

    it("persists taskId when provided", () => {
      // FK enforcement requires an actual tasks row.
      sqlite.exec(`INSERT INTO tasks (id, project_id) VALUES (77, NULL)`);

      const result = todoStore.recordTodoWrite({
        chatId,
        taskId: 77,
        input: { todos: [{ content: "x", status: "pending" }] },
      });
      expect(result).not.toBeNull();
      const row = db.select().from(chatTodos).where(eq(chatTodos.id, result!.rowId)).get()!;
      expect(row.taskId).toBe(77);
    });
  });

  describe("recordTodoWrite — dedup", () => {
    it("does not insert a second row for an identical snapshot", () => {
      const input = {
        todos: [
          { content: "a", status: "completed", activeForm: "doing a" },
          { content: "b", status: "in_progress", activeForm: "doing b" },
        ],
      };

      const first = todoStore.recordTodoWrite({ chatId, input });
      const second = todoStore.recordTodoWrite({ chatId, input });

      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(db.select().from(chatTodos).all().length).toBe(1);
    });

    it("inserts a new row when status changes", () => {
      todoStore.recordTodoWrite({
        chatId,
        input: { todos: [{ content: "a", status: "pending", activeForm: "doing a" }] },
      });
      const second = todoStore.recordTodoWrite({
        chatId,
        input: { todos: [{ content: "a", status: "completed", activeForm: "doing a" }] },
      });
      expect(second).not.toBeNull();
      expect(db.select().from(chatTodos).all().length).toBe(2);
    });

    it("scopes dedup per-chat (identical snapshot in another chat still inserts)", () => {
      const other = db.insert(chats).values({ title: "other" }).returning().get()!;
      const input = { todos: [{ content: "a", status: "pending" as const }] };
      todoStore.recordTodoWrite({ chatId, input });
      const result = todoStore.recordTodoWrite({ chatId: other.id, input });
      expect(result).not.toBeNull();
      expect(db.select().from(chatTodos).all().length).toBe(2);
    });

    it("scopes dedup per-agent within the same chat (sub-agent's identical snapshot still inserts)", () => {
      // Without parent-scoped dedup, a sub-agent emitting an identical
      // [step] plan to the main agent would be silently swallowed —
      // collapsing two distinct timelines into one. Each agent gets its
      // own dedup boundary, so identical snapshots from different
      // parent_tool_use_ids land as separate rows.
      const input = { todos: [{ content: "step", status: "pending" as const }] };
      const a = todoStore.recordTodoWrite({ chatId, input });
      const b = todoStore.recordTodoWrite({
        chatId,
        parentToolUseId: "toolu_sub_a",
        input,
      });
      const c = todoStore.recordTodoWrite({
        chatId,
        parentToolUseId: "toolu_sub_b",
        input,
      });
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(c).not.toBeNull();
      const rows = db.select().from(chatTodos).all();
      expect(rows.length).toBe(3);
      // Ensure the column was actually written. NULL for the main agent;
      // distinct toolu_… values for the two sub-agents.
      const parents = rows.map((r) => r.parentToolUseId).sort((x, y) => String(x).localeCompare(String(y)));
      expect(parents).toEqual([null, "toolu_sub_a", "toolu_sub_b"]);
    });

    it("dedups within the same parent_tool_use_id (an agent re-emitting identical todos still no-ops)", () => {
      const input = { todos: [{ content: "step", status: "pending" as const }] };
      const first = todoStore.recordTodoWrite({
        chatId,
        parentToolUseId: "toolu_sub_a",
        input,
      });
      const second = todoStore.recordTodoWrite({
        chatId,
        parentToolUseId: "toolu_sub_a",
        input,
      });
      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(db.select().from(chatTodos).all().length).toBe(1);
    });
  });

  describe("recordTodoWrite — invalid shapes", () => {
    it("skips when the input is missing `todos`", () => {
      const result = todoStore.recordTodoWrite({ chatId, input: { nothing: "here" } });
      expect(result).toBeNull();
      expect(db.select().from(chatTodos).all().length).toBe(0);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("skips when an entry has a non-string status", () => {
      const result = todoStore.recordTodoWrite({
        chatId,
        input: { todos: [{ content: "a", status: 1 }] },
      });
      expect(result).toBeNull();
      expect(db.select().from(chatTodos).all().length).toBe(0);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("skips when an entry is missing `content`", () => {
      const result = todoStore.recordTodoWrite({
        chatId,
        input: { todos: [{ status: "pending" }] },
      });
      expect(result).toBeNull();
      expect(db.select().from(chatTodos).all().length).toBe(0);
    });

    it("skips when `todos` is not an array", () => {
      const result = todoStore.recordTodoWrite({ chatId, input: { todos: "oops" } });
      expect(result).toBeNull();
      expect(db.select().from(chatTodos).all().length).toBe(0);
    });

    it("skips when input is a non-JSON string", () => {
      const result = todoStore.recordTodoWrite({ chatId, input: "{ not json" });
      expect(result).toBeNull();
      expect(db.select().from(chatTodos).all().length).toBe(0);
    });

    it("skips on null/undefined without throwing", () => {
      expect(() => todoStore.recordTodoWrite({ chatId, input: null })).not.toThrow();
      expect(() => todoStore.recordTodoWrite({ chatId, input: undefined })).not.toThrow();
      expect(db.select().from(chatTodos).all().length).toBe(0);
    });
  });

  describe("recordTodoWrite — oversize", () => {
    it("rejects a snapshot with > 100 entries and emits a single warning", () => {
      const todos = Array.from({ length: 101 }, (_, i) => ({
        content: `t${i}`,
        status: "pending" as const,
      }));
      const result = todoStore.recordTodoWrite({ chatId, input: { todos } });

      expect(result).toBeNull();
      expect(db.select().from(chatTodos).all().length).toBe(0);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toMatch(/oversize/i);
    });

    it("accepts exactly 100 entries (boundary)", () => {
      const todos = Array.from({ length: 100 }, (_, i) => ({
        content: `t${i}`,
        status: "pending" as const,
      }));
      const result = todoStore.recordTodoWrite({ chatId, input: { todos } });
      expect(result).not.toBeNull();
      expect(result!.counts.total).toBe(100);
    });
  });
});
