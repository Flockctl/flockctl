import { describe, it, expect } from "vitest";
import { calculateCost, getCopilotQuotaMultiplier } from "../../services/ai/cost.js";

describe("Cost calculation", () => {
  it("calculates Anthropic Claude Opus cost", () => {
    const cost = calculateCost("anthropic", "claude-opus-4-7", 1_000_000, 1_000_000);
    expect(cost).toBe(30); // 5 input + 25 output
  });

  it("calculates with cache tokens", () => {
    const cost = calculateCost("anthropic", "claude-opus-4-7", 500_000, 200_000, 100_000, 300_000);
    // 500k input: 2.5 + 200k output: 5 + 100k cache creation: 0.625 + 300k cache read: 0.15
    expect(cost).toBeCloseTo(8.275, 3);
  });

  it("returns 0 for unknown provider", () => {
    const cost = calculateCost("unknown", "model", 1000, 1000);
    expect(cost).toBe(0);
  });

  it("aliases claude_cli to Anthropic pricing (subscription shown as would-have-cost)", () => {
    const cost = calculateCost("claude_cli", "claude-opus-4-7", 1_000_000, 1_000_000);
    expect(cost).toBe(30); // same as anthropic/claude-opus-4-7
  });

  it("returns 0 for github_copilot (flat-rate subscription) on opus", () => {
    const cost = calculateCost("github_copilot", "claude-opus-4.7", 1_000_000, 1_000_000);
    expect(cost).toBe(0);
  });

  it("returns 0 for github_copilot on gpt-5.3-codex", () => {
    const cost = calculateCost("github_copilot", "gpt-5.3-codex", 1_000_000, 1_000_000);
    expect(cost).toBe(0);
  });

  it("exposes premium-request multiplier for Copilot models", () => {
    expect(getCopilotQuotaMultiplier("claude-opus-4.7")).toBe(7.5);
    expect(getCopilotQuotaMultiplier("claude-sonnet-4.6")).toBe(1);
    expect(getCopilotQuotaMultiplier("claude-haiku-4.5")).toBeCloseTo(0.33);
    expect(getCopilotQuotaMultiplier("gpt-4.1")).toBe(0);
    expect(getCopilotQuotaMultiplier("unknown-model")).toBe(1);
  });

  it("calculates OpenAI GPT-4o cost", () => {
    const cost = calculateCost("openai", "gpt-4o", 1_000_000, 1_000_000);
    expect(cost).toBe(12.5); // 2.5 input + 10 output
  });

  it("calculates Google Gemini cost", () => {
    const cost = calculateCost("google", "gemini-2.5-pro", 1_000_000, 1_000_000);
    expect(cost).toBe(11.25); // 1.25 input + 10 output
  });
});
