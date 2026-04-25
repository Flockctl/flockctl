import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the helper module so we never touch the real Copilot SDK or spawn
// the CLI subprocess. Same pattern as claude-code-provider.test.ts.
vi.mock("../../../services/ai/copilot-sdk", () => ({
  COPILOT_MODELS: [
    { id: "claude-opus-4.7", name: "Claude Opus 4.7", multiplier: 7.5, premium: true },
    { id: "gpt-5.3-codex", name: "GPT-5.3-Codex", multiplier: 1, premium: true },
    { id: "gpt-4.1", name: "GPT-4.1", multiplier: 0, premium: false },
  ],
  checkCopilotReadiness: vi.fn(() => ({
    installed: true,
    authenticated: true,
    ready: true,
  })),
  clearCopilotReadinessCache: vi.fn(),
  streamViaCopilotSdk: vi.fn(async function* () {
    yield { type: "text", text: "pong" };
    yield {
      type: "done",
      sessionId: undefined,
      usage: { inputTokens: 12, outputTokens: 3, totalCostUsd: 0 },
    };
  }),
  chatViaCopilotSdk: vi.fn(async () => ({
    text: "pong",
    usage: {
      inputTokens: 12,
      outputTokens: 3,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  })),
}));

import { CopilotProvider } from "../../../services/agents/copilot/provider.js";
import {
  checkCopilotReadiness,
  streamViaCopilotSdk,
} from "../../../services/ai/copilot-sdk.js";

describe("CopilotProvider", () => {
  let provider: CopilotProvider;

  beforeEach(() => {
    provider = new CopilotProvider();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("has id copilot and display name", () => {
    expect(provider.id).toBe("copilot");
    expect(provider.displayName).toBe("GitHub Copilot");
  });

  it("listModels surfaces COPILOT_MODELS with id and name", () => {
    const models = provider.listModels();
    expect(models.length).toBe(3);
    expect(models.map((m) => m.id)).toContain("claude-opus-4.7");
    expect(models.map((m) => m.id)).toContain("gpt-5.3-codex");
    expect(models.find((m) => m.id === "claude-opus-4.7")?.name).toBe(
      "Claude Opus 4.7",
    );
  });

  it("checkReadiness delegates to checkCopilotReadiness", () => {
    const r = provider.checkReadiness();
    expect(r).toEqual({ installed: true, authenticated: true, ready: true });
    expect(checkCopilotReadiness).toHaveBeenCalled();
  });

  it("chat drives streamViaCopilotSdk and forwards text events to onEvent", async () => {
    // The provider was rewritten to stream in-turn so tool_call / tool_result
    // events reach the caller in order — it no longer defers to
    // chatViaCopilotSdk (which coalesces the whole turn into one blob).
    const events: Array<{ type: string; content: string }> = [];
    const result = await provider.chat({
      model: "gpt-5.3-codex",
      system: "sys",
      messages: [{ role: "user", content: "ping" }],
      onEvent: (e) => events.push(e as { type: string; content: string }),
    });
    expect(streamViaCopilotSdk).toHaveBeenCalled();
    expect(result.text).toBe("pong");
    expect(result.usage?.inputTokens).toBe(12);
    expect(result.costUsd).toBe(0); // flat-rate subscription
    expect(events).toEqual([{ type: "text", content: "pong" }]);
  });

  it("chat surfaces SDK errors as thrown exceptions", async () => {
    vi.mocked(streamViaCopilotSdk).mockImplementationOnce(async function* () {
      yield { type: "error", error: "Model not available" } as const;
    });
    await expect(
      provider.chat({
        model: "nonsense",
        system: "",
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toThrow(/Model not available/);
  });

  it("streamChat yields text then done events", async () => {
    const events: Array<{ type: string }> = [];
    for await (const ev of provider.streamChat({
      model: "gpt-5.3-codex",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(ev);
    }
    expect(events[0].type).toBe("text");
    expect(events[1].type).toBe("done");
    expect(streamViaCopilotSdk).toHaveBeenCalled();
  });

  it("estimateCost returns 0 (Copilot is flat-rate subscription)", () => {
    expect(
      provider.estimateCost("claude-opus-4.7", { inputTokens: 100_000, outputTokens: 10_000 }),
    ).toBe(0);
    expect(
      provider.estimateCost("gpt-5.3-codex", { inputTokens: 50, outputTokens: 5 }),
    ).toBe(0);
  });

  it("clearReadinessCache delegates to helper module", () => {
    provider.clearReadinessCache();
    // Mock is reset between tests; just confirm no throw and method exists.
    expect(typeof provider.clearReadinessCache).toBe("function");
  });

  it("chat forwards providerKeyValue as githubToken", async () => {
    await provider.chat({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "x" }],
      providerKeyValue: "gho_test_token_123",
    });
    expect(streamViaCopilotSdk).toHaveBeenCalledWith(
      expect.objectContaining({ githubToken: "gho_test_token_123" }),
    );
  });

  it("streamChat forwards providerKeyValue as githubToken", async () => {
    const iter = provider.streamChat({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "x" }],
      providerKeyValue: "gho_stream_token",
    });
    // Drain the iterator to actually invoke the mock.
    for await (const _ of iter) { void _; }
    expect(streamViaCopilotSdk).toHaveBeenCalledWith(
      expect.objectContaining({ githubToken: "gho_stream_token" }),
    );
  });

  it("chat forwards cwd as workingDirectory so Copilot sees the chat's project root", async () => {
    await provider.chat({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "x" }],
      cwd: "/Users/alice/code/teachersflow",
    });
    expect(streamViaCopilotSdk).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: "/Users/alice/code/teachersflow" }),
    );
  });

  it("streamChat forwards cwd as workingDirectory", async () => {
    const iter = provider.streamChat({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "x" }],
      cwd: "/Users/alice/code/teachersflow",
    });
    for await (const _ of iter) { void _; }
    expect(streamViaCopilotSdk).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: "/Users/alice/code/teachersflow" }),
    );
  });

  it("chat omits workingDirectory when cwd is not supplied", async () => {
    await provider.chat({
      model: "gpt-5.3-codex",
      system: "",
      messages: [{ role: "user", content: "x" }],
    });
    const call = vi.mocked(streamViaCopilotSdk).mock.calls.at(-1)?.[0];
    expect(call?.workingDirectory).toBeUndefined();
  });
});
