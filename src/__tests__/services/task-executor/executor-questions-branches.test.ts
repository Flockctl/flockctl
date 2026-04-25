/**
 * Direct unit coverage for task-executor/executor-questions.ts.
 *
 * The sibling `task-executor-questions.test.ts` covers the happy path
 * integrated through TaskExecutor. Here we poke the module directly to
 * hit the remaining uncovered branches:
 *
 *   - findPendingQuestionRow: missing, wrong-status, happy
 *   - handleQuestionEmitted:
 *       • task in a terminal state so validateTaskTransition returns false
 *         (status left alone, row still inserted)
 *       • no backing chat — task-only broadcast, no mirror
 *       • backing chat exists — mirror broadcast
 *   - resolveQuestionHot:
 *       • task already DONE → validateTaskTransition false; DB row still
 *         flipped to 'answered' but no status update / ws frame
 *       • backingChat exists / absent branches
 *   - resolveQuestionCold:
 *       • current==null path → returns false early
 *       • current.status !== WAITING_FOR_INPUT → returns false
 *       • happy path + backing chat mirror
 *   - listPendingQuestions:
 *       • empty / ordered / null createdAt fallback
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../../helpers.js";
import { setDb, type FlockctlDb } from "../../../db/index.js";
import { agentQuestions, chats, tasks } from "../../../db/schema.js";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";

vi.mock("../../../services/ws-manager", () => ({
  wsManager: {
    broadcast: vi.fn(),
    broadcastAll: vi.fn(),
    broadcastChat: vi.fn(),
    connections: new Map(),
  },
}));

// Mock agent-interaction so we can assert which broadcast fired and skip
// real WS plumbing.
const persistAgentQuestionMock = vi.fn<(ref: any, request: any) => number>();
const broadcastAgentQuestionMock = vi.fn();
const broadcastAgentQuestionResolvedMock = vi.fn();

vi.mock("../../../services/agent-interaction", () => ({
  persistAgentQuestion: (ref: any, request: any) => persistAgentQuestionMock(ref, request),
  broadcastAgentQuestion: (...args: any[]) => broadcastAgentQuestionMock(...args),
  broadcastAgentQuestionResolved: (...args: any[]) => broadcastAgentQuestionResolvedMock(...args),
}));

// Mock attention module — we don't care about the WS side-effect here.
vi.mock("../../../services/attention", () => ({
  emitAttentionChanged: vi.fn(),
}));

let db: FlockctlDb;
let sqlite: Database.Database;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);

  // Seed a project so task FK is satisfied.
  sqlite.exec("INSERT INTO projects (id, name) VALUES (1, 'p');");
});

afterAll(() => {
  sqlite.close();
});

beforeEach(() => {
  // Reset + reseed mocks.
  persistAgentQuestionMock.mockReset();
  persistAgentQuestionMock.mockImplementation((ref: any, request: any) => {
    // Real implementation would insert agent_questions. We mimic that so the
    // hot-path and cold-path updates find the row.
    const res = db.insert(agentQuestions).values({
      requestId: request.requestId,
      taskId: ref.kind === "task" ? ref.id : null,
      chatId: ref.kind === "chat" ? ref.id : null,
      toolUseId: request.toolUseID ?? "tu",
      question: request.question,
      status: "pending",
    }).returning().get();
    return res!.id;
  });
  broadcastAgentQuestionMock.mockReset();
  broadcastAgentQuestionResolvedMock.mockReset();
});

// Import after mocks so the target module binds to them.
import {
  findPendingQuestionRow,
  handleQuestionEmitted,
  resolveQuestionHot,
  resolveQuestionCold,
  listPendingQuestions,
} from "../../../services/task-executor/executor-questions.js";
import { TaskStatus } from "../../../lib/types.js";

function newTask(status: string = TaskStatus.RUNNING): number {
  const row = db.insert(tasks).values({
    projectId: 1,
    prompt: "t-" + Math.random(),
    status,
  }).returning().get();
  return row!.id;
}

describe("findPendingQuestionRow", () => {
  it("returns null when no row exists for (taskId, requestId)", () => {
    const taskId = newTask();
    expect(findPendingQuestionRow(taskId, "ghost")).toBeNull();
  });

  it("returns null when the row exists but is already answered", () => {
    const taskId = newTask();
    db.insert(agentQuestions).values({
      requestId: "done", taskId, toolUseId: "tu", question: "?",
      status: "answered",
    }).run();
    expect(findPendingQuestionRow(taskId, "done")).toBeNull();
  });

  it("returns the row when it exists and is pending", () => {
    const taskId = newTask();
    db.insert(agentQuestions).values({
      requestId: "pend", taskId, toolUseId: "tu", question: "?",
      status: "pending",
    }).run();
    const out = findPendingQuestionRow(taskId, "pend");
    expect(out).not.toBeNull();
    expect(out!.requestId).toBe("pend");
  });
});

describe("handleQuestionEmitted — status transition branches", () => {
  it("leaves status alone when current task is terminal (validateTaskTransition → false)", () => {
    // done → waiting_for_input is NOT a valid transition.
    const taskId = newTask(TaskStatus.DONE);

    const id = handleQuestionEmitted(taskId, {
      requestId: "emit-terminal",
      question: "q?",
      toolUseID: "tu-1",
    });
    expect(typeof id).toBe("number");

    // Row inserted by the mocked persistAgentQuestion, but the task status
    // must still be DONE.
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    expect(task!.status).toBe(TaskStatus.DONE);

    // No backing chat → only the task broadcast fires.
    expect(broadcastAgentQuestionMock).toHaveBeenCalledTimes(1);
  });

  it("mirrors the broadcast to the backing chat when one exists", () => {
    const taskId = newTask(TaskStatus.RUNNING);
    const chatRow = db.insert(chats).values({
      title: "backing",
      entityType: "task",
      entityId: String(taskId),
    }).returning().get()!;

    handleQuestionEmitted(taskId, {
      requestId: "emit-with-chat",
      question: "q?",
      toolUseID: "tu-2",
    });
    // Two broadcasts: the task channel + the backing chat mirror.
    expect(broadcastAgentQuestionMock).toHaveBeenCalledTimes(2);
    // Second call was to the chat ref.
    const secondArgs = broadcastAgentQuestionMock.mock.calls[1];
    expect(secondArgs[0]).toEqual({ kind: "chat", id: chatRow.id });
    expect(secondArgs[3]).toEqual({ task_id: String(taskId) });
  });
});

describe("resolveQuestionHot — status transition branches", () => {
  it("persists answer but does NOT flip status when current task is terminal (validateTaskTransition false)", () => {
    const taskId = newTask(TaskStatus.DONE);
    const row = db.insert(agentQuestions).values({
      requestId: "hot-terminal", taskId, toolUseId: "tu", question: "?",
      status: "pending",
    }).returning().get()!;

    resolveQuestionHot(taskId, row as any, "hot-terminal", "answer-text");

    // Row updated to answered.
    const updated = db.select().from(agentQuestions)
      .where(eq(agentQuestions.id, row.id)).get();
    expect(updated!.status).toBe("answered");
    expect(updated!.answer).toBe("answer-text");

    // Task status stays DONE — no transition.
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    expect(task!.status).toBe(TaskStatus.DONE);

    // Broadcast fired on task channel only (no backing chat).
    expect(broadcastAgentQuestionResolvedMock).toHaveBeenCalledTimes(1);
  });

  it("flips status back to RUNNING and mirrors to the backing chat when one exists", () => {
    const taskId = newTask(TaskStatus.WAITING_FOR_INPUT);
    const row = db.insert(agentQuestions).values({
      requestId: "hot-mirror", taskId, toolUseId: "tu", question: "?",
      status: "pending",
    }).returning().get()!;
    const chatRow = db.insert(chats).values({
      title: "bhot",
      entityType: "task",
      entityId: String(taskId),
    }).returning().get()!;

    resolveQuestionHot(taskId, row as any, "hot-mirror", "ok");

    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    expect(task!.status).toBe(TaskStatus.RUNNING);
    expect(broadcastAgentQuestionResolvedMock).toHaveBeenCalledTimes(2);
    const secondArgs = broadcastAgentQuestionResolvedMock.mock.calls[1];
    expect(secondArgs[0]).toEqual({ kind: "chat", id: chatRow.id });
    expect(secondArgs[3]).toEqual({ task_id: String(taskId) });
  });
});

describe("resolveQuestionCold — early-return branches", () => {
  it("returns false when the task row is missing entirely", () => {
    const row = { id: 999999 } as any;
    expect(resolveQuestionCold(999999, row, "ghost", "x")).toBe(false);
  });

  it("returns false when the task is not in WAITING_FOR_INPUT", () => {
    const taskId = newTask(TaskStatus.RUNNING);
    const row = db.insert(agentQuestions).values({
      requestId: "cold-wrong", taskId, toolUseId: "tu", question: "?",
      status: "pending",
    }).returning().get()!;

    expect(resolveQuestionCold(taskId, row as any, "cold-wrong", "x")).toBe(false);

    // Row stayed pending since the guard returned before the update.
    const after = db.select().from(agentQuestions)
      .where(eq(agentQuestions.id, row.id)).get();
    expect(after!.status).toBe("pending");
  });

  it("happy path: flips row → answered, task → queued, mirrors to backing chat", () => {
    const taskId = newTask(TaskStatus.WAITING_FOR_INPUT);
    const row = db.insert(agentQuestions).values({
      requestId: "cold-happy", taskId, toolUseId: "tu", question: "?",
      status: "pending",
    }).returning().get()!;
    const chatRow = db.insert(chats).values({
      title: "bcold",
      entityType: "task",
      entityId: String(taskId),
    }).returning().get()!;

    const ok = resolveQuestionCold(taskId, row as any, "cold-happy", "answer");
    expect(ok).toBe(true);

    const after = db.select().from(agentQuestions)
      .where(eq(agentQuestions.id, row.id)).get();
    expect(after!.status).toBe("answered");
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    expect(task!.status).toBe(TaskStatus.QUEUED);
    // Two broadcasts: task + chat mirror.
    expect(broadcastAgentQuestionResolvedMock).toHaveBeenCalledTimes(2);
    expect(broadcastAgentQuestionResolvedMock.mock.calls[1][0]).toEqual({
      kind: "chat",
      id: chatRow.id,
    });
  });

  it("happy path without backing chat skips the mirror", () => {
    const taskId = newTask(TaskStatus.WAITING_FOR_INPUT);
    const row = db.insert(agentQuestions).values({
      requestId: "cold-solo", taskId, toolUseId: "tu", question: "?",
      status: "pending",
    }).returning().get()!;

    const ok = resolveQuestionCold(taskId, row as any, "cold-solo", "answer");
    expect(ok).toBe(true);
    expect(broadcastAgentQuestionResolvedMock).toHaveBeenCalledTimes(1);
  });
});

describe("listPendingQuestions", () => {
  it("returns [] for a task with no pending questions", () => {
    const taskId = newTask();
    expect(listPendingQuestions(taskId)).toEqual([]);
  });

  it("sorts rows oldest-first and excludes non-pending", () => {
    const taskId = newTask();
    db.insert(agentQuestions).values({
      requestId: "l-2", taskId, toolUseId: "t2", question: "two",
      status: "pending", createdAt: "2026-02-02T00:00:02Z",
    }).run();
    db.insert(agentQuestions).values({
      requestId: "l-1", taskId, toolUseId: "t1", question: "one",
      status: "pending", createdAt: "2026-02-02T00:00:01Z",
    }).run();
    db.insert(agentQuestions).values({
      requestId: "l-d", taskId, toolUseId: "td", question: "done",
      status: "answered",
    }).run();

    const out = listPendingQuestions(taskId);
    expect(out.map((r) => r.requestId)).toEqual(["l-1", "l-2"]);
  });

  it("maps a null createdAt to null (fallback branch) and compares null-safely", () => {
    const taskId = newTask();
    // Drive in two rows with NULL createdAt so the sort's `?? ""` and the
    // mapping's `?? null` both fire.
    sqlite.prepare(
      "INSERT INTO agent_questions (request_id, task_id, tool_use_id, question, status, created_at) VALUES (?, ?, ?, ?, 'pending', NULL)",
    ).run("null-a", taskId, "tu", "a");
    sqlite.prepare(
      "INSERT INTO agent_questions (request_id, task_id, tool_use_id, question, status, created_at) VALUES (?, ?, ?, ?, 'pending', NULL)",
    ).run("null-b", taskId, "tu", "b");

    const out = listPendingQuestions(taskId);
    expect(out).toHaveLength(2);
    for (const r of out) {
      expect(r.createdAt).toBeNull();
    }
  });
});
