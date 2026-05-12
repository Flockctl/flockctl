import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mock fns so per-test overrides can drive both the readiness path
// (`claude --version`) and the reaper's `ps` invocation (used for PID
// discovery in streamViaClaudeAgentSDK).
const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(() => Buffer.from("claude 1.0.0")),
}));

// Mock child_process for getClaudePath (called inside streamViaClaudeAgentSDK)
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...(args as [])),
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
import {
  _resetTrackingForTests,
  _trackedPidsSnapshot,
} from "../../services/claude/process-reaper.js";

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

// PID watchdog wired into streamViaClaudeAgentSDK by the process-reaper.
// Asserts that we discover and track the SDK subprocess via the `ps` diff,
// and that the abort path / clean-exit finally both stamp the PID for the
// reaper to kill.
describe("streamViaClaudeAgentSDK PID watchdog", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockExecFileSync.mockReset();
    // Default: pretend `claude --version` works and `ps` returns nothing.
    mockExecFileSync.mockImplementation(((bin: string) =>
      bin === "ps" ? Buffer.from("") : Buffer.from("claude 1.0.0")) as never);
    _resetTrackingForTests();
  });

  it("discovers and tracks our SDK subprocess via the ps diff on first event", async () => {
    let psCallCount = 0;
    mockExecFileSync.mockImplementation(((bin: string) => {
      if (bin === "ps") {
        psCallCount++;
        // 1st: snapshot before query — empty
        // 2nd+: discovery during for-await — one new matching claude proc
        if (psCallCount === 1) return Buffer.from("");
        return Buffer.from(
          `  4242   ${process.pid} 00:01 /tmp/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --output-format stream-json --resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
        );
      }
      return Buffer.from("claude 1.0.0");
    }) as never);

    mockQuery.mockReturnValue(
      toAsync([
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } },
        { type: "result", session_id: "r", usage: {}, total_cost_usd: 0 },
      ]),
    );

    await collect(
      streamViaClaudeAgentSDK({
        model: "m",
        system: "",
        messages: [{ role: "user", content: "x" }],
        resumeSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
    );

    // After clean exit, the `finally` block marks the tracked PID as aborted
    // so the reaper sweeps it on the next tick. The PID stays in the
    // tracking map until reaped (or until the process dies on its own).
    const snap = _trackedPidsSnapshot();
    expect(snap.has(4242)).toBe(true);
    expect(snap.get(4242)!.abortAt).not.toBeNull();
  });

  it("does not attribute a sibling SDK process spawned concurrently", async () => {
    let psCallCount = 0;
    mockExecFileSync.mockImplementation(((bin: string) => {
      if (bin === "ps") {
        psCallCount++;
        if (psCallCount === 1) return Buffer.from("");
        // Two new procs appeared — one ours, one a sibling. Without a
        // resumeSessionId filter the watchdog must NOT pick a winner.
        return Buffer.from(
          [
            `  4242   ${process.pid} 00:01 /tmp/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --output-format stream-json`,
            `  4243   ${process.pid} 00:01 /tmp/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --output-format stream-json`,
          ].join("\n"),
        );
      }
      return Buffer.from("claude 1.0.0");
    }) as never);

    mockQuery.mockReturnValue(
      toAsync([
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } },
        { type: "result", session_id: "r", usage: {}, total_cost_usd: 0 },
      ]),
    );

    await collect(
      streamViaClaudeAgentSDK({
        model: "m",
        system: "",
        messages: [{ role: "user", content: "x" }],
        // no resumeSessionId — ambiguous case
      }),
    );

    // Conservative: when ambiguous, the watchdog leaks rather than risking
    // killing a sibling session. The periodic reaper is the safety net.
    const snap = _trackedPidsSnapshot();
    expect(snap.has(4242)).toBe(false);
    expect(snap.has(4243)).toBe(false);
  });

  it("filters by resumeSessionId when provided — picks only the matching PID", async () => {
    let psCallCount = 0;
    mockExecFileSync.mockImplementation(((bin: string) => {
      if (bin === "ps") {
        psCallCount++;
        if (psCallCount === 1) return Buffer.from("");
        // Two new procs — only one matches our resume id.
        return Buffer.from(
          [
            `  5000   ${process.pid} 00:01 /tmp/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --resume 11111111-1111-1111-1111-111111111111`,
            `  5001   ${process.pid} 00:01 /tmp/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --resume 22222222-2222-2222-2222-222222222222`,
          ].join("\n"),
        );
      }
      return Buffer.from("claude 1.0.0");
    }) as never);

    mockQuery.mockReturnValue(
      toAsync([
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } },
        { type: "result", session_id: "r", usage: {}, total_cost_usd: 0 },
      ]),
    );

    await collect(
      streamViaClaudeAgentSDK({
        model: "m",
        system: "",
        messages: [{ role: "user", content: "x" }],
        resumeSessionId: "22222222-2222-2222-2222-222222222222",
      }),
    );

    const snap = _trackedPidsSnapshot();
    expect(snap.has(5001)).toBe(true);
    expect(snap.has(5000)).toBe(false);
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
