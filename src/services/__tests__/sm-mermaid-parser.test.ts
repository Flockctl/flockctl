/**
 * Mermaid `stateDiagram-v2` subset parser — fixtures + negative cases.
 *
 * The three fixtures intentionally mirror the YAML fixtures under
 * `fixtures/sm/` so we can assert that mermaid is a faithful alternate
 * input format for the *same* three realistic domains (form wizard,
 * task lifecycle, payment retry).
 *
 * Every fixture must:
 *   1. parse cleanly (`parseMermaidStateDiagram.ok === true`)
 *   2. pass the shared semantic validator with zero findings
 *   3. expose the expected states / initial / final
 *
 * Malformed documents are checked at the bottom to exercise the error
 * path.
 */

import { describe, it, expect } from "vitest";
import { parseMermaidStateDiagram } from "../state-machines/sm-mermaid-parser";
import { validateStateMachine } from "../state-machines/sm-parser";

interface Fixture {
  name: string;
  mermaid: string;
  expectedInitial: string;
  expectedFinal: string[];
  expectedStates: string[];
  expectedTransitionCount: number;
}

const FIXTURES: Fixture[] = [
  {
    name: "task-lifecycle",
    mermaid: `
stateDiagram-v2
  %% Background task lifecycle.
  [*] --> pending
  pending --> running : start
  pending --> cancelled : cancel
  running --> completed : finish
  running --> failed : error
  running --> cancelled : cancel
  completed --> [*]
  failed --> [*]
  cancelled --> [*]
`,
    expectedInitial: "pending",
    expectedFinal: ["completed", "failed", "cancelled"],
    expectedStates: [
      "pending",
      "running",
      "cancelled",
      "completed",
      "failed",
    ],
    expectedTransitionCount: 5,
  },
  {
    name: "form-wizard",
    mermaid: `
stateDiagram-v2
  [*] --> draft
  draft --> fill : begin
  fill --> review : next
  review --> fill : back
  review --> submitted : submit
  draft --> cancelled : cancel
  fill --> cancelled : cancel
  review --> cancelled : cancel
  submitted --> [*]
  cancelled --> [*]
`,
    expectedInitial: "draft",
    expectedFinal: ["submitted", "cancelled"],
    expectedStates: ["draft", "fill", "review", "submitted", "cancelled"],
    expectedTransitionCount: 7,
  },
  {
    name: "payment-retry",
    mermaid: `
stateDiagram-v2
  [*] --> pending
  pending --> processing : charge
  processing --> success : approved
  processing --> retry : transient_error
  processing --> failed : declined
  retry --> processing : reattempt
  retry --> failed : give_up
  success --> [*]
  failed --> [*]
`,
    expectedInitial: "pending",
    expectedFinal: ["success", "failed"],
    expectedStates: ["pending", "processing", "success", "retry", "failed"],
    expectedTransitionCount: 6,
  },
];

describe("parseMermaidStateDiagram — entity fixtures", () => {
  for (const fx of FIXTURES) {
    describe(fx.name, () => {
      it("parses cleanly", () => {
        const r = parseMermaidStateDiagram(fx.mermaid);
        expect(r.ok).toBe(true);
      });

      it("passes the shared semantic validator with zero findings", () => {
        const r = parseMermaidStateDiagram(fx.mermaid);
        if (!r.ok) throw new Error("fixture failed to parse");
        expect(validateStateMachine(r.value)).toEqual([]);
      });

      it("exposes the expected shape", () => {
        const r = parseMermaidStateDiagram(fx.mermaid);
        if (!r.ok) throw new Error("fixture failed to parse");
        expect(r.value.initial).toBe(fx.expectedInitial);
        expect(r.value.final).toEqual(fx.expectedFinal);
        expect(new Set(r.value.states)).toEqual(new Set(fx.expectedStates));
        expect(r.value.transitions).toHaveLength(fx.expectedTransitionCount);
      });

      it("preserves first-appearance state order", () => {
        const r = parseMermaidStateDiagram(fx.mermaid);
        if (!r.ok) throw new Error("fixture failed to parse");
        expect(r.value.states).toEqual(fx.expectedStates);
      });
    });
  }
});

describe("parseMermaidStateDiagram — optional header / comments / whitespace", () => {
  it("accepts a missing header", () => {
    const r = parseMermaidStateDiagram(`
[*] --> a
a --> b : go
b --> [*]
`);
    expect(r.ok).toBe(true);
  });

  it("ignores %% comments and blank lines", () => {
    const r = parseMermaidStateDiagram(`
stateDiagram-v2
  %% leading comment
  [*] --> a

  a --> b : go %% trailing comment

  b --> [*]
`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.transitions).toEqual([{ from: "a", to: "b", event: "go" }]);
      expect(r.value.final).toEqual(["b"]);
    }
  });

  it("allows stateDiagram (without -v2) as an alias", () => {
    const r = parseMermaidStateDiagram(`
stateDiagram
  [*] --> a
  a --> [*]
`);
    expect(r.ok).toBe(true);
  });
});

describe("parseMermaidStateDiagram — malformed input is caught", () => {
  it("flags a missing initial declaration", () => {
    const r = parseMermaidStateDiagram(`
stateDiagram-v2
  a --> b : go
  b --> [*]
`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.errors.some((e) =>
          e.message.includes("missing initial state declaration"),
        ),
      ).toBe(true);
    }
  });

  it("flags a transition without an event label", () => {
    const r = parseMermaidStateDiagram(`
stateDiagram-v2
  [*] --> a
  a --> b
  b --> [*]
`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const found = r.errors.find((e) =>
        e.message.includes("missing an event label"),
      );
      expect(found).toBeDefined();
      // The fixture has a leading blank line, so `a --> b` sits on line 4.
      expect(found!.line).toBe(4);
    }
  });

  it("flags an empty event label after ':'", () => {
    const r = parseMermaidStateDiagram(`
stateDiagram-v2
  [*] --> a
  a --> b :
  b --> [*]
`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.errors.some((e) =>
          e.message.includes("event label after ':' is empty"),
        ),
      ).toBe(true);
    }
  });

  it("flags a line without an arrow", () => {
    const r = parseMermaidStateDiagram(`
stateDiagram-v2
  [*] --> a
  totally-not-a-transition
  a --> [*]
`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.errors.some((e) => e.message.includes("expected transition")),
      ).toBe(true);
    }
  });

  it("flags multiple initial declarations pointing at different states", () => {
    const r = parseMermaidStateDiagram(`
stateDiagram-v2
  [*] --> a
  [*] --> b
  a --> [*]
`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.errors.some((e) =>
          e.message.includes("multiple initial states declared"),
        ),
      ).toBe(true);
    }
  });

  it("flags invalid state name tokens", () => {
    const r = parseMermaidStateDiagram(`
stateDiagram-v2
  [*] --> 1badname
  1badname --> [*]
`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.errors.some((e) => e.message.includes("invalid state name")),
      ).toBe(true);
    }
  });

  it("flags a degenerate '[*] --> [*]'", () => {
    const r = parseMermaidStateDiagram(`
stateDiagram-v2
  [*] --> [*]
`);
    expect(r.ok).toBe(false);
  });

  it("attaches a 1-based line number to row-level errors", () => {
    const r = parseMermaidStateDiagram(`stateDiagram-v2
[*] --> a
a --> b
b --> [*]`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const missing = r.errors.find((e) =>
        e.message.includes("missing an event label"),
      );
      expect(missing).toBeDefined();
      expect(missing!.line).toBe(3);
    }
  });
});
