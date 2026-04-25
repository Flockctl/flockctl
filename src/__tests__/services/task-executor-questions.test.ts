import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { tasks, aiProviderKeys, projects, agentQuestions } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";

// Live MockAgentSession instances, keyed by taskId. Populated inside the
// mocked class constructor (see vi.mock factory). Typed as `any` because
// the mock class is defined inside the factory (vi.mock hoisting) and
// isn't visible to the outer scope at declaration time.
const liveSessions = new Map<number, any>();

vi.mock("../../services/agent-session/index", () => {
  const { EventEmitter } = require("events");
  class MockAgentSession extends EventEmitter {
    public readonly taskId: number | undefined;
    public readonly chatId: number | undefined;
    public readonly opts: any;
    private runResolver: ((metrics: any) => void) | null = null;
    private runRejector: ((err: Error) => void) | null = null;
    private pendingQuestions = new Map<string, (answer: string) => void>();

    constructor(opts: any) {
      super();
      this.opts = opts;
      this.taskId = opts.taskId;
      this.chatId = opts.chatId;
      if (this.taskId !== undefined) liveSessions.set(this.taskId, this);
    }

    run(): Promise<any> {
      return new Promise((resolve, reject) => {
        this.runResolver = resolve;
        this.runRejector = reject;
      });
    }

    abort(_reason?: string): void {
      this.runRejector?.(new Error("Aborted"));
    }

    emitQuestion(request: { requestId: string; question: string; toolUseID: string }): Promise<string> {
      return new Promise((resolveAnswer) => {
        this.pendingQuestions.set(request.requestId, resolveAnswer);
        this.emit("question_request", request);
      });
    }

    resolveQuestion(requestId: string, answer: string): boolean {
      const r = this.pendingQuestions.get(requestId);
      if (!r) return false;
      this.pendingQuestions.delete(requestId);
      r(answer);
      return true;
    }

    finish(metrics: any = { totalInputTokens: 10, totalOutputTokens: 5 }): void {
      this.runResolver?.(metrics);
    }

    pendingPermissionRequests() {
      return [];
    }
    get pendingPermissionCount() {
      return 0;
    }
  }
  return { AgentSession: MockAgentSession };
});

vi.mock("../../services/ws-manager", () => ({
  wsManager: {
    broadcast: vi.fn(),
    broadcastAll: vi.fn(),
    broadcastChat: vi.fn(),
    connections: new Map(),
  },
}));

vi.mock("../../services/claude/skills-sync", () => ({
  reconcileClaudeSkillsForProject: vi.fn(() => {}),
}));

vi.mock("../../services/claude/mcp-sync", () => ({
  reconcileMcpForProject: vi.fn(() => {}),
}));

vi.mock("../../services/git-context", () => ({
  buildCodebaseContext: vi.fn(async () => ""),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
  };
});

let db: FlockctlDb;
let sqlite: Database.Database;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);

  db.insert(aiProviderKeys).values({
    provider: "anthropic",
    providerType: "anthropic-messages",
    label: "test-key",
    keyValue: "sk-ant-api-test-key",
    isActive: true,
    priority: 0,
  }).run();

  db.insert(projects).values({ name: "q-proj" }).run();
});

afterAll(() => {
  sqlite.close();
});

// Import after mocks so taskExecutor binds to the mocked modules.
import { taskExecutor } from "../../services/task-executor/index.js";
import { TaskStatus } from "../../lib/types.js";

