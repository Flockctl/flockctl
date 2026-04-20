import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../services/ai-client", () => ({
  createAIClient: vi.fn(() => ({ chat: vi.fn() })),
}));

import { AgentSession } from "../../services/agent-session.js";
import { createAIClient } from "../../services/ai-client.js";

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

describe("AgentSession — onEvent callbacks", () => {
  let mockChat: any;

  beforeEach(() => {
    mockChat = vi.fn();
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
  });

  it("emits text/tool_call/tool_result/usage via onEvent streaming", async () => {
    mockChat.mockImplementationOnce(async (args: any) => {
      args.onEvent?.({ type: "text", content: "Hi" });
      args.onEvent?.({ type: "tool_call", toolName: "Read", content: { path: "x" } });
      args.onEvent?.({ type: "tool_result", toolName: "Read", content: "res" });
      args.onEvent?.({
        type: "usage",
        usage: {
          inputTokens: 11,
          outputTokens: 22,
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 4,
          totalCostUsd: 0.5,
        },
      });
      return {
        text: "Hi",
        rawContent: "Hi",
        toolCalls: [],
        usage: {},
        costUsd: 0.7,
      };
    });

    const session = makeSession();
    const texts: string[] = [];
    const usages: any[] = [];
    const toolCalls: string[] = [];
    const toolResults: string[] = [];
    session.on("text", (t) => texts.push(t));
    session.on("tool_call", (n) => toolCalls.push(n));
    session.on("tool_result", (n) => toolResults.push(n));
    session.on("usage", (u) => usages.push(u));

    const result = await session.run();

    expect(texts).toContain("Hi");
    expect(toolCalls).toContain("Read");
    expect(toolResults).toContain("Read");
    expect(usages.length).toBeGreaterThanOrEqual(2);
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(22);
    // costUsd from response overrides when turnUsageFromEvent true
    expect(result.totalCostUsd).toBeCloseTo(0.7, 5);
  });

  it("handles missing toolName on events (defaults)", async () => {
    mockChat.mockImplementationOnce(async (args: any) => {
      args.onEvent?.({ type: "tool_call", content: {} });
      args.onEvent?.({ type: "tool_result", content: "" });
      return {
        text: "done",
        rawContent: "done",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    const session = makeSession();
    const names: string[] = [];
    session.on("tool_call", (n) => names.push(n));
    session.on("tool_result", (n) => names.push(`r:${n}`));
    await session.run();
    expect(names).toContain("unknown");
    expect(names).toContain("r:");
  });
});

describe("AgentSession — permission flow (canUseTool)", () => {
  let mockChat: any;
  beforeEach(() => {
    mockChat = vi.fn();
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
  });

  it("relays permission_request and resolves via resolvePermission (allow)", async () => {
    let capturedCanUseTool: any;
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedCanUseTool = args.canUseTool;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });

    const session = makeSession();
    let gotRequest: any;
    session.on("permission_request", (req) => { gotRequest = req; });

    await session.run();

    expect(typeof capturedCanUseTool).toBe("function");

    const pending = capturedCanUseTool("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      toolUseID: "use1",
      title: "Run?",
    });

    // Give the event a chance to fire
    await new Promise((r) => setImmediate(r));

    expect(gotRequest).toBeTruthy();
    expect(gotRequest.toolName).toBe("Bash");

    const ok = session.resolvePermission(gotRequest.requestId, { behavior: "allow" });
    expect(ok).toBe(true);

    const res = await pending;
    expect(res.behavior).toBe("allow");
  });

  it("echoes updatedInput on UI-resolved allow (SDK Zod requires it)", async () => {
    let capturedCanUseTool: any;
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedCanUseTool = args.canUseTool;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });

    const session = makeSession();
    let gotRequest: any;
    session.on("permission_request", (req) => { gotRequest = req; });

    await session.run();

    const input = { file_path: "/tmp/foo.txt", content: "hi" };
    const pending = capturedCanUseTool("Write", input, {
      signal: new AbortController().signal,
      toolUseID: "use-write",
    });

    await new Promise((r) => setImmediate(r));
    expect(gotRequest).toBeTruthy();

    session.resolvePermission(gotRequest.requestId, { behavior: "allow" });
    const res = await pending;

    expect(res).toEqual({ behavior: "allow", updatedInput: input });
  });

  it("echoes updatedInput on auto-approved allow", async () => {
    let capturedCanUseTool: any;
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedCanUseTool = args.canUseTool;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });

    const session = makeSession({ permissionMode: "auto", allowedRoots: ["/tmp"] });
    await session.run();

    const input = { file_path: "/tmp/x.txt" };
    const res = await capturedCanUseTool("Read", input, {
      signal: new AbortController().signal,
      toolUseID: "use-read",
    });

    expect(res).toEqual({ behavior: "allow", updatedInput: input });
  });

  it("resolvePermission returns false for unknown id", async () => {
    mockChat.mockResolvedValueOnce({ text: "", rawContent: "", toolCalls: [], usage: {} });
    const session = makeSession();
    await session.run();
    expect(session.resolvePermission("no-such", { behavior: "allow" })).toBe(false);
  });

  it("denies pending permission when session aborted during wait", async () => {
    let capturedCanUseTool: any;
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedCanUseTool = args.canUseTool;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });
    const session = makeSession();
    await session.run();

    const pending = capturedCanUseTool("Bash", {}, {
      signal: new AbortController().signal,
      toolUseID: "u",
    });

    // Abort, which should trigger onAbort → deny
    session.abort();
    const res = await pending;
    expect(res.behavior).toBe("deny");
    expect((res as any).message).toContain("cancelled");
  });

  it("denies immediately if already aborted before canUseTool called", async () => {
    let capturedCanUseTool: any;
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedCanUseTool = args.canUseTool;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });
    const session = makeSession();
    await session.run();

    session.abort();
    const res = await capturedCanUseTool("Bash", {}, {
      signal: new AbortController().signal,
      toolUseID: "u",
    });
    expect(res.behavior).toBe("deny");
  });
});

