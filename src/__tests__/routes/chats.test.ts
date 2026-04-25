import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { projects, chats as chatsTable, agentQuestions, aiProviderKeys } from "../../db/schema.js";
import { eq } from "drizzle-orm";

// Capture AgentSession constructor calls across all tests in this file.
const agentSessionCalls: Array<{ opts: any }> = [];
let mockText = "Mocked AI response";
let mockUsage = {
  inputTokens: 100,
  outputTokens: 50,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalCostUsd: 0,
};

vi.mock("../../services/agent-session/index", async () => {
  const { EventEmitter } = await import("events");
  class MockAgentSession extends EventEmitter {
    opts: any;
    constructor(opts: any) {
      super();
      this.opts = opts;
      agentSessionCalls.push({ opts });
    }
    async run() {
      this.emit("text", mockText);
      this.emit("usage", { ...mockUsage });
      this.emit("session_id", "new-session-id");
    }
    abort() { /* no-op */ }
    resolvePermission() { return false; }
  }
  return { AgentSession: MockAgentSession };
});

vi.mock("../../services/agents/registry", () => ({
  getAgent: vi.fn().mockReturnValue({
    renameSession: vi.fn().mockResolvedValue(undefined),
    estimateCost: vi.fn().mockReturnValue(0),
  }),
}));

// Mock key selection — return a fake key so AI calls work without real keys in DB.
// `resolveAllowedKeyIds` is used by chats.ts to enforce the project whitelist,
// so mock it too — default to "no restriction" (empty array) so existing tests
// that don't set `allowedKeyIds` pass unchanged.
vi.mock("../../services/ai/key-selection", () => ({
  selectKeyForTask: vi.fn().mockResolvedValue({
    id: 1,
    provider: "anthropic",
    keyValue: "sk-test",
    providerType: "api-key",
  }),
  resolveAllowedKeyIds: vi.fn().mockReturnValue([]),
}));

