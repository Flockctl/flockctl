/**
 * Branch-coverage tests for src/services/state-machines/sm-mermaid-parser.ts.
 *
 * Targets remaining uncovered if-branches the existing fixture-driven suite
 * (src/services/__tests__/sm-mermaid-parser.test.ts) misses:
 *
 *   - Empty LHS of `-->` (source blank).
 *   - Empty RHS of `-->` (nothing after the arrow at all).
 *   - Empty target after `:` split (e.g. `:ev` with no state).
 *   - Initial declaration `[*] --> a : ev` with a stray event label.
 *   - Final declaration `a --> [*] : ev` with a stray event label.
 *   - Duplicate final declaration for the same state (second `--> [*]` is
 *     de-duped by the `finalSet.has` guard).
 *   - Normal transition with invalid LHS and invalid RHS state names.
 */
import { describe, it, expect } from "vitest";
import { parseMermaidStateDiagram } from "../../../services/state-machines/sm-mermaid-parser.js";

describe("parseMermaidStateDiagram — remaining branches", () => {
  it("flags a transition with an empty source (left is blank)", () => {
    const r = parseMermaidStateDiagram(`
stateDiagram-v2
[*] --> a
 --> b : go
a --> [*]
`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.message.includes("transition source is empty"))).toBe(true);
    }
  });

  it("flags a transition with an empty rest (nothing after `-->`)", () => {
    const r = parseMermaidStateDiagram(`
stateDiagram-v2
[*] --> a
a -->
a --> [*]
`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.message.includes("transition target is empty"))).toBe(true);
    }
  });

  it("flags an empty target after `:` event split", () => {
    // `a -->  : go` parses to rest="  : go" → colon split gives right="" after trim.
    const r = parseMermaidStateDiagram(`
stateDiagram-v2
[*] --> a
a -->  : go
a --> [*]
`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.message.includes("transition target is empty"))).toBe(true);
    }
  });

  it("rejects an event label on the initial '[*] --> a' declaration", () => {
    const r = parseMermaidStateDiagram(`
stateDiagram-v2
[*] --> a : start
a --> [*]
`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.errors.some((e) =>
          e.message.includes("initial transition '[*] --> a' must not have an event label"),
        ),
      ).toBe(true);
    }
  });

  it("rejects an event label on the final 'a --> [*]' declaration", () => {
    const r = parseMermaidStateDiagram(`
stateDiagram-v2
[*] --> a
a --> [*] : done
`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.errors.some((e) =>
          e.message.includes("final transition 'a --> [*]' must not have an event label"),
        ),
      ).toBe(true);
    }
  });

  it("dedupes repeated 'a --> [*]' final declarations (finalSet.has guard)", () => {
    const r = parseMermaidStateDiagram(`
stateDiagram-v2
[*] --> a
a --> b : go
b --> [*]
b --> [*]
`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Duplicate final is silently collapsed — no double entry in `final`.
      expect(r.value.final).toEqual(["b"]);
    }
  });

  it("rejects a normal transition with an invalid LHS state name", () => {
    const r = parseMermaidStateDiagram(`
stateDiagram-v2
[*] --> a
1bad --> b : go
a --> [*]
`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.errors.some((e) => e.message === "invalid state name `1bad`"),
      ).toBe(true);
    }
  });

  it("rejects a normal transition with an invalid RHS state name", () => {
    const r = parseMermaidStateDiagram(`
stateDiagram-v2
[*] --> a
a --> 2bad : go
a --> [*]
`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.errors.some((e) => e.message === "invalid state name \`2bad\`"),
      ).toBe(true);
    }
  });
});
