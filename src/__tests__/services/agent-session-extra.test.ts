import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../services/ai/client", () => ({
  createAIClient: vi.fn(() => ({ chat: vi.fn() })),
}));

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

// Variant B — live permission-mode switching mid-session.
//
// The scenario: a chat starts with a restrictive mode (`default` or `auto`),
// the agent asks to run a tool, the user wants to unblock the blocker by
// switching to `bypassPermissions` / `acceptEdits` without cancelling the
// turn. `updatePermissionMode()` mutates the in-memory mode, auto-resolves
// any pending permission entry that the new mode would have allowed, and
// leaves the rest pending. Subsequent `canUseTool` invocations during the
// same turn observe the new mode.
describe("AgentSession — updatePermissionMode (live)", () => {
  let mockChat: any;
  beforeEach(() => {
    mockChat = vi.fn();
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
  });

  it("exposes current mode via getter and emits permission_mode_changed on update", async () => {
    mockChat.mockResolvedValueOnce({ text: "", rawContent: "", toolCalls: [], usage: {} });
    const session = makeSession({ permissionMode: "default" });
    await session.run();

    const events: Array<{ previous: string; current: string }> = [];
    session.on("permission_mode_changed", (e: any) => events.push(e));

    expect(session.permissionMode).toBe("default");
    session.updatePermissionMode("bypassPermissions");
    expect(session.permissionMode).toBe("bypassPermissions");
    expect(events).toEqual([{ previous: "default", current: "bypassPermissions" }]);

    // no-op when mode is unchanged — avoids spurious UI refreshes
    session.updatePermissionMode("bypassPermissions");
    expect(events.length).toBe(1);
  });

  it("switching to bypassPermissions auto-resolves every pending request as allow", async () => {
    let capturedCanUseTool: any;
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedCanUseTool = args.canUseTool;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });

    const session = makeSession({ permissionMode: "default" });
    await session.run();

    const p1 = capturedCanUseTool("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      toolUseID: "u1",
    });
    const p2 = capturedCanUseTool("Write", { file_path: "/etc/passwd" }, {
      signal: new AbortController().signal,
      toolUseID: "u2",
    });

    await new Promise((r) => setImmediate(r));
    expect(session.pendingPermissionCount).toBe(2);

    session.updatePermissionMode("bypassPermissions");

    const r1 = await p1;
    const r2 = await p2;
    expect(r1.behavior).toBe("allow");
    expect(r2.behavior).toBe("allow");
    expect(session.pendingPermissionCount).toBe(0);
  });

  it("switching to acceptEdits auto-resolves only file-write pending requests", async () => {
    let capturedCanUseTool: any;
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedCanUseTool = args.canUseTool;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });

    const session = makeSession({ permissionMode: "default" });
    await session.run();

    const pBash = capturedCanUseTool("Bash", { command: "rm -rf /" }, {
      signal: new AbortController().signal,
      toolUseID: "u-bash",
    });
    const pWrite = capturedCanUseTool("Write", { file_path: "/tmp/x.txt" }, {
      signal: new AbortController().signal,
      toolUseID: "u-write",
    });

    await new Promise((r) => setImmediate(r));
    expect(session.pendingPermissionCount).toBe(2);

    session.updatePermissionMode("acceptEdits");

    // Write auto-allowed; Bash still pending (needs user decision).
    const rWrite = await pWrite;
    expect(rWrite.behavior).toBe("allow");
    expect(session.pendingPermissionCount).toBe(1);

    // Resolve bash manually so the test promise doesn't dangle.
    const pending = session.pendingPermissionRequests();
    session.resolvePermission(pending[0].requestId, { behavior: "deny", message: "no" });
    const rBash = await pBash;
    expect(rBash.behavior).toBe("deny");
  });

  it("after switching to bypassPermissions, subsequent canUseTool calls auto-allow (live)", async () => {
    let capturedCanUseTool: any;
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedCanUseTool = args.canUseTool;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });

    const session = makeSession({ permissionMode: "default" });
    await session.run();

    session.updatePermissionMode("bypassPermissions");

    // New canUseTool call after the switch should not prompt — it should
    // allow synchronously based on the new mode.
    const res = await capturedCanUseTool("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      toolUseID: "u-after",
    });
    expect(res.behavior).toBe("allow");
    expect(session.pendingPermissionCount).toBe(0);
  });

  it("switching to auto re-runs decideAuto on pending entries and allows matches", async () => {
    let capturedCanUseTool: any;
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedCanUseTool = args.canUseTool;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });

    const session = makeSession({
      permissionMode: "default",
      allowedRoots: ["/tmp"],
    });
    await session.run();

    const pRead = capturedCanUseTool("Read", { file_path: "/tmp/foo.txt" }, {
      signal: new AbortController().signal,
      toolUseID: "u-read",
    });
    const pBash = capturedCanUseTool("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      toolUseID: "u-bash2",
    });

    await new Promise((r) => setImmediate(r));
    expect(session.pendingPermissionCount).toBe(2);

    session.updatePermissionMode("auto");

    // Read is read-only → auto-allowed; Bash still needs user decision.
    const rRead = await pRead;
    expect(rRead.behavior).toBe("allow");
    expect(session.pendingPermissionCount).toBe(1);

    const pending = session.pendingPermissionRequests();
    session.resolvePermission(pending[0].requestId, { behavior: "deny", message: "nope" });
    await pBash;
  });
});

