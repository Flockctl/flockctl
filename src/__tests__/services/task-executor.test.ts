import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { tasks, taskLogs, aiProviderKeys, projects } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";

// Track AgentSession constructor calls for assertions
const agentSessionCalls: any[] = [];

// Mock heavy dependencies
vi.mock("../../services/agent-session/index", () => {
  const EventEmitter = require("events").EventEmitter;
  class MockAgentSession extends EventEmitter {
    private shouldFail: boolean;
    constructor(opts: any) {
      super();
      agentSessionCalls.push(opts);
      // If prompt contains "FAIL", the session will fail
      this.shouldFail = opts.prompt?.includes("FAIL_SESSION");
    }
    async run() {
      if (this.shouldFail) {
        throw new Error("Agent session failed");
      }
      this.emit("text", "Done");
      return { totalInputTokens: 100, totalOutputTokens: 50 };
    }
    abort() {}
  }
  return { AgentSession: MockAgentSession };
});

vi.mock("../../services/ws-manager", () => ({
  wsManager: {
    broadcast: vi.fn(),
    broadcastAll: vi.fn(), broadcastTaskStatus: vi.fn(), broadcastChatStatus: vi.fn(),
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

// Mock fs operations used for workingDir creation (paths in tests don't exist on disk)
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

  // Insert a key so selectKeyForTask works
  db.insert(aiProviderKeys).values({
    provider: "anthropic",
    providerType: "anthropic-messages",
    label: "test-key",
    keyValue: "sk-ant-api-test-key",
    isActive: true,
    priority: 0,
  }).run();

  db.insert(projects).values({ name: "executor-proj" }).run();
});

afterAll(() => {
  sqlite.close();
});

// Import after mocks are set up
import { taskExecutor } from "../../services/task-executor/index.js";
import { wsManager } from "../../services/ws-manager.js";

describe("TaskExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentSessionCalls.length = 0;
  });

  it("execute() runs task to completion (done)", async () => {
    const task = db.insert(tasks).values({
      projectId: 1,
      prompt: "Hello world",
      status: "queued",
    }).returning().get();

    await taskExecutor.execute(task!.id);

    const updated = db.select().from(tasks).where(eq(tasks.id, task!.id)).get();
    expect(updated!.status).toBe("done");
    expect(updated!.exitCode).toBe(0);
    expect(updated!.completedAt).toBeTruthy();
  });

  it("execute() sets status to running first", async () => {
    const statuses: string[] = [];
    const mockBroadcastTaskStatus = (wsManager as any).broadcastTaskStatus;
    mockBroadcastTaskStatus.mockImplementation((_taskId: number, status: string) => {
      statuses.push(status);
    });

    const task = db.insert(tasks).values({
      projectId: 1,
      prompt: "Track status",
      status: "queued",
    }).returning().get();

    await taskExecutor.execute(task!.id);

    expect(statuses).toContain("running");
    expect(statuses).toContain("done");
  });

  it("execute() handles failed session", async () => {
    const task = db.insert(tasks).values({
      projectId: 1,
      prompt: "FAIL_SESSION please",
      status: "queued",
    }).returning().get();

    await taskExecutor.execute(task!.id);

    const updated = db.select().from(tasks).where(eq(tasks.id, task!.id)).get();
    expect(updated!.status).toBe("failed");
    expect(updated!.exitCode).toBe(1);
    expect(updated!.errorMessage).toContain("Agent session failed");
  });

  it("execute() returns silently for nonexistent task", async () => {
    // Should not throw
    await taskExecutor.execute(99999);
  });

  it("appends logs during execution", async () => {
    const task = db.insert(tasks).values({
      projectId: 1,
      prompt: "Log test",
      status: "queued",
    }).returning().get();

    await taskExecutor.execute(task!.id);

    const logs = db.select().from(taskLogs).where(eq(taskLogs.taskId, task!.id)).all();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some(l => l.content === "Done")).toBe(true);
  });

  it("cancel() returns false for non-running task", () => {
    expect(taskExecutor.cancel(99999)).toBe(false);
  });

  it("isRunning() returns false for non-running task", () => {
    expect(taskExecutor.isRunning(99999)).toBe(false);
  });

  it("cancelAll() does not throw", () => {
    expect(() => taskExecutor.cancelAll()).not.toThrow();
  });

  it("setMaxConcurrent does not throw", () => {
    expect(() => taskExecutor.setMaxConcurrent(10)).not.toThrow();
    // Reset
    taskExecutor.setMaxConcurrent(5);
  });

  it("activeCount is a number", () => {
    expect(typeof taskExecutor.activeCount).toBe("number");
  });

  it("queues tasks when exceeding maxConcurrent", async () => {
    taskExecutor.setMaxConcurrent(1);

    const task1 = db.insert(tasks).values({
      projectId: 1,
      prompt: "Task 1",
      status: "queued",
    }).returning().get();

    const task2 = db.insert(tasks).values({
      projectId: 1,
      prompt: "Task 2",
      status: "queued",
    }).returning().get();

    // Run both — one should queue
    const p1 = taskExecutor.execute(task1!.id);
    const p2 = taskExecutor.execute(task2!.id);

    await p1;
    // Wait a tick for queue to process
    await new Promise(r => setTimeout(r, 50));
    await p2;

    const t1 = db.select().from(tasks).where(eq(tasks.id, task1!.id)).get();
    const t2 = db.select().from(tasks).where(eq(tasks.id, task2!.id)).get();

    expect(t1!.status).toBe("done");
    // t2 may still be running or done depending on timing
    expect(["done", "running", "queued"]).toContain(t2!.status);

    taskExecutor.setMaxConcurrent(5);
  });

  it("resolves workingDir from project.path when task has no workingDir", async () => {
    // Create a project with an explicit path
    const proj = db.insert(projects).values({
      name: "proj-with-path",
      path: "/home/user/flockctl/projects/my-project",
    }).returning().get();

    const task = db.insert(tasks).values({
      projectId: proj!.id,
      prompt: "Should use project path",
      status: "queued",
      // no workingDir set
    }).returning().get();

    await taskExecutor.execute(task!.id);

    // Verify AgentSession was created with the project path as workingDir
    const sessionOpts = agentSessionCalls.find(c => c.taskId === task!.id);
    expect(sessionOpts).toBeTruthy();
    expect(sessionOpts.workingDir).toBe("/home/user/flockctl/projects/my-project");
  });

  it("prefers task.workingDir over project.path", async () => {
    const proj = db.insert(projects).values({
      name: "proj-override",
      path: "/home/user/flockctl/projects/proj-override",
    }).returning().get();

    const task = db.insert(tasks).values({
      projectId: proj!.id,
      prompt: "Should use task override",
      status: "queued",
      workingDir: "/custom/override/path",
    }).returning().get();

    await taskExecutor.execute(task!.id);

    const sessionOpts = agentSessionCalls.find(c => c.taskId === task!.id);
    expect(sessionOpts).toBeTruthy();
    expect(sessionOpts.workingDir).toBe("/custom/override/path");
  });

  it("uses flockctl home as fallback when no project path and no workingDir", async () => {
    // Project without a path
    const proj = db.insert(projects).values({
      name: "proj-no-path",
    }).returning().get();

    const task = db.insert(tasks).values({
      projectId: proj!.id,
      prompt: "Should use flockctl home",
      status: "queued",
    }).returning().get();

    await taskExecutor.execute(task!.id);

    const sessionOpts = agentSessionCalls.find(c => c.taskId === task!.id);
    expect(sessionOpts).toBeTruthy();
    // Should be getFlockctlHome() which defaults to ~/flockctl
    expect(sessionOpts.workingDir).toMatch(/flockctl/);
    // Must NOT be process.cwd()
    expect(sessionOpts.workingDir).not.toBe(process.cwd());
  });
});
