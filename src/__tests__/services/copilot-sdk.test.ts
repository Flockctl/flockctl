import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * These tests cover the cwd-forwarding contract of `streamViaCopilotSdk`:
 * without it, every chat inherits the Flockctl daemon's `process.cwd()`,
 * leaking the Flockctl repo into chats pinned to other projects.
 *
 * We mock `@github/copilot-sdk` so the CLI subprocess is never spawned.
 */

const createSessionMock = vi.fn<(config: unknown) => void>();
const sendAndWaitMock = vi.fn<(args: { prompt: string }) => Promise<void>>(async () => {});
const disconnectMock = vi.fn<() => Promise<void>>(async () => {});

class FakeSession {
  handlers = new Map<string, (e: unknown) => void>();
  on(event: string, handler: (e: unknown) => void) {
    this.handlers.set(event, handler);
  }
  sendAndWait(args: { prompt: string }) {
    const msg = this.handlers.get("assistant.message");
    msg?.({ data: { content: `echo: ${args.prompt}` } });
    const usage = this.handlers.get("assistant.usage");
    usage?.({ data: { inputTokens: 1, outputTokens: 1 } });
    return sendAndWaitMock(args);
  }
  disconnect() {
    return disconnectMock();
  }
}

let lastSession: FakeSession | null = null;

class FakeClient {
  async createSession(config: unknown) {
    createSessionMock(config);
    const session = new FakeSession();
    lastSession = session;
    return session;
  }
}

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: FakeClient,
}));

// Fresh module import per test so the module-level client pool is reset.
async function importFresh() {
  vi.resetModules();
  return import("../../services/ai/copilot-sdk.js");
}

describe("streamViaCopilotSdk — cwd forwarding", () => {
  beforeEach(() => {
    createSessionMock.mockClear();
    sendAndWaitMock.mockClear();
    disconnectMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes workingDirectory to client.createSession when supplied", async () => {
    const mod = await importFresh();
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
      workingDirectory: "/Users/alice/code/teachersflow",
    });
    for await (const _ of iter) { void _; }

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.3-codex",
        workingDirectory: "/Users/alice/code/teachersflow",
      }),
    );
  });

  it("omits workingDirectory when caller does not supply one", async () => {
    const mod = await importFresh();
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
    });
    for await (const _ of iter) { void _; }

    const config = createSessionMock.mock.calls[0]?.[0] as { workingDirectory?: string };
    expect(config.workingDirectory).toBeUndefined();
  });

  it("chatViaCopilotSdk also forwards workingDirectory through to createSession", async () => {
    const mod = await importFresh();
    await mod.chatViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
      workingDirectory: "/tmp/project-x",
    });

    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: "/tmp/project-x" }),
    );
  });
});

describe("streamViaCopilotSdk — sdkPermissionMode handler synthesis", () => {
  beforeEach(() => {
    createSessionMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function capturedHandler(mode?: "default" | "acceptEdits" | "plan" | "bypassPermissions") {
    const mod = await importFresh();
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
      sdkPermissionMode: mode,
    });
    for await (const _ of iter) { void _; }
    const cfg = createSessionMock.mock.calls[0]?.[0] as {
      onPermissionRequest: (req: { kind: string }) => Promise<{ kind: string }>;
    };
    return cfg.onPermissionRequest;
  }

  it("bypassPermissions approves every kind", async () => {
    const h = await capturedHandler("bypassPermissions");
    for (const kind of ["shell", "write", "mcp", "read", "url", "custom-tool"]) {
      expect(await h({ kind })).toEqual({ kind: "approved" });
    }
  });

  it("acceptEdits approves read+write only, denies the rest", async () => {
    const h = await capturedHandler("acceptEdits");
    expect(await h({ kind: "read" })).toEqual({ kind: "approved" });
    expect(await h({ kind: "write" })).toEqual({ kind: "approved" });
    for (const kind of ["shell", "mcp", "url", "custom-tool"]) {
      expect((await h({ kind })).kind).toBe("denied-by-rules");
    }
  });

  it("plan approves only read", async () => {
    const h = await capturedHandler("plan");
    expect(await h({ kind: "read" })).toEqual({ kind: "approved" });
    for (const kind of ["shell", "write", "mcp", "url", "custom-tool"]) {
      expect((await h({ kind })).kind).toBe("denied-by-rules");
    }
  });

  it("default (no caller canUseTool) denies every kind — caller must wire one up", async () => {
    const h = await capturedHandler("default");
    for (const kind of ["shell", "write", "mcp", "read", "url", "custom-tool"]) {
      expect((await h({ kind })).kind).toBe("denied-by-rules");
    }
  });

  it("when neither canUseTool nor mode is supplied, defaults to approve-all (matches Claude Code default)", async () => {
    const h = await capturedHandler();
    for (const kind of ["shell", "write", "mcp", "read", "url", "custom-tool"]) {
      expect(await h({ kind })).toEqual({ kind: "approved" });
    }
  });

  it("forwards tool.execution_start / _complete to onEvent as tool_call / tool_result", async () => {
    // Without this mirror, the chat route never learns about Copilot tool
    // invocations — the UI collapses the entire turn into a single blob.
    const mod = await importFresh();
    const events: Array<{ type: string; toolName?: string; content?: unknown }> = [];

    // Kick off the iterator without blocking so we can fire tool events
    // before sendAndWait (assistant.message) resolves the turn.
    const customSendAndWait = sendAndWaitMock.mockImplementationOnce(async () => {
      const session = lastSession!;
      session.handlers.get("tool.execution_start")?.({
        data: { toolName: "edit", input: { path: "/tmp/a.ts" } },
      });
      session.handlers.get("tool.execution_complete")?.({
        data: { toolName: "edit", output: "ok" },
      });
      const msg = session.handlers.get("assistant.message");
      msg?.({ data: { content: "done" } });
      const usage = session.handlers.get("assistant.usage");
      usage?.({ data: { inputTokens: 2, outputTokens: 2 } });
    });

    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
      onEvent: (e) => {
        events.push({
          type: e.type,
          toolName: "toolName" in e ? e.toolName : undefined,
          content: "content" in e ? e.content : undefined,
        });
      },
    });
    for await (const _ of iter) { void _; }

    const toolEvents = events.filter((e) => e.type === "tool_call" || e.type === "tool_result");
    expect(toolEvents).toEqual([
      { type: "tool_call", toolName: "edit", content: { path: "/tmp/a.ts" } },
      { type: "tool_result", toolName: "edit", content: "ok" },
    ]);
    // Also silences the "unused mock" lint — we only needed the single call override.
    expect(customSendAndWait).toHaveBeenCalledTimes(1);
  });

  it("canUseTool takes precedence over sdkPermissionMode", async () => {
    const mod = await importFresh();
    const canUseTool = vi.fn(async () => ({ behavior: "deny" as const }));
    const iter = mod.streamViaCopilotSdk({
      model: "gpt-5.3-codex",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      githubToken: "gho_test",
      sdkPermissionMode: "bypassPermissions",
      canUseTool,
    });
    for await (const _ of iter) { void _; }
    const cfg = createSessionMock.mock.calls[0]?.[0] as {
      onPermissionRequest: (req: { kind: string }) => Promise<{ kind: string }>;
    };
    const decision = await cfg.onPermissionRequest({ kind: "shell" });
    expect(canUseTool).toHaveBeenCalled();
    expect(decision.kind).toBe("denied-by-rules");
  });
});
