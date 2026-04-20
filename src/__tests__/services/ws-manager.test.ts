import { describe, it, expect, vi, beforeEach } from "vitest";

describe("WSManager", () => {
  let WSManagerModule: any;

  beforeEach(async () => {
    vi.resetModules();
    WSManagerModule = await import("../../services/ws-manager.js");
  });

  it("starts with zero clients", () => {
    expect(WSManagerModule.wsManager.clientCount).toBe(0);
  });

  it("addTaskClient / addChatClient / addGlobalChatClient increase client count", () => {
    const a = { send: vi.fn(), readyState: 1 };
    const b = { send: vi.fn(), readyState: 1 };
    const c = { send: vi.fn(), readyState: 1 };
    WSManagerModule.wsManager.addTaskClient(1, a);
    WSManagerModule.wsManager.addChatClient(2, b);
    WSManagerModule.wsManager.addGlobalChatClient(c);
    expect(WSManagerModule.wsManager.clientCount).toBe(3);
  });

  it("removeClient drops the client from every bucket", () => {
    const ws = { send: vi.fn(), readyState: 1 };
    WSManagerModule.wsManager.addTaskClient(42, ws);
    WSManagerModule.wsManager.removeClient(ws);
    expect(WSManagerModule.wsManager.clientCount).toBe(0);
    // Should not deliver anything after removal
    WSManagerModule.wsManager.broadcast(42, { type: "log" });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("broadcast only reaches clients subscribed to that taskId", () => {
    const task42 = { send: vi.fn(), readyState: 1 };
    const task99 = { send: vi.fn(), readyState: 1 };
    const chatClient = { send: vi.fn(), readyState: 1 };

    WSManagerModule.wsManager.addTaskClient(42, task42);
    WSManagerModule.wsManager.addTaskClient(99, task99);
    WSManagerModule.wsManager.addChatClient(7, chatClient);

    WSManagerModule.wsManager.broadcast(42, { type: "log_line", content: "hello" });

    expect(task42.send).toHaveBeenCalledOnce();
    expect(task99.send).not.toHaveBeenCalled();
    expect(chatClient.send).not.toHaveBeenCalled();

    const msg = JSON.parse(task42.send.mock.calls[0][0]);
    expect(msg.taskId).toBe(42);
    expect(msg.type).toBe("log_line");
  });

  it("broadcast skips CLOSED clients", () => {
    const open = { send: vi.fn(), readyState: 1 };
    const closed = { send: vi.fn(), readyState: 3 };
    WSManagerModule.wsManager.addTaskClient(1, open);
    WSManagerModule.wsManager.addTaskClient(1, closed);
    WSManagerModule.wsManager.broadcast(1, { type: "x" });
    expect(open.send).toHaveBeenCalledOnce();
    expect(closed.send).not.toHaveBeenCalled();
  });

  it("broadcastChat reaches chat-scoped and global-chat clients, but not task clients", () => {
    const chat7 = { send: vi.fn(), readyState: 1 };
    const chat8 = { send: vi.fn(), readyState: 1 };
    const global = { send: vi.fn(), readyState: 1 };
    const task = { send: vi.fn(), readyState: 1 };

    WSManagerModule.wsManager.addChatClient(7, chat7);
    WSManagerModule.wsManager.addChatClient(8, chat8);
    WSManagerModule.wsManager.addGlobalChatClient(global);
    WSManagerModule.wsManager.addTaskClient(1, task);

    WSManagerModule.wsManager.broadcastChat(7, { type: "session_started" });

    expect(chat7.send).toHaveBeenCalledOnce();
    expect(chat8.send).not.toHaveBeenCalled();
    expect(global.send).toHaveBeenCalledOnce();
    expect(task.send).not.toHaveBeenCalled();

    const msg = JSON.parse(chat7.send.mock.calls[0][0]);
    expect(msg.chatId).toBe(7);
    expect(msg.type).toBe("session_started");
  });

  it("broadcastAll reaches every registered client", () => {
    const taskClient = { send: vi.fn(), readyState: 1 };
    const chatClient = { send: vi.fn(), readyState: 1 };
    const globalChat = { send: vi.fn(), readyState: 1 };

    WSManagerModule.wsManager.addTaskClient(1, taskClient);
    WSManagerModule.wsManager.addChatClient(2, chatClient);
    WSManagerModule.wsManager.addGlobalChatClient(globalChat);

    WSManagerModule.wsManager.broadcastAll({ type: "task_status", running: true });

    expect(taskClient.send).toHaveBeenCalledOnce();
    expect(chatClient.send).toHaveBeenCalledOnce();
    expect(globalChat.send).toHaveBeenCalledOnce();

    const msg = JSON.parse(taskClient.send.mock.calls[0][0]);
    expect(msg.type).toBe("task_status");
    expect(msg.running).toBe(true);
  });

  it("broadcast ignores clients that throw on send", () => {
    const dead = { send: vi.fn(() => { throw new Error("dead socket"); }), readyState: 1 };
    const live = { send: vi.fn(), readyState: 1 };
    WSManagerModule.wsManager.addTaskClient(1, dead);
    WSManagerModule.wsManager.addTaskClient(1, live);
    expect(() => WSManagerModule.wsManager.broadcast(1, { type: "test" })).not.toThrow();
    expect(live.send).toHaveBeenCalledOnce();
  });

  it("broadcastAll ignores clients that throw on send", () => {
    const dead = { send: vi.fn(() => { throw new Error("dead"); }), readyState: 1 };
    WSManagerModule.wsManager.addTaskClient(1, dead);
    expect(() => WSManagerModule.wsManager.broadcastAll({ type: "ping" })).not.toThrow();
  });

  it("closeAll closes every client and clears all buckets", () => {
    const taskClient = { send: vi.fn(), readyState: 1, close: vi.fn() };
    const chatClient = { send: vi.fn(), readyState: 1, close: vi.fn() };
    const globalChat = { send: vi.fn(), readyState: 1, close: vi.fn() };

    WSManagerModule.wsManager.addTaskClient(1, taskClient);
    WSManagerModule.wsManager.addChatClient(2, chatClient);
    WSManagerModule.wsManager.addGlobalChatClient(globalChat);

    WSManagerModule.wsManager.closeAll();

    expect(taskClient.close).toHaveBeenCalled();
    expect(chatClient.close).toHaveBeenCalled();
    expect(globalChat.close).toHaveBeenCalled();
    expect(WSManagerModule.wsManager.clientCount).toBe(0);

    // Further broadcasts deliver nothing
    WSManagerModule.wsManager.broadcast(1, { type: "x" });
    WSManagerModule.wsManager.broadcastChat(2, { type: "x" });
    WSManagerModule.wsManager.broadcastAll({ type: "x" });
    expect(taskClient.send).not.toHaveBeenCalled();
    expect(chatClient.send).not.toHaveBeenCalled();
    expect(globalChat.send).not.toHaveBeenCalled();
  });

  it("closeAll tolerates clients without a close method", () => {
    const ws = { send: vi.fn(), readyState: 1 };
    WSManagerModule.wsManager.addTaskClient(1, ws);
    expect(() => WSManagerModule.wsManager.closeAll()).not.toThrow();
    expect(WSManagerModule.wsManager.clientCount).toBe(0);
  });

  it("removeClient is idempotent", () => {
    const ws = { send: vi.fn(), readyState: 1 };
    WSManagerModule.wsManager.addTaskClient(1, ws);
    WSManagerModule.wsManager.removeClient(ws);
    WSManagerModule.wsManager.removeClient(ws);
    expect(WSManagerModule.wsManager.clientCount).toBe(0);
  });

  it("broadcast with no subscribers to that taskId is a no-op", () => {
    const other = { send: vi.fn(), readyState: 1 };
    WSManagerModule.wsManager.addTaskClient(1, other);
    WSManagerModule.wsManager.broadcast(2, { type: "log_line" });
    expect(other.send).not.toHaveBeenCalled();
  });

  it("broadcastAll with no clients does nothing", () => {
    expect(() => WSManagerModule.wsManager.broadcastAll({ type: "test" })).not.toThrow();
  });
});
