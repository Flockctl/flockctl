import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { createTestDb } from "../helpers.js";
import { chatMessages, chats } from "../../db/schema.js";

class FakeSession extends EventEmitter {
  abort = vi.fn();
  resolvePermission = vi.fn().mockReturnValue(true);
  pendingPermissionCount = 0;
  updatePermissionMode = vi.fn();
}

describe("ChatExecutor", () => {
  let chatExecutorModule: typeof import("../../services/chat-executor.js");
  let wsManagerModule: typeof import("../../services/ws-manager.js");
  let dbModule: typeof import("../../db/index.js");
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(async () => {
    vi.resetModules();
    dbModule = await import("../../db/index.js");
    const t = createTestDb();
    db = t.db;
    dbModule.setDb(db, t.sqlite);
    wsManagerModule = await import("../../services/ws-manager.js");
    chatExecutorModule = await import("../../services/chat-executor.js");
  });

  afterEach(() => {
    dbModule.closeDb();
  });

  it("broadcasts session_started on register and session_ended on unregister", () => {
    const ws = { send: vi.fn(), readyState: 1 };
    wsManagerModule.wsManager.addGlobalChatClient(ws);

    const session = new FakeSession();
    chatExecutorModule.chatExecutor.register(42, session as any);

    expect(chatExecutorModule.chatExecutor.isRunning(42)).toBe(true);
    const started = JSON.parse(ws.send.mock.calls[0][0]);
    expect(started.type).toBe("session_started");
    expect(started.chatId).toBe(42);
    expect(started.payload.chat_id).toBe("42");

    chatExecutorModule.chatExecutor.unregister(42);

    expect(chatExecutorModule.chatExecutor.isRunning(42)).toBe(false);
    const ended = JSON.parse(ws.send.mock.calls[1][0]);
    expect(ended.type).toBe("session_ended");
    expect(ended.chatId).toBe(42);
  });

  it("does not emit session_ended when unregistering an unknown chat", () => {
    const ws = { send: vi.fn(), readyState: 1 };
    wsManagerModule.wsManager.addGlobalChatClient(ws);

    chatExecutorModule.chatExecutor.unregister(999);

    expect(ws.send).not.toHaveBeenCalled();
  });

  // Regression: `POST /chats/:id/messages/stream` persists the user row and
  // then enters the streamSSE arrow before calling `register`. During that
  // window the UI was seeing `isRunning=false` on a GET while the messages
  // list already ended with the user's turn, which fired the "Response was
  // not received" fallback whenever the user switched chats and came back
  // mid-setup. `claim` flips `isRunning` up immediately; `register` promotes
  // it without changing the answer.
  it("claim marks isRunning without broadcasting and register promotes it without a duplicate frame", () => {
    const ws = { send: vi.fn(), readyState: 1 };
    wsManagerModule.wsManager.addGlobalChatClient(ws);

    chatExecutorModule.chatExecutor.claim(77);
    expect(chatExecutorModule.chatExecutor.isRunning(77)).toBe(true);
    // claim is the "pre-wire" marker — it must not put a session_started on
    // the wire, otherwise WS subscribers would observe session_started twice
    // (once at claim, once at register).
    expect(ws.send).not.toHaveBeenCalled();

    const session = new FakeSession();
    chatExecutorModule.chatExecutor.register(77, session as any);
    expect(chatExecutorModule.chatExecutor.isRunning(77)).toBe(true);
    const msgs = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]).type);
    expect(msgs).toEqual(["session_started"]);

    chatExecutorModule.chatExecutor.unregister(77);
    expect(chatExecutorModule.chatExecutor.isRunning(77)).toBe(false);
  });

  it("release reaps a claim that never got promoted and emits session_ended", () => {
    const ws = { send: vi.fn(), readyState: 1 };
    wsManagerModule.wsManager.addGlobalChatClient(ws);

    chatExecutorModule.chatExecutor.claim(88);
    expect(chatExecutorModule.chatExecutor.isRunning(88)).toBe(true);

    chatExecutorModule.chatExecutor.release(88);
    expect(chatExecutorModule.chatExecutor.isRunning(88)).toBe(false);
    const msgs = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]).type);
    expect(msgs).toEqual(["session_ended"]);
  });

  it("unregister reaps a lingering claim even if register was never called", () => {
    const ws = { send: vi.fn(), readyState: 1 };
    wsManagerModule.wsManager.addGlobalChatClient(ws);

    chatExecutorModule.chatExecutor.claim(89);
    chatExecutorModule.chatExecutor.unregister(89);
    expect(chatExecutorModule.chatExecutor.isRunning(89)).toBe(false);
    const msgs = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]).type);
    expect(msgs).toEqual(["session_ended"]);
  });

  it("claim is idempotent when already registered", () => {
    const session = new FakeSession();
    chatExecutorModule.chatExecutor.register(90, session as any);
    const before = chatExecutorModule.chatExecutor.isRunning(90);
    chatExecutorModule.chatExecutor.claim(90);
    const after = chatExecutorModule.chatExecutor.isRunning(90);
    expect(before).toBe(true);
    expect(after).toBe(true);
    chatExecutorModule.chatExecutor.unregister(90);
  });

  it("forwards permission_request events via broadcastChat", () => {
    const ws = { send: vi.fn(), readyState: 1 };
    wsManagerModule.wsManager.addGlobalChatClient(ws);

    const session = new FakeSession();
    chatExecutorModule.chatExecutor.register(7, session as any);

    session.emit("permission_request", {
      requestId: "req-1",
      toolName: "Bash",
      toolInput: { command: "ls" },
      toolUseID: "use-1",
      title: "Run ls",
      displayName: "List",
      description: "Lists files",
      decisionReason: "user-interactive",
    });

    const permMsg = ws.send.mock.calls.find((c: any[]) => {
      try { return JSON.parse(c[0]).type === "permission_request"; } catch { return false; }
    });
    expect(permMsg).toBeDefined();
    const body = JSON.parse(permMsg![0]);
    expect(body.chatId).toBe(7);
    expect(body.payload.request_id).toBe("req-1");
    expect(body.payload.tool_name).toBe("Bash");
    expect(body.payload.title).toBe("Run ls");
    expect(body.payload.display_name).toBe("List");
    expect(body.payload.description).toBe("Lists files");
    expect(body.payload.decision_reason).toBe("user-interactive");

    chatExecutorModule.chatExecutor.unregister(7);
  });

  it("persists tool_call as a tool message and broadcasts tool_call", () => {
    const ws = { send: vi.fn(), readyState: 1 };
    wsManagerModule.wsManager.addGlobalChatClient(ws);

    const chat = db.insert(chats).values({ title: "c" }).returning().get()!;
    const session = new FakeSession();
    chatExecutorModule.chatExecutor.register(chat.id, session as any);

    session.emit("tool_call", "Bash", { command: "echo hi" });

    const rows = db.select().from(chatMessages).all();
    expect(rows.length).toBe(1);
    expect(rows[0].role).toBe("tool");
    const payload = JSON.parse(rows[0].content);
    expect(payload.kind).toBe("call");
    expect(payload.name).toBe("Bash");
    expect(payload.input.command).toBe("echo hi");

    const msg = ws.send.mock.calls.find((c: any[]) => {
      try { return JSON.parse(c[0]).type === "tool_call"; } catch { return false; }
    });
    expect(msg).toBeDefined();
    const body = JSON.parse(msg![0]);
    expect(body.payload.tool_name).toBe("Bash");
    expect(body.payload.message_id).toBe(rows[0].id);

    chatExecutorModule.chatExecutor.unregister(chat.id);
  });

  it("persists tool_result as a tool message and broadcasts tool_result", () => {
    const ws = { send: vi.fn(), readyState: 1 };
    wsManagerModule.wsManager.addGlobalChatClient(ws);

    const chat = db.insert(chats).values({ title: "c" }).returning().get()!;
    const session = new FakeSession();
    chatExecutorModule.chatExecutor.register(chat.id, session as any);

    session.emit("tool_result", "Bash", "ok");

    const rows = db.select().from(chatMessages).all();
    expect(rows.length).toBe(1);
    const payload = JSON.parse(rows[0].content);
    expect(payload.kind).toBe("result");
    expect(payload.output).toBe("ok");

    const msg = ws.send.mock.calls.find((c: any[]) => {
      try { return JSON.parse(c[0]).type === "tool_result"; } catch { return false; }
    });
    expect(msg).toBeDefined();

    chatExecutorModule.chatExecutor.unregister(chat.id);
  });

  it("cancel aborts the session when it exists; returns false otherwise", () => {
    const session = new FakeSession();
    chatExecutorModule.chatExecutor.register(20, session as any);

    expect(chatExecutorModule.chatExecutor.cancel(20)).toBe(true);
    expect(session.abort).toHaveBeenCalled();
    expect(chatExecutorModule.chatExecutor.cancel(9999)).toBe(false);

    chatExecutorModule.chatExecutor.unregister(20);
  });

  it("cancelAll aborts every active session", () => {
    const s1 = new FakeSession();
    const s2 = new FakeSession();
    chatExecutorModule.chatExecutor.register(31, s1 as any);
    chatExecutorModule.chatExecutor.register(32, s2 as any);

    chatExecutorModule.chatExecutor.cancelAll();

    expect(s1.abort).toHaveBeenCalledWith("shutdown");
    expect(s2.abort).toHaveBeenCalledWith("shutdown");

    chatExecutorModule.chatExecutor.unregister(31);
    chatExecutorModule.chatExecutor.unregister(32);
  });

  it("resolvePermission delegates to session and broadcasts resolution", () => {
    const ws = { send: vi.fn(), readyState: 1 };
    wsManagerModule.wsManager.addGlobalChatClient(ws);

    const session = new FakeSession();
    chatExecutorModule.chatExecutor.register(40, session as any);

    const ok = chatExecutorModule.chatExecutor.resolvePermission(40, "req-x", { behavior: "allow" });
    expect(ok).toBe(true);
    expect(session.resolvePermission).toHaveBeenCalledWith("req-x", { behavior: "allow" });

    const msg = ws.send.mock.calls.find((c: any[]) => {
      try { return JSON.parse(c[0]).type === "permission_resolved"; } catch { return false; }
    });
    expect(msg).toBeDefined();
    expect(JSON.parse(msg![0]).payload.behavior).toBe("allow");

    chatExecutorModule.chatExecutor.unregister(40);
  });

  it("updatePermissionMode delegates to session and broadcasts chat_permission_mode_changed", () => {
    const ws = { send: vi.fn(), readyState: 1 };
    wsManagerModule.wsManager.addGlobalChatClient(ws);

    const session = new FakeSession();
    chatExecutorModule.chatExecutor.register(80, session as any);
    ws.send.mockClear();

    const ok = chatExecutorModule.chatExecutor.updatePermissionMode(80, "bypassPermissions");
    expect(ok).toBe(true);
    expect(session.updatePermissionMode).toHaveBeenCalledWith("bypassPermissions");

    // The WS `chat_permission_mode_changed` frame is driven by the session's
    // own `permission_mode_changed` event (real AgentSession emits this on
    // a genuine transition). The FakeSession lets us fire it directly.
    session.emit("permission_mode_changed", { previous: "default", current: "bypassPermissions" });
    const frame = ws.send.mock.calls.find((c: any[]) => {
      try { return JSON.parse(c[0]).type === "chat_permission_mode_changed"; } catch { return false; }
    });
    expect(frame).toBeDefined();
    const body = JSON.parse(frame![0]);
    expect(body.chatId).toBe(80);
    expect(body.payload.previous).toBe("default");
    expect(body.payload.current).toBe("bypassPermissions");

    chatExecutorModule.chatExecutor.unregister(80);
  });

  it("updatePermissionMode returns false when no session is running", () => {
    const ok = chatExecutorModule.chatExecutor.updatePermissionMode(9999, "auto");
    expect(ok).toBe(false);
  });

  it("broadcasts permission_resolved for each auto-resolved request", () => {
    // Variant-B side effect: when the session bulk-resolves pending requests
    // after a permission-mode swap, the UI needs a `permission_resolved`
    // frame per request so the pending card disappears. The session emits
    // `permission_auto_resolved` per entry; chat-executor is responsible
    // for relaying it as the canonical WS event.
    const ws = { send: vi.fn(), readyState: 1 };
    wsManagerModule.wsManager.addGlobalChatClient(ws);

    const session = new FakeSession();
    chatExecutorModule.chatExecutor.register(90, session as any);
    ws.send.mockClear();

    session.emit("permission_auto_resolved", "perm-c90-1");
    session.emit("permission_auto_resolved", "perm-c90-2");

    const resolvedFrames = ws.send.mock.calls.filter((c: any[]) => {
      try { return JSON.parse(c[0]).type === "permission_resolved"; } catch { return false; }
    });
    expect(resolvedFrames.length).toBe(2);
    const firstBody = JSON.parse(resolvedFrames[0][0]);
    expect(firstBody.payload.behavior).toBe("allow");
    expect(firstBody.payload.request_id).toBe("perm-c90-1");

    chatExecutorModule.chatExecutor.unregister(90);
  });

  it("resolvePermission returns false when session unknown", () => {
    const res = chatExecutorModule.chatExecutor.resolvePermission(
      999,
      "req-y",
      { behavior: "deny", message: "nope" },
    );
    expect(res).toBe(false);
  });

  it("resolvePermission does not broadcast when session returns false", () => {
    const ws = { send: vi.fn(), readyState: 1 };
    wsManagerModule.wsManager.addGlobalChatClient(ws);

    const session = new FakeSession();
    session.resolvePermission = vi.fn().mockReturnValue(false);
    chatExecutorModule.chatExecutor.register(41, session as any);
    ws.send.mockClear();

    const ok = chatExecutorModule.chatExecutor.resolvePermission(41, "missing", { behavior: "allow" });
    expect(ok).toBe(false);
    const resolved = ws.send.mock.calls.find((c: any[]) => {
      try { return JSON.parse(c[0]).type === "permission_resolved"; } catch { return false; }
    });
    expect(resolved).toBeUndefined();

    chatExecutorModule.chatExecutor.unregister(41);
  });

  it("pendingPermissionCounts reports only chats with pending requests", () => {
    const s1 = new FakeSession();
    const s2 = new FakeSession();
    s1.pendingPermissionCount = 2;
    s2.pendingPermissionCount = 0;
    chatExecutorModule.chatExecutor.register(50, s1 as any);
    chatExecutorModule.chatExecutor.register(51, s2 as any);

    const counts = chatExecutorModule.chatExecutor.pendingPermissionCounts();
    expect(counts).toEqual({ 50: 2 });

    chatExecutorModule.chatExecutor.unregister(50);
    chatExecutorModule.chatExecutor.unregister(51);
  });

  it("runningChatIds enumerates active sessions", () => {
    const s1 = new FakeSession();
    const s2 = new FakeSession();
    chatExecutorModule.chatExecutor.register(60, s1 as any);
    chatExecutorModule.chatExecutor.register(61, s2 as any);

    const ids = chatExecutorModule.chatExecutor.runningChatIds().sort();
    expect(ids).toEqual([60, 61]);

    chatExecutorModule.chatExecutor.unregister(60);
    chatExecutorModule.chatExecutor.unregister(61);
  });

  it("waitForIdle resolves immediately when no sessions are running", async () => {
    const start = Date.now();
    await chatExecutorModule.chatExecutor.waitForIdle(2000);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("waitForIdle returns when last session unregisters before timeout", async () => {
    const session = new FakeSession();
    chatExecutorModule.chatExecutor.register(70, session as any);

    setTimeout(() => chatExecutorModule.chatExecutor.unregister(70), 100);

    const start = Date.now();
    await chatExecutorModule.chatExecutor.waitForIdle(2000);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(1500);
    expect(chatExecutorModule.chatExecutor.isRunning(70)).toBe(false);
  });

  it("waitForIdle gives up after the timeout when sessions linger", async () => {
    const session = new FakeSession();
    chatExecutorModule.chatExecutor.register(71, session as any);

    const start = Date.now();
    await chatExecutorModule.chatExecutor.waitForIdle(150);
    expect(Date.now() - start).toBeGreaterThanOrEqual(140);
    expect(chatExecutorModule.chatExecutor.isRunning(71)).toBe(true);

    chatExecutorModule.chatExecutor.unregister(71);
  });

  describe("markPendingApprovalIfRequired", () => {
    it("flips approvalStatus to 'pending' when requiresApproval=true and status is null", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      wsManagerModule.wsManager.addGlobalChatClient(ws);

      const row = db
        .insert(chats)
        .values({ title: "needs review", requiresApproval: true })
        .returning()
        .get()!;

      chatExecutorModule.chatExecutor.markPendingApprovalIfRequired(row.id);

      const { eq } = require("drizzle-orm");
      const after = db.select().from(chats).where(eq(chats.id, row.id)).get()!;
      expect(after.approvalStatus).toBe("pending");

      // attention_changed WS event was broadcast on the global channel.
      const types = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]).type);
      expect(types).toContain("attention_changed");
    });

    it("no-ops when requiresApproval=false", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      wsManagerModule.wsManager.addGlobalChatClient(ws);

      const row = db
        .insert(chats)
        .values({ title: "untracked", requiresApproval: false })
        .returning()
        .get()!;

      chatExecutorModule.chatExecutor.markPendingApprovalIfRequired(row.id);

      const { eq } = require("drizzle-orm");
      const after = db.select().from(chats).where(eq(chats.id, row.id)).get()!;
      expect(after.approvalStatus).toBeNull();

      const types = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]).type);
      expect(types).not.toContain("attention_changed");
    });

    it("no-ops (idempotent) when approvalStatus is already 'pending'", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      wsManagerModule.wsManager.addGlobalChatClient(ws);

      const { eq } = require("drizzle-orm");
      const row = db
        .insert(chats)
        .values({ title: "already pending", requiresApproval: true, approvalStatus: "pending" })
        .returning()
        .get()!;
      const before = db.select().from(chats).where(eq(chats.id, row.id)).get()!;

      chatExecutorModule.chatExecutor.markPendingApprovalIfRequired(row.id);

      // No second broadcast.
      const types = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]).type);
      expect(types).not.toContain("attention_changed");

      // Row is not rewritten — status and updatedAt stay identical.
      const after = db.select().from(chats).where(eq(chats.id, row.id)).get()!;
      expect(after.approvalStatus).toBe("pending");
      expect(after.updatedAt).toBe(before.updatedAt);
    });

    it("re-flips to 'pending' on a subsequent turn after the user approved the prior one", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      wsManagerModule.wsManager.addGlobalChatClient(ws);

      const row = db
        .insert(chats)
        .values({
          title: "approved once",
          requiresApproval: true,
          approvalStatus: "approved",
          approvedAt: new Date().toISOString(),
        })
        .returning()
        .get()!;

      chatExecutorModule.chatExecutor.markPendingApprovalIfRequired(row.id);

      const { eq } = require("drizzle-orm");
      const after = db.select().from(chats).where(eq(chats.id, row.id)).get()!;
      expect(after.approvalStatus).toBe("pending");
    });

    it("no-ops silently when chat id does not exist", () => {
      expect(() =>
        chatExecutorModule.chatExecutor.markPendingApprovalIfRequired(99999),
      ).not.toThrow();
    });
  });

  /**
   * File-edit journal is the backbone of the chat "Changes" card — every
   * Edit/Write/MultiEdit tool call must (a) persist into the chat's
   * `file_edits` column and (b) broadcast a `chat_diff_updated` frame so
   * `useChatDiff` invalidates live. These tests pin both behaviours.
   */
  describe("file-edit journal + chat_diff_updated broadcast", () => {
    it("persists Edit tool entries into chats.file_edits and broadcasts chat_diff_updated", async () => {
      const ws = { send: vi.fn(), readyState: 1 };
      wsManagerModule.wsManager.addGlobalChatClient(ws);

      const row = db.insert(chats).values({ title: "j" }).returning().get()!;
      const session = new FakeSession();
      chatExecutorModule.chatExecutor.register(row.id, session as any);

      session.emit("tool_call", "Edit", {
        file_path: "/tmp/j/foo.ts",
        old_string: "old",
        new_string: "new\nline",
      });

      const { eq } = await import("drizzle-orm");
      const after = db.select().from(chats).where(eq(chats.id, row.id)).get()!;
      expect(after.fileEdits).not.toBeNull();
      const journal = JSON.parse(after.fileEdits as string);
      expect(journal.entries).toHaveLength(1);
      expect(journal.entries[0]).toMatchObject({
        filePath: "/tmp/j/foo.ts",
        original: "old",
        current: "new\nline",
      });

      const diffMsg = ws.send.mock.calls
        .map((c: any[]) => JSON.parse(c[0]))
        .find((m: any) => m.type === "chat_diff_updated");
      expect(diffMsg).toBeDefined();
      expect(diffMsg.chatId).toBe(row.id);
      expect(diffMsg.payload.chat_id).toBe(String(row.id));
      expect(diffMsg.payload.total_entries).toBe(1);
      expect(diffMsg.payload.summary).toMatch(/1 file changed/);
    });

    it("does NOT broadcast chat_diff_updated for non-file-modifying tool calls", () => {
      const ws = { send: vi.fn(), readyState: 1 };
      wsManagerModule.wsManager.addGlobalChatClient(ws);

      const row = db.insert(chats).values({ title: "read-only" }).returning().get()!;
      const session = new FakeSession();
      chatExecutorModule.chatExecutor.register(row.id, session as any);

      session.emit("tool_call", "Read", { file_path: "/tmp/x.ts" });
      session.emit("tool_call", "Bash", { command: "ls" });

      const diffFrames = ws.send.mock.calls
        .map((c: any[]) => JSON.parse(c[0]))
        .filter((m: any) => m.type === "chat_diff_updated");
      expect(diffFrames).toHaveLength(0);
    });

    it("appends subsequent edits to an existing journal (not overwrite)", async () => {
      const ws = { send: vi.fn(), readyState: 1 };
      wsManagerModule.wsManager.addGlobalChatClient(ws);

      // Seed an existing journal on the chat row.
      const seeded = {
        entries: [{ filePath: "/a", original: "1", current: "2" }],
      };
      const row = db
        .insert(chats)
        .values({ title: "seeded", fileEdits: JSON.stringify(seeded) } as any)
        .returning()
        .get()!;

      const session = new FakeSession();
      chatExecutorModule.chatExecutor.register(row.id, session as any);

      session.emit("tool_call", "Write", {
        file_path: "/b",
        content: "hello",
      });

      const { eq } = await import("drizzle-orm");
      const after = db.select().from(chats).where(eq(chats.id, row.id)).get()!;
      const journal = JSON.parse(after.fileEdits as string);
      expect(journal.entries).toHaveLength(2);
      expect(journal.entries.map((e: any) => e.filePath)).toEqual(["/a", "/b"]);
    });
  });
});
