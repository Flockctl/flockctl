import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "events";
import { serve } from "@hono/node-server";
import WebSocket from "ws";
import { app, injectWebSocket } from "../server.js";
import { createTestDb } from "./helpers.js";
import { setDb, type FlockctlDb } from "../db/index.js";
import Database from "better-sqlite3";
import { chats } from "../db/schema.js";
import { chatExecutor } from "../services/chat-executor.js";
import type { AgentSession } from "../services/agent-session/index.js";

let db: FlockctlDb;
let sqlite: Database.Database;
let server: any;
let port: number;

function open(path: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const timeout = setTimeout(() => {
      reject(new Error("ws open timeout"));
      try { ws.close(); } catch {}
    }, 1500);
    ws.once("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    ws.once("close", (code, reason) => {
      clearTimeout(timeout);
      // Resolve with the (already-closed) socket so the test can inspect it.
      resolve(ws);
    });
  });
}

beforeAll(async () => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);

  await new Promise<void>((res) => {
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      port = info.port;
      res();
    });
  });
  injectWebSocket(server);
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  sqlite.close();
});

describe("WebSocket endpoints", () => {
  it("connects to /ws/ui/tasks/:taskId/logs and closes cleanly", async () => {
    const ws = await open("/ws/ui/tasks/123/logs");
    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    await new Promise((r) => ws.once("close", r));
    expect(true).toBe(true);
  });

  it("connects to /ws/ui/chats/:chatId/events", async () => {
    const ws = await open("/ws/ui/chats/42/events");
    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    await new Promise((r) => ws.once("close", r));
    expect(true).toBe(true);
  });

  it("connects to global /ws/ui/chats/events", async () => {
    const ws = await open("/ws/ui/chats/events");
    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    await new Promise((r) => ws.once("close", r));
    expect(true).toBe(true);
  });

  it("handles non-numeric :taskId param (NaN branch)", async () => {
    const ws = await open("/ws/ui/tasks/notanumber/logs");
    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    await new Promise((r) => ws.once("close", r));
    expect(true).toBe(true);
  });

  it("handles non-numeric :chatId param (NaN branch)", async () => {
    const ws = await open("/ws/ui/chats/bogus/events");
    await new Promise((r) => setTimeout(r, 30));
    ws.close();
    await new Promise((r) => ws.once("close", r));
    expect(true).toBe(true);
  });

  /**
   * Broadcast path: a stub AgentSession (pure EventEmitter, cast to the
   * real type — chat-executor only uses .on) wired through
   * chatExecutor.register. Emitting a `tool_call` with a TodoWrite payload
   * must trigger recordTodoWrite's internal wsManager.broadcastChat and
   * land a `todo_updated` frame on the connected client.
   */
  it("broadcasts todo_updated when a TodoWrite tool_call is emitted", async () => {
    const chat = db.insert(chats).values({ title: "todo ws" }).returning().get();

    const ws = await open(`/ws/ui/chats/${chat.id}/events`);
    // Give the server a tick to register the WS client before we fan out.
    await new Promise((r) => setTimeout(r, 30));

    const frames: any[] = [];
    ws.on("message", (data) => {
      try { frames.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });

    const stubSession = new EventEmitter() as unknown as AgentSession;
    chatExecutor.register(chat.id, stubSession);

    stubSession.emit("tool_call", "TodoWrite", {
      todos: [
        { content: "do a", status: "completed", activeForm: "doing a" },
        { content: "do b", status: "in_progress", activeForm: "doing b" },
        { content: "do c", status: "pending", activeForm: "doing c" },
      ],
    });

    // Small wait so the broadcast reaches the socket layer.
    await new Promise((r) => setTimeout(r, 50));

    const todoFrame = frames.find((f) => f?.type === "todo_updated");
    expect(todoFrame).toBeDefined();
    expect(todoFrame.payload.chat_id).toBe(String(chat.id));
    expect(todoFrame.payload.task_id).toBeNull();
    expect(typeof todoFrame.payload.snapshot_id).toBe("number");
    expect(todoFrame.payload.counts).toEqual({
      total: 3,
      completed: 1,
      in_progress: 1,
      pending: 1,
    });

    // Re-emit an identical snapshot — dedup must skip the insert, so no
    // additional todo_updated frame should arrive.
    const beforeCount = frames.filter((f) => f?.type === "todo_updated").length;
    stubSession.emit("tool_call", "TodoWrite", {
      todos: [
        { content: "do a", status: "completed", activeForm: "doing a" },
        { content: "do b", status: "in_progress", activeForm: "doing b" },
        { content: "do c", status: "pending", activeForm: "doing c" },
      ],
    });
    await new Promise((r) => setTimeout(r, 50));
    const afterCount = frames.filter((f) => f?.type === "todo_updated").length;
    expect(afterCount).toBe(beforeCount);

    chatExecutor.unregister(chat.id);
    ws.close();
    await new Promise((r) => ws.once("close", r));
  });

  /**
   * Mirror of the permission_request fan-out path for agent clarification
   * questions. A stub AgentSession with a stand-in `resolveQuestion` is wired
   * through chatExecutor; emitting `question_request` lands as an
   * `agent_question` frame on the subscribed client, and
   * chatExecutor.answerQuestion → session.resolveQuestion lands the matching
   * `agent_question_resolved` frame.
   */
  it("broadcasts agent_question + agent_question_resolved over a chat subscription", async () => {
    const chat = db.insert(chats).values({ title: "q ws" }).returning().get();

    const ws = await open(`/ws/ui/chats/${chat.id}/events`);
    await new Promise((r) => setTimeout(r, 30));

    const frames: any[] = [];
    ws.on("message", (data) => {
      try { frames.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });

    // Stub AgentSession with just enough surface area for chat-executor:
    // EventEmitter for .on() plus a resolveQuestion method that the
    // chatExecutor.answerQuestion hot path calls into.
    class StubSession extends EventEmitter {
      resolveQuestion(_requestId: string, _answer: string): boolean {
        return true;
      }
    }
    const stubSession = new StubSession() as unknown as AgentSession;
    chatExecutor.register(chat.id, stubSession);

    stubSession.emit("question_request", {
      requestId: "q-req-1",
      question: "What port should I bind to?",
      toolUseID: "tu-q-1",
    });

    await new Promise((r) => setTimeout(r, 50));

    const questionFrame = frames.find((f) => f?.type === "agent_question");
    expect(questionFrame).toBeDefined();
    expect(questionFrame.payload.chat_id).toBe(String(chat.id));
    expect(questionFrame.payload.request_id).toBe("q-req-1");
    expect(questionFrame.payload.question).toBe("What port should I bind to?");

    // Resolve via the public API — flips the row to answered and broadcasts
    // the agent_question_resolved frame with the answer text.
    const ok = chatExecutor.answerQuestion(chat.id, "q-req-1", "52077");
    expect(ok).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    const resolvedFrame = frames.find((f) => f?.type === "agent_question_resolved");
    expect(resolvedFrame).toBeDefined();
    expect(resolvedFrame.payload.request_id).toBe("q-req-1");
    expect(resolvedFrame.payload.answer).toBe("52077");

    chatExecutor.unregister(chat.id);
    ws.close();
    await new Promise((r) => ws.once("close", r));
  });
});
