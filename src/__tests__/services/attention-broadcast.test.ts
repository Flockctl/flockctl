import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import { tasks, projects, chats, aiProviderKeys } from "../../db/schema.js";
import { TaskStatus } from "../../lib/types.js";

// ─── Mocks ────────────────────────────────────────────────────────────────
//
// We keep the REAL `wsManager`, `attention`, `task-executor`, `chat-executor`,
// and the route handlers — that's the integration surface being tested. Only
// `AgentSession` and the heavy task-executor side-effects (git, skills / MCP
// reconcile, fs creation of workingDir) are stubbed. The MockAgentSession
// mirrors the real class at the two call sites that emit `attention_changed`
// (canUseTool add, resolvePermission resolve) so the test faithfully measures
// the broadcast fan-out through the surrounding layers.

// Everything `vi.mock` factories touch must live inside `vi.hoisted` because
// factories run before any top-level `const` in this module. The holder keeps
// a reference to the mock class + a slot for the most-recently-constructed
// instance so `it` blocks can drive the session without reaching into
// executor internals.
const h = vi.hoisted(() => {
   
  const { EventEmitter } = require("events") as typeof import("events");
  // `emit` is populated after the real `attention` + `ws-manager` modules
  // import (see the `beforeAll` block). Keeping it as a slot lets the mock
  // class use the real broadcaster without tripping the vitest hoist.
  const holder: {
    captured: any;
    emit: (() => void) | null;
  } = { captured: null, emit: null };

  class MockAgentSession extends EventEmitter {
    public opts: any;
    /** Keyed by requestId — each entry's `resolve` is what canUseTool would
     *  have returned on the provider side. Tests don't care about the result,
     *  only about the broadcast fan-out. */
    public pending = new Map<string, { request: any; resolve: (r: any) => void }>();
    private _runResolve: (() => void) | null = null;

    constructor(opts: any) {
      super();
      this.opts = opts;
      holder.captured = this;
    }

    /** Returns after `finishRun()` is called (mimics a session that's still
     *  alive waiting on tool calls / permissions). */
    async run(): Promise<any> {
      await new Promise<void>((resolve) => {
        this._runResolve = resolve;
      });
      return {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalCostUsd: 0,
        turns: 1,
        durationMs: 1,
      };
    }

    finishRun(): void {
      this._runResolve?.();
      this._runResolve = null;
    }

    abort(): void {
      this._runResolve?.();
      this._runResolve = null;
    }

    /** Mirrors agent-session.ts resolvePermission: deletes the pending entry
     *  and broadcasts `attention_changed`. The real emit lives inside the
     *  mocked module, so we import the real attention module lazily here. */
    resolvePermission(
      requestId: string,
      result: { behavior: "allow" } | { behavior: "deny"; message: string },
    ): boolean {
      const entry = this.pending.get(requestId);
      if (!entry) return false;
      this.pending.delete(requestId);
      entry.resolve(result);
      holder.emit?.();
      return true;
    }

    /** Test-only helper: simulate canUseTool adding a permission. Mirrors
     *  the real agent-session.ts canUseTool emit sequence. */
    addPermission(request: any, resolve: (r: any) => void = () => {}): void {
      this.pending.set(request.requestId, { request, resolve });
      holder.emit?.();
      this.emit("permission_request", request);
    }

    get pendingPermissionCount(): number {
      return this.pending.size;
    }

    pendingPermissionRequests(): any[] {
      return Array.from(this.pending.values()).map((e) => e.request);
    }

    pendingPermissionEntries(): Array<{ request: any; createdAt: Date }> {
      return Array.from(this.pending.values()).map((e) => ({
        request: e.request,
        createdAt: new Date(),
      }));
    }
  }

  return { MockAgentSession, holder };
});

vi.mock("../../services/agent-session/index", () => {
  return { AgentSession: h.MockAgentSession };
});

vi.mock("../../services/git-context", () => ({
  buildCodebaseContext: vi.fn(async () => ""),
}));

vi.mock("../../services/claude/skills-sync", () => ({
  reconcileClaudeSkillsForProject: vi.fn(() => {}),
}));

vi.mock("../../services/claude/mcp-sync", () => ({
  reconcileMcpForProject: vi.fn(() => {}),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
  };
});

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn(() => "deadbeef\n"),
  };
});

// ─── Imports that rely on the mocks above ────────────────────────────────
import { wsManager } from "../../services/ws-manager.js";
import { emitAttentionChanged } from "../../services/attention.js";
import { taskExecutor } from "../../services/task-executor/index.js";
import { chatExecutor } from "../../services/chat-executor.js";
import { app } from "../../server.js";

// Inject the real emit into the hoisted mock class so calls inside
// MockAgentSession route through the real `attention` module and hit the
// spy we install in beforeAll.
h.holder.emit = () => emitAttentionChanged(wsManager);

/** Any `wsManager.broadcastAll(arg)` call whose first argument's `type` is
 *  `"attention_changed"`. Used as the predicate for `spy.mock.calls.filter`. */
function matches(call: readonly unknown[]): boolean {
  const payload = call[0];
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { type?: unknown }).type === "attention_changed"
  );
}

