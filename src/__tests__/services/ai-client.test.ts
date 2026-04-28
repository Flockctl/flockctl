import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Claude Agent SDK. We control what `query()` yields. The
// `createSdkMcpServer` / `tool` mocks return tagged sentinels so tests can
// assert that the AskUserQuestion bridge wires through to the SDK without
// needing the real in-process MCP-server runtime — the actual server is
// opaque to the test and we only care that the right slot in `mcpServers`
// got populated.
const mockQuery = vi.fn();
const mockCreateSdkMcpServer = vi.fn((opts: any) => ({
  __mockMcpServer: true,
  name: opts.name,
  version: opts.version,
  tools: opts.tools,
}));
const mockTool = vi.fn((name: string, description: string, inputSchema: any, handler: any) => ({
  __mockTool: true,
  name,
  description,
  inputSchema,
  handler,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
  createSdkMcpServer: (opts: any) => mockCreateSdkMcpServer(opts),
  tool: (...args: any[]) => mockTool(...(args as [string, string, any, any])),
}));

// Mock renameClaudeSession — it's a dynamic import from ./claude-cli
vi.mock("../../services/claude/cli", async () => {
  const actual = await vi.importActual<any>("../../services/claude/cli");
  return { ...actual, renameClaudeSession: vi.fn(() => Promise.resolve()) };
});

import { createAIClient } from "../../services/ai/client.js";

beforeEach(() => {
  mockQuery.mockReset();
  mockCreateSdkMcpServer.mockClear();
  mockTool.mockClear();
});

// Helper to build an async iterable for the mocked stream
function asStream(messages: any[]) {
  async function* gen() {
    for (const m of messages) yield m;
  }
  return gen();
}

describe("createAIClient — basic shape", () => {
  it("returns a client with chat method", () => {
    const client = createAIClient();
    expect(client).toBeDefined();
    expect(typeof client.chat).toBe("function");
  });

  it("accepts configDir option", () => {
    const client = createAIClient({ configDir: "/tmp/test-config" });
    expect(client).toBeDefined();
  });

  it("chat rejects with empty messages", async () => {
    const client = createAIClient();
    await expect(
      client.chat({ model: "claude-sonnet-4-6", system: "", messages: [] }),
    ).rejects.toThrow("messages array must not be empty");
  });
});

describe("createAIClient.chat — stream handling", () => {
  it("processes assistant text blocks and emits text events", async () => {
    const events: any[] = [];
    mockQuery.mockImplementationOnce(() => asStream([
      {
        type: "assistant",
        message: {
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [
            { type: "text", text: "Hello" },
            { type: "tool_use", name: "Read", input: { file: "x" } },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          usage: { input_tokens: 2, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [{ type: "text", text: " world" }],
        },
      },
      {
        type: "result",
        result: "final text",
        session_id: "sess-123",
        total_cost_usd: 0.01,
        usage: { input_tokens: 12, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    ]));

    const client = createAIClient();
    const result = await client.chat({
      model: "m",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      onEvent: (e) => events.push(e),
    });

    expect(result.text).toBe("final text");
    expect(result.sessionId).toBe("sess-123");
    // Cumulative usage across assistant messages — SDK's result.usage is only
    // the last turn, so we keep the accumulated totals instead.
    expect(result.usage?.inputTokens).toBe(12);
    expect(result.usage?.outputTokens).toBe(6);

    // Emitted events: usage (after assistant), text, tool_call, usage (after result)
    const types = events.map(e => e.type);
    expect(types).toContain("text");
    expect(types).toContain("tool_call");
    expect(types.filter(t => t === "usage").length).toBeGreaterThanOrEqual(1);
  });

  it("handles tool_use_summary messages", async () => {
    const events: any[] = [];
    mockQuery.mockImplementationOnce(() => asStream([
      { type: "tool_use_summary", summary: "done", tool_name: "Bash" },
      { type: "result", result: "ok", session_id: "s", total_cost_usd: 0, usage: {} },
    ]));

    const client = createAIClient();
    await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "go" }],
      onEvent: (e) => events.push(e),
    });

    const toolResult = events.find(e => e.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult.toolName).toBe("Bash");
    expect(toolResult.content).toBe("done");
  });

  it("passes canUseTool and uses 'default' permissionMode", async () => {
    let captured: any;
    mockQuery.mockImplementationOnce((opts: any) => {
      captured = opts;
      return asStream([{ type: "result", result: "x", session_id: "s", total_cost_usd: 0, usage: {} }]);
    });

    const canUse = vi.fn(() => Promise.resolve({ behavior: "allow" as const }));

    const client = createAIClient();
    await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      canUseTool: canUse,
    });

    expect(captured.options.permissionMode).toBe("default");
    expect(captured.options.canUseTool).toBe(canUse);
  });

  it("uses bypassPermissions when no canUseTool is provided", async () => {
    let captured: any;
    mockQuery.mockImplementationOnce((opts: any) => {
      captured = opts;
      return asStream([{ type: "result", result: "", session_id: "s", total_cost_usd: 0, usage: {} }]);
    });

    const client = createAIClient();
    await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "x" }],
    });

    expect(captured.options.permissionMode).toBe("bypassPermissions");
    expect(captured.options.allowDangerouslySkipPermissions).toBe(true);
  });

  it("passes cwd and noTools options", async () => {
    let captured: any;
    mockQuery.mockImplementationOnce((opts: any) => {
      captured = opts;
      return asStream([{ type: "result", result: "", session_id: "s", total_cost_usd: 0, usage: {} }]);
    });

    const client = createAIClient();
    await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "x" }],
      cwd: "/some/dir",
      noTools: true,
    });

    expect(captured.options.cwd).toBe("/some/dir");
    expect(captured.options.tools).toEqual([]);
  });

  it("injects CLAUDE_CONFIG_DIR env when configDir option is set", async () => {
    let captured: any;
    mockQuery.mockImplementationOnce((opts: any) => {
      captured = opts;
      return asStream([{ type: "result", result: "", session_id: "s", total_cost_usd: 0, usage: {} }]);
    });

    const client = createAIClient({ configDir: "/custom/conf" });
    await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "x" }],
    });

    expect(captured.options.env).toBeDefined();
    expect(captured.options.env.CLAUDE_CONFIG_DIR).toBe("/custom/conf");
  });

  it("expands ~/ in configDir", async () => {
    let captured: any;
    mockQuery.mockImplementationOnce((opts: any) => {
      captured = opts;
      return asStream([{ type: "result", result: "", session_id: "s", total_cost_usd: 0, usage: {} }]);
    });

    const client = createAIClient({ configDir: "~/my-conf" });
    await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "x" }],
    });

    expect(captured.options.env.CLAUDE_CONFIG_DIR).toMatch(/\/my-conf$/);
    expect(captured.options.env.CLAUDE_CONFIG_DIR.startsWith("~")).toBe(false);
  });

