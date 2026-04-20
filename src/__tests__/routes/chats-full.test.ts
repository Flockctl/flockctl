import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { chats, chatMessages, projects, workspaces, aiProviderKeys, usageRecords } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";

const { agentCalls, chatExecutorMock } = vi.hoisted(() => ({
  agentCalls: [] as any[],
  chatExecutorMock: {
    register: vi.fn(),
    unregister: vi.fn(),
    isRunning: vi.fn(),
    cancel: vi.fn(),
    resolvePermission: vi.fn(),
    pendingPermissionCounts: vi.fn(() => ({})),
    runningChatIds: vi.fn<() => number[]>(() => []),
  },
}));

vi.mock("../../services/agent-session", async () => {
  const { EventEmitter } = await import("events");
  class MockAgentSession extends EventEmitter {
    opts: any;
    constructor(opts: any) {
      super();
      this.opts = opts;
      agentCalls.push(this);
    }
    async run() {
      this.emit("text", "Hi ");
      this.emit("text", "there");
      this.emit("session_id", "sess-new");
      this.emit("usage", {
        inputTokens: 12, outputTokens: 8,
        cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0,
      });
    }
    abort() {}
    resolvePermission() { return false; }
  }
  return { AgentSession: MockAgentSession };
});

vi.mock("../../services/chat-executor", () => ({
  chatExecutor: chatExecutorMock,
}));

vi.mock("../../services/agents/registry", () => ({
  getAgent: vi.fn().mockReturnValue({
    renameSession: vi.fn().mockResolvedValue(undefined),
    estimateCost: vi.fn().mockReturnValue(0.0005),
  }),
}));

vi.mock("../../services/claude-skills-sync", () => ({
  reconcileClaudeSkillsForProject: vi.fn(),
}));
vi.mock("../../services/claude-mcp-sync", () => ({
  reconcileMcpForProject: vi.fn(),
}));

import { app } from "../../server.js";

let db: FlockctlDb;
let sqlite: Database.Database;
let tempDir: string;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);
  tempDir = mkdtempSync(join(tmpdir(), "flockctl-chatfull-"));
});

