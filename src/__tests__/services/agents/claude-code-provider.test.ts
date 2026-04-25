import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock underlying modules so we don't actually call Claude SDK.
vi.mock("../../../services/ai/client", () => ({
  createAIClient: vi.fn(() => ({
    chat: vi.fn(async () => ({ text: "hello", usage: { inputTokens: 10, outputTokens: 5 } })),
  })),
}));

vi.mock("../../../services/claude/cli", () => ({
  CLAUDE_CODE_MODELS: [
    { id: "claude-opus-4-7", name: "Claude Opus 4.7", contextWindow: 200_000, maxTokens: 128_000 },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200_000, maxTokens: 64_000 },
  ],
  streamViaClaudeAgentSDK: vi.fn(async function* () {
    yield { type: "text", text: "chunk" };
    yield { type: "done", sessionId: "sess-1", usage: { inputTokens: 1, outputTokens: 2, totalCostUsd: 0 } };
  }),
  renameClaudeSession: vi.fn(async () => {}),
  isClaudeBinaryPresent: vi.fn(() => true),
  isClaudeCodeAuthed: vi.fn(() => true),
  isClaudeCodeReady: vi.fn(() => true),
  clearReadinessCache: vi.fn(),
}));

import { ClaudeCodeProvider } from "../../../services/agents/claude-code/provider.js";
import { createAIClient } from "../../../services/ai/client.js";
import { streamViaClaudeAgentSDK, renameClaudeSession } from "../../../services/claude/cli.js";

describe("ClaudeCodeProvider", () => {
  let provider: ClaudeCodeProvider;

  beforeEach(() => {
    provider = new ClaudeCodeProvider();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("has id claude-code and display name", () => {
    expect(provider.id).toBe("claude-code");
    expect(provider.displayName).toBe("Claude Code");
  });

  it("listModels exposes CLAUDE_CODE_MODELS", () => {
    const models = provider.listModels();
    expect(models.length).toBeGreaterThanOrEqual(2);
    expect(models[0].id).toBe("claude-opus-4-7");
    expect(models[0].contextWindow).toBe(200_000);
  });

  it("checkReadiness delegates to claude-cli helpers", () => {
    expect(provider.checkReadiness()).toEqual({
      installed: true,
      authenticated: true,
      ready: true,
    });
  });

  it("chat delegates to createAIClient.chat", async () => {
    const result = await provider.chat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.text).toBe("hello");
    expect(createAIClient).toHaveBeenCalled();
  });

  it("streamChat delegates to streamViaClaudeAgentSDK and yields events", async () => {
    const events: any[] = [];
    for await (const ev of provider.streamChat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(ev);
    }
    expect(events[0].type).toBe("text");
    expect(events[1].type).toBe("done");
    expect(streamViaClaudeAgentSDK).toHaveBeenCalled();
  });

  it("chat forwards mcpServers down to createAIClient.chat", async () => {
    const chatSpy = vi.fn(async () => ({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 } }));
    (createAIClient as any).mockReturnValueOnce({ chat: chatSpy });
    const mcpServers = { albs: { command: "/bin/albs-mcp" } };
    await provider.chat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      mcpServers,
    });
    expect(chatSpy).toHaveBeenCalledTimes(1);
    const chatArg = (chatSpy.mock.calls as any[])[0][0];
    expect(chatArg.mcpServers).toEqual(mcpServers);
  });

  it("streamChat forwards mcpServers down to streamViaClaudeAgentSDK", async () => {
    const mcpServers = { albs: { command: "/bin/albs-mcp" } };
    const iter = provider.streamChat({
      model: "claude-sonnet-4-6",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      mcpServers,
    });
    // drain
    for await (const _ of iter) { void _; }
    expect(streamViaClaudeAgentSDK).toHaveBeenCalled();
    const arg = (streamViaClaudeAgentSDK as any).mock.calls[0][0];
    expect(arg.mcpServers).toEqual(mcpServers);
  });

  it("estimateCost reports the Anthropic-API-equivalent cost for claude_cli (subscription shadow-pricing)", () => {
    const cost = provider.estimateCost("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    // anthropic/claude-sonnet-4-6: 3 input + 15 output per 1M tokens
    // → 1M input ($3) + 0.5M output ($7.5) = $10.5
    expect(cost).toBeCloseTo(10.5, 4);
  });

  it("renameSession delegates to renameClaudeSession", async () => {
    await provider.renameSession("sess-1", "New Title");
    expect(renameClaudeSession).toHaveBeenCalledWith("sess-1", "New Title");
  });
});