it("throws AbortError when abortSignal already aborted", async () => {
    mockQuery.mockImplementationOnce(() => asStream([
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
    ]));

    const ctrl = new AbortController();
    ctrl.abort();

    const client = createAIClient();
    await expect(client.chat({
      model: "m", system: "", messages: [{ role: "user", content: "x" }], abortSignal: ctrl.signal,
    })).rejects.toThrow(/cancelled|Task/);
  });

  it("wraps stream errors with 'AI stream error' prefix", async () => {
    mockQuery.mockImplementationOnce(() => {
      async function* gen() {
        yield { type: "assistant", message: { content: [] } };
        throw new Error("boom");
      }
      return gen();
    });

    const client = createAIClient();
    await expect(client.chat({
      model: "m", system: "", messages: [{ role: "user", content: "x" }],
    })).rejects.toThrow(/AI stream error.*boom/);
  });

  it("forwards block-array content as an AsyncIterable<SDKUserMessage>", async () => {
    // Multimodal turns (text + image attachments) must reach the SDK as
    // native content blocks, not as a JSON-stringified string — otherwise
    // the model sees a stringly-typed body and loses the image semantics.
    let captured: any;
    mockQuery.mockImplementationOnce((opts: any) => {
      captured = opts;
      return asStream([{ type: "result", result: "", session_id: "s", total_cost_usd: 0, usage: {} }]);
    });

    const blocks = [{ type: "text", text: "hi" }];
    const client = createAIClient();
    await client.chat({
      model: "m", system: "",
      messages: [{ role: "user", content: blocks }],
    });

    // The prompt should be an AsyncIterable yielding exactly one
    // SDKUserMessage whose `content` is the original block array.
    expect(typeof captured.prompt).toBe("object");
    expect(typeof captured.prompt?.[Symbol.asyncIterator]).toBe("function");

    const emitted: any[] = [];
    for await (const msg of captured.prompt) emitted.push(msg);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe("user");
    expect(emitted[0].message.role).toBe("user");
    expect(emitted[0].message.content).toBe(blocks);
  });
});

