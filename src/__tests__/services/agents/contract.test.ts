import { describe, it, expect, beforeEach } from "vitest";
import { listAgents, resetRegistry, getAgent } from "../../../services/agents/registry.js";
import type { AgentProvider } from "../../../services/agents/types.js";

/**
 * Contract tests: any provider registered in the registry must satisfy
 * these shape invariants. Acts as a safety net for future adapters.
 */

function runContract(name: string, load: () => AgentProvider) {
  describe(`AgentProvider contract: ${name}`, () => {
    it("has stable id and display name", () => {
      const provider = load();
      expect(provider.id).toBeTruthy();
      expect(typeof provider.id).toBe("string");
      expect(provider.displayName).toBeTruthy();
      expect(typeof provider.displayName).toBe("string");
    });

    it("lists at least one model", () => {
      const provider = load();
      const models = provider.listModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) {
        expect(m.id).toBeTruthy();
        expect(m.name).toBeTruthy();
      }
    });

    it("checkReadiness returns the expected shape", () => {
      const provider = load();
      const readiness = provider.checkReadiness();
      expect(typeof readiness.installed).toBe("boolean");
      expect(typeof readiness.authenticated).toBe("boolean");
      expect(typeof readiness.ready).toBe("boolean");
    });

    it("estimateCost returns a number or null", () => {
      const provider = load();
      const model = provider.listModels()[0].id;
      const cost = provider.estimateCost(model, { inputTokens: 100, outputTokens: 50 });
      expect(cost === null || typeof cost === "number").toBe(true);
    });

    it("exposes chat and streamChat callable members", () => {
      const provider = load();
      expect(typeof provider.chat).toBe("function");
      expect(typeof provider.streamChat).toBe("function");
    });
  });
}

describe("AgentProvider contract suite", () => {
  beforeEach(() => {
    resetRegistry();
  });

  // Run contract against the default built-in provider.
  runContract("claude-code (built-in)", () => getAgent("claude-code"));

  // Run contract against every registered provider (future-proofing).
  it("all registered providers satisfy the contract shape", () => {
    const providers = listAgents();
    expect(providers.length).toBeGreaterThan(0);
    for (const p of providers) {
      expect(p.id).toBeTruthy();
      expect(typeof p.chat).toBe("function");
      expect(typeof p.streamChat).toBe("function");
      expect(typeof p.listModels).toBe("function");
      expect(typeof p.checkReadiness).toBe("function");
      expect(typeof p.estimateCost).toBe("function");
    }
  });
});
