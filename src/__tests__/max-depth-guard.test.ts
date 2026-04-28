// MaxDepthGuard — recursion-ceiling unit tests.
//
// Slice 11/01 task 03 ships the supervisor-loop depth guard that prevents
// remediation -> task -> failure -> remediation loops from running away.
// This file pins every branch in `max-depth-guard.ts`:
//
//   • non-remediation triggers run at depth 0 regardless of payload.depth
//   • remediation triggers read payload.depth, coerced to a safe integer
//   • the [0, MAX_ALLOWED_DEPTH] band is admitted; (MAX_ALLOWED_DEPTH, ∞)
//     is rejected with a depth_exceeded event carrying the full
//     trigger payload + rejected metadata
//   • bypass-protection contract: negative numbers, NaN, Infinity,
//     -Infinity, non-numbers, missing fields all coerce to 0 — a caller
//     CANNOT smuggle past the gate by sending depth=-1
//   • fractional depths are floored (depth is conceptually integer)
//   • a custom `maxAllowedDepth` constructor argument is honoured (lets
//     the supervisor tighten/widen the gate per-mission)

import { describe, it, expect } from "vitest";
import {
  MaxDepthGuard,
  MAX_ALLOWED_DEPTH,
  type MissionEvent,
  type MissionTrigger,
} from "../services/missions/max-depth-guard.js";

/**
 * Capture-style event sink. Every guard test wants to assert on emitted
 * events; making this a tuple of (sink, getter) keeps the sink-handle
 * narrow without relying on `vi.fn()` for what is fundamentally just a
 * push to an array.
 */
function makeSink(): [(event: MissionEvent) => void, () => MissionEvent[]] {
  const events: MissionEvent[] = [];
  return [(e) => events.push(e), () => events];
}

describe("MaxDepthGuard — non-remediation triggers", () => {
  it("admits any non-remediation trigger as depth 0, even with bogus payload.depth", () => {
    const [sink, get] = makeSink();
    const guard = new MaxDepthGuard(sink);
    const trigger: MissionTrigger = {
      kind: "task_observed",
      payload: { depth: 9999 }, // ignored — non-remediation runs at 0
    };
    const r = guard.check(trigger);
    expect(r.allowed).toBe(true);
    expect(r.depth).toBe(0);
    expect(get()).toEqual([]);
  });

  it("admits a non-remediation trigger with no payload at all", () => {
    const [sink] = makeSink();
    const guard = new MaxDepthGuard(sink);
    const r = guard.check({ kind: "heartbeat" });
    expect(r).toEqual({ allowed: true, depth: 0 });
  });
});

describe("MaxDepthGuard — remediation depth admission band", () => {
  it.each([0, 1, 2])("admits remediation at depth %i", (d) => {
    const [sink, get] = makeSink();
    const guard = new MaxDepthGuard(sink);
    const r = guard.check({ kind: "remediation", payload: { depth: d } });
    expect(r).toEqual({ allowed: true, depth: d });
    expect(get()).toEqual([]);
  });

  it("rejects remediation at depth 3 (one above the ceiling)", () => {
    const [sink, get] = makeSink();
    const guard = new MaxDepthGuard(sink);
    const r = guard.check({ kind: "remediation", payload: { depth: 3, foo: "bar" } });
    expect(r).toEqual({ allowed: false, depth: 3 });
    const events = get();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("depth_exceeded");
    // Event payload merges the trigger payload with the metadata fields
    // the guard adds. `foo: bar` propagates so consumers can correlate.
    expect(events[0].payload).toMatchObject({
      depth: 3,
      max_allowed_depth: MAX_ALLOWED_DEPTH,
      trigger_kind: "remediation",
      foo: "bar",
    });
  });

  it("rejects remediation at depth far above the ceiling", () => {
    const [sink] = makeSink();
    const guard = new MaxDepthGuard(sink);
    const r = guard.check({ kind: "remediation", payload: { depth: 100 } });
    expect(r.allowed).toBe(false);
    expect(r.depth).toBe(100);
  });
});