describe("createAIClient.chat — AskUserQuestion bridge wiring", () => {
  // Regression coverage for the milestone "Structured agent questions +
  // inbox integration" bug that landed task 432 in `done` after the inner
  // agent called AskUserQuestion three times: the SDK's stubbed-headless
  // built-in resolved with empty answers because Flockctl never registered
  // an in-process override. These tests assert that when an
  // `askUserQuestionHandler` is wired, the SDK options carry both
  // `disallowedTools: ["AskUserQuestion"]` AND a `mcpServers.flockctl_host`
  // entry — without that combination the bug recurs silently.

  it("does NOT add disallowedTools or flockctl_host when no handler is provided", async () => {
    let captured: any;
    mockQuery.mockImplementationOnce((opts: any) => {
      captured = opts;
      return asStream([{ type: "result", result: "", session_id: "s", total_cost_usd: 0, usage: {} }]);
    });

    const client = createAIClient();
    await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "hi" }],
    });

    // Backward-compat: callers that don't ask for the bridge get the
    // historic SDK invocation byte-identical to the pre-fix behavior.
    expect(captured.options.disallowedTools).toBeUndefined();
    expect(captured.options.mcpServers).toBeUndefined();
    expect(mockCreateSdkMcpServer).not.toHaveBeenCalled();
  });

  it("registers the flockctl_host MCP server and disables AskUserQuestion when a handler is provided", async () => {
    let captured: any;
    mockQuery.mockImplementationOnce((opts: any) => {
      captured = opts;
      return asStream([{ type: "result", result: "", session_id: "s", total_cost_usd: 0, usage: {} }]);
    });

    const handler = vi.fn(async () => "the answer");

    const client = createAIClient();
    await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      askUserQuestionHandler: handler,
    });

    // Built-in must be removed from the tool inventory — without this, the
    // CLI subprocess auto-resolves AskUserQuestion before the model ever
    // sees our override.
    expect(captured.options.disallowedTools).toEqual(["AskUserQuestion"]);

    // Override is registered as an in-process MCP server under the
    // `flockctl_host` name. The model sees the tool as
    // `mcp__flockctl_host__AskUserQuestion`.
    expect(captured.options.mcpServers).toBeDefined();
    expect(captured.options.mcpServers.flockctl_host).toBeDefined();
    expect(captured.options.mcpServers.flockctl_host.__mockMcpServer).toBe(true);

    // The single tool registered in the override must be named
    // `AskUserQuestion` so namespace+name composes to the documented
    // `mcp__flockctl_host__AskUserQuestion` identifier.
    expect(mockTool).toHaveBeenCalledTimes(1);
    expect(mockTool.mock.calls[0]![0]).toBe("AskUserQuestion");
  });

  it("preserves caller-supplied mcpServers alongside the bridge entry", async () => {
    // Real callers pass project-resolved MCP servers (github, albs, etc.)
    // via opts.mcpServers — the bridge MUST add to the map, not replace it,
    // otherwise wiring AskUserQuestion would silently strip every other
    // MCP integration the project relies on.
    let captured: any;
    mockQuery.mockImplementationOnce((opts: any) => {
      captured = opts;
      return asStream([{ type: "result", result: "", session_id: "s", total_cost_usd: 0, usage: {} }]);
    });

    const handler = vi.fn(async () => "answer");
    const userMcpServers = {
      github: { command: "/bin/gh-mcp" } as Record<string, unknown>,
      albs: { command: "/bin/albs-mcp" } as Record<string, unknown>,
    };

    const client = createAIClient();
    await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      mcpServers: userMcpServers,
      askUserQuestionHandler: handler,
    });

    expect(Object.keys(captured.options.mcpServers).sort()).toEqual([
      "albs",
      "flockctl_host",
      "github",
    ]);
    expect(captured.options.mcpServers.github).toEqual({ command: "/bin/gh-mcp" });
    expect(captured.options.mcpServers.albs).toEqual({ command: "/bin/albs-mcp" });
  });

  it("invokes the underlying handler when the bridge tool is called by the SDK", async () => {
    // The bridge handler captured by `tool()` MUST round-trip a structured
    // question through the user's `askUserQuestionHandler` — the SDK
    // routes a `tool_use` for AskUserQuestion to this closure, so if the
    // closure doesn't end up calling the user-supplied handler the agent
    // will sit forever (or worse, the SDK will surface an exception).
    mockQuery.mockImplementationOnce(() =>
      asStream([{ type: "result", result: "", session_id: "s", total_cost_usd: 0, usage: {} }]),
    );

    const handler = vi.fn(async (_parsed: { question: string }, _id: string) => "user picked option A");

    const client = createAIClient();
    await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      askUserQuestionHandler: handler as any,
    });

    // Now simulate the SDK calling the registered tool's handler closure
    // exactly as it would when the agent emits a tool_use for AskUserQuestion.
    const toolCall = mockTool.mock.calls[0];
    if (!toolCall) throw new Error("expected tool() to have been called once");
    const registeredHandler = toolCall[3] as (
      args: any,
      extra: any,
    ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

    const result = await registeredHandler(
      {
        questions: [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }],
      },
      { toolUseId: "toolu_xyz" },
    );

    expect(handler).toHaveBeenCalledTimes(1);
    const handlerCall = handler.mock.calls[0];
    if (!handlerCall) throw new Error("expected askUserQuestionHandler to have been called once");
    expect(handlerCall[0].question).toBe("Pick one");
    expect(handlerCall[1]).toBe("toolu_xyz");
    expect(result.content[0]!.text).toBe("user picked option A");
  });
});
