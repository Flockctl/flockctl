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
    "claude-opus-4-7": { inputPer1M: 15, outputPer1M: 75, cacheCreationPer1M: 18.75, cacheReadPer1M: 1.5 },
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
  claude_cli: {
    // Zero cost — covered by subscription
    "claude-opus-4-7": { inputPer1M: 0, outputPer1M: 0 },
    "claude-sonnet-4-6": { inputPer1M: 0, outputPer1M: 0 },
    "claude-haiku-4-5": { inputPer1M: 0, outputPer1M: 0 },
  },
};

export function calculateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
): number {
  const providerPricing = PRICING[provider];
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