describe("AgentSession — workspaceContext injection", () => {
  let mockChat: any;
  beforeEach(() => {
    mockChat = vi.fn();
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
  });

  it("appends <workspace_projects> block listing sibling projects to the task system prompt", async () => {
    let capturedSystem = "";
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedSystem = args.system;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });

    const session = makeSession({
      workspaceContext: {
        name: "WS",
        path: "/tmp/ws",
        projects: [
          { name: "alpha", path: "/tmp/ws/alpha", description: "first" },
          { name: "beta", path: "/tmp/ws/beta", description: null },
          { name: "missing", path: null, description: "no path" },
        ],
      },
    });
    await session.run();

    // Shape of the injected block
    expect(capturedSystem).toContain(`<workspace_projects workspace="WS" path="/tmp/ws">`);
    expect(capturedSystem).toContain("collection of 2 project(s)");
    // Projects with paths rendered
    expect(capturedSystem).toContain("- alpha (/tmp/ws/alpha) — first");
    expect(capturedSystem).toContain("- beta (/tmp/ws/beta)");
    // Project without a path skipped
    expect(capturedSystem).not.toContain("missing");
    // Scope rules pushed through
    expect(capturedSystem).toContain("Do NOT run Grep/Glob/ListDir against the workspace root");
    expect(capturedSystem).toMatch(/<\/workspace_projects>/);
  });

  it("skips injection when workspaceContext is absent", async () => {
    let capturedSystem = "";
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedSystem = args.system;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });

    const session = makeSession();
    await session.run();
    expect(capturedSystem).not.toContain("<workspace_projects");
  });

  it("renders a clarifying note when the workspace has no projects with paths", async () => {
    let capturedSystem = "";
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedSystem = args.system;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });

    const session = makeSession({
      workspaceContext: {
        name: "Empty",
        path: "/tmp/empty",
        projects: [{ name: "ghost", path: null }],
      },
    });
    await session.run();
    expect(capturedSystem).toContain("no projects with known paths");
    expect(capturedSystem).toContain(`<workspace_projects workspace="Empty" path="/tmp/empty">`);
  });

  it("does not double-inject when systemPromptOverride already carries a workspace_projects tag", async () => {
    let capturedSystem = "";
    mockChat.mockImplementationOnce(async (args: any) => {
      capturedSystem = args.system;
      return { text: "", rawContent: "", toolCalls: [], usage: {} };
    });

    const override =
      "caller prompt\n\n<workspace_projects workspace=\"WS\" path=\"/tmp/ws\">listed by caller</workspace_projects>";
    const session = makeSession({
      systemPromptOverride: override,
      workspaceContext: {
        name: "WS",
        path: "/tmp/ws",
        projects: [{ name: "alpha", path: "/tmp/ws/alpha" }],
      },
    });
    await session.run();

    // The pre-existing tag is kept; no second block appended.
    const occurrences = capturedSystem.match(/<workspace_projects/g) ?? [];
    expect(occurrences.length).toBe(1);
    expect(capturedSystem).toContain("listed by caller");
  });
});
