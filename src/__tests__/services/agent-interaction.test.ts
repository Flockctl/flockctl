import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { agentQuestions, tasks, chats } from "../../db/schema.js";
import { eq } from "drizzle-orm";

/**
 * Unit tests for the shared `agent-interaction` helpers. Both TaskExecutor
 * and ChatExecutor route their WS broadcasts and `agent_questions` inserts
 * through these helpers, so the payload shape and DB shape are asserted
 * here once instead of being duplicated in each executor's test file.
 */
describe("agent-interaction", () => {
  let dbModule: typeof import("../../db/index.js");
  let wsManagerModule: typeof import("../../services/ws-manager.js");
  let agentInteraction: typeof import("../../services/agent-interaction.js");
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(async () => {
    vi.resetModules();
    dbModule = await import("../../db/index.js");
    const t = createTestDb();
    db = t.db;
    dbModule.setDb(db, t.sqlite);
    wsManagerModule = await import("../../services/ws-manager.js");
    agentInteraction = await import("../../services/agent-interaction.js");
  });

  afterEach(() => {
    dbModule.closeDb();
  });

  function listen(kind: "task" | "chat", id: number): { send: ReturnType<typeof vi.fn> } {
    const ws = { send: vi.fn(), readyState: 1 } as any;
    if (kind === "task") {
      wsManagerModule.wsManager.addTaskClient(id, ws);
    } else {
      wsManagerModule.wsManager.addGlobalChatClient(ws);
    }
    return ws;
  }

  function parse(ws: { send: ReturnType<typeof vi.fn> }, type: string): any {
    const call = ws.send.mock.calls.find((c: any[]) => {
      try { return JSON.parse(c[0]).type === type; } catch { return false; }
    });
    expect(call, `expected WS event ${type}`).toBeDefined();
    return JSON.parse(call![0]);
  }

  const permRequest = {
    requestId: "req-1",
    toolName: "Bash",
    toolInput: { command: "ls" },
    toolUseID: "tu-1",
    title: "Run ls",
    displayName: "List",
    description: "Lists files",
    decisionReason: "user-interactive",
  };

  const qRequest = {
    requestId: "q-1",
    question: "Which file?",
    toolUseID: "tu-2",
  };

  describe("broadcastPermissionRequest", () => {
    it("emits task_id field on task channel", () => {
      const ws = listen("task", 7);
      agentInteraction.broadcastPermissionRequest({ kind: "task", id: 7 }, permRequest);
      const body = parse(ws, "permission_request");
      expect(body.taskId).toBe(7);
      expect(body.payload.task_id).toBe("7");
      expect(body.payload.chat_id).toBeUndefined();
      expect(body.payload.request_id).toBe("req-1");
      expect(body.payload.tool_name).toBe("Bash");
      expect(body.payload.title).toBe("Run ls");
      expect(body.payload.display_name).toBe("List");
      expect(body.payload.description).toBe("Lists files");
      expect(body.payload.decision_reason).toBe("user-interactive");
      expect(body.payload.tool_use_id).toBe("tu-1");
    });

    it("emits chat_id field on chat channel", () => {
      const ws = listen("chat", 11);
      agentInteraction.broadcastPermissionRequest({ kind: "chat", id: 11 }, permRequest);
      const body = parse(ws, "permission_request");
      expect(body.chatId).toBe(11);
      expect(body.payload.chat_id).toBe("11");
      expect(body.payload.task_id).toBeUndefined();
    });

    it("nulls out missing optional fields", () => {
      const ws = listen("task", 1);
      const minimal = { requestId: "r", toolName: "X", toolInput: {}, toolUseID: "u" };
      agentInteraction.broadcastPermissionRequest({ kind: "task", id: 1 }, minimal);
      const body = parse(ws, "permission_request");
      expect(body.payload.title).toBeNull();
      expect(body.payload.display_name).toBeNull();
      expect(body.payload.description).toBeNull();
      expect(body.payload.decision_reason).toBeNull();
    });

    it("merges extraPayload fields", () => {
      const ws = listen("task", 2);
      agentInteraction.broadcastPermissionRequest(
        { kind: "task", id: 2 },
        permRequest,
        { extra_note: "hi" },
      );
      const body = parse(ws, "permission_request");
      expect(body.payload.extra_note).toBe("hi");
    });
  });

  describe("broadcastPermissionResolved", () => {
    it("emits the resolved payload for tasks", () => {
      const ws = listen("task", 3);
      agentInteraction.broadcastPermissionResolved({ kind: "task", id: 3 }, "req-9", "allow");
      const body = parse(ws, "permission_resolved");
      expect(body.payload.task_id).toBe("3");
      expect(body.payload.request_id).toBe("req-9");
      expect(body.payload.behavior).toBe("allow");
    });

    it("emits the resolved payload for chats", () => {
      const ws = listen("chat", 4);
      agentInteraction.broadcastPermissionResolved({ kind: "chat", id: 4 }, "req-10", "deny");
      const body = parse(ws, "permission_resolved");
      expect(body.payload.chat_id).toBe("4");
      expect(body.payload.behavior).toBe("deny");
    });
  });

  describe("persistAgentQuestion", () => {
    it("inserts a task-scoped row and returns its id", () => {
      const task = db.insert(tasks).values({ prompt: "p" }).returning().get()!;
      const id = agentInteraction.persistAgentQuestion({ kind: "task", id: task.id }, qRequest);
      expect(id).not.toBeNull();
      const row = db.select().from(agentQuestions).where(eq(agentQuestions.id, id!)).get();
      expect(row?.taskId).toBe(task.id);
      expect(row?.chatId).toBeNull();
      expect(row?.requestId).toBe("q-1");
      expect(row?.question).toBe("Which file?");
      expect(row?.toolUseId).toBe("tu-2");
      expect(row?.status).toBe("pending");
    });

    it("inserts a chat-scoped row and returns its id", () => {
      const chat = db.insert(chats).values({ title: "c" }).returning().get()!;
      const id = agentInteraction.persistAgentQuestion({ kind: "chat", id: chat.id }, qRequest);
      expect(id).not.toBeNull();
      const row = db.select().from(agentQuestions).where(eq(agentQuestions.id, id!)).get();
      expect(row?.chatId).toBe(chat.id);
      expect(row?.taskId).toBeNull();
    });

    it("returns null on duplicate requestId (idempotent replay)", () => {
      const task = db.insert(tasks).values({ prompt: "p" }).returning().get()!;
      const first = agentInteraction.persistAgentQuestion({ kind: "task", id: task.id }, qRequest);
      expect(first).not.toBeNull();
      const second = agentInteraction.persistAgentQuestion({ kind: "task", id: task.id }, qRequest);
      expect(second).toBeNull();
      const rows = db.select().from(agentQuestions).all();
      expect(rows.length).toBe(1);
    });

    it("logs and returns null on non-UNIQUE errors (e.g. missing NOT NULL)", () => {
      const task = db.insert(tasks).values({ prompt: "p" }).returning().get()!;
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      // Null toolUseID violates the NOT NULL constraint — distinct from the
      // UNIQUE path, so the helper logs via console.error and returns null.
      const badRequest = { requestId: "bad-req", question: "x", toolUseID: null as any };
      const id = agentInteraction.persistAgentQuestion({ kind: "task", id: task.id }, badRequest);
      expect(id).toBeNull();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("broadcastAgentQuestion", () => {
    it("emits agent_question with db_id on task channel", () => {
      const ws = listen("task", 5);
      agentInteraction.broadcastAgentQuestion({ kind: "task", id: 5 }, qRequest, 42);
      const body = parse(ws, "agent_question");
      expect(body.payload.task_id).toBe("5");
      expect(body.payload.request_id).toBe("q-1");
      expect(body.payload.question).toBe("Which file?");
      expect(body.payload.tool_use_id).toBe("tu-2");
      expect(body.payload.db_id).toBe(42);
    });

    it("surfaces backing chat id via extraPayload on task channel", () => {
      const ws = listen("task", 6);
      agentInteraction.broadcastAgentQuestion(
        { kind: "task", id: 6 },
        qRequest,
        null,
        { chat_id: "99" },
      );
      const body = parse(ws, "agent_question");
      expect(body.payload.task_id).toBe("6");
      expect(body.payload.chat_id).toBe("99");
      expect(body.payload.db_id).toBeNull();
    });
  });

  describe("broadcastAgentQuestionResolved", () => {
    it("emits agent_question_resolved with the answer for chats", () => {
      const ws = listen("chat", 8);
      agentInteraction.broadcastAgentQuestionResolved(
        { kind: "chat", id: 8 },
        "q-1",
        "file.txt",
      );
      const body = parse(ws, "agent_question_resolved");
      expect(body.payload.chat_id).toBe("8");
      expect(body.payload.request_id).toBe("q-1");
      expect(body.payload.answer).toBe("file.txt");
    });

    it("merges extraPayload for cross-entity forwarding", () => {
      const ws = listen("chat", 9);
      agentInteraction.broadcastAgentQuestionResolved(
        { kind: "chat", id: 9 },
        "q-x",
        "answer",
        { task_id: "55" },
      );
      const body = parse(ws, "agent_question_resolved");
      expect(body.payload.task_id).toBe("55");
      expect(body.payload.chat_id).toBe("9");
    });
  });
});