afterAll(() => {
  sqlite.close();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM usage_records;
    DELETE FROM chat_messages;
    DELETE FROM chats;
    DELETE FROM projects;
    DELETE FROM workspaces;
    DELETE FROM ai_provider_keys;
  `);
  agentCalls.length = 0;
  chatExecutorMock.register.mockReset();
  chatExecutorMock.unregister.mockReset();
  chatExecutorMock.isRunning.mockReset();
  chatExecutorMock.cancel.mockReset();
  chatExecutorMock.resolvePermission.mockReset();
  chatExecutorMock.pendingPermissionCounts.mockReturnValue({});
  chatExecutorMock.runningChatIds.mockReturnValue([]);
});

describe("chats — POST /:id/messages (non-stream)", () => {
  it("returns early without AI call when role != 'user'", async () => {
    const chat = db.insert(chats).values({ title: "x" }).returning().get()!;
    const res = await app.request(`/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "system-level", role: "system" }),
    });
    expect(res.status).toBe(201);
    expect(agentCalls.length).toBe(0);
    const msgs = db.select().from(chatMessages).where(eq(chatMessages.chatId, chat.id)).all();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
  });

  it("422 when content missing", async () => {
    const chat = db.insert(chats).values({}).returning().get()!;
    const res = await app.request(`/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("404 when chat missing", async () => {
    const res = await app.request(`/chats/9999/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("runs AI path, persists assistant + usage, resolves configDir from keyId", async () => {
    const key = db.insert(aiProviderKeys).values({
      provider: "anthropic", providerType: "anthropic-messages",
      label: "k", keyValue: "sk-x", isActive: 1, priority: 0,
      configDir: "/tmp/cfg-dir",
    } as any).returning().get()!;

    const projPath = mkdtempSync(join(tempDir, "proj-msg-"));
    const proj = db.insert(projects).values({ name: "mp", path: projPath }).returning().get()!;
    const chat = db.insert(chats).values({ projectId: proj.id }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "hello",
        keyId: key.id,
        system: "Custom system prompt",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.userMessage.content).toBe("hello");
    expect(body.assistantMessage.content).toContain("Hi there");
    // session configDir threaded through
    expect(agentCalls[0].opts.configDir).toBe("/tmp/cfg-dir");
    expect(agentCalls[0].opts.systemPromptOverride).toBe("Custom system prompt");

    // claude_session_id persisted
    const updated = db.select().from(chats).where(eq(chats.id, chat.id)).get()!;
    expect(updated.claudeSessionId).toBe("sess-new");

    // usage record inserted with non-zero tokens
    const records = db.select().from(usageRecords).all();
    expect(records).toHaveLength(1);
    expect(records[0].inputTokens).toBe(12);
    expect(records[0].outputTokens).toBe(8);
    // calculateCost fallback used (estimateCost returned 0.0005)
    expect(records[0].totalCostUsd).toBeGreaterThan(0);
  });

  it("tolerates reconcile errors during message send", async () => {
    const { reconcileClaudeSkillsForProject } = await import("../../services/claude-skills-sync.js");
    (reconcileClaudeSkillsForProject as any).mockImplementationOnce(() => { throw new Error("sync fail"); });

    const projPath = mkdtempSync(join(tempDir, "proj-sync-fail-"));
    const proj = db.insert(projects).values({ name: "rf", path: projPath }).returning().get()!;
    const chat = db.insert(chats).values({ projectId: proj.id }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "retry despite sync fail" }),
    });
    expect(res.status).toBe(201);
  });

  it("falls back to global defaultKeyId when body omits keyId", async () => {
    const config = await import("../../config.js");
    const key = db.insert(aiProviderKeys).values({
      provider: "anthropic", providerType: "anthropic-messages",
      label: "default", keyValue: "sk-d", isActive: 1, priority: 0,
      configDir: "/tmp/cfg-default",
    } as any).returning().get()!;

    const spy = vi.spyOn(config, "getDefaultKeyId").mockReturnValue(key.id);
    try {
      const chat = db.insert(chats).values({}).returning().get()!;
      const res = await app.request(`/chats/${chat.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "use global default" }),
      });
      expect(res.status).toBe(201);
      expect(agentCalls[0].opts.configDir).toBe("/tmp/cfg-default");
    } finally {
      spy.mockRestore();
    }
  });

  it("ignores defaultKeyId when the key is inactive", async () => {
    const config = await import("../../config.js");
    const key = db.insert(aiProviderKeys).values({
      provider: "anthropic", providerType: "anthropic-messages",
      label: "disabled", keyValue: "sk-d", isActive: 0, priority: 0,
      configDir: "/tmp/cfg-disabled",
    } as any).returning().get()!;

    const spy = vi.spyOn(config, "getDefaultKeyId").mockReturnValue(key.id);
    try {
      const chat = db.insert(chats).values({}).returning().get()!;
      const res = await app.request(`/chats/${chat.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "should not pin to disabled key" }),
      });
      expect(res.status).toBe(201);
      expect(agentCalls[0].opts.configDir).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("body keyId still wins over defaultKeyId fallback", async () => {
    const config = await import("../../config.js");
    const explicit = db.insert(aiProviderKeys).values({
      provider: "anthropic", providerType: "anthropic-messages",
      label: "explicit", keyValue: "sk-e", isActive: 1, priority: 0,
      configDir: "/tmp/cfg-explicit",
    } as any).returning().get()!;
    const fallback = db.insert(aiProviderKeys).values({
      provider: "anthropic", providerType: "anthropic-messages",
      label: "fallback", keyValue: "sk-f", isActive: 1, priority: 0,
      configDir: "/tmp/cfg-fallback",
    } as any).returning().get()!;

    const spy = vi.spyOn(config, "getDefaultKeyId").mockReturnValue(fallback.id);
    try {
      const chat = db.insert(chats).values({}).returning().get()!;
      const res = await app.request(`/chats/${chat.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "explicit wins", keyId: explicit.id }),
      });
      expect(res.status).toBe(201);
      expect(agentCalls[0].opts.configDir).toBe("/tmp/cfg-explicit");
    } finally {
      spy.mockRestore();
    }
  });

  it("resolves cwd via workspace path when chat has workspaceId", async () => {
    const wsPath = mkdtempSync(join(tempDir, "ws-cwd-"));
    const ws = db.insert(workspaces).values({ name: "w-cwd", path: wsPath }).returning().get()!;
    const chat = db.insert(chats).values({ workspaceId: ws.id }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "cwd from ws" }),
    });
    expect(res.status).toBe(201);
    expect(agentCalls[0].opts.workingDir).toBe(wsPath);
  });
});

describe("chats — POST /:id/permission/:requestId", () => {
  it("422 when behavior missing", async () => {
    const chat = db.insert(chats).values({}).returning().get()!;
    const res = await app.request(`/chats/${chat.id}/permission/req-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("422 when session is not running", async () => {
    chatExecutorMock.isRunning.mockReturnValue(false);
    const chat = db.insert(chats).values({}).returning().get()!;
    const res = await app.request(`/chats/${chat.id}/permission/req-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ behavior: "allow" }),
    });
    expect(res.status).toBe(422);
  });

  it("404 when permission request not found", async () => {
    chatExecutorMock.isRunning.mockReturnValue(true);
    chatExecutorMock.resolvePermission.mockReturnValue(false);
    const chat = db.insert(chats).values({}).returning().get()!;
    const res = await app.request(`/chats/${chat.id}/permission/unknown-req`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ behavior: "deny", message: "no thanks" }),
    });
    expect(res.status).toBe(404);
  });

  it("200 allow path", async () => {
    chatExecutorMock.isRunning.mockReturnValue(true);
    chatExecutorMock.resolvePermission.mockReturnValue(true);
    const chat = db.insert(chats).values({}).returning().get()!;
    const res = await app.request(`/chats/${chat.id}/permission/req-ok`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ behavior: "allow" }),
    });
    expect(res.status).toBe(200);
    const call = chatExecutorMock.resolvePermission.mock.calls[0];
    expect(call[2]).toEqual({ behavior: "allow" });
  });

  it("200 deny path with default message", async () => {
    chatExecutorMock.isRunning.mockReturnValue(true);
    chatExecutorMock.resolvePermission.mockReturnValue(true);
    const chat = db.insert(chats).values({}).returning().get()!;
    const res = await app.request(`/chats/${chat.id}/permission/req-deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ behavior: "deny" }),
    });
    expect(res.status).toBe(200);
    const call = chatExecutorMock.resolvePermission.mock.calls[0];
    expect(call[2]).toEqual({ behavior: "deny", message: "Denied by user" });
  });

  it("accepts empty body → 422 (no behavior)", async () => {
    const chat = db.insert(chats).values({}).returning().get()!;
    const res = await app.request(`/chats/${chat.id}/permission/req-empty`, {
      method: "POST",
    });
    expect(res.status).toBe(422);
  });
});