describe("MaxDepthGuard — bypass-protection (security invariant)", () => {
  // Each row encodes one untrusted input form the security contract
  // requires us to coerce to 0 (and therefore admit at depth 0). The
  // names mirror the test pin in the parent slice.md spec:
  // "max_depth_guard_cannot_be_bypassed_by_passing_negative_depth".
  it.each([
    ["negative integer", -1, 0],
    ["large negative", -1000, 0],
    ["negative float", -2.5, 0],
    ["NaN", NaN, 0],
    ["Infinity", Infinity, 0],
    ["-Infinity", -Infinity, 0],
    ["string", "1" as unknown, 0],
    ["null", null as unknown, 0],
    ["undefined", undefined as unknown, 0],
    ["object", {} as unknown, 0],
    ["array", [3] as unknown, 0],
    ["boolean", true as unknown, 0],
  ])("coerces %s payload.depth to 0 and admits", (_label, raw, expected) => {
    const [sink, get] = makeSink();
    const guard = new MaxDepthGuard(sink);
    const r = guard.check({
      kind: "remediation",
      payload: { depth: raw as unknown as number },
    });
    expect(r.allowed).toBe(true);
    expect(r.depth).toBe(expected);
    expect(get()).toEqual([]);
  });

  it("missing payload entirely on a remediation trigger coerces to depth 0", () => {
    const [sink] = makeSink();
    const guard = new MaxDepthGuard(sink);
    const r = guard.check({ kind: "remediation" });
    expect(r).toEqual({ allowed: true, depth: 0 });
  });

  it("missing payload.depth (other keys present) coerces to depth 0", () => {
    const [sink] = makeSink();
    const guard = new MaxDepthGuard(sink);
    const r = guard.check({
      kind: "remediation",
      payload: { other: "value" },
    });
    expect(r).toEqual({ allowed: true, depth: 0 });
  });

  it("a caller CANNOT smuggle past the gate by sending depth: -100 from a deep stack", () => {
    // Reads as: even if upstream code accidentally subtracts and goes
    // negative, the guard treats it as a fresh top-level entry. This is
    // the headline invariant; we pin it explicitly so the regression
    // would scream in the test name.
    const [sink, get] = makeSink();
    const guard = new MaxDepthGuard(sink);
    const r = guard.check({
      kind: "remediation",
      payload: { depth: -100 },
    });
    expect(r.allowed).toBe(true);
    expect(r.depth).toBe(0);
    expect(get()).toEqual([]);
  });
});

describe("MaxDepthGuard — fractional depths are floored", () => {
  it("admits 2.9 as 2 (still inside the band)", () => {
    const [sink] = makeSink();
    const guard = new MaxDepthGuard(sink);
    const r = guard.check({ kind: "remediation", payload: { depth: 2.9 } });
    expect(r).toEqual({ allowed: true, depth: 2 });
  });

  it("rejects 3.5 as depth 3 (above ceiling, with floored value)", () => {
    const [sink, get] = makeSink();
    const guard = new MaxDepthGuard(sink);
    const r = guard.check({ kind: "remediation", payload: { depth: 3.5 } });
    expect(r).toEqual({ allowed: false, depth: 3 });
    expect(get()[0].payload).toMatchObject({ depth: 3 });
  });
});

describe("MaxDepthGuard — custom maxAllowedDepth", () => {
  it("honours a tighter ceiling (0 admits only depth 0)", () => {
    const [sink, get] = makeSink();
    const guard = new MaxDepthGuard(sink, 0);
    expect(guard.check({ kind: "remediation", payload: { depth: 0 } })).toEqual({
      allowed: true,
      depth: 0,
    });
    expect(guard.check({ kind: "remediation", payload: { depth: 1 } })).toEqual({
      allowed: false,
      depth: 1,
    });
    expect(get()[0].payload).toMatchObject({ max_allowed_depth: 0 });
  });

  it("honours a wider ceiling (5 admits depth 5)", () => {
    const [sink] = makeSink();
    const guard = new MaxDepthGuard(sink, 5);
    expect(guard.check({ kind: "remediation", payload: { depth: 5 } }).allowed).toBe(true);
    expect(guard.check({ kind: "remediation", payload: { depth: 6 } }).allowed).toBe(false);
  });
});

describe("MaxDepthGuard — event sink contract", () => {
  it("does NOT fire the sink on an admitted trigger", () => {
    const [sink, get] = makeSink();
    const guard = new MaxDepthGuard(sink);
    guard.check({ kind: "remediation", payload: { depth: 1 } });
    expect(get()).toEqual([]);
  });

  it("emits exactly one depth_exceeded event per rejection", () => {
    const [sink, get] = makeSink();
    const guard = new MaxDepthGuard(sink);
    guard.check({ kind: "remediation", payload: { depth: 100 } });
    guard.check({ kind: "remediation", payload: { depth: 50 } });
    expect(get()).toHaveLength(2);
    expect(get().every((e) => e.kind === "depth_exceeded")).toBe(true);
  });

  it("the emitted payload preserves arbitrary trigger payload keys", () => {
    const [sink, get] = makeSink();
    const guard = new MaxDepthGuard(sink);
    guard.check({
      kind: "remediation",
      payload: {
        depth: 9,
        task_id: 42,
        attempt: 3,
        nested: { reason: "test_failed" },
      },
    });
    expect(get()[0].payload).toMatchObject({
      depth: 9,
      max_allowed_depth: MAX_ALLOWED_DEPTH,
      trigger_kind: "remediation",
      task_id: 42,
      attempt: 3,
      nested: { reason: "test_failed" },
    });
  });
});
