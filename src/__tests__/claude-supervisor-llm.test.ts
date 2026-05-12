// ─── ClaudeSupervisorLLM (production SupervisorLLM adapter) ───
//
// Unit-tests the adapter that bridges `SupervisorService` to the Claude
// Agent SDK seam (`AIClient.chat`). The adapter has no DB, no network — it
// reshapes one `ChatResult` into one `SupervisorLLMReply`. Tests inject a
// fake `AIClient` so the contract can be pinned without a real Anthropic
// round-trip; mirrors the DI pattern used in `supervisor-evaluate.test.ts`
// where `SupervisorLLM` is the swap-able boundary.
//
// Coverage:
//   • prompt → single `{role: 'user'}` message in the chat options
//   • fixed config (model, system='', noTools, thinkingEnabled=false,
//     sessionLabel) is forwarded verbatim
//   • result.text round-trips to reply.text
//   • cost.tokens = inputTokens + outputTokens (cache tokens NOT included —
//     they're already priced into costUsd)
//   • cost.cents = Math.round(costUsd * 100)
//   • missing `usage` defaults to zero tokens
//   • missing `costUsd` defaults to zero cents

import { describe, expect, it, vi } from "vitest";
import type { AIClient } from "../services/ai/client.js";
import {
  ClaudeSupervisorLLM,
  SUPERVISOR_MODEL,
  SUPERVISOR_SESSION_LABEL,
} from "../services/missions/claude-supervisor-llm.js";

interface FakeChatResult {
  text?: string;
  costUsd?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
}

function makeFakeClient(result: FakeChatResult): {
  client: AIClient;
  chat: ReturnType<typeof vi.fn>;
} {
  const chat = vi.fn(async () => ({
    text: result.text ?? "",
    costUsd: result.costUsd,
    usage: result.usage,
  }));
  return { client: { chat } as unknown as AIClient, chat };
}

describe("ClaudeSupervisorLLM", () => {
  it("forwards the prompt as a single user-role message", async () => {
    const { client, chat } = makeFakeClient({ text: "{}" });
    const llm = new ClaudeSupervisorLLM(client);

    await llm.complete("PROMPT BODY");

    expect(chat).toHaveBeenCalledOnce();
    const opts = chat.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.messages).toEqual([{ role: "user", content: "PROMPT BODY" }]);
  });

  it("pins production config (model, empty system, noTools, no thinking, session label)", async () => {
    const { client, chat } = makeFakeClient({ text: "{}" });
    const llm = new ClaudeSupervisorLLM(client);

    await llm.complete("PROMPT");

    const opts = chat.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.model).toBe(SUPERVISOR_MODEL);
    expect(opts.system).toBe("");
    expect(opts.noTools).toBe(true);
    expect(opts.thinkingEnabled).toBe(false);
    expect(opts.sessionLabel).toBe(SUPERVISOR_SESSION_LABEL);
  });

  it("returns the model's raw text verbatim (caller owns JSON parsing)", async () => {
    const { client } = makeFakeClient({ text: '{"kind":"no_action","rationale":"…"}' });
    const llm = new ClaudeSupervisorLLM(client);

    const reply = await llm.complete("PROMPT");

    expect(reply.text).toBe('{"kind":"no_action","rationale":"…"}');
  });

  it("sums tokens (input + output only — cache tokens not counted)", async () => {
    const { client } = makeFakeClient({
      text: "{}",
      usage: {
        inputTokens: 100,
        outputTokens: 200,
        cacheCreationInputTokens: 50,
        cacheReadInputTokens: 75,
      },
    });
    const llm = new ClaudeSupervisorLLM(client);

    const reply = await llm.complete("PROMPT");

    // 100 + 200 only — cache tokens are already priced into costUsd and
    // would double-count if rolled into the integer token budget.
    expect(reply.cost.tokens).toBe(300);
  });

  it("rounds costUsd to integer cents", async () => {
    // 0.0123 USD → 1.23¢ → Math.round → 1¢
    const cheap = makeFakeClient({ text: "{}", costUsd: 0.0123 });
    const reply1 = await new ClaudeSupervisorLLM(cheap.client).complete("p");
    expect(reply1.cost.cents).toBe(1);

    // 0.0156 USD → 1.56¢ → Math.round → 2¢
    const mid = makeFakeClient({ text: "{}", costUsd: 0.0156 });
    const reply2 = await new ClaudeSupervisorLLM(mid.client).complete("p");
    expect(reply2.cost.cents).toBe(2);

    // 1.5 USD → 150¢ exactly — confirms no floating-point drift on whole values
    const expensive = makeFakeClient({ text: "{}", costUsd: 1.5 });
    const reply3 = await new ClaudeSupervisorLLM(expensive.client).complete("p");
    expect(reply3.cost.cents).toBe(150);
  });

  it("defaults missing usage to zero tokens", async () => {
    const { client } = makeFakeClient({ text: "{}" });
    const llm = new ClaudeSupervisorLLM(client);

    const reply = await llm.complete("PROMPT");

    expect(reply.cost.tokens).toBe(0);
  });

  it("defaults missing costUsd to zero cents", async () => {
    const { client } = makeFakeClient({
      text: "{}",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    });
    const llm = new ClaudeSupervisorLLM(client);

    const reply = await llm.complete("PROMPT");

    expect(reply.cost.cents).toBe(0);
    expect(reply.cost.tokens).toBe(30); // sanity: usage still reaches the reply
  });
});
