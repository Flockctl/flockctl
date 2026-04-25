import { getDb } from "../../db/index.js";
import { usageRecords } from "../../db/schema.js";
import { calculateCost } from "../ai/cost.js";
import type { AgentSessionMetrics } from "../agent-session/index.js";

export function inferProvider(model: string): string {
  if (model.includes("claude") || model.includes("haiku") || model.includes("sonnet") || model.includes("opus")) return "anthropic";
  if (model.includes("gpt") || model.includes("o3") || model.includes("o1")) return "openai";
  if (model.includes("gemini")) return "google";
  if (model.includes("mistral") || model.includes("codestral")) return "mistral";
  return "anthropic"; // default — Claude Code SDK
}

export function saveUsage(args: {
  taskId: number;
  projectId: number | null;
  aiProviderKeyId: number | null;
  keyProvider: string | null;
  model: string;
  metrics: AgentSessionMetrics;
}): void {
  const { taskId, projectId, aiProviderKeyId, keyProvider, model, metrics } = args;
  const db = getDb();
  // Provider resolution order:
  //   1) Flat-rate subscription keys (`claude_cli`, `github_copilot`) are
  //      authoritative — they override the per-token API tariff implied by
  //      the model name, because the subscription price stands regardless of
  //      which model the task actually invoked.
  //   2) Otherwise (BYO API key providers, or no key at all) fall back to
  //      `inferProvider(model)` so a cross-provider model name like
  //      `gpt-4o-mini` attached to an Anthropic-labeled key still reports
  //      cost under `openai`.
  //
  // Without (1), a Copilot task on `claude-opus-4.7` would be priced as if
  // it had gone straight to the Anthropic API ($5/$25 per 1M tokens) instead
  // of against the flat-rate Copilot subscription.
  const FLAT_RATE_PROVIDERS = new Set(["claude_cli", "github_copilot"]);
  const provider = keyProvider && FLAT_RATE_PROVIDERS.has(keyProvider)
    ? keyProvider
    : inferProvider(model);
  const cost = calculateCost(
    provider, model,
    metrics.inputTokens, metrics.outputTokens,
    metrics.cacheCreationInputTokens, metrics.cacheReadInputTokens,
  );
  try {
    db.insert(usageRecords).values({
      taskId,
      projectId,
      aiProviderKeyId,
      provider,
      model,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      cacheCreationInputTokens: metrics.cacheCreationInputTokens,
      cacheReadInputTokens: metrics.cacheReadInputTokens,
      totalCostUsd: cost,
    }).run();
  } catch (err) {
    console.error("Failed to save usage record:", err instanceof Error ? err.message : String(err));
  }
}
