import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { tasks, taskLogs, usageRecords, aiProviderKeys, projects, workspaces } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import Database from "better-sqlite3";

const createdSessions: any[] = [];

vi.mock("../../services/agent-session", () => {
  const EventEmitter = require("events").EventEmitter;
  class MockAgentSession extends EventEmitter {
    private opts: any;
    constructor(opts: any) {
      super();
      this.opts = opts;
      createdSessions.push(this);
    }
    async run() {
      // Emit a session_id so the persist path runs
      this.emit("session_id", "claude-session-abc");
      return {
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalCostUsd: 0, // drives calculateCost fallback
        turns: 1,
        durationMs: 5,
      };
    }
    abort() {}
  }
  return { AgentSession: MockAgentSession };
});

vi.mock("../../services/ws-manager", () => ({
  wsManager: { broadcast: vi.fn(), broadcastAll: vi.fn() },
}));
vi.mock("../../services/claude-skills-sync", () => ({
  reconcileClaudeSkillsForProject: vi.fn(),
}));
vi.mock("../../services/claude-mcp-sync", () => ({
  reconcileMcpForProject: vi.fn(),
}));
vi.mock("../../services/git-context", () => ({
  buildCodebaseContext: vi.fn(async () => "context"),
}));
vi.mock("../../services/project-config", () => ({
  loadProjectConfig: vi.fn(() => ({})),
}));
vi.mock("../../services/workspace-config", () => ({
  loadWorkspaceConfig: vi.fn(() => ({ permissionMode: "default" })),
}));

const existsSyncMock = vi.fn((p: string) => p.endsWith(".git"));
const mkdirSyncMock = vi.fn();
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: (p: string) => existsSyncMock(p),
    mkdirSync: (...args: any[]) => mkdirSyncMock(...args),
  };
});

const execFileSyncMock = vi.fn();
vi.mock("child_process", () => ({
  execFileSync: (...args: any[]) => execFileSyncMock(...args),
}));

// selectKeyForTask can throw to exercise failure branch
const selectKeyMock = vi.fn();
vi.mock("../../services/key-selection", () => ({
  selectKeyForTask: (...args: any[]) => selectKeyMock(...args),
}));

import { taskExecutor } from "../../services/task-executor.js";

let db: FlockctlDb;
let sqlite: Database.Database;
let projectId: number;
let workspaceId: number;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);

  db.insert(aiProviderKeys).values({
    provider: "anthropic",
    providerType: "anthropic-messages",
    label: "k",
    keyValue: "sk-ant-api-k",
    isActive: 1,
    priority: 0,
  } as any).run();
});

afterAll(() => sqlite.close());

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM task_logs;
    DELETE FROM tasks;
    DELETE FROM usage_records;
    DELETE FROM projects;
    DELETE FROM workspaces;
  `);
  createdSessions.length = 0;
  existsSyncMock.mockReset();
  existsSyncMock.mockImplementation((p: string) => p.endsWith(".git"));
  mkdirSyncMock.mockReset();
  execFileSyncMock.mockReset();
  selectKeyMock.mockReset();
  selectKeyMock.mockResolvedValue({ id: 1, configDir: "/tmp/cfg" });

  const ws = db.insert(workspaces).values({
    name: "wsx", path: "/tmp/wsx",
  }).returning().get()!;
  workspaceId = ws.id;
  const p = db.insert(projects).values({
    name: "tx-px", workspaceId, path: "/tmp/px",
  }).returning().get()!;
  projectId = p.id;
});

describe("task-executor — git capture paths", () => {
  it("records gitCommitBefore and gitDiffSummary when repo has commits", async () => {
    execFileSyncMock
      .mockReturnValueOnce("sha-before\n") // rev-parse HEAD pre
      .mockReturnValueOnce("sha-after\n")  // rev-parse HEAD post
      .mockReturnValueOnce(" 1 file changed\n"); // git diff --stat

    const task = db.insert(tasks).values({
      projectId,
      prompt: "git-change",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const u = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(u.gitCommitBefore).toBe("sha-before");
    expect(u.gitCommitAfter).toBe("sha-after");
    expect(u.gitDiffSummary).toContain("file changed");
  });

  it("falls back to working-tree diff when no new commits were made", async () => {
    execFileSyncMock
      .mockReturnValueOnce("sha-same\n")   // rev-parse HEAD pre
      .mockReturnValueOnce("sha-same\n")   // rev-parse HEAD post
      .mockReturnValueOnce("")             // git diff --stat sha..sha (empty)
      .mockReturnValueOnce(" M foo.ts\n"); // git diff --stat (working tree)

    const task = db.insert(tasks).values({
      projectId,
      prompt: "working-tree",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const u = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(u.gitDiffSummary).toContain("M foo.ts");
  });

  it("tolerates git errors during both pre- and post-execution capture", async () => {
    execFileSyncMock.mockImplementation(() => { throw new Error("not a git repo"); });

    const task = db.insert(tasks).values({
      projectId,
      prompt: "git-broken",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);
    const u = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    // gitCommitBefore never captured; status still completes
    expect(u.status).toBe("done");
    expect(u.gitCommitBefore).toBeNull();
  });

  it("creates missing workingDir (mkdir recursive)", async () => {
    existsSyncMock.mockImplementation(() => false); // no existing workingDir and no .git

    const task = db.insert(tasks).values({
      projectId,
      prompt: "mkdir-path",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    expect(mkdirSyncMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ recursive: true }));
  });
});

describe("task-executor — key selection failure", () => {
  it("marks task failed when selectKeyForTask throws", async () => {
    selectKeyMock.mockRejectedValueOnce(new Error("no-keys"));

    const task = db.insert(tasks).values({
      projectId,
      prompt: "kselect-fail",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const u = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(u.status).toBe("failed");
    expect(u.errorMessage).toBe("no-keys");
  });

  it("handles null selectedKey (assignedKeyId not set)", async () => {
    selectKeyMock.mockResolvedValueOnce(null);

    const task = db.insert(tasks).values({
      projectId,
      prompt: "no-key",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const u = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(u.status).toBe("done");
    expect(u.assignedKeyId).toBeNull();
  });
});

describe("task-executor — task without project", () => {
  it("skips codebase context and project config lookup", async () => {
    const task = db.insert(tasks).values({
      prompt: "orphan",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const u = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(u.status).toBe("done");
  });
});

describe("task-executor — usage cost fallback", () => {
  it("calculates cost via calculateCost when SDK reports totalCostUsd=0", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "calc-cost",
      status: "queued",
      model: "claude-haiku-4-5-20251001",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const records = db.select().from(usageRecords).where(eq(usageRecords.taskId, task.id)).all();
    expect(records.length).toBe(1);
    // calculateCost for haiku with 10 in + 20 out should be > 0
    expect(records[0].totalCostUsd).toBeGreaterThan(0);
  });
});

describe("task-executor — session claudeSessionId persisted", () => {
  it("records claudeSessionId emitted by the session", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "persist-sess",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    const u = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(u.claudeSessionId).toBe("claude-session-abc");
  });
});

describe("task-executor — workspace config", () => {
  it("loads workspace config when project.workspaceId is set", async () => {
    const task = db.insert(tasks).values({
      projectId,
      prompt: "ws-cfg",
      status: "queued",
    }).returning().get()!;

    await taskExecutor.execute(task.id);

    // Session options should receive a permission mode resolved from workspace config
    const opts = createdSessions.at(-1)!.opts;
    expect(opts.permissionMode).toBeDefined();
  });
});
