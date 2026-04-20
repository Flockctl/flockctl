import { describe, it, expect, beforeEach } from "vitest";
import {
  registerAgent,
  getAgent,
  listAgents,
  hasAgent,
  unregisterAgent,
  resetRegistry,
} from "../../../services/agents/registry.js";
import type { AgentProvider } from "../../../services/agents/types.js";

function makeFakeProvider(id: string): AgentProvider {
  return {
    id,
    displayName: id,
    listModels: () => [],
    checkReadiness: () => ({ installed: true, authenticated: true, ready: true }),
    chat: async () => ({ text: "" }),
    streamChat: async function* () {},
    estimateCost: () => 0,
  };
}

describe("agents/registry", () => {
  beforeEach(() => {
    resetRegistry();
  });

  it("auto-registers built-in claude-code provider on first access", () => {
    expect(hasAgent("claude-code")).toBe(true);
    const provider = getAgent("claude-code");
    expect(provider.id).toBe("claude-code");
    expect(provider.displayName).toBe("Claude Code");
  });

  it("returns the default provider when no id given", () => {
    const provider = getAgent();
    expect(provider.id).toBe("claude-code");
  });

  it("throws on unknown provider id", () => {
    expect(() => getAgent("does-not-exist")).toThrow(/not registered/);
  });

  it("allows registering a new provider", () => {
    const fake = makeFakeProvider("fake");
    registerAgent(fake);
    expect(hasAgent("fake")).toBe(true);
    expect(getAgent("fake").id).toBe("fake");
  });

  it("supports asDefault to switch the default provider", () => {
    const fake = makeFakeProvider("fake");
    registerAgent(fake, { asDefault: true });
    expect(getAgent().id).toBe("fake");
  });

  it("listAgents returns every registered provider", () => {
    registerAgent(makeFakeProvider("fake-a"));
    registerAgent(makeFakeProvider("fake-b"));
    const ids = listAgents().map((p) => p.id);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("fake-a");
    expect(ids).toContain("fake-b");
  });

  it("unregisterAgent removes provider and resets default if needed", () => {
    const fake = makeFakeProvider("fake");
    registerAgent(fake, { asDefault: true });
    expect(getAgent().id).toBe("fake");
    unregisterAgent("fake");
    expect(hasAgent("fake")).toBe(false);
    // Default falls back to another registered provider
    expect(getAgent().id).toBe("claude-code");
  });

  it("unregisterAgent sets default to null when no providers remain", () => {
    resetRegistry();
    const fake = makeFakeProvider("solo");
    registerAgent(fake, { asDefault: true });
    unregisterAgent("solo");
    // After: no providers; getAgent will trigger ensureBuiltIns and re-register claude-code
    expect(getAgent().id).toBe("claude-code");
  });

  it("unregisterAgent of non-default provider preserves default", () => {
    const a = makeFakeProvider("a");
    const b = makeFakeProvider("b");
    registerAgent(a, { asDefault: true });
    registerAgent(b);
    unregisterAgent("b");
    expect(getAgent().id).toBe("a");
  });
});
