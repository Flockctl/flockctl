import { describe, it, expect } from "vitest";
import {
  type StateMachine,
  validateStateMachine,
  validateInitialInStates,
  validateTransitionFromInStates,
  validateTransitionToInStates,
  validateNoDuplicateTransitions,
  validateFinalStatesHaveNoOutgoing,
  validateReachability,
} from "../state-machines/sm-parser";

/**
 * These tests exercise the semantic validator directly against hand-built
 * `StateMachine` values, bypassing the YAML parser so we can construct shapes
 * the parser itself would already reject (e.g. transitions referencing
 * unknown states) and confirm each rule fires independently.
 */

describe("validateStateMachine — invalid machines (each rule fires)", () => {
  it("catches `initial` not in `states`", () => {
    const sm: StateMachine = {
      states: ["a", "b"],
      initial: "z",
      transitions: [{ from: "a", to: "b", event: "go" }],
    };
    const errs = validateStateMachine(sm);
    const cats = errs.map((e) => e.category);
    expect(cats).toContain("initial-not-in-states");
    const hit = errs.find((e) => e.category === "initial-not-in-states")!;
    expect(hit.severity).toBe("error");
    expect(hit.path).toBe("initial");
  });

  it("catches transitions with unknown `from`", () => {
    const sm: StateMachine = {
      states: ["a", "b"],
      initial: "a",
      transitions: [{ from: "ghost", to: "b", event: "go" }],
    };
    const errs = validateTransitionFromInStates(sm);
    expect(errs).toHaveLength(1);
    expect(errs[0].category).toBe("transition-from-not-in-states");
    expect(errs[0].severity).toBe("error");
    expect(errs[0].path).toBe("transitions[0].from");
  });

  it("catches transitions with unknown `to`", () => {
    const sm: StateMachine = {
      states: ["a", "b"],
      initial: "a",
      transitions: [{ from: "a", to: "ghost", event: "go" }],
    };
    const errs = validateTransitionToInStates(sm);
    expect(errs).toHaveLength(1);
    expect(errs[0].category).toBe("transition-to-not-in-states");
    expect(errs[0].severity).toBe("error");
    expect(errs[0].path).toBe("transitions[0].to");
  });

  it("catches duplicate `(from, event)` pairs", () => {
    const sm: StateMachine = {
      states: ["a", "b", "c"],
      initial: "a",
      transitions: [
        { from: "a", to: "b", event: "go" },
        { from: "a", to: "c", event: "go" }, // duplicate (a, go)
      ],
    };
    const errs = validateNoDuplicateTransitions(sm);
    expect(errs).toHaveLength(1);
    expect(errs[0].category).toBe("duplicate-transition");
    expect(errs[0].severity).toBe("error");
    expect(errs[0].path).toBe("transitions[1]");
  });

  it("catches final states with outgoing transitions", () => {
    const sm: StateMachine = {
      states: ["a", "b"],
      initial: "a",
      transitions: [
        { from: "a", to: "b", event: "go" },
        { from: "b", to: "a", event: "back" }, // b is final but has outgoing
      ],
      final: ["b"],
    };
    const errs = validateFinalStatesHaveNoOutgoing(sm);
    expect(errs).toHaveLength(1);
    expect(errs[0].category).toBe("final-has-outgoing");
    expect(errs[0].severity).toBe("error");
    expect(errs[0].path).toBe("transitions[1]");
  });

  it("flags unreachable states as a warning, not an error", () => {
    const sm: StateMachine = {
      states: ["a", "b", "orphan"],
      initial: "a",
      transitions: [{ from: "a", to: "b", event: "go" }],
    };
    const errs = validateReachability(sm);
    expect(errs).toHaveLength(1);
    expect(errs[0].category).toBe("unreachable-state");
    expect(errs[0].severity).toBe("warning");
    expect(errs[0].path).toBe("states[2]");
    expect(errs[0].message).toMatch(/orphan/);
  });
});

describe("validateStateMachine — valid machines pass clean", () => {
  it("a minimal linear machine with a final state", () => {
    const sm: StateMachine = {
      states: ["idle", "running", "done"],
      initial: "idle",
      transitions: [
        { from: "idle", to: "running", event: "start" },
        { from: "running", to: "done", event: "finish" },
      ],
      final: ["done"],
    };
    expect(validateStateMachine(sm)).toEqual([]);
  });

  it("a cyclic machine with no finals", () => {
    const sm: StateMachine = {
      states: ["a", "b", "c"],
      initial: "a",
      transitions: [
        { from: "a", to: "b", event: "next" },
        { from: "b", to: "c", event: "next" },
        { from: "c", to: "a", event: "reset" },
      ],
    };
    expect(validateStateMachine(sm)).toEqual([]);
  });

  it("a branching machine where every state is reachable", () => {
    const sm: StateMachine = {
      states: ["start", "left", "right", "end"],
      initial: "start",
      transitions: [
        { from: "start", to: "left", event: "goLeft" },
        { from: "start", to: "right", event: "goRight" },
        { from: "left", to: "end", event: "finish" },
        { from: "right", to: "end", event: "finish" },
      ],
      final: ["end"],
    };
    expect(validateStateMachine(sm)).toEqual([]);
  });
});
