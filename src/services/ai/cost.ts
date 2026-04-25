/** Cost calculation per provider/model */

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cacheCreationPer1M?: number;
  cacheReadPer1M?: number;
}

// Pricing in USD per 1M tokens (approximate, as of 2025)
const PRICING: Record<string, Record<string, ModelPricing>> = {
  anthropic: {
    "claude-opus-4-7": { inputPer1M: 5, outputPer1M: 25, cacheCreationPer1M: 6.25, cacheReadPer1M: 0.5 },
    "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15, cacheCreationPer1M: 3.75, cacheReadPer1M: 0.3 },
    "claude-haiku-4-5": { inputPer1M: 0.8, outputPer1M: 4, cacheCreationPer1M: 1, cacheReadPer1M: 0.08 },
  },
  openai: {
    "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
    "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "gpt-4-turbo": { inputPer1M: 10, outputPer1M: 30 },
    "o3": { inputPer1M: 10, outputPer1M: 40 },
    "o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
  },
  google: {
    "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10 },
    "gemini-2.5-flash": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
  },
  mistral: {
    "mistral-large-latest": { inputPer1M: 2, outputPer1M: 6 },
    "mistral-medium-latest": { inputPer1M: 2.7, outputPer1M: 8.1 },
    "codestral-latest": { inputPer1M: 0.3, outputPer1M: 0.9 },
  },
  // github_copilot is flat-rate — USD cost is always 0. Per-turn premium-request
  // quota is exposed separately via `getCopilotQuotaMultiplier()` below.
  github_copilot: {},
};

// Providers that don't have their own per-token tariff but price-as-if at
// another provider's rate. `claude_cli` runs on Anthropic models under a
// Claude subscription — we still surface a "what would this have cost at the
// Anthropic API" number so subscription users see apples-to-apples usage.
const PROVIDER_ALIASES: Record<string, string> = {
  claude_cli: "anthropic",
};

export function calculateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
): number {
  const providerKey = PROVIDER_ALIASES[provider] ?? provider;
  const providerPricing = PRICING[providerKey];
  if (!providerPricing) return 0;

  // Try exact match first, then partial match
  let pricing = providerPricing[model];
  if (!pricing) {
    const key = Object.keys(providerPricing).find(k => model.includes(k) || k.includes(model));
    if (key) pricing = providerPricing[key];
  }
  if (!pricing) return 0;

  let cost = (inputTokens / 1_000_000) * pricing.inputPer1M
    + (outputTokens / 1_000_000) * pricing.outputPer1M;

  if (cacheCreationTokens > 0 && pricing.cacheCreationPer1M) {
    cost += (cacheCreationTokens / 1_000_000) * pricing.cacheCreationPer1M;
  }
  if (cacheReadTokens > 0 && pricing.cacheReadPer1M) {
    cost += (cacheReadTokens / 1_000_000) * pricing.cacheReadPer1M;
  }

  return Math.round(cost * 1_000_000) / 1_000_000; // 6 decimal places
}

/**
 * Premium-request quota multiplier for a GitHub Copilot model.
 *
 * Mirrors `COPILOT_MODELS[*].multiplier` from `copilot-sdk.ts` — duplicated
 * here so `cost.ts` stays free of the heavier copilot-sdk dependency chain
 * (execSync, dynamic SDK import). Keep the two lists in sync when adding a
 * new model.
 *
 * Returns 1 for unknown models — matches GitHub's default billing when a
 * model id isn't on the known list. Returns 0 for free-tier models, which
 * the UI uses to suppress the quota badge.
 */
const COPILOT_QUOTA_MULTIPLIERS: Record<string, number> = {
  "claude-opus-4.7": 7.5,
  "claude-sonnet-4.6": 1,
  "claude-sonnet-4.5": 1,
  "claude-haiku-4.5": 0.33,
  "gpt-5.4": 1,
  "gpt-5.3-codex": 1,
  "gpt-5.2-codex": 1,
  "gpt-5.2": 1,
  "gpt-5.4-mini": 0.33,
  "gpt-5-mini": 0,
  "gpt-4.1": 0,
};

export function getCopilotQuotaMultiplier(model: string): number {
  return COPILOT_QUOTA_MULTIPLIERS[model] ?? 1;
}
