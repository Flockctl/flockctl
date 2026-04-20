import { describe, it, expect } from "vitest";
import { calculateCost } from "../../services/cost.js";

describe("Cost calculation", () => {
  it("calculates Anthropic Claude Opus cost", () => {
    const cost = calculateCost("anthropic", "claude-opus-4-7", 1_000_000, 1_000_000);
    expect(cost).toBe(90); // 15 input + 75 output
  });

  it("calculates with cache tokens", () => {
    const cost = calculateCost("anthropic", "claude-opus-4-7", 500_000, 200_000, 100_000, 300_000);
    // 500k input: 7.5 + 200k output: 15 + 100k cache creation: 1.875 + 300k cache read: 0.45
    expect(cost).toBeCloseTo(24.825, 3);
  });

  it("returns 0 for unknown provider", () => {
    const cost = calculateCost("unknown", "model", 1000, 1000);
    expect(cost).toBe(0);
  });

  it("returns 0 for claude_cli (subscription)", () => {
    const cost = calculateCost("claude_cli", "claude-opus-4-7", 1_000_000, 1_000_000);
    expect(cost).toBe(0);
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
