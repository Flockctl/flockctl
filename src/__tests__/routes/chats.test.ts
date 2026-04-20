import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { projects } from "../../db/schema.js";

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

vi.mock("../../services/agent-session", async () => {
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

// Mock key selection — return a fake key so AI calls work without real keys in DB
vi.mock("../../services/key-selection", () => ({
  selectKeyForTask: vi.fn().mockResolvedValue({
    id: 1,
    provider: "anthropic",
    keyValue: "sk-test",
    providerType: "api-key",
  }),
}));

// Mock AI client — not used by chat routes after refactor, but kept for any
// adjacent code path that may still import it.
vi.mock("../../services/ai-client", () => ({
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
});