// Mock AI client — not used by chat routes after refactor, but kept for any
// adjacent code path that may still import it.
vi.mock("../../services/ai/client", () => ({
  createAIClient: vi.fn().mockReturnValue({
    chat: vi.fn().mockResolvedValue({
      text: "Mocked AI response",
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  }),
}));

describe("Chats API", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let projectId: number;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);

    const p = testDb.db.insert(projects).values({
      name: "Chat Test Project",
    }).returning().get();
    projectId = p!.id;

    // Seed a few aiProviderKeys so persistChatSelection doesn't hit an FK
    // failure when tests supply `keyId` values that the whitelist tests need
    // to exist. Key id 7 is the "allowed" fixture, 42 is the "rejected"
    // fixture, 99 is the "no whitelist configured" fixture.
    testDb.db.insert(aiProviderKeys).values([
      { id: 7, provider: "github_copilot", providerType: "oauth", label: "Copilot Test", isActive: true },
      { id: 42, provider: "github_copilot", providerType: "oauth", label: "Copilot Rejected", isActive: true },
      { id: 99, provider: "anthropic", providerType: "api-key", label: "Anthropic Test", isActive: true },
    ]).run();
  });

  afterAll(() => testDb.sqlite.close());

  // ─── Create ─────────────────────

  describe("POST /chats", () => {
    it("creates a chat with minimal fields", async () => {
      const res = await app.request("/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
      const chat = await res.json();
      expect(chat.id).toBeDefined();
      expect(chat.projectId).toBeNull();
      expect(chat.title).toBeNull();
    });

    it("creates a chat with project and title", async () => {
      const res = await app.request("/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          title: "Architecture Discussion",
        }),
      });
      expect(res.status).toBe(201);
      const chat = await res.json();
      expect(chat.projectId).toBe(projectId);
      expect(chat.title).toBe("Architecture Discussion");
    });

    it("creates multiple chats for same project", async () => {
      const res = await app.request("/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title: "Second Chat" }),
      });
      expect(res.status).toBe(201);
    });
  });

  // ─── List ─────────────────────

  describe("GET /chats", () => {
    it("returns paginated list", async () => {
      const res = await app.request("/chats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toBeDefined();
      expect(body.total).toBeGreaterThanOrEqual(3);
      expect(body.page).toBe(1);
    });

    it("filters by project_id", async () => {
      const res = await app.request(`/chats?project_id=${projectId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.every((c: any) => c.projectId === projectId)).toBe(true);
    });

    it("pagination works", async () => {
      const res = await app.request("/chats?page=1&per_page=1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBe(1);
      expect(body.perPage).toBe(1);
    });

    // Full-text search covers chat title AND message content AND
    // project/workspace name. Seeds a chat with a distinctive title plus a
    // chat whose only mention of the term is in a message body — both must
    // surface, and a non-matching chat must not.
    it("full-text search matches title and message content", async () => {
      const { chats: chatsTbl, chatMessages } = await import("../../db/schema.js");
      const db = testDb.db;

      const byTitle = db.insert(chatsTbl).values({
        projectId,
        title: "Обсуждение zzzSearchTitle plan",
      }).returning().get()!;
      const byBody = db.insert(chatsTbl).values({
        projectId,
        title: "Unrelated title",
      }).returning().get()!;
      db.insert(chatsTbl).values({
        projectId,
        title: "Another chat, no match",
      }).run();
      db.insert(chatMessages).values({
        chatId: byBody.id,
        role: "user",
        content: "Let's talk about zzzSearchTitle later",
      }).run();

      const res = await app.request("/chats?q=zzzSearchTitle");
      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.items.map((c: any) => c.id);
      expect(ids).toContain(byTitle.id);
      expect(ids).toContain(byBody.id);
      // Non-matching chats from prior tests must not leak in.
      expect(body.items.every((c: any) =>
        (c.title ?? "").includes("zzzSearchTitle") ||
        // Body-match chats don't have the term in title; allow them through.
        c.id === byBody.id
      )).toBe(true);
    });

    it("full-text search escapes LIKE wildcards", async () => {
      // Neither the `%` nor the `_` should act as a wildcard — the query
      // must be treated as a literal substring, so a search for `%` must
      // NOT return every chat in the table.
      const res = await app.request("/chats?q=%25"); // decoded: "%"
      expect(res.status).toBe(200);
      const body = await res.json();
      // No seeded chat/message contains a literal "%", so the result set
      // must be empty. If the escape is dropped, this will match everything.
      expect(body.items.length).toBe(0);
    });
  });

  // ─── Get single ─────────────────────

  describe("GET /chats/:id", () => {
    it("returns chat with messages", async () => {
      const res = await app.request("/chats/2");
      expect(res.status).toBe(200);
      const chat = await res.json();
      expect(chat.id).toBe(2);
      expect(chat.title).toBe("Architecture Discussion");
      expect(chat.messages).toEqual([]);
      // Idle chat — no session is registered, so isRunning must be false.
      expect(chat.isRunning).toBe(false);
    });

    it("returns 404 for non-existent chat", async () => {
      const res = await app.request("/chats/999");
      expect(res.status).toBe(404);
    });

    it("reports isRunning=true while a session is registered", async () => {
      const { chatExecutor } = await import("../../services/chat-executor.js");
      const fakeSession = { on: () => {}, abort: () => {}, resolvePermission: () => false } as any;
      chatExecutor.register(2, fakeSession);
      try {
        const res = await app.request("/chats/2");
        const body = await res.json();
        expect(body.isRunning).toBe(true);
      } finally {
        chatExecutor.unregister(2);
      }
    });

    // Regression for the "Response was not received" flash on chat switch.
    // Between the `chat_messages` insert and `chatExecutor.register`, the
    // message route calls `chatExecutor.claim(id)` so that a racing GET
    // during setup still reports `isRunning=true` instead of the torn state
    // (user row committed, session not yet registered) that used to trigger
    // the UI fallback. See chat-executor.ts + routes/chats/messages.ts.
    it("reports isRunning=true while a chat is claimed but not yet registered", async () => {
      const { chatExecutor } = await import("../../services/chat-executor.js");
      chatExecutor.claim(2);
      try {
        const res = await app.request("/chats/2");
        const body = await res.json();
        expect(body.isRunning).toBe(true);
      } finally {
        chatExecutor.release(2);
      }
    });
  });

  // ─── Messages ─────────────────────

  describe("POST /chats/:id/messages", () => {
    it("sends user message and gets AI response", async () => {
      const res = await app.request("/chats/2/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "user",
          content: "How should we design the API?",
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      // Returns both user message and AI response
      expect(body.userMessage.role).toBe("user");
      expect(body.userMessage.content).toBe("How should we design the API?");
      expect(body.userMessage.chatId).toBe(2);
      expect(body.assistantMessage.role).toBe("assistant");
      expect(body.assistantMessage.content).toBe("Mocked AI response");
      expect(body.usage.inputTokens).toBe(100);
      expect(body.usage.outputTokens).toBe(50);
    });

    it("adds an assistant message without AI call", async () => {
      const res = await app.request("/chats/2/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "assistant",
          content: "I suggest using REST with Hono.",
        }),
      });
      expect(res.status).toBe(201);
      const msg = await res.json();
      expect(msg.role).toBe("assistant");
      // Non-user messages return just the saved message, no AI call
      expect(msg.content).toBe("I suggest using REST with Hono.");
    });

    it("defaults role to user and triggers AI", async () => {
      const res = await app.request("/chats/2/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "No role specified" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.userMessage.role).toBe("user");
      expect(body.assistantMessage.role).toBe("assistant");
    });

    it("returns 404 for message on non-existent chat", async () => {
      const res = await app.request("/chats/999/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "orphan" }),
      });
      expect(res.status).toBe(404);
    });

    it("GET chat includes all messages in order", async () => {
      const res = await app.request("/chats/2");
      expect(res.status).toBe(200);
      const chat = await res.json();
      // user + AI response + assistant (manual) + user + AI response = 5+
      expect(chat.messages.length).toBeGreaterThanOrEqual(5);
      expect(chat.messages[0].role).toBe("user");
      expect(chat.messages[1].role).toBe("assistant"); // AI response
    });

    it("accepts custom model and system prompt", async () => {
      agentSessionCalls.length = 0;
      mockText = "Custom model response";
      mockUsage = { inputTokens: 200, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 };

      const res = await app.request("/chats/2/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Test with custom model",
          model: "claude-opus-4-20250514",
          system: "You are a code reviewer.",
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.assistantMessage.content).toBe("Custom model response");
      // Verify custom model/system were passed to AgentSession
      const opts = agentSessionCalls[0].opts;
      expect(opts.model).toBe("claude-opus-4-20250514");
      expect(opts.systemPromptOverride).toBe("You are a code reviewer.");

      // Restore defaults for subsequent tests
      mockText = "Mocked AI response";
      mockUsage = { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 };
    });

    it("records usage with cache tokens in response", async () => {
      mockText = "Cache test";
      mockUsage = {
        inputTokens: 500,
        outputTokens: 200,
        cacheCreationInputTokens: 300,
        cacheReadInputTokens: 150,
        totalCostUsd: 0,
      };

      const res = await app.request("/chats/2/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Check cache tracking" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.usage.inputTokens).toBe(500);
      expect(body.usage.outputTokens).toBe(200);
      expect(body.usage.cacheCreationInputTokens).toBe(300);
      expect(body.usage.cacheReadInputTokens).toBe(150);
      expect(body.usage.costUsd).toBeGreaterThanOrEqual(0);

      // Restore defaults for subsequent tests
      mockText = "Mocked AI response";
      mockUsage = { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 };
    });

    it("applies sliding window for long conversations", async () => {
      agentSessionCalls.length = 0;
      mockText = "Windowed response";
      mockUsage = { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 };

      // Create a new chat and fill it with many messages
      const chatRes = await app.request("/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Long chat" }),
      });
      const longChat = await chatRes.json();

      // Add 60 pairs of messages (120 total) via direct DB insert
      const { chatMessages: chatMsgsTable } = await import("../../db/schema.js");
      for (let i = 0; i < 60; i++) {
        testDb.db.insert(chatMsgsTable).values({ chatId: longChat.id, role: "user", content: `msg-${i}` }).run();
        testDb.db.insert(chatMsgsTable).values({ chatId: longChat.id, role: "assistant", content: `reply-${i}` }).run();
      }

      // Send one more message — should trigger sliding window
      const res = await app.request(`/chats/${longChat.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Latest question" }),
      });
      expect(res.status).toBe(201);

      // AgentSession gets priorMessages (history w/o the just-inserted user msg)
      // plus prompt = "Latest question". priorMessages is capped at 50-1 = 49.
      const opts = agentSessionCalls[0].opts;
      const priorMessages = opts.priorMessages ?? [];
      const callArgs = {
        messages: [...priorMessages, { role: "user", content: opts.prompt }],
      };
      expect(callArgs.messages.length).toBeLessThanOrEqual(50);
      // Last message should be the new one
      expect(callArgs.messages[callArgs.messages.length - 1].content).toBe("Latest question");
      // First message should be user (Anthropic requirement)
      expect(callArgs.messages[0].role).toBe("user");
    });
  });

  // ─── allowedKeyIds whitelist enforcement ───────────────────
  //
  // Chats whose project sets `allowedKeyIds` must reject requests (and the
  // stored / default fallbacks) that resolve to a key outside the whitelist.
  // Silently swapping to a different provider was the original bug: the UI
  // showed Copilot but Claude Code actually ran.
  describe("POST /chats/:id/messages — allowedKeyIds whitelist", () => {
    it("rejects an explicit keyId that is not in the project's allowedKeyIds", async () => {
      const { resolveAllowedKeyIds } = await import("../../services/ai/key-selection.js");
      (resolveAllowedKeyIds as ReturnType<typeof vi.fn>).mockReturnValueOnce([1]);

      const res = await app.request("/chats/2/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "try copilot", keyId: 42 }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/not allowed for this chat's project/);
      expect(body.error).toMatch(/#42/);
      // Hint should mention allowedKeyIds or the whitelist
      expect(body.error).toMatch(/allowed/i);
    });

    it("allows an explicit keyId that is in the whitelist", async () => {
      const { resolveAllowedKeyIds } = await import("../../services/ai/key-selection.js");
      (resolveAllowedKeyIds as ReturnType<typeof vi.fn>).mockReturnValueOnce([1, 7]);

      const res = await app.request("/chats/2/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "allowed key", keyId: 7 }),
      });
      expect(res.status).toBe(201);
    });

    it("lets requests through when no whitelist is configured", async () => {
      const { resolveAllowedKeyIds } = await import("../../services/ai/key-selection.js");
      (resolveAllowedKeyIds as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);

      const res = await app.request("/chats/2/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "no whitelist", keyId: 99 }),
      });
      expect(res.status).toBe(201);
    });

    it("rejects disallowed keys on the streaming endpoint too", async () => {
      const { resolveAllowedKeyIds } = await import("../../services/ai/key-selection.js");
      (resolveAllowedKeyIds as ReturnType<typeof vi.fn>).mockReturnValueOnce([1]);

      const res = await app.request("/chats/2/messages/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "stream copilot", keyId: 42 }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/not allowed for this chat's project/);
    });
  });

  // ─── Metrics ─────────────────────

  describe("GET /chats/:id/metrics", () => {
    it("returns metrics for chat with messages and usage", async () => {
      // Chat 2 has messages from earlier send tests
      const res = await app.request("/chats/2/metrics");
      expect(res.status).toBe(200);
      const metrics = await res.json();

      expect(metrics.chatId).toBe(2);
      expect(metrics.createdAt).toBeDefined();
      expect(metrics.updatedAt).toBeDefined();
      expect(metrics.messageCount).toBeGreaterThanOrEqual(5);
      expect(metrics.userMessageCount).toBeGreaterThanOrEqual(2);
      expect(metrics.assistantMessageCount).toBeGreaterThanOrEqual(2);
      expect(metrics.totalInputTokens).toBeGreaterThanOrEqual(0);
      expect(metrics.totalOutputTokens).toBeGreaterThanOrEqual(0);
      expect(metrics.totalCostUsd).toBeGreaterThanOrEqual(0);
      expect(metrics.totalCacheCreationTokens).toBeGreaterThanOrEqual(0);
      expect(metrics.totalCacheReadTokens).toBeGreaterThanOrEqual(0);
      expect(metrics.modelsUsed).toBeInstanceOf(Array);
      expect(metrics.lastMessageAt).toBeDefined();
    });

    it("returns zero metrics for empty chat", async () => {
      // Create a fresh empty chat
      const createRes = await app.request("/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Empty metrics" }),
      });
      const emptyChat = await createRes.json();

      const res = await app.request(`/chats/${emptyChat.id}/metrics`);
      expect(res.status).toBe(200);
      const metrics = await res.json();

      expect(metrics.messageCount).toBe(0);
      expect(metrics.totalInputTokens).toBe(0);
      expect(metrics.totalOutputTokens).toBe(0);
      expect(metrics.totalCostUsd).toBe(0);
      expect(metrics.modelsUsed).toEqual([]);
      expect(metrics.lastMessageAt).toBeNull();
    });

    it("returns 404 for non-existent chat", async () => {
      const res = await app.request("/chats/999/metrics");
      expect(res.status).toBe(404);
    });
  });

  // ─── Metrics in list and detail ─────────────────────

  describe("Inline metrics", () => {
    it("GET /chats includes metrics in list items", async () => {
      const res = await app.request("/chats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBeGreaterThan(0);
      for (const item of body.items) {
        expect(item.metrics).toBeDefined();
        expect(typeof item.metrics.messageCount).toBe("number");
        expect(typeof item.metrics.totalCostUsd).toBe("number");
      }
    });

    it("GET /chats/:id includes metrics", async () => {
      const res = await app.request("/chats/2");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.metrics).toBeDefined();
      expect(body.metrics.messageCount).toBeGreaterThanOrEqual(5);
      expect(typeof body.metrics.totalCostUsd).toBe("number");
      expect(body.metrics.lastMessageAt).toBeDefined();
    });
  });

  // ─── Todos ─────────────────────

  describe("GET /chats/:id/todos", () => {
    it("returns 204 when chat has no snapshots", async () => {
      const createRes = await app.request("/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Todos empty" }),
      });
      const chat = await createRes.json();

      const res = await app.request(`/chats/${chat.id}/todos`);
      expect(res.status).toBe(204);
      // 204 must have an empty body — RFC 7230.
      const text = await res.text();
      expect(text).toBe("");
    });

    it("returns the latest snapshot + counts when present", async () => {
      const createRes = await app.request("/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Todos populated" }),
      });
      const chat = await createRes.json();

      const { chatTodos: chatTodosTable } = await import("../../db/schema.js");
      // Insert two snapshots — the endpoint must pick the newer one.
      testDb.db.insert(chatTodosTable).values({
        chatId: chat.id,
        todosJson: JSON.stringify([
          { content: "old", status: "pending" },
        ]),
        createdAt: "2024-01-01T00:00:00Z",
      }).run();
      const newer = testDb.db.insert(chatTodosTable).values({
        chatId: chat.id,
        todosJson: JSON.stringify([
          { content: "write code", status: "in_progress", activeForm: "writing" },
          { content: "write tests", status: "pending" },
          { content: "ship", status: "completed" },
        ]),
        createdAt: "2024-06-01T00:00:00Z",
      }).returning().get();

      const res = await app.request(`/chats/${chat.id}/todos`);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.snapshot).toBeDefined();
      expect(body.snapshot.id).toBe(newer!.id);
      expect(body.snapshot.createdAt).toBe("2024-06-01T00:00:00Z");
      expect(body.snapshot.todos).toHaveLength(3);
      expect(body.snapshot.todos[0].content).toBe("write code");
      expect(body.snapshot.todos[0].activeForm).toBe("writing");

      expect(body.counts).toEqual({
        total: 3,
        completed: 1,
        in_progress: 1,
        pending: 1,
      });
    });

    it("returns 404 for non-existent chat", async () => {
      const res = await app.request("/chats/999999/todos");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /chats/:id/todos/history", () => {
    it("returns paginated list of snapshots (newest first)", async () => {
      const createRes = await app.request("/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Todos history" }),
      });
      const chat = await createRes.json();

      const { chatTodos: chatTodosTable } = await import("../../db/schema.js");
      // Insert 3 snapshots at distinct timestamps.
      const inputs = [
        { ts: "2024-01-01T00:00:00Z", todos: [{ content: "a", status: "pending" }] },
        { ts: "2024-02-01T00:00:00Z", todos: [{ content: "a", status: "in_progress" }] },
        {
          ts: "2024-03-01T00:00:00Z",
          todos: [
            { content: "a", status: "completed" },
            { content: "b", status: "pending" },
          ],
        },
      ];
      for (const s of inputs) {
        testDb.db.insert(chatTodosTable).values({
          chatId: chat.id,
          todosJson: JSON.stringify(s.todos),
          createdAt: s.ts,
        }).run();
      }

      // Default page — all three, newest first.
      const res = await app.request(`/chats/${chat.id}/todos/history`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(3);
      expect(body.total).toBe(3);
      expect(body.page).toBe(1);
      expect(body.perPage).toBe(20);
      expect(body.items[0].createdAt).toBe("2024-03-01T00:00:00Z");
      expect(body.items[2].createdAt).toBe("2024-01-01T00:00:00Z");

      // Counts computed per snapshot.
      expect(body.items[0].counts).toEqual({ total: 2, completed: 1, in_progress: 0, pending: 1 });
      expect(body.items[1].counts).toEqual({ total: 1, completed: 0, in_progress: 1, pending: 0 });
      expect(body.items[2].counts).toEqual({ total: 1, completed: 0, in_progress: 0, pending: 1 });

      // Page 1 of 2 per page — newest row only.
      const page1 = await app.request(`/chats/${chat.id}/todos/history?page=1&per_page=2`);
      const page1Body = await page1.json();
      expect(page1Body.items).toHaveLength(2);
      expect(page1Body.items[0].createdAt).toBe("2024-03-01T00:00:00Z");
      expect(page1Body.items[1].createdAt).toBe("2024-02-01T00:00:00Z");
      expect(page1Body.total).toBe(3);
      expect(page1Body.perPage).toBe(2);

      // Page 2 — oldest row.
      const page2 = await app.request(`/chats/${chat.id}/todos/history?page=2&per_page=2`);
      const page2Body = await page2.json();
      expect(page2Body.items).toHaveLength(1);
      expect(page2Body.items[0].createdAt).toBe("2024-01-01T00:00:00Z");
      expect(page2Body.page).toBe(2);
    });

    it("returns empty items when chat has no snapshots", async () => {
      const createRes = await app.request("/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Todos history empty" }),
      });
      const chat = await createRes.json();

      const res = await app.request(`/chats/${chat.id}/todos/history`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("returns 404 for non-existent chat", async () => {
      const res = await app.request("/chats/999999/todos/history");
      expect(res.status).toBe(404);
    });

    it("filters by ?agent=main to scope history to the main agent only", async () => {
      const createRes = await app.request("/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Todos history main filter" }),
      });
      const chat = await createRes.json();

      const { chatTodos: chatTodosTable } = await import("../../db/schema.js");
      // Two snapshots from main (parent_tool_use_id NULL), one from a sub-agent.
      testDb.db.insert(chatTodosTable).values({
        chatId: chat.id,
        todosJson: JSON.stringify([{ content: "main1", status: "pending" }]),
        createdAt: "2024-01-01T00:00:00Z",
      }).run();
      testDb.db.insert(chatTodosTable).values({
        chatId: chat.id,
        todosJson: JSON.stringify([{ content: "main2", status: "pending" }]),
        createdAt: "2024-01-02T00:00:00Z",
      }).run();
      testDb.db.insert(chatTodosTable).values({
        chatId: chat.id,
        parentToolUseId: "toolu_sub_a",
        todosJson: JSON.stringify([{ content: "sub", status: "pending" }]),
        createdAt: "2024-01-03T00:00:00Z",
      }).run();

      const res = await app.request(`/chats/${chat.id}/todos/history?agent=main`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(2);
      expect(body.items.map((it: any) => it.todos[0].content)).toEqual(["main2", "main1"]);
      // Snapshots from main MUST carry a NULL parent_tool_use_id on the wire.
      expect(body.items.every((it: any) => it.parentToolUseId === null)).toBe(true);
    });

    it("filters by ?agent=<toolu_id> to scope history to one sub-agent", async () => {
      const createRes = await app.request("/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Todos history sub filter" }),
      });
      const chat = await createRes.json();
      const { chatTodos: chatTodosTable } = await import("../../db/schema.js");
      testDb.db.insert(chatTodosTable).values({
        chatId: chat.id,
        todosJson: JSON.stringify([{ content: "main", status: "pending" }]),
        createdAt: "2024-01-01T00:00:00Z",
      }).run();
      testDb.db.insert(chatTodosTable).values({
        chatId: chat.id,
        parentToolUseId: "toolu_sub_a",
        todosJson: JSON.stringify([{ content: "sub-a", status: "pending" }]),
        createdAt: "2024-01-02T00:00:00Z",
      }).run();
      testDb.db.insert(chatTodosTable).values({
        chatId: chat.id,
        parentToolUseId: "toolu_sub_b",
        todosJson: JSON.stringify([{ content: "sub-b", status: "pending" }]),
        createdAt: "2024-01-03T00:00:00Z",
      }).run();

      const res = await app.request(`/chats/${chat.id}/todos/history?agent=toolu_sub_a`);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.items[0].todos[0].content).toBe("sub-a");
      expect(body.items[0].parentToolUseId).toBe("toolu_sub_a");
    });

    it("rejects an empty ?agent= as 422 (defense-in-depth, not a NULL match)", async () => {
      const createRes = await app.request("/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Todos history empty agent" }),
      });
      const chat = await createRes.json();
      const res = await app.request(`/chats/${chat.id}/todos/history?agent=`);
      expect(res.status).toBe(422);
    });
  });

  // ─── Per-agent grouping ──────────

  describe("GET /chats/:id/todos/agents", () => {
    it("returns empty items when chat has no snapshots", async () => {
      const createRes = await app.request("/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Agents empty" }),
      });
      const chat = await createRes.json();
      const res = await app.request(`/chats/${chat.id}/todos/agents`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toEqual([]);
    });

    it("groups by parent_tool_use_id, annotates completedAt, resolves Task labels", async () => {
      const createRes = await app.request("/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Agents grouped" }),
      });
      const chat = await createRes.json();

      const { chatTodos: chatTodosTable, chatMessages: chatMessagesTable } =
        await import("../../db/schema.js");

      // Main agent emits two snapshots — second marks the first todo done.
      testDb.db.insert(chatTodosTable).values({
        chatId: chat.id,
        todosJson: JSON.stringify([
          { content: "plan", status: "in_progress" },
          { content: "ship", status: "pending" },
        ]),
        createdAt: "2024-01-01T00:00:00Z",
      }).run();
      testDb.db.insert(chatTodosTable).values({
        chatId: chat.id,
        todosJson: JSON.stringify([
          { content: "plan", status: "completed" },
          { content: "ship", status: "in_progress" },
        ]),
        createdAt: "2024-01-02T00:00:00Z",
      }).run();

      // Sub-agent A — one snapshot.
      testDb.db.insert(chatTodosTable).values({
        chatId: chat.id,
        parentToolUseId: "toolu_sub_a",
        todosJson: JSON.stringify([{ content: "child task", status: "pending" }]),
        createdAt: "2024-01-03T00:00:00Z",
      }).run();

      // Spawning Task tool message for sub-agent A. The /agents route reads
      // chat_messages where role='tool', parses the JSON content, and matches
      // tool_use_id to recover the description for the tab label.
      testDb.db.insert(chatMessagesTable).values({
        chatId: chat.id,
        role: "tool",
        content: JSON.stringify({
          kind: "call",
          name: "Task",
          input: { description: "tester-1", subagent_type: "general-purpose" },
          summary: "Task: tester-1",
          parent_tool_use_id: null,
          tool_use_id: "toolu_sub_a",
        }),
        createdAt: "2024-01-03T00:00:00Z",
      }).run();

      const res = await app.request(`/chats/${chat.id}/todos/agents`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(2);

      // Main agent first (insertion order).
      const main = body.items[0];
      expect(main.key).toBe("main");
      expect(main.parentToolUseId).toBeNull();
      expect(main.label).toBe("Main agent");
      expect(main.snapshotCount).toBe(2);
      expect(main.latest.todos).toHaveLength(2);
      // The completed `plan` todo should carry completedAt = the timestamp
      // of the snapshot in which it first transitioned to completed.
      const planTodo = main.latest.todos.find((t: any) => t.content === "plan");
      expect(planTodo.completedAt).toBe("2024-01-02T00:00:00Z");
      const shipTodo = main.latest.todos.find((t: any) => t.content === "ship");
      expect(shipTodo.completedAt).toBeNull();

      // Sub-agent — label resolved from the Task call.
      const subA = body.items[1];
      expect(subA.key).toBe("toolu_sub_a");
      expect(subA.label).toBe("tester-1");
      expect(subA.subagentType).toBe("general-purpose");
      expect(subA.snapshotCount).toBe(1);
    });

    it("falls back to 'Sub-agent <suffix>' when no spawning Task message is found", async () => {
      const createRes = await app.request("/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Agents fallback label" }),
      });
      const chat = await createRes.json();
      const { chatTodos: chatTodosTable } = await import("../../db/schema.js");
      testDb.db.insert(chatTodosTable).values({
        chatId: chat.id,
        parentToolUseId: "toolu_orphan_xyz123",
        todosJson: JSON.stringify([{ content: "orphan", status: "pending" }]),
        createdAt: "2024-01-01T00:00:00Z",
      }).run();

      const res = await app.request(`/chats/${chat.id}/todos/agents`);
      const body = await res.json();
      expect(body.items[0].label).toBe("Sub-agent xyz123");
      expect(body.items[0].subagentType).toBeNull();
    });

    it("returns 404 for unknown chat", async () => {
      const res = await app.request("/chats/999999/todos/agents");
      expect(res.status).toBe(404);
    });
  });

  // ─── Delete ─────────────────────

  describe("DELETE /chats/:id", () => {
    it("deletes a chat", async () => {
      const res = await app.request("/chats/1", { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);

      // Verify it's gone
      const getRes = await app.request("/chats/1");
      expect(getRes.status).toBe(404);
    });

    it("returns 404 for already deleted chat", async () => {
      const res = await app.request("/chats/1", { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("returns 404 for non-existent chat", async () => {
      const res = await app.request("/chats/999", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  // ─── Question /answer endpoints ─────────────────────────────────────────
  describe("POST /chats/:id/question/:requestId/answer", () => {
    function insertChat(title = "question-chat"): number {
      const row = testDb.db.insert(chatsTable).values({ title }).returning().get();
      return row!.id;
    }

    function insertQuestion(opts: {
      chatId: number;
      requestId: string;
      status?: "pending" | "answered" | "cancelled";
    }): void {
      testDb.db.insert(agentQuestions).values({
        requestId: opts.requestId,
        chatId: opts.chatId,
        toolUseId: `tu-${opts.requestId}`,
        question: "please clarify",
        status: opts.status ?? "pending",
        answer: opts.status === "answered" ? "prior answer" : null,
        answeredAt: opts.status === "answered" ? new Date().toISOString() : null,
      }).run();
    }

    async function hit(chatId: number | string, requestId: string, body: unknown): Promise<Response> {
      return app.request(`/chats/${chatId}/question/${requestId}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("answers a pending question", async () => {
      const chatId = insertChat();
      insertQuestion({ chatId, requestId: "cq-ok-1" });

      const { chatExecutor } = await import("../../services/chat-executor.js");
      const spy = vi.spyOn(chatExecutor, "answerQuestion").mockImplementation(() => {
        testDb.db.update(agentQuestions)
          .set({ status: "answered", answer: "hello", answeredAt: new Date().toISOString() })
          .where(eq(agentQuestions.requestId, "cq-ok-1"))
          .run();
        return true;
      });

      try {
        const res = await hit(chatId, "cq-ok-1", { answer: "hello" });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(spy).toHaveBeenCalledWith(chatId, "cq-ok-1", "hello");
      } finally {
        spy.mockRestore();
      }
    });

    it("returns 404 when the requestId is unknown", async () => {
      const chatId = insertChat();
      const res = await hit(chatId, "missing", { answer: "hi" });
      expect(res.status).toBe(404);
    });

    it("returns 404 when the requestId belongs to another chat", async () => {
      const ownerChat = insertChat();
      const otherChat = insertChat();
      insertQuestion({ chatId: ownerChat, requestId: "cq-other-1" });

      const res = await hit(otherChat, "cq-other-1", { answer: "hi" });
      expect(res.status).toBe(404);
    });

    it("returns 400 for an oversize answer (> 8000 chars)", async () => {
      const chatId = insertChat();
      insertQuestion({ chatId, requestId: "cq-size-1" });

      const res = await hit(chatId, "cq-size-1", { answer: "x".repeat(8001) });
      expect(res.status).toBe(400);
    });

    it("returns 400 for an empty answer", async () => {
      const chatId = insertChat();
      insertQuestion({ chatId, requestId: "cq-empty-1" });

      const res = await hit(chatId, "cq-empty-1", { answer: "" });
      expect(res.status).toBe(400);
    });

    it("returns 409 when the question is already answered", async () => {
      const chatId = insertChat();
      insertQuestion({ chatId, requestId: "cq-dup-1", status: "answered" });

      const res = await hit(chatId, "cq-dup-1", { answer: "again" });
      expect(res.status).toBe(409);
    });

    it("returns 404 when the chat does not exist", async () => {
      const res = await hit(999999, "anything", { answer: "hi" });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /chats/:id/questions", () => {
    it("lists pending questions for the chat", async () => {
      const chat = testDb.db.insert(chatsTable).values({ title: "list-questions-chat" }).returning().get();
      const chatId = chat!.id;

      testDb.db.insert(agentQuestions).values({
        requestId: "cq-list-1",
        chatId,
        toolUseId: "tu-clist-1",
        question: "confirm?",
        status: "pending",
      }).run();
      testDb.db.insert(agentQuestions).values({
        requestId: "cq-list-done",
        chatId,
        toolUseId: "tu-clist-done",
        question: "old",
        status: "answered",
        answer: "ok",
        answeredAt: new Date().toISOString(),
      }).run();

      const res = await app.request(`/chats/${chatId}/questions`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].requestId).toBe("cq-list-1");
    });

    it("returns 404 for a missing chat", async () => {
      const res = await app.request("/chats/999999/questions");
      expect(res.status).toBe(404);
    });
  });
});
