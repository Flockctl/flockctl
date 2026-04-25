import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ai-client
vi.mock("../../services/ai/client", () => ({
  createAIClient: vi.fn(() => ({
    chat: vi.fn(),
  })),
}));

import { AgentSession } from "../../services/agent-session/index.js";
import { createAIClient } from "../../services/ai/client.js";

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

  it("emits turn_end once per agentic-loop iteration — provider-agnostic per-turn boundary", async () => {
    // Simulates the GitHub Copilot path: `provider.chat()` returns the full
    // turn as one text block (no per-block streaming, no per-SDK-message
    // turn_end from inside the provider). agent-session.ts's while-loop MUST
    // emit `turn_end` itself at the end of each iteration, otherwise
    // consecutive text-only turns would merge into a single `chat_messages`
    // row on the chats.ts side because nothing triggers a flush between
    // turns. This is the parity guarantee for non-Claude-Code providers.

    // Turn 1: text + tool call
    mockChat.mockResolvedValueOnce({
      text: "Turn 1 reply",
      rawContent: "Turn 1 reply",
      toolCalls: [{ id: "tc1", name: "Read", input: { path: "a.txt" } }],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    // Turn 2: text only, no tools → loop breaks after this turn
    mockChat.mockResolvedValueOnce({
      text: "Turn 2 final",
      rawContent: "Turn 2 final",
      toolCalls: [],
      usage: { inputTokens: 8, outputTokens: 3 },
    });

    const session = makeSession();
    const turnEnds: number[] = [];
    // Record when turn_end fires relative to other events to lock the
    // ordering contract: turn_end MUST come AFTER the assistant text/tool
    // of its own turn, not before the next turn's text.
    const trace: string[] = [];
    session.on("text", (t: string) => trace.push(`text:${t}`));
    session.on("tool_call", (name: string) => trace.push(`tool:${name}`));
    session.on("turn_end", () => {
      turnEnds.push(trace.length);
      trace.push("turn_end");
    });

    await session.run();

    // Exactly two turn_end emits — one per while-loop iteration.
    expect(turnEnds).toHaveLength(2);
    // `turn_end` fires AFTER the assistant's text is pushed into history
    // but BEFORE the tool_call for-loop executes — which is fine for the
    // row-ordering contract on the chats.ts side:
    //   - turn_end flushes the accumulated text as its own assistant row
    //   - each subsequent tool_call flushes an (empty) pending and
    //     chatExecutor inserts the tool-call row right after
    // So the persisted order is still text-row → tool-row, matching
    // Claude Code's per-turn rendering. This test pins that sequence.
    expect(trace).toEqual([
      "text:Turn 1 reply",
      "turn_end",
      "tool:Read",
      "text:Turn 2 final",
      "turn_end",
    ]);
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

  it("intercepts AskUserQuestion: emits question_request and routes resolveQuestion answer into tool_result", async () => {
    // Turn 1: agent requests clarification via AskUserQuestion tool_use.
    mockChat.mockResolvedValueOnce({
      text: "",
      rawContent: [
        { type: "tool_use", id: "tq1", name: "AskUserQuestion", input: { question: "Prefer TS or JS?" } },
      ],
      toolCalls: [
        { id: "tq1", name: "AskUserQuestion", input: { question: "Prefer TS or JS?" } },
      ],
      usage: { inputTokens: 5, outputTokens: 3 },
    });
    // Turn 2: after receiving the answer, agent finishes. Snapshot messages
    // at call time — agent-session passes its internal array by reference,
    // so reading mockChat.mock.calls[1][0] later would show the post-run state.
    let turn2Messages: any[] | undefined;
    mockChat.mockImplementationOnce(async (args: any) => {
      turn2Messages = JSON.parse(JSON.stringify(args.messages));
      return {
        text: "Got it — TypeScript.",
        rawContent: "Got it — TypeScript.",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 4 },
      };
    });

    const session = makeSession();
    const gotRequests: any[] = [];
    session.on("question_request", (req: any) => gotRequests.push(req));
    const toolResults: Array<[string, string]> = [];
    session.on("tool_result", (name: string, out: string) => toolResults.push([name, out]));

    const runPromise = session.run();

    // Wait for the question_request event to fire.
    while (gotRequests.length === 0) await new Promise((r) => setImmediate(r));

    const req = gotRequests[0];
    expect(req.question).toBe("Prefer TS or JS?");
    expect(req.toolUseID).toBe("tq1");
    expect(req.requestId).toMatch(/^q-/);

    // pendingQuestionRequests() mirrors pendingPermissionRequests() — accessor works.
    expect(session.pendingQuestionRequests().map((q: any) => q.requestId)).toContain(req.requestId);

    // Resolve from the UI; the pending promise should wake and the agentic
    // loop should emit a tool_result containing the answer text verbatim.
    expect(session.resolveQuestion(req.requestId, "TypeScript")).toBe(true);
    // After resolving, the entry is gone.
    expect(session.pendingQuestionRequests()).toHaveLength(0);

    await runPromise;

    const askResult = toolResults.find(([n]) => n === "AskUserQuestion");
    expect(askResult?.[1]).toBe("TypeScript");

    // Second chat call must have received the answer as a tool_result block
    // against the original toolUseID.
    expect(turn2Messages).toBeDefined();
    const lastMsg = turn2Messages![turn2Messages!.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(Array.isArray(lastMsg.content)).toBe(true);
    expect(lastMsg.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tq1",
      content: "TypeScript",
    });
  });

  it("resolveQuestion returns false for unknown id and for permission-entry ids", async () => {
    mockChat.mockResolvedValueOnce({
      text: "x", rawContent: "x", toolCalls: [], usage: {},
    });
    const session = makeSession();
    await session.run();
    expect(session.resolveQuestion("no-such", "hi")).toBe(false);
    // resolvePermission rejects unknown ids the same way.
    expect(session.resolvePermission("no-such", { behavior: "allow" })).toBe(false);
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