describe("chats — POST /:id/cancel", () => {
  it("delegates to chatExecutor.cancel", async () => {
    chatExecutorMock.cancel.mockReturnValue(true);
    const chat = db.insert(chats).values({}).returning().get()!;
    const res = await app.request(`/chats/${chat.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(chatExecutorMock.cancel).toHaveBeenCalledWith(chat.id);
  });

  it("returns ok:false when cancel has nothing to abort", async () => {
    chatExecutorMock.cancel.mockReturnValue(false);
    const res = await app.request(`/chats/9999/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(false);
  });
});

describe("chats — PATCH /:id with permissionMode", () => {
  it("updates permissionMode field", async () => {
    const chat = db.insert(chats).values({ title: "X" }).returning().get()!;
    const res = await app.request(`/chats/${chat.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionMode: "bypassPermissions" }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.permissionMode).toBe("bypassPermissions");
  });

  it("clears permissionMode when null", async () => {
    const chat = db.insert(chats).values({ permissionMode: "acceptEdits" }).returning().get()!;
    const res = await app.request(`/chats/${chat.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionMode: null }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.permissionMode).toBeNull();
  });
});

describe("chats — stream entity_context variants", () => {
  it("slice entity_context produces systemPromptOverride", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-slice-"));
    mkdirSync(join(projPath, ".flockctl", "plan", "m1", "s1"), { recursive: true });
    writeFileSync(join(projPath, ".flockctl", "plan", "m1", "s1", "slice.md"), "slice body");
    const proj = db.insert(projects).values({ name: "slice-proj", path: projPath }).returning().get()!;
    const chat = db.insert(chats).values({ projectId: proj.id }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "discuss this slice",
        entity_context: { entity_type: "slice", entity_id: "s1", milestone_id: "m1" },
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(agentCalls[0].opts.systemPromptOverride).toContain("slice");
    expect(agentCalls[0].opts.systemPromptOverride).toContain("slice body");
  });

  it("task entity_context produces systemPromptOverride", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-task-"));
    mkdirSync(join(projPath, ".flockctl", "plan", "m1", "s1"), { recursive: true });
    writeFileSync(join(projPath, ".flockctl", "plan", "m1", "s1", "t1.md"), "task body");
    const proj = db.insert(projects).values({ name: "task-proj", path: projPath }).returning().get()!;
    const chat = db.insert(chats).values({ projectId: proj.id }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "discuss this task",
        entity_context: { entity_type: "task", entity_id: "t1", milestone_id: "m1", slice_id: "s1" },
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(agentCalls[0].opts.systemPromptOverride).toContain("task");
    expect(agentCalls[0].opts.systemPromptOverride).toContain("task body");
  });

  it("falls back to default system when entity resolution incomplete", async () => {
    const proj = db.insert(projects).values({ name: "nopath-proj" }).returning().get()!;
    const chat = db.insert(chats).values({ projectId: proj.id }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "x",
        entity_context: { entity_type: "slice", entity_id: "s1" }, // missing milestone_id
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    // default fallback
    expect(agentCalls[0].opts.systemPromptOverride).toBe("You are a helpful AI assistant.");
  });
});

describe("chats — stream tolerates reconcile errors", () => {
  it("continues after reconcile fail in stream path", async () => {
    const { reconcileClaudeSkillsForProject } = await import("../../services/claude-skills-sync.js");
    (reconcileClaudeSkillsForProject as any).mockImplementationOnce(() => { throw new Error("stream-sync-fail"); });

    const projPath = mkdtempSync(join(tempDir, "proj-streamfail-"));
    const proj = db.insert(projects).values({ name: "sfp", path: projPath }).returning().get()!;
    const chat = db.insert(chats).values({ projectId: proj.id }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "msg" }),
    });
    expect(res.status).toBe(200);
    await res.text();
  });
});

