/**
 * Branch-coverage extensions for services/ai/client.ts. Targets the
 * fall-through arms of:
 *   - `thinkingEnabled=false` → `thinking: { type: "disabled" }`
 *   - `resumeSessionId` spread into queryOpts
 *   - `mcpServers` path (non-empty)
 *   - rawContent that's not a string or array (object → `JSON.stringify`)
 *   - block-array content without a `text` block (`?? "[multimodal message]"`)
 *   - `block.type === "thinking"` emission
 *   - tool_use block without an `input` (`?? {}`)
 *   - `tool_use_summary` without `summary` (`?? ""`)
 *   - `result` without `result` / `session_id` fields (`?? ""` / keep prior)
 *   - assistant.usage with missing sub-fields (all `?? 0` paths)
 *   - error-throwing stream where `err` is a non-Error (`String(err)` path)
 *
 * Mocks follow the existing `ai-client.test.ts` pattern.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

vi.mock("../../services/claude/cli", async () => {
  const actual = await vi.importActual<any>("../../services/claude/cli");
  return { ...actual, renameClaudeSession: vi.fn(() => Promise.resolve()) };
});

import { createAIClient } from "../../services/ai/client.js";

beforeEach(() => {
  mockQuery.mockReset();
});

function asStream(messages: any[]) {
  async function* gen() {
    for (const m of messages) yield m;
  }
  return gen();
}

describe("client.chat — queryOpts spread branches", () => {
  it("forwards thinking.type='disabled' when thinkingEnabled=false", async () => {
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
      thinkingEnabled: false,
    });
    expect(captured.options.thinking).toEqual({ type: "disabled" });
  });

  it("does NOT forward `thinking` when thinkingEnabled=true (default)", async () => {
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
      thinkingEnabled: true,
    });
    expect(captured.options.thinking).toBeUndefined();
  });

  it("forwards resume when resumeSessionId is supplied", async () => {
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
      resumeSessionId: "claude-session-abc",
    });
    expect(captured.options.resume).toBe("claude-session-abc");
  });

  it("forwards mcpServers when provided with at least one entry", async () => {
    let captured: any;
    mockQuery.mockImplementationOnce((opts: any) => {
      captured = opts;
      return asStream([{ type: "result", result: "", session_id: "s", total_cost_usd: 0, usage: {} }]);
    });
    const client = createAIClient();
    const servers = { ctx7: { command: "x", args: [] } };
    await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "x" }],
      mcpServers: servers,
    });
    expect(captured.options.mcpServers).toEqual(servers);
  });

  it("does NOT forward mcpServers when the object is empty (length === 0 branch)", async () => {
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
      mcpServers: {},
    });
    expect(captured.options.mcpServers).toBeUndefined();
  });
});

describe("client.chat — content/prompt shape branches", () => {
  it("stringifies an object-content user message via JSON.stringify (non-string, non-array path)", async () => {
    let captured: any;
    mockQuery.mockImplementationOnce((opts: any) => {
      captured = opts;
      return asStream([{ type: "result", result: "", session_id: "s", total_cost_usd: 0, usage: {} }]);
    });
    const client = createAIClient();
    await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: { foo: "bar", n: 42 } }],
    });
    // Object content — promptForSDK hits `typeof rawContent === "string"` else
    // branch → JSON.stringify(rawContent).
    expect(typeof captured.prompt).toBe("string");
    expect(captured.prompt).toContain("foo");
    expect(captured.prompt).toContain("42");
  });

  it("block-array user message without a text block renames with '[multimodal message]' fallback", async () => {
    mockQuery.mockImplementationOnce(() =>
      asStream([{ type: "result", result: "ok", session_id: "sess-multi", total_cost_usd: 0, usage: {} }]),
    );
    const { renameClaudeSession } = await import("../../services/claude/cli.js");
    const renameSpy = vi.mocked(renameClaudeSession);
    renameSpy.mockClear();

    const client = createAIClient();
    // Blocks array but NO text block — only images — forces the `?? "[multimodal message]"` branch.
    const blocks = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }];
    await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: blocks }],
    });
    // renameClaudeSession was called with the fallback label slice.
    expect(renameSpy).toHaveBeenCalled();
    const labelArg = renameSpy.mock.calls[0]![1];
    expect(labelArg).toContain("[FLOCKCTL]");
    expect(labelArg).toContain("[multimodal message]");
  });
});

describe("client.chat — assistant/result stream branches", () => {
  it("handles assistant.message.usage with all fields missing (uses ?? 0 for each)", async () => {
    const events: any[] = [];
    mockQuery.mockImplementationOnce(() => asStream([
      {
        type: "assistant",
        message: {
          usage: {}, // fully empty — every `?? 0` branch fires
          content: [{ type: "text", text: "hi" }],
        },
      },
      { type: "result", result: "", session_id: "s", total_cost_usd: 0, usage: {} },
    ]));

    const client = createAIClient();
    const result = await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "x" }],
      onEvent: (e) => events.push(e),
    });
    expect(result.usage?.inputTokens).toBe(0);
    expect(result.usage?.outputTokens).toBe(0);
    expect(result.usage?.cacheCreationInputTokens).toBe(0);
    expect(result.usage?.cacheReadInputTokens).toBe(0);
  });

  it("emits 'thinking' events for assistant message thinking blocks", async () => {
    const events: any[] = [];
    mockQuery.mockImplementationOnce(() => asStream([
      {
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "let me consider..." }],
        },
      },
      { type: "result", result: "", session_id: "s", total_cost_usd: 0, usage: {} },
    ]));
    const client = createAIClient();
    await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "x" }],
      onEvent: (e) => events.push(e),
    });
    const t = events.find((e) => e.type === "thinking");
    expect(t).toBeDefined();
    expect(t.content).toBe("let me consider...");
  });

  it("tool_use block without `input` uses `?? {}` default", async () => {
    const events: any[] = [];
    mockQuery.mockImplementationOnce(() => asStream([
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "NoInput" /* input missing */ }],
        },
      },
      { type: "result", result: "", session_id: "s", total_cost_usd: 0, usage: {} },
    ]));
    const client = createAIClient();
    await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "x" }],
      onEvent: (e) => events.push(e),
    });
    const call = events.find((e) => e.type === "tool_call");
    expect(call).toBeDefined();
    expect(call.content).toEqual({});
    expect(call.toolName).toBe("NoInput");
  });

  it("tool_use_summary without summary field falls back to '' (`?? \"\"` path)", async () => {
    const events: any[] = [];
    mockQuery.mockImplementationOnce(() => asStream([
      // No `summary` field — exercises the `?? ""` branch.
      { type: "tool_use_summary", tool_name: "X" },
      { type: "result", result: "", session_id: "s", total_cost_usd: 0, usage: {} },
    ]));
    const client = createAIClient();
    await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "x" }],
      onEvent: (e) => events.push(e),
    });
    const r = events.find((e) => e.type === "tool_result");
    expect(r).toBeDefined();
    expect(r.content).toBe("");
    expect(r.toolName).toBe("X");
  });

  it("result message without `result` field uses '' fallback for text", async () => {
    mockQuery.mockImplementationOnce(() => asStream([
      // `result` key missing → `resultText = ?? ""`.
      { type: "result", session_id: "sss", total_cost_usd: 0, usage: {} },
    ]));
    const client = createAIClient();
    const out = await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "x" }],
    });
    expect(out.text).toBe("");
    expect(out.sessionId).toBe("sss");
  });

  it("result message without session_id keeps the eagerly-captured sessionId", async () => {
    mockQuery.mockImplementationOnce(() => asStream([
      // First message carries a session_id — the eager-emit path sets it.
      { type: "system", session_id: "eager-s" },
      // Terminal result has no session_id → `?? sessionId` keeps "eager-s".
      { type: "result", result: "done", total_cost_usd: 0, usage: {} },
    ]));
    const client = createAIClient();
    const out = await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "x" }],
    });
    expect(out.sessionId).toBe("eager-s");
  });
});

