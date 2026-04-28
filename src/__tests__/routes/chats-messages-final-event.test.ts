import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { chats, projects } from "../../db/schema.js";
import Database from "better-sqlite3";

// Hoisted state — `vi.mock` factories run before module-level `const`s, so
// any binding referenced from inside a factory must come from `vi.hoisted`.
//
// `sessionMode` is switchable per-test:
//   "clean" — yields one assistant text chunk and resolves cleanly.
//   "abort" — throws an AbortError mid-yield (no text emitted).
//   "error" — throws a generic Error mid-yield (no text emitted).
//
// `clean` is the only path where `flushPending('stream_end')` actually writes
// a row — pendingText is non-empty at end-of-stream because the fake never
// emits a `turn_end` event, so the text accumulated since the start of the
// run sits in the buffer until the final stream_end flush. `abort` and
// `error` throw BEFORE yielding text, so pendingText stays empty and
// flushPending returns null.
const { sessionMode, broadcastChatAssistantFinal } = vi.hoisted(() => ({
  sessionMode: { mode: "clean" as "clean" | "abort" | "error" },
  broadcastChatAssistantFinal: vi.fn(),
}));

vi.mock("../../services/agent-session/index", async () => {
  const { EventEmitter } = await import("events");
  class MockAgentSession extends EventEmitter {
    opts: any;
    constructor(opts: any) {
      super();
      this.opts = opts;
    }
    async run() {
      if (sessionMode.mode === "clean") {
        this.emit("text", "canonical assistant text");
        this.emit("session_id", "sess-clean");
        this.emit("usage", {
          inputTokens: 1, outputTokens: 1,
          cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0,
        });
        return;
      }
      if (sessionMode.mode === "abort") {
        // AbortError shape Node uses — `name` is the discriminant.
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      // sessionMode.mode === "error"
      throw new Error("generic provider failure");
    }
    abort() { /* no-op */ }
    resolvePermission() { return false; }
  }
  return { AgentSession: MockAgentSession };
});

// Stub chatExecutor — the real one writes to DB on tool_call / unregister
// paths and registers permission handlers we don't exercise here. The
// route only calls a handful of methods, all of which are no-ops for this
// test's purpose (we're asserting on the WS broadcast, not on execution
// state transitions).
vi.mock("../../services/chat-executor", () => ({
  chatExecutor: {
    register: vi.fn(),
    unregister: vi.fn(),
    claim: vi.fn(),
    release: vi.fn(),
    isRunning: vi.fn(),
    cancel: vi.fn(),
    resolvePermission: vi.fn(),
    pendingPermissionCounts: vi.fn(() => ({})),
    runningChatIds: vi.fn(() => []),
    pendingPermissions: vi.fn(() => []),
    markPendingApprovalIfRequired: vi.fn(),
  },
}));

// Mock wsManager so we can spy on broadcastChatAssistantFinal directly.
// Other broadcasters are stubbed because the route + chatExecutor's listeners
// touch them indirectly (broadcastChat, broadcastChatStatus, broadcastAll).
vi.mock("../../services/ws-manager", () => ({
  wsManager: {
    broadcastChat: vi.fn(),
    broadcastChatStatus: vi.fn(),
    broadcastAll: vi.fn(),
    broadcastTaskStatus: vi.fn(),
    broadcastChatAssistantFinal,
  },
}));

vi.mock("../../services/agents/registry", () => ({
  getAgent: vi.fn().mockReturnValue({
    renameSession: vi.fn().mockResolvedValue(undefined),
    estimateCost: vi.fn().mockReturnValue(0),
  }),
}));

vi.mock("../../services/claude/skills-sync", () => ({
  reconcileClaudeSkillsForProject: vi.fn(),
}));
vi.mock("../../services/claude/mcp-sync", () => ({
  reconcileMcpForProject: vi.fn(),
}));

import { app } from "../../server.js";

let db: FlockctlDb;
let sqlite: Database.Database;
let chatId: number;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  const proj = db.insert(projects).values({ name: "final-event-proj" }).returning().get()!;
  const chat = db.insert(chats).values({ projectId: proj.id }).returning().get()!;
  chatId = chat.id;
});

afterAll(() => {
  sqlite.close();
});

beforeEach(() => {
  broadcastChatAssistantFinal.mockReset();
});

describe("chat_assistant_final emission from SSE stream_end branch", () => {
  it("clean turn-end: broadcasts exactly once with the new assistant message id", async () => {
    sessionMode.mode = "clean";
    const res = await app.request(`/chats/${chatId}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "say hi" }),
    });
    expect(res.status).toBe(200);
    await res.text(); // drain SSE so the handler's try-block fully completes

    expect(broadcastChatAssistantFinal).toHaveBeenCalledTimes(1);
    const [calledChatId, calledMessageId] = broadcastChatAssistantFinal.mock.calls[0];
    expect(calledChatId).toBe(chatId);
    // Message id must be a real positive integer — proves flushPending wrote
    // a row before the broadcast (not a phantom emission of a stale value).
    expect(typeof calledMessageId).toBe("number");
    expect(calledMessageId).toBeGreaterThan(0);
  });

  it("AbortError mid-yield: broadcasts zero times (pendingText empty → flushPending returns null)", async () => {
    sessionMode.mode = "abort";
    const res = await app.request(`/chats/${chatId}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "will be aborted" }),
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(broadcastChatAssistantFinal).not.toHaveBeenCalled();
  });

  it("thrown Error mid-yield: broadcasts zero times (errors do not produce a final assistant message)", async () => {
    sessionMode.mode = "error";
    const res = await app.request(`/chats/${chatId}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "will throw" }),
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(broadcastChatAssistantFinal).not.toHaveBeenCalled();
  });
});
