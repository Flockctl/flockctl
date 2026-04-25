/**
 * Runtime helpers for state-machine tests.
 *
 * Provides two exports:
 *
 *   1. `notImplemented(msg)`: throws a well-formed `Error` so that
 *      auto-generated test stubs compile and fail loudly with a clear
 *      reason when executed.
 *
 *   2. A fluent spec builder + custom vitest matcher for asserting that
 *      a parsed `StateMachine` contains a specific transition:
 *
 *        expect(sm).toSatisfyTransition(
 *          toTransitionFrom("idle").to("running").onEvent("start"),
 *        );
 *
 *      The fluent form is generator-friendly (no `sm` argument needed
 *      until the `expect` call) and reads naturally in generated code.
 */

import { expect } from "vitest";
import type { StateMachine } from "../services/state-machines/sm-parser";

/* -------------------------------------------------------------------------- */
/* notImplemented                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Throws an `Error` with a stable prefix. Typed as `never` so the
 * compiler accepts it as the body of a function that must return a
 * value — generated test stubs rely on this.
 */
export function notImplemented(msg: string): never {
  throw new Error(`Not implemented: ${msg}`);
}

/* -------------------------------------------------------------------------- */
/* Transition spec + fluent builder                                           */
/* -------------------------------------------------------------------------- */

/**
 * A fully-specified transition query (`from`, `to`, `event`) plus
 * behaviour for matching against a `StateMachine`.
 *
 * Produced by the fluent `toTransitionFrom(...).to(...).onEvent(...)`
 * chain so generated tests can build spec values inline without
 * threading the state machine through every step.
 */
export class TransitionSpec {
  constructor(
    public readonly from: string,
    public readonly to: string,
    public readonly event: string,
  ) {}

  /** True iff `sm` contains a transition exactly matching this spec. */
  matches(sm: StateMachine): boolean {
    return sm.transitions.some(
      (t) => t.from === this.from && t.to === this.to && t.event === this.event,
    );
  }

  /** Human-readable arrow form, e.g. `idle --start--> running`. */
  describe(): string {
    return `${this.from} --${this.event}--> ${this.to}`;
  }
}

/**
 * Start a fluent transition spec.
 *
 *   toTransitionFrom("idle").to("running").onEvent("start")
 *
 * Returns a `TransitionSpec` at the end of the chain so it can be fed
 * to `expect(sm).toSatisfyTransition(...)`, asserted manually via
 * `spec.matches(sm)`, or logged with `spec.describe()`.
 */
export function toTransitionFrom(from: string): {
  to(to: string): {
    onEvent(event: string): TransitionSpec;
  };
} {
  return {
    to(to: string) {
      return {
        onEvent(event: string): TransitionSpec {
          return new TransitionSpec(from, to, event);
        },
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Vitest custom matcher: toSatisfyTransition                                 */
/* -------------------------------------------------------------------------- */

interface SmMatchers<R = unknown> {
  toSatisfyTransition(spec: TransitionSpec): R;
}

declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Assertion<T = any> extends SmMatchers<T> {}
   
  interface AsymmetricMatchersContaining extends SmMatchers {}
}

expect.extend({
  toSatisfyTransition(received: unknown, spec: TransitionSpec) {
    if (
      received === null ||
      typeof received !== "object" ||
      !Array.isArray((received as { transitions?: unknown }).transitions)
    ) {
      return {
        pass: false,
        message: () =>
          "toSatisfyTransition: received value is not a StateMachine (missing `transitions` array)",
      };
    }
    const sm = received as StateMachine;
    const pass = spec.matches(sm);
    return {
      pass,
      message: () =>
        pass
          ? `expected state machine NOT to contain transition ${spec.describe()}`
          : `expected state machine to contain transition ${spec.describe()}`,
    };
  },
});
