import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ai-client
vi.mock("../../services/ai-client", () => ({
  createAIClient: vi.fn(() => ({
    chat: vi.fn(),
  })),
}));

import { AgentSession } from "../../services/agent-session.js";
import { createAIClient } from "../../services/ai-client.js";

const mockCreateAIClient = createAIClient as any;

function makeSession(overrides: any = {}) {
  return new AgentSession({
    taskId: 1,
    prompt: "Write hello world",
    model: "claude-sonnet-4-6",
    codebaseContext: "",
    ...overrides,
  });
}

describe("AgentSession", () => {
  let mockChat: any;

  beforeEach(() => {
    mockChat = vi.fn();
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
  });

  it("runs to completion with simple text response", async () => {
    mockChat.mockResolvedValueOnce({
      text: "Hello, World!",
      rawContent: "Hello, World!",
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const session = makeSession();
    const textChunks: string[] = [];
    session.on("text", (chunk: string) => textChunks.push(chunk));

    const result = await session.run();

    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(textChunks).toContain("Hello, World!");
  });

  it("executes tool calls and continues conversation", async () => {
    // First response: tool call
    mockChat.mockResolvedValueOnce({
      text: "",
      rawContent: [{ type: "tool_use", id: "tc1", name: "Read", input: { path: "test.txt" } }],
      toolCalls: [{ id: "tc1", name: "Read", input: { path: "test.txt" } }],
      usage: { inputTokens: 50, outputTokens: 30 },
    });

    // Second response: done (no tool calls)
    mockChat.mockResolvedValueOnce({
      text: "Read the file successfully.",
      rawContent: "Read the file successfully.",
      toolCalls: [],
      usage: { inputTokens: 80, outputTokens: 40 },
    });

    const session = makeSession();
    const toolCalls: string[] = [];
    const toolResults: string[] = [];
    session.on("tool_call", (name: string) => toolCalls.push(name));
    session.on("tool_result", (name: string) => toolResults.push(name));

    const result = await session.run();

    expect(toolCalls).toContain("Read");
    expect(toolResults).toContain("Read");
    expect(result.inputTokens).toBe(130);
    expect(result.outputTokens).toBe(70);
    expect(mockChat).toHaveBeenCalledTimes(2);
  });

  it("abort() cancels the session", async () => {
    mockChat.mockImplementation(() => new Promise(() => {})); // hang forever

    const session = makeSession();

    // Start run but don't await yet
    const runPromise = session.run();

    // Abort immediately
    session.abort();

    await expect(runPromise).rejects.toThrow();
  });

  it("builds system prompt without inlined skills and with codebase context", async () => {
    mockChat.mockResolvedValueOnce({
      text: "Done",
      rawContent: "Done",
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const session = makeSession({
      codebaseContext: "file_tree here",
    });

    await session.run();

    // Skills are no longer inlined — Claude Code loads them via progressive disclosure.
    const chatCall = mockChat.mock.calls[0][0];
    expect(chatCall.system).not.toContain("<skills>");
    expect(chatCall.system).not.toContain("<skill ");
    expect(chatCall.system).not.toContain("<available_mcp_servers>");
    expect(chatCall.system).toContain("<codebase_context>");
    expect(chatCall.system).toContain("file_tree here");
  });

  it("handles no tool calls in response (null)", async () => {
    mockChat.mockResolvedValueOnce({
      text: "Simple answer",
      rawContent: "Simple answer",
      toolCalls: null,
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const session = makeSession();
    const result = await session.run();
    expect(result.inputTokens).toBe(10);
  });

  it("handles missing usage in response", async () => {
    mockChat.mockResolvedValueOnce({
      text: "No usage",
      rawContent: "No usage",
      toolCalls: [],
      usage: undefined,
    });

    const session = makeSession();
    const result = await session.run();
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it("emits tool_call and tool_result for Glob tool", async () => {
    // Glob tool is safe and returns results even for pattern with no matches
    mockChat.mockResolvedValueOnce({
      text: "",
      rawContent: [{ type: "tool_use", id: "tc1", name: "Glob", input: { pattern: "*.nonexistent-ext" } }],
      toolCalls: [{ id: "tc1", name: "Glob", input: { pattern: "*.nonexistent-ext" } }],
      usage: { inputTokens: 20, outputTokens: 10 },
    });

    mockChat.mockResolvedValueOnce({
      text: "No files found.",
      rawContent: "No files found.",
      toolCalls: [],
      usage: { inputTokens: 30, outputTokens: 15 },
    });

    const session = makeSession();
    const toolResults: string[] = [];
    session.on("tool_result", (_name: string, output: string) => toolResults.push(output));

    await session.run();
    expect(toolResults.length).toBe(1);
  });
});