describe("chats — stream preserves existing title", () => {
  it("does not rename when chat already has title", async () => {
    const projPath = mkdtempSync(join(tempDir, "proj-title-"));
    const proj = db.insert(projects).values({ name: "p-title", path: projPath }).returning().get()!;
    const chat = db.insert(chats).values({ projectId: proj.id, title: "Kept" }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "msg" }),
    });
    expect(res.status).toBe(200);
    await res.text();
    const updated = db.select().from(chats).where(eq(chats.id, chat.id)).get()!;
    expect(updated.title).toBe("Kept");
  });
});

describe("chats — stream run() error surfaces as SSE error event", () => {
  it("emits error chunk when session.run rejects", async () => {
    const mod = await import("../../services/agent-session.js");
    const orig = (mod as any).AgentSession.prototype.run;
    (mod as any).AgentSession.prototype.run = async function () {
      this.emit("error", new Error("boom from run"));
      throw new Error("boom from run");
    };

    const projPath = mkdtempSync(join(tempDir, "proj-err-"));
    const proj = db.insert(projects).values({ name: "err-p", path: projPath }).returning().get()!;
    const chat = db.insert(chats).values({ projectId: proj.id }).returning().get()!;

    try {
      const res = await app.request(`/chats/${chat.id}/messages/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "msg" }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("boom from run");
    } finally {
      (mod as any).AgentSession.prototype.run = orig;
    }
  });
});

describe("chats — GET /pending-permissions", () => {
  it("returns formatted map from chatExecutor", async () => {
    chatExecutorMock.pendingPermissionCounts.mockReturnValue({ 10: 2, 11: 1 });
    chatExecutorMock.runningChatIds.mockReturnValue([10, 11, 12]);

    const res = await app.request("/chats/pending-permissions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pending).toEqual({ "10": 2, "11": 1 });
    expect(body.running).toEqual(["10", "11", "12"]);
  });
});
