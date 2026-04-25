import { describe, it, expect } from "vitest";
import {
  notImplemented,
  toTransitionFrom,
  TransitionSpec,
} from "../../test-helpers";
import type { StateMachine } from "../../services/state-machines/sm-parser";

const sm: StateMachine = {
  states: ["idle", "running", "done"],
  initial: "idle",
  transitions: [
    { from: "idle", to: "running", event: "start" },
    { from: "running", to: "done", event: "finish" },
  ],
};

describe("notImplemented", () => {
  it("throws an Error typed as `never`", () => {
    expect(() => notImplemented("stub body")).toThrow(Error);
  });

  it("includes the caller-supplied message in the thrown error", () => {
    expect(() => notImplemented("payment.charge")).toThrow(
      /Not implemented: payment\.charge/,
    );
  });

  it("throws a genuine Error instance (not a string)", () => {
    try {
      notImplemented("x");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      return;
    }
    throw new Error("notImplemented did not throw");
  });
});

describe("toTransitionFrom fluent builder", () => {
  it("produces a TransitionSpec with the three captured fields", () => {
    const spec = toTransitionFrom("idle").to("running").onEvent("start");
    expect(spec).toBeInstanceOf(TransitionSpec);
    expect(spec.from).toBe("idle");
    expect(spec.to).toBe("running");
    expect(spec.event).toBe("start");
  });

  it("matches() returns true when the transition exists in the SM", () => {
    const spec = toTransitionFrom("idle").to("running").onEvent("start");
    expect(spec.matches(sm)).toBe(true);
  });

  it("matches() returns false when the transition is absent", () => {
    const spec = toTransitionFrom("idle").to("done").onEvent("start");
    expect(spec.matches(sm)).toBe(false);
  });

  it("matches() is strict on every field (wrong event => miss)", () => {
    const spec = toTransitionFrom("idle").to("running").onEvent("BOGUS");
    expect(spec.matches(sm)).toBe(false);
  });

  it("describe() renders an arrow form with event in the middle", () => {
    const spec = toTransitionFrom("a").to("b").onEvent("go");
    expect(spec.describe()).toBe("a --go--> b");
  });
});

describe("toSatisfyTransition custom matcher", () => {
  it("passes when the SM has the specified transition", () => {
    expect(sm).toSatisfyTransition(
      toTransitionFrom("idle").to("running").onEvent("start"),
    );
  });

  it("passes for a second, distinct transition", () => {
    expect(sm).toSatisfyTransition(
      toTransitionFrom("running").to("done").onEvent("finish"),
    );
  });

  it("fails when the transition is absent — error cites the arrow form", () => {
    const spec = toTransitionFrom("idle").to("done").onEvent("teleport");
    expect(() => expect(sm).toSatisfyTransition(spec)).toThrow(
      /idle --teleport--> done/,
    );
  });

  it("supports `.not.` negation", () => {
    expect(sm).not.toSatisfyTransition(
      toTransitionFrom("done").to("idle").onEvent("reset"),
    );
  });

  it("`.not.` fails when the transition actually exists", () => {
    const spec = toTransitionFrom("idle").to("running").onEvent("start");
    expect(() => expect(sm).not.toSatisfyTransition(spec)).toThrow(
      /NOT to contain transition idle --start--> running/,
    );
  });

  it("rejects a non-StateMachine received value with a clear message", () => {
    expect(() =>
      expect({ foo: 1 }).toSatisfyTransition(
        toTransitionFrom("a").to("b").onEvent("e"),
      ),
    ).toThrow(/not a StateMachine/);
  });

  it("rejects null as received value", () => {
    expect(() =>
      expect(null).toSatisfyTransition(
        toTransitionFrom("a").to("b").onEvent("e"),
      ),
    ).toThrow(/not a StateMachine/);
  });
});
