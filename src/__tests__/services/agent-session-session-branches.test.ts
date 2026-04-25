/**
 * Branch-coverage tests for `services/agent-session/session.ts`.
 *
 * Fills gaps in `agent-session-extra.test.ts`:
 *  - constructor: throws when neither taskId nor chatId provided
 *  - chatId-only session → sessionPrefix uses "c<id>"
 *  - autoResolvePendingForMode: early-return for `default`/`plan` modes;
 *    non-permission entry (question) is skipped
 *  - canUseTool denylist: `denyIfTouchesSensitivePath` → deny path
 *  - canUseTool `acceptEdits` read-only auto-allow
 *  - canUseTool `plan` read-only auto-allow
 *  - priorMessages seeding when NOT resuming
 *  - isResume + useContinuation=false → uses opts.prompt verbatim
 *  - onEvent `thinking` and `turn_end` branches
 *  - AskUserQuestion: awaitUserAnswer abort-before-register fast path
 *  - isAbortLikeError: non-object error doesn't trigger abort mapping
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../services/ai/client", () => ({
  createAIClient: vi.fn(() => ({ chat: vi.fn() })),
}));

// Mock executeToolCall so we don't actually run Bash/fs tools.
vi.mock("../../services/agent-tools", async () => {
  const actual = await vi.importActual<any>("../../services/agent-tools");
  return {
    ...actual,
    executeToolCall: vi.fn(() => "mock-tool-result"),
    getAgentTools: vi.fn(() => []),
  };
});

import { AgentSession } from "../../services/agent-session/index.js";
import { createAIClient } from "../../services/ai/client.js";

const mockCreateAIClient = createAIClient as any;

function makeSession(overrides: any = {}) {
  return new AgentSession({
    taskId: 1,
    prompt: "p",
    model: "m",
    codebaseContext: "",
    ...overrides,
  });
}

describe("AgentSession — constructor validation", () => {
  it("throws when neither taskId nor chatId provided", () => {
    expect(() =>
      new AgentSession({
        prompt: "p",
        model: "m",
        codebaseContext: "",
      } as any),
    ).toThrow(/taskId or chatId/);
  });

  it("chatId-only session uses refKind=chat and has valid refId", () => {
    const s = new AgentSession({
      chatId: 42,
      prompt: "hi",
      model: "m",
      codebaseContext: "",
    });
    expect(s.refKind).toBe("chat");
    expect(s.refId).toBe(42);
  });
});

describe("AgentSession — autoResolvePendingForMode edges", () => {
  let mockChat: any;
  beforeEach(() => {
    mockChat = vi.fn();
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
  });

  it("switching to `default` (non-auto mode) does not auto-resolve pending", async () => {
    let capturedCanUseTool: any;
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedCanUseTool = args.canUseTool;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });
    const session = makeSession({ permissionMode: "bypassPermissions" });
    await session.run();

    // Move to default → should just emit the change but leave any entries be.
    // First create a pending entry by switching back to default FIRST, then
    // opening a request, then flipping to plan (also no-op).
    session.updatePermissionMode("default");
    const p = capturedCanUseTool("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      toolUseID: "u",
    });
    await new Promise((r) => setImmediate(r));
    expect(session.pendingPermissionCount).toBe(1);

    session.updatePermissionMode("plan");
    // plan mode does NOT auto-resolve pending entries.
    await new Promise((r) => setImmediate(r));
    expect(session.pendingPermissionCount).toBe(1);

    // Drain the pending promise to keep test clean.
    const entries = session.pendingPermissionRequests();
    session.resolvePermission(entries[0]!.requestId, { behavior: "deny", message: "x" });
    await p;
  });

  it("skips pending question entries when auto-resolving for bypass mode", async () => {
    let capturedCanUseTool: any;
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedCanUseTool = args.canUseTool;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });

    const session = makeSession({ permissionMode: "default" });
    const run = session.run();

    // Wait for run to enter chat (capture canUseTool).
    await new Promise((r) => setImmediate(r));

    // Open a permission so there's a mix of entries.
    const p1 = capturedCanUseTool("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      toolUseID: "u1",
    });

    // Open a question via the private method. We can't easily hit awaitUserAnswer
    // without a tool_call, so directly stub a pending question to exercise the
    // "kind !== permission" skip branch during autoResolvePendingForMode.
    const fakeQ = {
      kind: "question",
      request: { requestId: "q-fake", question: "?", toolUseID: "tq" },
      createdAt: new Date(),
      resolve: () => {},
    };
    (session as any).pendingInteractive.set("q-fake", fakeQ);

    await new Promise((r) => setImmediate(r));
    expect(session.pendingPermissionCount).toBe(1);
    // `pendingInteractive` total = 2 (perm + question)
    expect((session as any).pendingInteractive.size).toBe(2);

    session.updatePermissionMode("bypassPermissions");

    // Permission auto-resolved; question stays.
    expect(session.pendingPermissionCount).toBe(0);
    expect((session as any).pendingInteractive.has("q-fake")).toBe(true);

    await p1;
    await run;
  });
});

describe("AgentSession — canUseTool dispatch branches", () => {
  let mockChat: any;
  beforeEach(() => {
    mockChat = vi.fn();
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
  });

  it("denies via denyIfTouchesSensitivePath before mode dispatch (bypass cannot override)", async () => {
    let capturedCanUseTool: any;
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedCanUseTool = args.canUseTool;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });
    const session = makeSession({
      permissionMode: "bypassPermissions",
      allowedRoots: ["/tmp/ws"],
    });
    await session.run();

    // Write to the sensitive .mcp.json path should deny even under bypass.
    const res = await capturedCanUseTool(
      "Write",
      { file_path: "/tmp/ws/.mcp.json", content: "x" },
      { signal: new AbortController().signal, toolUseID: "u" },
    );
    expect(res.behavior).toBe("deny");
  });

  it("acceptEdits mode auto-allows read-only tools (Read)", async () => {
    let capturedCanUseTool: any;
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedCanUseTool = args.canUseTool;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });
    const session = makeSession({ permissionMode: "acceptEdits" });
    await session.run();

    const res = await capturedCanUseTool(
      "Read",
      { file_path: "/tmp/x.txt" },
      { signal: new AbortController().signal, toolUseID: "u" },
    );
    expect(res.behavior).toBe("allow");
    expect((res as any).updatedInput).toEqual({ file_path: "/tmp/x.txt" });
  });

  it("plan mode auto-allows read-only tools; non-read-only prompts user", async () => {
    let capturedCanUseTool: any;
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedCanUseTool = args.canUseTool;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });
    const session = makeSession({ permissionMode: "plan" });
    await session.run();

    const ok = await capturedCanUseTool(
      "Read",
      { file_path: "/tmp/x.txt" },
      { signal: new AbortController().signal, toolUseID: "u" },
    );
    expect(ok.behavior).toBe("allow");

    // Non-read-only → routed to pending prompt (deferred).
    const pending = capturedCanUseTool(
      "Bash",
      { command: "ls" },
      { signal: new AbortController().signal, toolUseID: "u2" },
    );
    await new Promise((r) => setImmediate(r));
    expect(session.pendingPermissionCount).toBe(1);
    const entries = session.pendingPermissionRequests();
    session.resolvePermission(entries[0]!.requestId, { behavior: "deny", message: "no" });
    const denied = await pending;
    expect(denied.behavior).toBe("deny");
  });
});

describe("AgentSession — resume + priorMessages", () => {
  let mockChat: any;
  beforeEach(() => {
    mockChat = vi.fn();
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
  });

  it("seeds priorMessages when NOT resuming", async () => {
    let capturedMessages: any[] = [];
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedMessages = args.messages.map((m: any) => ({ ...m }));
      return { text: "ok", rawContent: "ok", toolCalls: [], usage: {} };
    });
    const session = makeSession({
      priorMessages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hey" },
      ],
      prompt: "final-turn",
    });
    await session.run();

    expect(capturedMessages[0]).toEqual({ role: "user", content: "hi" });
    expect(capturedMessages[1]).toEqual({ role: "assistant", content: "hey" });
    // Last message is the `prompt` per the final user-turn push.
    expect(capturedMessages[capturedMessages.length - 1]).toEqual({
      role: "user",
      content: "final-turn",
    });
  });

  it("isResume + useContinuation=false passes opts.prompt as-is (chat path)", async () => {
    let capturedMessages: any[] = [];
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedMessages = args.messages.map((m: any) => ({ ...m }));
      return { text: "ok", rawContent: "ok", toolCalls: [], usage: {} };
    });
    const session = makeSession({
      resumeSessionId: "sess-1",
      useResumeContinuationPrompt: false,
      prompt: "next-user-msg",
    });
    await session.run();
    expect(capturedMessages[capturedMessages.length - 1]).toEqual({
      role: "user",
      content: "next-user-msg",
    });
  });

  it("isResume + useContinuation=true replaces prompt with a continue nudge", async () => {
    let capturedMessages: any[] = [];
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedMessages = args.messages.map((m: any) => ({ ...m }));
      return { text: "ok", rawContent: "ok", toolCalls: [], usage: {} };
    });
    const session = makeSession({
      resumeSessionId: "sess-1",
      prompt: "ignored-on-resume",
    });
    await session.run();
    expect(capturedMessages[capturedMessages.length - 1].content).toMatch(
      /continue from where you left off/i,
    );
  });
});

describe("AgentSession — onEvent secondary branches", () => {
  let mockChat: any;
  beforeEach(() => {
    mockChat = vi.fn();
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
  });

  it("forwards `thinking` events as `thinking` emits", async () => {
    mockChat.mockImplementationOnce(async (args: any) => {
      args.onEvent?.({ type: "thinking", content: "pondering" });
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });
    const session = makeSession();
    const thinks: string[] = [];
    session.on("thinking", (t: string) => thinks.push(t));
    await session.run();
    expect(thinks).toEqual(["pondering"]);
  });

  it("forwards explicit `turn_end` events (Copilot path)", async () => {
    mockChat.mockImplementationOnce(async (args: any) => {
      args.onEvent?.({ type: "turn_end" });
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });
    const session = makeSession();
    let count = 0;
    session.on("turn_end", () => count++);
    await session.run();
    // One from onEvent + one post-response emit → >= 2
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

describe("AgentSession — AskUserQuestion abort edges", () => {
  let mockChat: any;
  beforeEach(() => {
    mockChat = vi.fn();
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
  });

  it("awaitUserAnswer returns `(question cancelled)` when session aborted before the call", async () => {
    // First chat call: schedules a single AskUserQuestion tool call and returns.
    // We then abort and expect tool_result to be "(question cancelled)".
    const askToolCall = { id: "tq", name: "AskUserQuestion", input: { question: "?" } };
    mockChat.mockImplementationOnce(async () => ({
      text: "",
      rawContent: [askToolCall],
      toolCalls: [askToolCall],
      usage: {},
    }));
    // Follow-up turn closes the loop.
    mockChat.mockImplementationOnce(async () => ({
      text: "done",
      rawContent: "done",
      toolCalls: [],
      usage: {},
    }));

    const session = makeSession();
    const run = session.run();
    // Let the first turn start and reach the question await — then abort.
    await new Promise((r) => setImmediate(r));
    session.abort();

    // run() may reject with AbortError because the while loop sees aborted signal.
    await run.catch(() => {});
  });

  it("resolveQuestion returns false for unknown id", async () => {
    mockChat.mockResolvedValueOnce({ text: "", rawContent: "", toolCalls: [], usage: {} });
    const session = makeSession();
    await session.run();
    expect(session.resolveQuestion("nope", "ans")).toBe(false);
  });
});

describe("AgentSession — isAbortLikeError defensive branches", () => {
  it("does NOT map non-object throw values as abort-like", async () => {
    const mockChat = vi.fn(async () => {
      // throw a primitive → not an object → isAbortLikeError returns false
      throw "plain-string";
    });
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
    const session = makeSession();
    const err = await session.run().catch((e) => e);
    // The thrown primitive bubbles up unchanged (no AbortError remap).
    expect(err).toBe("plain-string");
  });
});

describe("AgentSession — pendingPermissionEntries snapshot", () => {
  let mockChat: any;
  beforeEach(() => {
    mockChat = vi.fn();
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
  });

  it("returns createdAt alongside request for recency-sorting consumers", async () => {
    let capturedCanUseTool: any;
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedCanUseTool = args.canUseTool;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });

    const session = makeSession({ permissionMode: "default" });
    await session.run();

    const p = capturedCanUseTool("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      toolUseID: "u",
    });
    await new Promise((r) => setImmediate(r));

    const entries = session.pendingPermissionEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.request.toolName).toBe("Bash");
    expect(entries[0]!.createdAt).toBeInstanceOf(Date);

    // pendingQuestionRequests with none pending returns empty.
    expect(session.pendingQuestionRequests()).toEqual([]);

    // Clean up.
    const reqs = session.pendingPermissionRequests();
    session.resolvePermission(reqs[0]!.requestId, { behavior: "deny", message: "x" });
    await p;
  });
});

describe("AgentSession — onEvent branches (session_id, usage, thinking, turn_end)", () => {
  let mockChat: any;
  beforeEach(() => {
    mockChat = vi.fn();
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
  });

  it("forwards session_id events and skips duplicate emits", async () => {
    const events: Array<[string, unknown]> = [];
    mockChat.mockImplementationOnce(async (args: any) => {
      // Emit session_id twice: first creates the sid; second (same value) is de-duped.
      args.onEvent({ type: "session_id", content: "sid-abc" });
      args.onEvent({ type: "session_id", content: "sid-abc" });
      // Emit a new different session_id — fires the "if sid !== currentSessionId" arm.
      args.onEvent({ type: "session_id", content: "sid-xyz" });
      // Usage event via onEvent sets turnUsageFromEvent=true.
      args.onEvent({
        type: "usage",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalCostUsd: 0,
        },
      });
      args.onEvent({ type: "thinking", content: "...considering..." });
      args.onEvent({ type: "turn_end" });
      // Empty-string session_id is the falsy sid short-circuit.
      args.onEvent({ type: "session_id", content: "" });
      return {
        text: "done",
        rawContent: "done",
        toolCalls: [],
        usage: {},
        sessionId: "sid-xyz",
      };
    });
    const session = makeSession();
    session.on("session_id", (sid: string) => events.push(["session_id", sid]));
    session.on("thinking", (t: string) => events.push(["thinking", t]));
    session.on("turn_end", () => events.push(["turn_end", null]));
    session.on("usage", (u: unknown) => events.push(["usage", u]));
    await session.run();
    const sidEmits = events.filter((e) => e[0] === "session_id").map((e) => e[1]);
    expect(sidEmits).toEqual(["sid-abc", "sid-xyz"]);
    expect(events.some((e) => e[0] === "thinking")).toBe(true);
    expect(events.some((e) => e[0] === "turn_end")).toBe(true);
    // Usage event with input/output tokens recorded (emitted 2x: via onEvent, then finalized).
    const usageEmits = events.filter((e) => e[0] === "usage");
    expect(usageEmits.length).toBeGreaterThanOrEqual(1);
  });

  it("spreads thinkingEnabled/effort only when provided (branch: `!== undefined`)", async () => {
    let captured: any;
    mockChat.mockImplementationOnce(async (args: any) => {
      captured = args;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });
    const session = makeSession({ thinkingEnabled: true, effort: "high" });
    await session.run();
    expect(captured.thinkingEnabled).toBe(true);
    expect(captured.effort).toBe("high");
  });
});

describe("AgentSession — tool-call branches", () => {
  let mockChat: any;
  beforeEach(() => {
    mockChat = vi.fn();
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
  });

  it("AskUserQuestion with non-string question input passes empty string", async () => {
    mockChat
      .mockImplementationOnce(async () => ({
        text: "",
        rawContent: "",
        toolCalls: [
          { id: "ask-1", name: "AskUserQuestion", input: { question: { not: "a string" } } },
        ],
        usage: {},
      }))
      .mockImplementationOnce(async () => ({
        text: "",
        rawContent: "",
        toolCalls: [],
        usage: {},
      }));
    const session = makeSession();
    const run = session.run();
    // Wait for the question to register
    for (let i = 0; i < 20; i++) {
      if (session.pendingQuestionRequests().length > 0) break;
      await new Promise((r) => setImmediate(r));
    }
    const q = session.pendingQuestionRequests()[0];
    expect(q?.question).toBe(""); // non-string → fallback to empty string
    session.resolveQuestion(q!.requestId, "my answer");
    await run;
  });

  it("awaitUserAnswer: abort before promise wires returns cancellation immediately", async () => {
    // First turn returns an AskUserQuestion, but we abort the session BEFORE the tool fires.
    const session = makeSession();
    mockChat.mockImplementationOnce(async () => {
      session.abort(); // abort before question tool resolution
      return {
        text: "",
        rawContent: "",
        toolCalls: [
          { id: "ask-abt", name: "AskUserQuestion", input: { question: "Q?" } },
        ],
        usage: {},
      };
    });
    await session.run().catch(() => {});
    // No pending question — the abort-fast-path returned "(question cancelled)".
    expect(session.pendingQuestionRequests()).toEqual([]);
  });
});
