// ─── Production SupervisorLLM adapter ───
//
// Bridges `SupervisorService` (which speaks the narrow `SupervisorLLM`
// interface) to the same Claude Agent SDK seam that powers task / chat
// executors (`createAIClient` in `src/services/ai/client.ts`). The
// supervisor's `complete(prompt)` becomes one non-streaming SDK round-trip
// with `noTools` and adaptive thinking disabled — everything the supervisor
// needs is the model's strict JSON reply and the post-call usage delta, no
// tool side-effects, no thinking tax.
//
// Design notes:
//
//   • Model is fixed at `claude-sonnet-4-6`. Haiku struggles with structured-
//     JSON discriminated unions (the supervisor's output schema), and opus
//     eats per-mission budget alarmingly fast on long-running missions
//     (heartbeats fire every 15 minutes). Sonnet is the sweet spot for the
//     "look at this small payload, decide one of two things" workload.
//
//   • System prompt is empty. `buildSupervisorPrompt` already encodes the
//     full role + DATA-fence contract in the user message; injecting a
//     system prompt here would just race for budget tokens with the prompt
//     builder's content.
//
//   • `cost.cents` rounds `costUsd * 100` to the nearest integer. The
//     `SupervisorLLMCost` interface requires integer cents (`BudgetEnforcer`
//     stores them in an INTEGER column). A 0.5¢ round-up is acceptable
//     drift over thousands of evaluations — much smaller than the per-call
//     model-pricing variance.
//
//   • `cost.tokens` sums input + output, matching what the supervisor budget
//     enforcer sees on every increment. Cache-creation / cache-read tokens
//     are intentionally NOT included in the supervisor's tokens metric —
//     they're already priced into `costUsd` and would double-count if
//     rolled into the integer token budget.
//
//   • Constructor takes the `AIClient` as an injectable parameter (default
//     = `createAIClient()`). Unit tests substitute a fake `AIClient` so the
//     adapter contract can be pinned without an actual Anthropic round-trip
//     — same DI pattern `SupervisorService` uses for its `SupervisorLLM`
//     seam.

import type { AIClient } from "../ai/client.js";
import { createAIClient } from "../ai/client.js";
import type { SupervisorLLM, SupervisorLLMReply } from "./supervisor.js";

/**
 * Default model used by the production supervisor. Exported so tests can
 * pin the literal in assertions instead of duplicating the string.
 */
export const SUPERVISOR_MODEL = "claude-sonnet-4-6";

/**
 * Session label written to the Claude Code UI when the supervisor's SDK
 * session is renamed (see `client.ts` §"Tag session with [FLOCKCTL] prefix").
 * Pinned as a const so the label is stable across tests + production.
 */
export const SUPERVISOR_SESSION_LABEL = "Mission supervisor";

/**
 * Production-wired `SupervisorLLM`. Wraps `AIClient.chat()` and reshapes the
 * streaming `ChatResult` into the integer-cost envelope the supervisor
 * pipeline expects.
 */
export class ClaudeSupervisorLLM implements SupervisorLLM {
  private readonly client: AIClient;

  /**
   * @param client Optional AIClient override. Defaults to a fresh
   *   `createAIClient()` so production code can `new ClaudeSupervisorLLM()`
   *   without ceremony; tests pass a fake to drive the adapter without
   *   spinning up the SDK.
   */
  constructor(client: AIClient = createAIClient()) {
    this.client = client;
  }

  async complete(prompt: string): Promise<SupervisorLLMReply> {
    const result = await this.client.chat({
      model: SUPERVISOR_MODEL,
      system: "",
      messages: [{ role: "user", content: prompt }],
      noTools: true,
      thinkingEnabled: false,
      sessionLabel: SUPERVISOR_SESSION_LABEL,
    });

    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;
    const usd = result.costUsd ?? 0;

    return {
      text: result.text,
      cost: {
        tokens: inputTokens + outputTokens,
        cents: Math.round(usd * 100),
      },
    };
  }
}