describe("client.chat — error wrapping branches", () => {
  it("wraps a non-Error throw inside the stream with String(err) path", async () => {
    mockQuery.mockImplementationOnce(() => {
      async function* gen() {
        yield { type: "assistant", message: { content: [] } };
        // Throw a bare string (not instanceof Error) → exercises String(err).
        throw "bare-string-error";
      }
      return gen();
    });
    const client = createAIClient();
    await expect(client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "x" }],
    })).rejects.toThrow(/AI stream error.*bare-string-error/);
  });
});

describe("client.chat — session renaming branch", () => {
  it("does NOT rename the Claude session when no sessionId was surfaced", async () => {
    // No session_id in any message → `if (sessionId)` branch is the "false"
    // path, which is the one we need for full branch coverage.
    mockQuery.mockImplementationOnce(() => asStream([
      { type: "result", result: "", total_cost_usd: 0, usage: {} },
    ]));
    const { renameClaudeSession } = await import("../../services/claude/cli.js");
    const renameSpy = vi.mocked(renameClaudeSession);
    renameSpy.mockClear();

    const client = createAIClient();
    const out = await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "x" }],
    });
    expect(out.sessionId).toBeUndefined();
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it("uses the explicit sessionLabel when provided", async () => {
    mockQuery.mockImplementationOnce(() => asStream([
      { type: "result", result: "", session_id: "labeled-s", total_cost_usd: 0, usage: {} },
    ]));
    const { renameClaudeSession } = await import("../../services/claude/cli.js");
    const renameSpy = vi.mocked(renameClaudeSession);
    renameSpy.mockClear();

    const client = createAIClient();
    await client.chat({
      model: "m",
      system: "",
      messages: [{ role: "user", content: "x" }],
      sessionLabel: "My Custom Label",
    });
    expect(renameSpy).toHaveBeenCalledWith("labeled-s", "[FLOCKCTL] My Custom Label");
  });
});
