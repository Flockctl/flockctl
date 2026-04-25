import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process for getClaudePath (called inside streamViaClaudeAgentSDK)
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => Buffer.from("claude 1.0.0")),
  execSync: vi.fn(() => Buffer.from("/usr/local/bin/claude")),
}));

// Mock the SDK module (dynamically imported inside claude-cli)
const mockQuery = vi.fn();
const mockRenameSession = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: any[]) => mockQuery(...args),
  renameSession: (...args: any[]) => mockRenameSession(...args),
}));

import { streamViaClaudeAgentSDK, renameClaudeSession } from "../../services/claude/cli.js";

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

async function* toAsync<T>(arr: T[]): AsyncGenerator<T> {
  for (const x of arr) yield x;
}

describe("streamViaClaudeAgentSDK", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockRenameSession.mockReset();
  });

  it("yields text events from content_block_delta", async () => {
    mockQuery.mockReturnValue(
      toAsync([
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hello " },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "world" },
          },
        },
        {
          type: "result",
          session_id: "sess-1",
          usage: { input_tokens: 10, output_tokens: 5 },
          total_cost_usd: 0.001,
        },
      ]),
    );

    const events = await collect(
      streamViaClaudeAgentSDK({
        model: "claude-opus-4-7",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(events.filter((e) => e.type === "text").map((e) => e.text).join("")).toBe("Hello world");

    const done = events.find((e) => e.type === "done")!;
    expect(done.sessionId).toBe("sess-1");
    expect(done.usage.inputTokens).toBe(10);
    expect(done.usage.outputTokens).toBe(5);
    expect(done.usage.totalCostUsd).toBeCloseTo(0.001, 4);
  });

  it("ignores non-text stream events", async () => {
    mockQuery.mockReturnValue(
      toAsync([
        { type: "stream_event", event: { type: "message_start" } },
        { type: "stream_event", event: { type: "content_block_start" } },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "ok" },
          },
        },
        { type: "result", session_id: "s", usage: {}, total_cost_usd: 0 },
      ]),
    );

    const events = await collect(
      streamViaClaudeAgentSDK({
        model: "m",
        system: "",
        messages: [{ role: "user", content: "x" }],
      }),
    );
    const texts = events.filter((e) => e.type === "text").map((e) => e.text);
    expect(texts).toEqual(["ok"]);
  });

  it("passes resume option when resumeSessionId is provided", async () => {
    mockQuery.mockReturnValue(
      toAsync([{ type: "result", session_id: "r", usage: {}, total_cost_usd: 0 }]),
    );

    await collect(
      streamViaClaudeAgentSDK({
        model: "m",
        system: "",
        messages: [{ role: "user", content: "more" }],
        resumeSessionId: "sess-resume",
      }),
    );

    const callArg = mockQuery.mock.calls[0][0];
    expect(callArg.options.resume).toBe("sess-resume");
  });

  it("does not pass resume option when no session to resume", async () => {
    mockQuery.mockReturnValue(
      toAsync([{ type: "result", session_id: "r", usage: {}, total_cost_usd: 0 }]),
    );

    await collect(
      streamViaClaudeAgentSDK({
        model: "m",
        system: "",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const callArg = mockQuery.mock.calls[0][0];
    expect(callArg.options.resume).toBeUndefined();
  });

  it("uses configDir env override when provided", async () => {
    mockQuery.mockReturnValue(
      toAsync([{ type: "result", session_id: "r", usage: {}, total_cost_usd: 0 }]),
    );

    await collect(
      streamViaClaudeAgentSDK({
        model: "m",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        configDir: "~/custom-claude",
      }),
    );

    const callArg = mockQuery.mock.calls[0][0];
    expect(callArg.options.env?.CLAUDE_CONFIG_DIR).toBeTruthy();
    expect(callArg.options.env?.CLAUDE_CONFIG_DIR).not.toContain("~");
  });

  it("uses systemPrompt when system string is set", async () => {
    mockQuery.mockReturnValue(
      toAsync([{ type: "result", session_id: "r", usage: {}, total_cost_usd: 0 }]),
    );

    await collect(
      streamViaClaudeAgentSDK({
        model: "m",
        system: "You are helpful",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const callArg = mockQuery.mock.calls[0][0];
    expect(callArg.options.systemPrompt).toBe("You are helpful");
  });

  it("passes the last user message as prompt", async () => {
    mockQuery.mockReturnValue(
      toAsync([{ type: "result", session_id: "r", usage: {}, total_cost_usd: 0 }]),
    );

    await collect(
      streamViaClaudeAgentSDK({
        model: "m",
        system: "",
        messages: [
          { role: "user", content: "first msg" },
          { role: "assistant", content: "reply" },
          { role: "user", content: "second msg" },
        ],
      }),
    );
    expect(mockQuery.mock.calls[0][0].prompt).toBe("second msg");
  });

  it("stringifies non-string content", async () => {
    mockQuery.mockReturnValue(
      toAsync([{ type: "result", session_id: "r", usage: {}, total_cost_usd: 0 }]),
    );

    await collect(
      streamViaClaudeAgentSDK({
        model: "m",
        system: "",
        messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      }),
    );
    const promptSent = mockQuery.mock.calls[0][0].prompt;
    expect(promptSent).toContain("text");
  });

  it("passes empty prompt when there are no user messages", async () => {
    mockQuery.mockReturnValue(
      toAsync([{ type: "result", session_id: "r", usage: {}, total_cost_usd: 0 }]),
    );
    await collect(
      streamViaClaudeAgentSDK({
        model: "m",
        system: "",
        messages: [{ role: "assistant", content: "only-assistant" }],
      }),
    );
    expect(mockQuery.mock.calls[0][0].prompt).toBe("");
  });

  it("falls back to zeroed usage when SDK omits usage fields", async () => {
    mockQuery.mockReturnValue(
      toAsync([{ type: "result", session_id: "s" }]),
    );
    const events = await collect(
      streamViaClaudeAgentSDK({
        model: "m",
        system: "",
        messages: [{ role: "user", content: "x" }],
      }),
    );
    const done = events.find((e) => e.type === "done")!;
    expect(done.usage.inputTokens).toBe(0);
    expect(done.usage.outputTokens).toBe(0);
    expect(done.usage.totalCostUsd).toBe(0);
  });

  it("completes even when stream ends without a result message", async () => {
    mockQuery.mockReturnValue(
      toAsync([
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "a" } } },
      ]),
    );
    const events = await collect(
      streamViaClaudeAgentSDK({
        model: "m",
        system: "",
        messages: [{ role: "user", content: "x" }],
      }),
    );
    expect(events.find((e) => e.type === "done")).toBeUndefined();
  });

  it("forwards mcpServers to SDK options when provided", async () => {
    mockQuery.mockReturnValue(
      toAsync([{ type: "result", session_id: "r", usage: {}, total_cost_usd: 0 }]),
    );

    const mcpServers = {
      albs: { command: "/bin/albs-mcp" },
      "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
    };

    await collect(
      streamViaClaudeAgentSDK({
        model: "m",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        mcpServers,
      }),
    );

    const callArg = mockQuery.mock.calls[0][0];
    expect(callArg.options.mcpServers).toEqual(mcpServers);
  });

  it("omits mcpServers from SDK options when unset or empty", async () => {
    mockQuery.mockReturnValue(
      toAsync([{ type: "result", session_id: "r", usage: {}, total_cost_usd: 0 }]),
    );

    await collect(
      streamViaClaudeAgentSDK({
        model: "m",
        system: "",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(mockQuery.mock.calls[0][0].options.mcpServers).toBeUndefined();

    mockQuery.mockClear();
    mockQuery.mockReturnValue(
      toAsync([{ type: "result", session_id: "r", usage: {}, total_cost_usd: 0 }]),
    );

    await collect(
      streamViaClaudeAgentSDK({
        model: "m",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        mcpServers: {},
      }),
    );
    expect(mockQuery.mock.calls[0][0].options.mcpServers).toBeUndefined();
  });

  it("respects external AbortSignal", async () => {
    mockQuery.mockReturnValue(
      toAsync([{ type: "result", session_id: "r", usage: {}, total_cost_usd: 0 }]),
    );
    const ac = new AbortController();
    await collect(
      streamViaClaudeAgentSDK({
        model: "m",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        signal: ac.signal,
      }),
    );
    const callArg = mockQuery.mock.calls[0][0];
    expect(callArg.options.abortController).toBeDefined();
  });
});

describe("renameClaudeSession", () => {
  beforeEach(() => {
    mockRenameSession.mockReset();
  });

  it("calls SDK renameSession with sessionId and title", async () => {
    mockRenameSession.mockResolvedValue(undefined);
    await renameClaudeSession("sess-1", "New Title");
    expect(mockRenameSession).toHaveBeenCalledWith("sess-1", "New Title");
  });

  it("swallows errors from SDK rename", async () => {
    mockRenameSession.mockRejectedValue(new Error("boom"));
    // Should not throw
    await expect(renameClaudeSession("sess-1", "T")).resolves.toBeUndefined();
  });
});
