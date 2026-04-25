import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { projects, chats, aiProviderKeys } from "../../db/schema.js";
import { eq } from "drizzle-orm";

// Capture AgentSession constructor args so we can assert which (key, model)
// actually flowed to the runtime. Mirrors the pattern in chats.test.ts.
const agentSessionCalls: Array<{ opts: any }> = [];

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
      this.emit("text", "ok");
      this.emit("usage", {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalCostUsd: 0,
      });
      this.emit("session_id", "sess-sel");
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

/**
 * Covers the "chat remembers provider + model selection" fix:
 *   - POST /chats accepts and stores `aiProviderKeyId` / `model`.
 *   - PATCH /chats/:id updates them (including clearing via null).
 *   - GET /chats/:id echoes the persisted selection.
 *   - POST /chats/:id/messages and /messages/stream read the saved values
 *     when the request body omits them, and persist the effective choice back
 *     so a reload restores it.
 */
describe("Chats — provider key + model persistence", () => {
  let testDb: ReturnType<typeof createTestDb>;
  let projectId: number;
  let activeKeyId: number;
  let otherActiveKeyId: number;
  let inactiveKeyId: number;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);

    const p = testDb.db.insert(projects).values({ name: "Selection Test Project" }).returning().get()!;
    projectId = p.id;

    activeKeyId = testDb.db.insert(aiProviderKeys).values({
      provider: "anthropic",
      providerType: "api-key",
      label: "primary",
      keyValue: "sk-ant-api-test-1",
      isActive: true,
    }).returning().get()!.id;
    otherActiveKeyId = testDb.db.insert(aiProviderKeys).values({
      provider: "anthropic",
      providerType: "api-key",
      label: "secondary",
      keyValue: "sk-ant-api-test-2",
      isActive: true,
    }).returning().get()!.id;
    inactiveKeyId = testDb.db.insert(aiProviderKeys).values({
      provider: "anthropic",
      providerType: "api-key",
      label: "retired",
      keyValue: "sk-ant-api-test-3",
      isActive: false,
    }).returning().get()!.id;
  });

  afterAll(() => testDb.sqlite.close());

  beforeEach(() => {
    agentSessionCalls.length = 0;
  });

  // ─── POST /chats ───────────────────────────────────────────────────────────

  it("POST /chats stores aiProviderKeyId + model when provided", async () => {
    const res = await app.request("/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        title: "Remembers selection",
        aiProviderKeyId: activeKeyId,
        model: "claude-sonnet-4-20250514",
      }),
    });
    expect(res.status).toBe(201);
    const chat = await res.json();
    expect(chat.aiProviderKeyId).toBe(activeKeyId);
    expect(chat.model).toBe("claude-sonnet-4-20250514");

    // Sanity-check against the raw DB row to make sure the ALTER TABLE landed.
    const row = testDb.db.select().from(chats).where(eq(chats.id, chat.id)).get();
    expect(row!.aiProviderKeyId).toBe(activeKeyId);
    expect(row!.model).toBe("claude-sonnet-4-20250514");
  });

  it("POST /chats leaves selection NULL when the body omits it", async () => {
    const res = await app.request("/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, title: "No selection" }),
    });
    const chat = await res.json();
    expect(chat.aiProviderKeyId).toBeNull();
    expect(chat.model).toBeNull();
  });

  // ─── GET /chats/:id ────────────────────────────────────────────────────────

  it("GET /chats/:id echoes the stored selection", async () => {
    const created = testDb.db.insert(chats).values({
      projectId,
      title: "echo",
      aiProviderKeyId: activeKeyId,
      model: "claude-opus-4-20250514",
    }).returning().get()!;

    const res = await app.request(`/chats/${created.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.aiProviderKeyId).toBe(activeKeyId);
    expect(body.model).toBe("claude-opus-4-20250514");
  });

  // ─── PATCH /chats/:id ──────────────────────────────────────────────────────

  it("PATCH /chats/:id updates aiProviderKeyId + model", async () => {
    const created = testDb.db.insert(chats).values({ projectId }).returning().get()!;

    const res = await app.request(`/chats/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        aiProviderKeyId: activeKeyId,
        model: "claude-haiku-4",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.aiProviderKeyId).toBe(activeKeyId);
    expect(body.model).toBe("claude-haiku-4");
  });

  it("PATCH /chats/:id clears selection when null is sent", async () => {
    const created = testDb.db.insert(chats).values({
      projectId,
      aiProviderKeyId: activeKeyId,
      model: "claude-sonnet-4-20250514",
    }).returning().get()!;

    const res = await app.request(`/chats/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aiProviderKeyId: null, model: null }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.aiProviderKeyId).toBeNull();
    expect(body.model).toBeNull();
  });

  it("PATCH /chats/:id empty-string model clears to NULL", async () => {
    const created = testDb.db.insert(chats).values({
      projectId,
      model: "claude-sonnet-4-20250514",
    }).returning().get()!;

    const res = await app.request(`/chats/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "   " }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBeNull();
  });

  it("PATCH /chats/:id rejects malformed aiProviderKeyId", async () => {
    const created = testDb.db.insert(chats).values({ projectId }).returning().get()!;

    const res = await app.request(`/chats/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aiProviderKeyId: "not-a-number" }),
    });
    expect(res.status).toBe(422);
  });

  it("PATCH /chats/:id rejects non-string model", async () => {
    const created = testDb.db.insert(chats).values({ projectId }).returning().get()!;

    const res = await app.request(`/chats/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: 42 }),
    });
    expect(res.status).toBe(422);
  });

  // ─── POST /chats/:id/messages — stored selection flows to AgentSession ────

  it("POST /chats/:id/messages uses the stored selection when body omits it", async () => {
    const created = testDb.db.insert(chats).values({
      projectId,
      aiProviderKeyId: activeKeyId,
      model: "claude-opus-4-20250514",
    }).returning().get()!;

    const res = await app.request(`/chats/${created.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(res.status).toBe(201);

    // AgentSession saw the saved model.
    expect(agentSessionCalls).toHaveLength(1);
    expect(agentSessionCalls[0].opts.model).toBe("claude-opus-4-20250514");
  });

  it("POST /chats/:id/messages body overrides + persists back to the chat", async () => {
    const created = testDb.db.insert(chats).values({
      projectId,
      aiProviderKeyId: activeKeyId,
      model: "claude-sonnet-4-20250514",
    }).returning().get()!;

    const res = await app.request(`/chats/${created.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "override",
        model: "claude-opus-4-20250514",
        keyId: otherActiveKeyId,
      }),
    });
    expect(res.status).toBe(201);

    expect(agentSessionCalls[0].opts.model).toBe("claude-opus-4-20250514");

    // The new pick was written back so the next reload restores it.
    const after = testDb.db.select().from(chats).where(eq(chats.id, created.id)).get()!;
    expect(after.aiProviderKeyId).toBe(otherActiveKeyId);
    expect(after.model).toBe("claude-opus-4-20250514");
  });

  it("POST /chats/:id/messages falls through when stored key is inactive", async () => {
    const created = testDb.db.insert(chats).values({
      projectId,
      aiProviderKeyId: inactiveKeyId,
    }).returning().get()!;

    const res = await app.request(`/chats/${created.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "fallback" }),
    });
    expect(res.status).toBe(201);

    // Config dir / dispatch lookups should not key off the inactive id.
    expect(agentSessionCalls[0].opts.configDir).toBeUndefined();
    expect(agentSessionCalls[0].opts.agentId).toBeUndefined();
    expect(agentSessionCalls[0].opts.providerKeyValue).toBeUndefined();
  });

  // ─── POST /chats/:id/messages/stream — same contract ──────────────────────

  it("POST /chats/:id/messages/stream uses stored selection and persists body overrides", async () => {
    const created = testDb.db.insert(chats).values({
      projectId,
      aiProviderKeyId: activeKeyId,
      model: "claude-sonnet-4-20250514",
    }).returning().get()!;

    // First call — no body override. Must pick up the stored model.
    const r1 = await app.request(`/chats/${created.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "first" }),
    });
    expect(r1.status).toBe(200);
    await r1.text();
    expect(agentSessionCalls[0].opts.model).toBe("claude-sonnet-4-20250514");

    // Second call — body overrides. Must win AND persist back.
    agentSessionCalls.length = 0;
    const r2 = await app.request(`/chats/${created.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "second",
        model: "claude-opus-4-20250514",
        keyId: otherActiveKeyId,
      }),
    });
    expect(r2.status).toBe(200);
    await r2.text();
    expect(agentSessionCalls[0].opts.model).toBe("claude-opus-4-20250514");

    const after = testDb.db.select().from(chats).where(eq(chats.id, created.id)).get()!;
    expect(after.aiProviderKeyId).toBe(otherActiveKeyId);
    expect(after.model).toBe("claude-opus-4-20250514");
  });

  // ─── Project allow-list enforcement ───────────────────────────────────────
  //
  // These cover the regression where a chat created inside a project whose
  // `allowed_key_ids` whitelist excluded the user's rc-level default would
  // still render its key dropdown pointed at the disallowed default, because
  // POST /chats stored NULL and the UI's auto-select then fell back to
  // `meta.defaults.key_id`. Fix is two-layered: POST /chats auto-fills a
  // compliant key when the project has an allow-list, and resolveChatKeyId
  // re-picks from the allow-list when falling through to the rc default.

  it("POST /chats auto-fills aiProviderKeyId from the project's allow-list when body omits it", async () => {
    const restricted = testDb.db.insert(projects).values({
      name: "Restricted",
      allowedKeyIds: JSON.stringify([otherActiveKeyId]),
    }).returning().get()!;

    const res = await app.request("/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: restricted.id, title: "auto-fill" }),
    });
    expect(res.status).toBe(201);
    const chat = await res.json();
    // Must land on the only allowed active key, NOT the first global key.
    expect(chat.aiProviderKeyId).toBe(otherActiveKeyId);

    // Belt and braces — confirm the DB row matches.
    const row = testDb.db.select().from(chats).where(eq(chats.id, chat.id)).get()!;
    expect(row.aiProviderKeyId).toBe(otherActiveKeyId);
  });

  it("POST /chats rejects a body keyId that isn't in the project's allow-list", async () => {
    const restricted = testDb.db.insert(projects).values({
      name: "Restricted-reject",
      allowedKeyIds: JSON.stringify([otherActiveKeyId]),
    }).returning().get()!;

    const res = await app.request("/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: restricted.id,
        aiProviderKeyId: activeKeyId, // allowed to exist, but disallowed for this project
      }),
    });
    expect(res.status).toBe(422);
  });

  it("POST /chats stores the body keyId when it IS in the project's allow-list", async () => {
    const restricted = testDb.db.insert(projects).values({
      name: "Restricted-accept",
      allowedKeyIds: JSON.stringify([activeKeyId, otherActiveKeyId]),
    }).returning().get()!;

    const res = await app.request("/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: restricted.id,
        aiProviderKeyId: activeKeyId,
      }),
    });
    expect(res.status).toBe(201);
    const chat = await res.json();
    expect(chat.aiProviderKeyId).toBe(activeKeyId);
  });

  it("POST /chats without projectId keeps aiProviderKeyId NULL when body omits it", async () => {
    // Preserves the legacy workspace-only / no-project contract — we only
    // auto-fill when the project has a whitelist. Anything else would surprise
    // long-standing clients that relied on "resolve-at-send-time" semantics.
    const ws = testDb.db.insert(projects).values({ name: "just to keep schema happy" }).returning().get()!;
    // Using workspace_id path — chat without project.
    const res = await app.request("/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "no project" }),
    });
    expect(res.status).toBe(201);
    const chat = await res.json();
    expect(chat.aiProviderKeyId).toBeNull();
    expect(ws.id).toBeDefined(); // sanity — make the unused var a no-op
  });

  it("POST /chats/:id/messages/stream resolves to an allowed key when chat has no stored selection", async () => {
    const restricted = testDb.db.insert(projects).values({
      name: "Restricted-stream",
      allowedKeyIds: JSON.stringify([otherActiveKeyId]),
    }).returning().get()!;

    // Insert directly to bypass POST /chats' auto-fill — this simulates an
    // older chat row (or any code path) that stored NULL before the auto-fill
    // landed. resolveChatKeyId must still pick a compliant key.
    const chat = testDb.db.insert(chats).values({
      projectId: restricted.id,
      aiProviderKeyId: null,
    }).returning().get()!;

    const res = await app.request(`/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const after = testDb.db.select().from(chats).where(eq(chats.id, chat.id)).get()!;
    // resolveChatKeyId + persistChatSelection round-trip saves the compliant
    // key back to the chat row so the UI sees it on reload.
    expect(after.aiProviderKeyId).toBe(otherActiveKeyId);
  });

  // ─── ON DELETE SET NULL from ai_provider_keys ─────────────────────────────

  it("deleting the underlying key sets the chat's aiProviderKeyId to NULL", async () => {
    const scratchKey = testDb.db.insert(aiProviderKeys).values({
      provider: "anthropic",
      providerType: "api-key",
      label: "scratch",
      keyValue: "sk-ant-api-scratch",
      isActive: true,
    }).returning().get()!.id;

    const created = testDb.db.insert(chats).values({
      projectId,
      aiProviderKeyId: scratchKey,
      model: "claude-sonnet-4-20250514",
    }).returning().get()!;

    testDb.db.delete(aiProviderKeys).where(eq(aiProviderKeys.id, scratchKey)).run();

    const after = testDb.db.select().from(chats).where(eq(chats.id, created.id)).get()!;
    expect(after.aiProviderKeyId).toBeNull();
    // Model survives — it's just a string, not a foreign reference.
    expect(after.model).toBe("claude-sonnet-4-20250514");
  });
});
