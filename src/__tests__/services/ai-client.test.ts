import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Claude Agent SDK. We control what `query()` yields.
const mockQuery = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

// Mock renameClaudeSession — it's a dynamic import from ./claude-cli
vi.mock("../../services/claude-cli", async () => {
  const actual = await vi.importActual<any>("../../services/claude-cli");
  return { ...actual, renameClaudeSession: vi.fn(() => Promise.resolve()) };
});

import { createAIClient } from "../../services/ai-client.js";

beforeEach(() => {
  mockQuery.mockReset();
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
    expect(result.costUsd).toBe(0.01);
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

  it("serializes non-string message content to JSON", async () => {
    let captured: any;
    mockQuery.mockImplementationOnce((opts: any) => {
      captured = opts;
      return asStream([{ type: "result", result: "", session_id: "s", total_cost_usd: 0, usage: {} }]);
    });

    const client = createAIClient();
    await client.chat({
      model: "m", system: "",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(captured.prompt).toBe(JSON.stringify([{ type: "text", text: "hi" }]));
  });
});
