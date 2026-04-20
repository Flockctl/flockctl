import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { projects, chats, chatMessages, usageRecords } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Capture AgentSession constructor calls so tests can assert on options.
const agentSessionCalls: Array<{ opts: any }> = [];

// Mock AgentSession: on run() it emits text chunks then usage + session_id.
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
      this.emit("text", "Hello ");
      this.emit("text", "world");
      this.emit("usage", {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalCostUsd: 0.001,
      });
      this.emit("session_id", "new-session-id");
    }
    abort() { /* no-op */ }
    resolvePermission() { return false; }
  }
  return { AgentSession: MockAgentSession };
});

// Mock agent registry so provider.renameSession + estimateCost are available.
vi.mock("../../services/agents/registry", () => ({
  getAgent: vi.fn().mockReturnValue({
    renameSession: vi.fn().mockResolvedValue(undefined),
    estimateCost: vi.fn().mockReturnValue(0),
  }),
}));

// Mock ai-client — not used by PATCH
vi.mock("../../services/ai-client", () => ({
  createAIClient: vi.fn().mockReturnValue({
    chat: vi.fn().mockResolvedValue({
      text: "non-stream response",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  }),
}));

// Mock claude-cli so any legacy imports resolve without spawning processes.
vi.mock("../../services/claude-cli", () => ({
  streamViaClaudeAgentSDK: vi.fn(),
  renameClaudeSession: vi.fn(() => Promise.resolve()),
  resolveModelId: vi.fn((m: string) => m),
  SUPPORTED_MODELS: [],
}));

describe("Chats — PATCH /chats/:id", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let projectId: number;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    const p = testDb.db.insert(projects).values({ name: "Chat Patch Proj" }).returning().get()!;
    projectId = p.id;
  });

  afterAll(() => testDb.sqlite.close());

  it("updates the chat title", async () => {
    const chat = testDb.db.insert(chats).values({ projectId, title: "Old Title" }).returning().get()!;
    const res = await app.request(`/chats/${chat.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New Title" }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.title).toBe("New Title");
  });

  it("truncates long titles to 200 chars", async () => {
    const chat = testDb.db.insert(chats).values({ projectId }).returning().get()!;
    const longTitle = "x".repeat(300);
    const res = await app.request(`/chats/${chat.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: longTitle }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.title.length).toBeLessThanOrEqual(200);
  });

  it("triggers renameSession when title changes and session exists", async () => {
    const chat = testDb.db.insert(chats).values({
      projectId,
      claudeSessionId: "sess-abc",
    }).returning().get()!;
    const res = await app.request(`/chats/${chat.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(res.status).toBe(200);

    const { getAgent } = await import("../../services/agents/registry.js");
    const provider = (getAgent as any)();
    expect(provider.renameSession).toHaveBeenCalled();
  });

  it("returns 422 when no valid fields provided", async () => {
    const chat = testDb.db.insert(chats).values({ projectId }).returning().get()!;
    const res = await app.request(`/chats/${chat.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unknownField: "x" }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 404 for missing chat", async () => {
    const res = await app.request("/chats/99999", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "X" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("Chats — POST /chats/:id/messages/stream (SSE)", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let chatId: number;
  let projectId: number;
  let projectPath: string;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    projectPath = join(tmpdir(), `flockctl-test-chat-stream-${process.pid}`);
    mkdirSync(join(projectPath, ".flockctl"), { recursive: true });
    const p = testDb.db.insert(projects).values({ name: "Chat Stream Proj", path: projectPath }).returning().get()!;
    projectId = p.id;
    const chat = testDb.db.insert(chats).values({ projectId }).returning().get()!;
    chatId = chat.id;
  });

  afterAll(() => {
    testDb.sqlite.close();
    try { rmSync(projectPath, { recursive: true, force: true }); } catch {}
  });

  it("streams text events and persists assistant message", async () => {
    const res = await app.request(`/chats/${chatId}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Hello?" }),
    });
    expect(res.status).toBe(200);

    // Read the SSE response
    const text = await res.text();
    expect(text).toContain("data:");

    // Verify assistant message was persisted
    const msgs = testDb.db.select().from(chatMessages).where(eq(chatMessages.chatId, chatId)).all();
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("Hello?");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("Hello world");

    // Verify chat session ID was updated
    const updated = testDb.db.select().from(chats).where(eq(chats.id, chatId)).get()!;
    expect(updated.claudeSessionId).toBe("new-session-id");

    // Verify usage record written
    const records = testDb.db.select().from(usageRecords).all();
    expect(records.length).toBeGreaterThan(0);
  });

  it("returns 422 when content is missing", async () => {
    const res = await app.request(`/chats/${chatId}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("returns 404 for missing chat", async () => {
    const res = await app.request("/chats/9999/messages/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("auto-generates title from first response when chat untitled", async () => {
    const chat = testDb.db.insert(chats).values({ projectId }).returning().get()!;
    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "ping" }),
    });
    // Drain the stream fully so the handler's DB writes complete
    await res.text();
    // SSE handler's title update happens right before the "done" event; wait for microtasks
    await new Promise((r) => setTimeout(r, 50));
    const updated = testDb.db.select().from(chats).where(eq(chats.id, chat.id)).get()!;
    expect(updated.title).toBeTruthy();
  });

  it("uses project model when chat is tied to a project with model", async () => {
    writeFileSync(join(projectPath, ".flockctl", "config.yaml"), "model: claude-opus-4-7\n");
    agentSessionCalls.length = 0;

    const chat = testDb.db.insert(chats).values({ projectId }).returning().get()!;
    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "ping" }),
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(agentSessionCalls[0].opts.model).toBe("claude-opus-4-7");
  });

  it("uses entity_context to build system prompt", async () => {
    agentSessionCalls.length = 0;

    const chat = testDb.db.insert(chats).values({ projectId }).returning().get()!;
    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "discuss milestone",
        entity_context: {
          entity_type: "milestone",
          entity_id: "some-milestone-slug",
        },
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    // System prompt should contain entity info
    expect(agentSessionCalls[0].opts.systemPromptOverride).toBeTruthy();
  });
});
