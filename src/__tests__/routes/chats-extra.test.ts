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
    updatePermissionMode = vi.fn();
    pendingPermissionCount = 0;
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
vi.mock("../../services/ai/client", () => ({
  createAIClient: vi.fn().mockReturnValue({
    chat: vi.fn().mockResolvedValue({
      text: "non-stream response",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  }),
}));

// Mock claude-cli so any legacy imports resolve without spawning processes.
vi.mock("../../services/claude/cli", () => ({
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

  // Variant B — live permission-mode propagation from PATCH to the running
  // AgentSession. The DB column is always updated; the session mutation is
  // only triggered when a session is in-flight for this chat. We assert
  // both: DB persistence (visible in the response) AND the executor call.
  it("PATCH permission_mode propagates to running session (variant B)", async () => {
    const chat = testDb.db.insert(chats).values({ projectId, permissionMode: "default" }).returning().get()!;

    // Register a fake session in the executor so `chatExecutor.isRunning(id)`
    // is true when the PATCH handler runs.
    const { chatExecutor } = await import("../../services/chat-executor.js");
    const { EventEmitter } = await import("events");
    class Fake extends EventEmitter {
      abort = vi.fn();
      resolvePermission = vi.fn();
      updatePermissionMode = vi.fn();
      pendingPermissionCount = 0;
    }
    const fake = new Fake();
    chatExecutor.register(chat.id, fake as any);

    try {
      const res = await app.request(`/chats/${chat.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permission_mode: "bypassPermissions" }),
      });
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.permissionMode).toBe("bypassPermissions");

      // Effective mode for a chat with explicit value = the value itself.
      expect(fake.updatePermissionMode).toHaveBeenCalledWith("bypassPermissions");
    } finally {
      chatExecutor.unregister(chat.id);
    }
  });

  // Pin toggle — boolean-only so a stray string can't silently pin. Default
  // is `false` on create (no backfill needed — migration sets the column
  // default to 0) and the PATCH flips either direction.
  it("PATCH pinned=true sets pinned on the chat row", async () => {
    const chat = testDb.db.insert(chats).values({ projectId, title: "Pin me" }).returning().get()!;
    expect(chat.pinned).toBe(false);

    const res = await app.request(`/chats/${chat.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.pinned).toBe(true);
  });

  it("PATCH pinned=false unpins a pinned chat", async () => {
    const chat = testDb.db.insert(chats).values({ projectId, title: "Already pinned", pinned: true }).returning().get()!;
    expect(chat.pinned).toBe(true);

    const res = await app.request(`/chats/${chat.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: false }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.pinned).toBe(false);
  });

  it("PATCH pinned rejects non-boolean payloads", async () => {
    const chat = testDb.db.insert(chats).values({ projectId }).returning().get()!;
    const res = await app.request(`/chats/${chat.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: "true" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/pinned must be a boolean/);
  });

  it("PATCH permission_mode=null falls back to resolver default (auto) for live session", async () => {
    const chat = testDb.db.insert(chats).values({ projectId, permissionMode: "bypassPermissions" }).returning().get()!;

    const { chatExecutor } = await import("../../services/chat-executor.js");
    const { EventEmitter } = await import("events");
    class Fake extends EventEmitter {
      abort = vi.fn();
      resolvePermission = vi.fn();
      updatePermissionMode = vi.fn();
      pendingPermissionCount = 0;
    }
    const fake = new Fake();
    chatExecutor.register(chat.id, fake as any);

    try {
      const res = await app.request(`/chats/${chat.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permission_mode: null }),
      });
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.permissionMode).toBeNull();

      // No project/workspace override in this test fixture → resolver fallback = "auto".
      expect(fake.updatePermissionMode).toHaveBeenCalledWith("auto");
    } finally {
      chatExecutor.unregister(chat.id);
    }
  });
});

// Pin ordering + filter interaction. Backend sorts by
// `(pinned DESC, created_at DESC)` AFTER applying filters — so pinned rows
// must float to the top inside the filtered bucket, and a pinned chat that
// doesn't match the filter must still be excluded.
describe("Chats — GET /chats pin ordering and filters", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let pinProjectId: number;
  let otherProjectId: number;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    pinProjectId = testDb.db.insert(projects).values({ name: "Pin Proj" }).returning().get()!.id;
    otherProjectId = testDb.db.insert(projects).values({ name: "Other Proj" }).returning().get()!.id;

    // Seed order (creation timestamp increases with each insert):
    //   #1 pin-proj, unpinned, oldest
    //   #2 pin-proj, unpinned, newer
    //   #3 pin-proj, pinned  <-- should jump to top when filtering by pin-proj
    //   #4 other-proj, pinned <-- must NOT appear in pin-proj filter
    testDb.db.insert(chats).values({ projectId: pinProjectId, title: "A-oldest" }).run();
    testDb.db.insert(chats).values({ projectId: pinProjectId, title: "B-newer" }).run();
    testDb.db.insert(chats).values({ projectId: pinProjectId, title: "C-pinned", pinned: true }).run();
    testDb.db.insert(chats).values({ projectId: otherProjectId, title: "D-other-pinned", pinned: true }).run();
  });

  afterAll(() => testDb.sqlite.close());

  it("pinned chats float to the top of the filtered set", async () => {
    const res = await app.request(`/chats?project_id=${pinProjectId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const titles: string[] = body.items.map((c: any) => c.title);
    // Pin-proj returns exactly its 3 chats. `D-other-pinned` is pinned but
    // belongs to the other project — it must not leak into this bucket.
    expect(titles).toHaveLength(3);
    expect(new Set(titles)).toEqual(new Set(["A-oldest", "B-newer", "C-pinned"]));
    // Pin invariant: the pinned chat is strictly above every unpinned chat.
    // Relative order among unpinned rows is not asserted — SQLite's
    // `datetime('now')` has second precision so two rapid inserts tie on
    // `created_at` and the tie-break is not what this test is about.
    expect(titles[0]).toBe("C-pinned");
    expect(body.items[0].pinned).toBe(true);
    expect(body.items.slice(1).every((c: any) => c.pinned === false)).toBe(true);
    expect(body.items.every((c: any) => c.projectId === pinProjectId)).toBe(true);
  });

  it("filter excludes pinned chats from other projects", async () => {
    const res = await app.request(`/chats?project_id=${otherProjectId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].title).toBe("D-other-pinned");
    expect(body.items[0].pinned).toBe(true);
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
    writeFileSync(join(projectPath, ".flockctl", "config.json"), JSON.stringify({ model: "claude-opus-4-7" }));
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

// POST /chats/:id/{approve,reject} — symmetric with task approvals.
// The routes gate on `approval_status = 'pending'`, flip the column to
// approved|rejected, and fire `attention_changed`. No-op side-effects on the
// session itself — chats have no terminal `status` equivalent to tasks.
describe("Chats — POST /chats/:id/approve|reject", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let projectId: number;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    const p = testDb.db.insert(projects).values({ name: "Chat Approve Proj" }).returning().get()!;
    projectId = p.id;
  });

  afterAll(() => testDb.sqlite.close());

  it("approves a chat in approval_status='pending'", async () => {
    const chat = testDb.db
      .insert(chats)
      .values({ projectId, requiresApproval: true, approvalStatus: "pending" })
      .returning()
      .get()!;
    const res = await app.request(`/chats/${chat.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "looks good" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const after = testDb.db.select().from(chats).where(eq(chats.id, chat.id)).get()!;
    expect(after.approvalStatus).toBe("approved");
    expect(after.approvalNote).toBe("looks good");
    expect(after.approvedAt).toBeTruthy();
  });

  it("rejects a chat in approval_status='pending'", async () => {
    const chat = testDb.db
      .insert(chats)
      .values({ projectId, requiresApproval: true, approvalStatus: "pending" })
      .returning()
      .get()!;
    const res = await app.request(`/chats/${chat.id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "not yet" }),
    });
    expect(res.status).toBe(200);

    const after = testDb.db.select().from(chats).where(eq(chats.id, chat.id)).get()!;
    expect(after.approvalStatus).toBe("rejected");
    expect(after.approvalNote).toBe("not yet");
  });

  it("accepts an empty JSON body (note becomes null)", async () => {
    const chat = testDb.db
      .insert(chats)
      .values({ projectId, requiresApproval: true, approvalStatus: "pending" })
      .returning()
      .get()!;
    const res = await app.request(`/chats/${chat.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect(res.status).toBe(200);
    const after = testDb.db.select().from(chats).where(eq(chats.id, chat.id)).get()!;
    expect(after.approvalStatus).toBe("approved");
    expect(after.approvalNote).toBeNull();
  });

  it("returns 404 when the chat does not exist", async () => {
    const res = await app.request(`/chats/99999/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("returns 422 when approval_status is null (never entered pending)", async () => {
    const chat = testDb.db
      .insert(chats)
      .values({ projectId, requiresApproval: true })
      .returning()
      .get()!;
    const res = await app.request(`/chats/${chat.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when approval_status is already 'approved' (no double-approve)", async () => {
    const chat = testDb.db
      .insert(chats)
      .values({ projectId, requiresApproval: true, approvalStatus: "approved" })
      .returning()
      .get()!;
    const res = await app.request(`/chats/${chat.id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  // Mirror of the approve-side branch tests to exercise the reject handler's
  // NotFound (line 145) and the approvalStatus-null message fallback (line 148).
  it("reject returns 404 when the chat does not exist", async () => {
    const res = await app.request(`/chats/99999/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("reject returns 422 when approval_status is null (exercises `?? 'null'` message fallback)", async () => {
    const chat = testDb.db
      .insert(chats)
      .values({ projectId, requiresApproval: true })
      .returning()
      .get()!;
    const res = await app.request(`/chats/${chat.id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/approval_status='null'/);
  });
});
