import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock ai-client so the provider's chat() returns a stub we can inspect —
// same mock strategy the other agent-session suites use. Lets us assert on
// the `system` string the provider would have received.
vi.mock("../../services/ai/client", () => ({
  createAIClient: vi.fn(() => ({ chat: vi.fn() })),
}));

import { AgentSession } from "../../services/agent-session/index.js";
import { createAIClient } from "../../services/ai/client.js";
import {
  matchRegistryForFiles,
  type RegistryEntry,
} from "../../services/state-machines/sm-registry.js";

const mockCreateAIClient = createAIClient as any;

/**
 * Tiny hand-rolled registry — avoids touching the file-system loader so the
 * test focuses on matching + injection behavior, not markdown parsing
 * (which is covered separately). The `order` entity owns `src/order/**`;
 * the `payment` entity owns a pattern that must NOT match in the positive
 * case, giving us a signal that matching is scoped by pattern.
 */
function buildRegistry(): Map<string, RegistryEntry> {
  const order: RegistryEntry = {
    sm: {
      states: ["pending", "paid", "shipped"],
      initial: "pending",
      transitions: [
        { from: "pending", to: "paid", event: "pay" },
        { from: "paid", to: "shipped", event: "ship" },
      ],
    },
    filePatterns: ["src/order/**"],
    sourcePath: "(test)",
    invariants: ["must be paid before shipping"],
  };
  const payment: RegistryEntry = {
    sm: {
      states: ["new", "captured"],
      initial: "new",
      transitions: [{ from: "new", to: "captured", event: "capture" }],
    },
    filePatterns: ["src/payment/**"],
    sourcePath: "(test)",
  };
  const reg = new Map<string, RegistryEntry>();
  reg.set("order", order);
  reg.set("payment", payment);
  return reg;
}

describe("matchRegistryForFiles — pure matcher", () => {
  it("returns the single entity whose glob pattern matches a touched file", () => {
    const registry = buildRegistry();
    const matches = matchRegistryForFiles(
      ["src/order/service.ts"],
      registry,
    );
    expect(matches.map((m) => m.entity)).toEqual(["order"]);
  });

  it("returns no entities when no touched file matches any pattern", () => {
    const registry = buildRegistry();
    const matches = matchRegistryForFiles(
      ["src/unrelated/foo.ts"],
      registry,
    );
    expect(matches).toEqual([]);
  });

  it("is deterministic in registry insertion order when several entities match", () => {
    const registry = buildRegistry();
    const matches = matchRegistryForFiles(
      ["src/payment/handler.ts", "src/order/service.ts"],
      registry,
    );
    // Map insertion order is `order` before `payment`, and the matcher
    // must respect it even when the touched-file list is reversed.
    expect(matches.map((m) => m.entity)).toEqual(["order", "payment"]);
  });

  it("returns empty array when either input is empty", () => {
    const registry = buildRegistry();
    expect(matchRegistryForFiles([], registry)).toEqual([]);
    expect(matchRegistryForFiles(["src/order/x.ts"], new Map())).toEqual([]);
  });
});

describe("AgentSession — sm-registry injection", () => {
  let mockChat: any;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockChat = vi.fn().mockResolvedValue({
      text: "done",
      rawContent: "done",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    mockCreateAIClient.mockReturnValue({ chat: mockChat });
    // Silence the incidents + sm logs for readable test output. Incidents
    // retrieval will warn on missing DB — that's expected noise here.
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("injects '<state_machines>' section when touched files match a registry entry", async () => {
    const session = new AgentSession({
      chatId: 1,
      prompt: "Add shipping support",
      model: "claude-sonnet-4-6",
      codebaseContext: "",
      touchedFiles: ["src/order/service.ts"],
      smRegistry: buildRegistry(),
    });

    await session.run();

    expect(mockChat).toHaveBeenCalledTimes(1);
    const system = mockChat.mock.calls[0][0].system as string;
    expect(system).toContain("<state_machines>");
    expect(system).toContain("State machines in scope: order");
    // Formatted transitions — "from→to (event: x)", joined by ", ".
    expect(system).toContain("Entity: order");
    expect(system).toContain("pending→paid (event: pay)");
    expect(system).toContain("paid→shipped (event: ship)");
    // Invariants are rendered on the same line after a pipe separator.
    expect(system).toContain("Invariants: must be paid before shipping");
    // Only `order` matched — `payment` must not appear.
    expect(system).not.toContain("Entity: payment");
  });

  it("does NOT inject when touched files do not match any registry entry", async () => {
    const session = new AgentSession({
      chatId: 2,
      prompt: "Unrelated work",
      model: "claude-sonnet-4-6",
      codebaseContext: "",
      touchedFiles: ["src/unrelated/foo.ts"],
      smRegistry: buildRegistry(),
    });

    await session.run();

    const system = mockChat.mock.calls[0][0].system as string;
    expect(system).not.toContain("<state_machines>");
    expect(system).not.toContain("State machines in scope");
    expect(system).not.toContain("Entity: order");
  });

  it("does NOT inject when the registry is not provided", async () => {
    const session = new AgentSession({
      chatId: 3,
      prompt: "Anything",
      model: "claude-sonnet-4-6",
      codebaseContext: "",
      touchedFiles: ["src/order/service.ts"],
      // smRegistry intentionally omitted
    });

    await session.run();

    const system = mockChat.mock.calls[0][0].system as string;
    expect(system).not.toContain("<state_machines>");
  });

  it("does NOT inject when touchedFiles is empty or omitted", async () => {
    const session = new AgentSession({
      chatId: 4,
      prompt: "Anything",
      model: "claude-sonnet-4-6",
      codebaseContext: "",
      smRegistry: buildRegistry(),
      // touchedFiles intentionally omitted
    });

    await session.run();

    const system = mockChat.mock.calls[0][0].system as string;
    expect(system).not.toContain("<state_machines>");
  });

  it("injects every matching entity, preserving registry order", async () => {
    const session = new AgentSession({
      taskId: 99,
      prompt: "Cross-cutting change",
      model: "claude-sonnet-4-6",
      codebaseContext: "",
      touchedFiles: ["src/payment/handler.ts", "src/order/service.ts"],
      smRegistry: buildRegistry(),
    });

    await session.run();

    const system = mockChat.mock.calls[0][0].system as string;
    expect(system).toContain("State machines in scope: order, payment");
    expect(system).toContain("Entity: order");
    expect(system).toContain("Entity: payment");
    expect(system).toContain("new→captured (event: capture)");
    // `order` entry is first in the rendered block.
    const orderIdx = system.indexOf("Entity: order");
    const paymentIdx = system.indexOf("Entity: payment");
    expect(orderIdx).toBeLessThan(paymentIdx);
  });
});
