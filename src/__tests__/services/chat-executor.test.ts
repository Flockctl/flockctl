import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { createTestDb } from "../helpers.js";
import { chatMessages, chats } from "../../db/schema.js";

class FakeSession extends EventEmitter {
  abort = vi.fn();
  resolvePermission = vi.fn().mockReturnValue(true);
  pendingPermissionCount = 0;
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
});