describe("TaskExecutor: question/answer cycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveSessions.clear();
  });

  it("question_request flips task to waiting_for_input, persists row, and answer restores running", async () => {
    const task = db.insert(tasks).values({
      projectId: 1,
      prompt: "Please ask me something",
      status: "queued",
    }).returning().get();

    // Kick off — don't await; the mock session parks until finish() is called.
    const runPromise = taskExecutor.execute(task!.id);

    await waitFor(() => liveSessions.has(task!.id));
    const session = liveSessions.get(task!.id)!;
    await waitFor(() => readStatus(task!.id) === TaskStatus.RUNNING);

    const answerPromise = session.emitQuestion({
      requestId: "req-1",
      question: "What port should I bind to?",
      toolUseID: "tool-use-1",
    });

    // The executor's on("question_request") handler runs synchronously on
    // the event loop — by the next microtask the row + status should both
    // be in place.
    await microtask();

    const row = db.select().from(agentQuestions)
      .where(eq(agentQuestions.requestId, "req-1")).get();
    expect(row).toBeTruthy();
    expect(row!.status).toBe("pending");
    expect(row!.taskId).toBe(task!.id);
    expect(row!.question).toBe("What port should I bind to?");

    expect(readStatus(task!.id)).toBe(TaskStatus.WAITING_FOR_INPUT);

    // pendingQuestions helper returns the row.
    const pending = taskExecutor.pendingQuestions(task!.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].requestId).toBe("req-1");

    // Answer — hot path, session still in memory.
    const ok = taskExecutor.answerQuestion(task!.id, "req-1", "port 52077");
    expect(ok).toBe(true);

    // Task flipped back to running; row updated to 'answered' with the text.
    expect(readStatus(task!.id)).toBe(TaskStatus.RUNNING);
    const updatedRow = db.select().from(agentQuestions)
      .where(eq(agentQuestions.requestId, "req-1")).get();
    expect(updatedRow!.status).toBe("answered");
    expect(updatedRow!.answer).toBe("port 52077");
    expect(updatedRow!.answeredAt).toBeTruthy();

    // The agent loop inside the session unblocked with the answer text.
    await expect(answerPromise).resolves.toBe("port 52077");

    // Let the session finish so execute() finalizes to done.
    session.finish();
    await runPromise;

    expect(readStatus(task!.id)).toBe(TaskStatus.DONE);
  });

  it("answerQuestion returns false for unknown requestId", async () => {
    const task = db.insert(tasks).values({
      projectId: 1,
      prompt: "unknown-answer",
      status: "queued",
    }).returning().get();

    const runPromise = taskExecutor.execute(task!.id);
    await waitFor(() => liveSessions.has(task!.id));
    const session = liveSessions.get(task!.id)!;

    expect(taskExecutor.answerQuestion(task!.id, "does-not-exist", "hi")).toBe(false);

    session.finish();
    await runPromise;
  });

  it("replay: answering the same requestId twice returns false the second time", async () => {
    const task = db.insert(tasks).values({
      projectId: 1,
      prompt: "replay-test",
      status: "queued",
    }).returning().get();

    const runPromise = taskExecutor.execute(task!.id);
    await waitFor(() => liveSessions.has(task!.id));
    const session = liveSessions.get(task!.id)!;
    await waitFor(() => readStatus(task!.id) === TaskStatus.RUNNING);

    session.emitQuestion({ requestId: "replay-1", question: "hi?", toolUseID: "tu-2" });
    await microtask();
    expect(taskExecutor.answerQuestion(task!.id, "replay-1", "yes")).toBe(true);
    expect(taskExecutor.answerQuestion(task!.id, "replay-1", "yes again")).toBe(false);

    session.finish();
    await runPromise;
  });

  it("duplicate question_request with same requestId is idempotent (UNIQUE constraint)", async () => {
    const task = db.insert(tasks).values({
      projectId: 1,
      prompt: "idempotent-q",
      status: "queued",
    }).returning().get();

    const runPromise = taskExecutor.execute(task!.id);
    await waitFor(() => liveSessions.has(task!.id));
    const session = liveSessions.get(task!.id)!;
    await waitFor(() => readStatus(task!.id) === TaskStatus.RUNNING);

    session.emitQuestion({ requestId: "dup-1", question: "first", toolUseID: "tu-3" });
    session.emitQuestion({ requestId: "dup-1", question: "second", toolUseID: "tu-3" });
    await microtask();

    const rows = db.select().from(agentQuestions)
      .where(eq(agentQuestions.requestId, "dup-1")).all();
    expect(rows).toHaveLength(1);
    // First insert wins — the second is swallowed by the UNIQUE constraint.
    expect(rows[0].question).toBe("first");

    taskExecutor.answerQuestion(task!.id, "dup-1", "ok");
    session.finish();
    await runPromise;
  });

  it("cold-path resume: daemon restart recreates session via claudeSessionId + queued transition", async () => {
    // Simulate the DB state left behind by a daemon crash mid-wait: task in
    // waiting_for_input with claudeSessionId, an open agent_questions row.
    // The production code would have written these during the first run
    // before the restart.
    const task = db.insert(tasks).values({
      projectId: 1,
      prompt: "restart-test",
      status: TaskStatus.WAITING_FOR_INPUT,
      claudeSessionId: "claude-session-abc",
    }).returning().get();

    db.insert(agentQuestions).values({
      requestId: "cold-1",
      taskId: task!.id,
      toolUseId: "tu-cold",
      question: "What config?",
      status: "pending",
    }).run();

    // No in-memory session exists — answering triggers the cold path:
    // update row, flip to queued, kick execute().
    const ok = taskExecutor.answerQuestion(task!.id, "cold-1", "prod");
    expect(ok).toBe(true);

    const row = db.select().from(agentQuestions)
      .where(eq(agentQuestions.requestId, "cold-1")).get();
    expect(row!.status).toBe("answered");
    expect(row!.answer).toBe("prod");

    // execute() was called (fire-and-forget) — a fresh mock session is
    // registered and the task is running again. resumeSessionId should be
    // forwarded so the agent SDK replays the prior Claude Code session.
    await waitFor(() => liveSessions.has(task!.id));
    const session = liveSessions.get(task!.id)!;
    expect(session.opts.resumeSessionId).toBe("claude-session-abc");
    await waitFor(() => readStatus(task!.id) === TaskStatus.RUNNING);

    session.finish();
    await waitFor(() => readStatus(task!.id) === TaskStatus.DONE);
  });

  it("resetStaleTasks leaves waiting_for_input tasks alone", () => {
    const stuck = db.insert(tasks).values({
      projectId: 1,
      prompt: "stuck-running",
      status: TaskStatus.RUNNING,
    }).returning().get();
    const parked = db.insert(tasks).values({
      projectId: 1,
      prompt: "parked",
      status: TaskStatus.WAITING_FOR_INPUT,
      claudeSessionId: "claude-session-xyz",
    }).returning().get();

    const requeued = taskExecutor.resetStaleTasks();

    expect(requeued).toContain(stuck!.id);
    expect(requeued).not.toContain(parked!.id);

    expect(readStatus(stuck!.id)).toBe(TaskStatus.QUEUED);
    expect(readStatus(parked!.id)).toBe(TaskStatus.WAITING_FOR_INPUT);
  });
});

// ─── helpers ───

function readStatus(taskId: number): string {
  const row = db.select({ status: tasks.status })
    .from(tasks).where(eq(tasks.id, taskId)).get();
  return row!.status ?? "";
}

function microtask(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timeout");
}