describe("AgentSession — abort reasons", () => {
  let mockChat: any;
  beforeEach(() => {
    mockChat = vi.fn();
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
  });

  /** Chat mock that hangs until abortSignal fires, then rejects with raw AbortError. */
  function hangingChat() {
    return (args: any) =>
      new Promise((_, reject) => {
        args.abortSignal.addEventListener("abort", () => {
          const e: any = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
  }

  it("timeout → TimeoutError with reason=timeout and descriptive message", async () => {
    mockChat.mockImplementation(hangingChat());

    const session = makeSession({ timeoutSeconds: 0.05 });
    const err = await session.run().then(
      () => { throw new Error("expected run to reject"); },
      (e) => e,
    );

    expect(err.name).toBe("TimeoutError");
    expect(err.reason).toBe("timeout");
    expect(err.message).toMatch(/timed out/i);
    expect(session.abortReason).toBe("timeout");
  });

  it("user cancel → AbortError with reason=user", async () => {
    mockChat.mockImplementation(hangingChat());

    const session = makeSession();
    const pending = session.run();
    await new Promise((r) => setImmediate(r));
    session.abort("user");

    const err = await pending.catch((e) => e);
    expect(err.name).toBe("AbortError");
    expect(err.reason).toBe("user");
    expect(err.message).toMatch(/user/i);
  });

  it("shutdown → AbortError with reason=shutdown", async () => {
    mockChat.mockImplementation(hangingChat());

    const session = makeSession();
    const pending = session.run();
    await new Promise((r) => setImmediate(r));
    session.abort("shutdown");

    const err = await pending.catch((e) => e);
    expect(err.name).toBe("AbortError");
    expect(err.reason).toBe("shutdown");
    expect(err.message).toMatch(/shutting down/i);
  });

  it("default abort() uses user reason (backwards compatibility)", async () => {
    mockChat.mockImplementation(hangingChat());

    const session = makeSession();
    const pending = session.run();
    await new Promise((r) => setImmediate(r));
    session.abort();

    const err = await pending.catch((e) => e);
    expect(err.reason).toBe("user");
  });

  it("first abort reason wins — later abort() calls don't overwrite", async () => {
    mockChat.mockImplementation(hangingChat());

    const session = makeSession();
    const pending = session.run();
    await new Promise((r) => setImmediate(r));
    session.abort("timeout");
    session.abort("shutdown"); // should not override

    const err = await pending.catch((e) => e);
    expect(err.reason).toBe("timeout");
    expect(session.abortReason).toBe("timeout");
  });

  it("does not transform non-abort errors", async () => {
    mockChat.mockImplementationOnce(async () => {
      throw new Error("some other failure");
    });
    const session = makeSession();
    const err = await session.run().catch((e) => e);
    expect(err.name).toBe("Error");
    expect(err.message).toBe("some other failure");
    expect(session.abortReason).toBeNull();
  });
});

describe("AgentSession — system prompt (MCP + workingDir)", () => {
  let mockChat: any;
  beforeEach(() => {
    mockChat = vi.fn();
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
  });

  it("uses workingDir in WORKSPACE line and omits MCP XML (loaded from .mcp.json)", async () => {
    mockChat.mockResolvedValueOnce({
      text: "ok",
      rawContent: "ok",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const session = makeSession({
      workingDir: "/tmp/work-xyz",
    });

    await session.run();

    const system = mockChat.mock.calls[0][0].system as string;
    expect(system).toContain("WORKSPACE: /tmp/work-xyz");
    expect(system).not.toContain("<available_mcp_servers>");
    expect(system).not.toContain("<mcp_server");
    expect(system).toContain("FLOCKCTL MCP DIRECTORIES");
  });

  it("uses getFlockctlHome() default when workingDir omitted", async () => {
    mockChat.mockResolvedValueOnce({
      text: "ok",
      rawContent: "ok",
      toolCalls: [],
      usage: {},
    });
    const session = makeSession();
    await session.run();
    const system = mockChat.mock.calls[0][0].system as string;
    // Default home path starts with / and contains flockctl
    expect(system).toMatch(/WORKSPACE: .+flockctl/);
  });
});

describe("AgentSession — sessionId emission", () => {
  let mockChat: any;

  beforeEach(() => {
    mockChat = vi.fn();
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
  });

  it("emits 'session_id' when response carries a new sessionId", async () => {
    mockChat.mockResolvedValueOnce({
      text: "ok",
      rawContent: "ok",
      toolCalls: [],
      usage: {},
      sessionId: "sess-abc-123",
    });

    const session = makeSession();
    const sessions: string[] = [];
    session.on("session_id", (sid) => sessions.push(sid));
    await session.run();
    expect(sessions).toEqual(["sess-abc-123"]);
  });

  it("does not re-emit session_id when value is unchanged across turns", async () => {
    mockChat.mockResolvedValueOnce({
      text: "first",
      rawContent: "first",
      toolCalls: [{ id: "t1", name: "Read", input: { path: "x" } }],
      usage: {},
      sessionId: "same-sess",
    });
    mockChat.mockResolvedValueOnce({
      text: "second",
      rawContent: "second",
      toolCalls: [],
      usage: {},
      sessionId: "same-sess",
    });

    const session = makeSession();
    const sessions: string[] = [];
    session.on("session_id", (sid) => sessions.push(sid));
    await session.run();
    expect(sessions).toEqual(["same-sess"]);
  });
});

describe("AgentSession — abortMessage defaults", () => {
  it("default branch returns 'Task cancelled' when reason is unset/unknown", () => {
    const session = makeSession();
    // Direct call into the private method to exercise the default branch,
    // which is otherwise unreachable since the type union covers every named
    // reason but the switch has a defensive default.
    const msg = (session as any).abortMessage();
    expect(msg).toBe("Task cancelled");
  });
});