describe("attention_changed — exactly one broadcast per transition", () => {
  let db: FlockctlDb;
  let sqlite: Database.Database;
  let projectId: number;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
    setDb(db, sqlite);

    // Seed one active provider key so `selectKeyForTask` succeeds.
    db
      .insert(aiProviderKeys)
      .values({
        provider: "anthropic",
        providerType: "anthropic-messages",
        label: "k",
        keyValue: "sk-ant-api-k",
        isActive: 1,
        priority: 0,
      } as any)
      .run();

    projectId = db
      .insert(projects)
      .values({ name: "attn-broadcast" })
      .returning()
      .get()!.id;

    spy = vi.spyOn(wsManager, "broadcastAll");
  });

  afterAll(() => {
    spy.mockRestore();
    sqlite.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.holder.captured = null;
  });

  // ─── (a) ─────────────────────────────────────────────────────────────
  it("task pending_approval transition emits exactly one attention_changed", async () => {
    const task = db
      .insert(tasks)
      .values({
        projectId,
        prompt: "needs approval",
        status: TaskStatus.QUEUED,
        requiresApproval: true,
      })
      .returning()
      .get()!;

    const runPromise = taskExecutor.execute(task.id);
    while (h.holder.captured === null) await new Promise((r) => setImmediate(r));
    h.holder.captured.finishRun();
    await runPromise;

    const row = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(row.status).toBe(TaskStatus.PENDING_APPROVAL);
    expect(spy.mock.calls.filter(matches).length).toBe(1);
  });

  // ─── (b) ─────────────────────────────────────────────────────────────
  it("task permission add emits exactly one attention_changed", async () => {
    const task = db
      .insert(tasks)
      .values({
        projectId,
        prompt: "adds permission",
        status: TaskStatus.QUEUED,
      })
      .returning()
      .get()!;

    const runPromise = taskExecutor.execute(task.id);
    while (h.holder.captured === null) await new Promise((r) => setImmediate(r));

    // Drop any broadcasts that happened during setup.
    spy.mockClear();

    h.holder.captured.addPermission({
      requestId: "r-add-1",
      toolName: "Bash",
      toolInput: { command: "ls" },
      toolUseID: "u-add-1",
    });

    expect(spy.mock.calls.filter(matches).length).toBe(1);

    taskExecutor.cancel(task.id);
    await runPromise;
  });

  // ─── (c) ─────────────────────────────────────────────────────────────
  it("task permission resolve via route emits exactly one attention_changed", async () => {
    const task = db
      .insert(tasks)
      .values({
        projectId,
        prompt: "resolve permission via route",
        status: TaskStatus.QUEUED,
      })
      .returning()
      .get()!;

    const runPromise = taskExecutor.execute(task.id);
    while (h.holder.captured === null) await new Promise((r) => setImmediate(r));

    h.holder.captured.addPermission({
      requestId: "r-resolve-1",
      toolName: "Bash",
      toolInput: {},
      toolUseID: "u-resolve-1",
    });

    // Clear setup noise (running broadcast + add broadcast).
    spy.mockClear();

    const res = await app.request(`/tasks/${task.id}/permission/r-resolve-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ behavior: "allow" }),
    });
    expect(res.status).toBe(200);

    expect(spy.mock.calls.filter(matches).length).toBe(1);

    taskExecutor.cancel(task.id);
    await runPromise;
  });

  // ─── (d) ─────────────────────────────────────────────────────────────
  it("task approve via route emits exactly one attention_changed", async () => {
    const task = db
      .insert(tasks)
      .values({
        projectId,
        prompt: "approve me",
        status: TaskStatus.PENDING_APPROVAL,
        requiresApproval: true,
      })
      .returning()
      .get()!;

    const res = await app.request(`/tasks/${task.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "looks good" }),
    });
    expect(res.status).toBe(200);

    const row = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(row.status).toBe(TaskStatus.DONE);
    expect(spy.mock.calls.filter(matches).length).toBe(1);
  });

  // ─── (e) ─────────────────────────────────────────────────────────────
  it("chat permission add emits exactly one attention_changed", () => {
    const chat = db
      .insert(chats)
      .values({ projectId, title: "perm-add" })
      .returning()
      .get()!;

    const session = new h.MockAgentSession({ chatId: chat.id });
    chatExecutor.register(chat.id, session as any);

    spy.mockClear();

    session.addPermission({
      requestId: "c-add-1",
      toolName: "Bash",
      toolInput: {},
      toolUseID: "u-cadd-1",
    });

    expect(spy.mock.calls.filter(matches).length).toBe(1);

    chatExecutor.unregister(chat.id);
  });

  // ─── (f) ─────────────────────────────────────────────────────────────
  it("chat permission resolve via route emits exactly one attention_changed", async () => {
    const chat = db
      .insert(chats)
      .values({ projectId, title: "perm-resolve" })
      .returning()
      .get()!;

    const session = new h.MockAgentSession({ chatId: chat.id });
    chatExecutor.register(chat.id, session as any);
    session.addPermission({
      requestId: "c-resolve-1",
      toolName: "Edit",
      toolInput: {},
      toolUseID: "u-cresolve-1",
    });

    spy.mockClear();

    const res = await app.request(`/chats/${chat.id}/permission/c-resolve-1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ behavior: "allow" }),
    });
    expect(res.status).toBe(200);

    expect(spy.mock.calls.filter(matches).length).toBe(1);

    chatExecutor.unregister(chat.id);
  });
});
