import { describe, it, expect } from "vitest";
import {
  toIsoUtcString,
  normalizeTimestampsDeep,
} from "../../lib/normalize-timestamps.js";

describe("toIsoUtcString", () => {
  it("rewrites bare SQLite (`YYYY-MM-DD HH:MM:SS`) as ISO-Z", () => {
    expect(toIsoUtcString("2026-04-27 17:04:51")).toBe(
      "2026-04-27T17:04:51.000Z",
    );
  });

  it("preserves fractional seconds when present", () => {
    expect(toIsoUtcString("2026-04-27 17:04:51.123")).toBe(
      "2026-04-27T17:04:51.123Z",
    );
  });

  it("rewrites ISO-without-TZ as ISO-Z", () => {
    expect(toIsoUtcString("2026-04-27T17:04:51")).toBe(
      "2026-04-27T17:04:51.000Z",
    );
  });

  it("passes through ISO-Z untouched (idempotent)", () => {
    const iso = "2026-04-27T17:04:51.497Z";
    expect(toIsoUtcString(iso)).toBe(iso);
  });

  it("passes through ISO with numeric offset untouched", () => {
    expect(toIsoUtcString("2026-04-27T17:04:51+03:00")).toBe(
      "2026-04-27T17:04:51+03:00",
    );
    expect(toIsoUtcString("2026-04-27T17:04:51-0500")).toBe(
      "2026-04-27T17:04:51-0500",
    );
  });

  it("does not touch arbitrary strings", () => {
    // Pure non-timestamp values must round-trip unchanged.
    for (const s of [
      "",
      "hello",
      "2026-04-27", // date-only
      "17:04:51", // time-only
      "2026-04-27 17:04", // missing seconds
      "log line @ 2026-04-27 17:04:51", // not anchored
      "2026/04/27 17:04:51", // wrong separator
      "abc 2026-04-27 17:04:51",
    ]) {
      expect(toIsoUtcString(s)).toBe(s);
    }
  });

  it("is idempotent on its own output", () => {
    const once = toIsoUtcString("2026-04-27 17:04:51");
    const twice = toIsoUtcString(once);
    expect(twice).toBe(once);
  });
});

describe("normalizeTimestampsDeep", () => {
  it("rewrites bare timestamps inside an object", () => {
    const input = {
      id: 1,
      created_at: "2026-04-27 17:04:51",
      updated_at: "2026-04-27T18:00:00.000Z",
      name: "task one",
    };
    expect(normalizeTimestampsDeep(input)).toEqual({
      id: 1,
      created_at: "2026-04-27T17:04:51.000Z",
      updated_at: "2026-04-27T18:00:00.000Z",
      name: "task one",
    });
  });

  it("recurses through nested arrays and objects", () => {
    const input = {
      tasks: [
        { id: 1, created_at: "2026-04-27 17:04:51" },
        { id: 2, created_at: "2026-04-27 17:04:52" },
      ],
      meta: {
        last_run: "2026-04-27 17:00:00",
        nested: { deeper: { ts: "2026-04-27 17:04:51" } },
      },
    };
    const out = normalizeTimestampsDeep(input);
    expect(out).toEqual({
      tasks: [
        { id: 1, created_at: "2026-04-27T17:04:51.000Z" },
        { id: 2, created_at: "2026-04-27T17:04:52.000Z" },
      ],
      meta: {
        last_run: "2026-04-27T17:00:00.000Z",
        nested: { deeper: { ts: "2026-04-27T17:04:51.000Z" } },
      },
    });
  });

  it("returns the SAME reference when nothing changed (hot path)", () => {
    // Performance contract: a payload with no leaked timestamps must not be
    // re-allocated. The response middleware relies on this to short-circuit.
    const clean = {
      id: 1,
      created_at: "2026-04-27T17:04:51.497Z",
      tags: ["a", "b"],
    };
    expect(normalizeTimestampsDeep(clean)).toBe(clean);
  });

  it("preserves non-timestamp primitives untouched", () => {
    expect(normalizeTimestampsDeep(42)).toBe(42);
    expect(normalizeTimestampsDeep(null)).toBe(null);
    expect(normalizeTimestampsDeep(true)).toBe(true);
    expect(normalizeTimestampsDeep("plain text")).toBe("plain text");
  });

  it("handles arrays of mixed primitives and objects", () => {
    const input = [
      "2026-04-27 17:04:51",
      42,
      { ts: "2026-04-27 17:04:51" },
      null,
    ];
    expect(normalizeTimestampsDeep(input)).toEqual([
      "2026-04-27T17:04:51.000Z",
      42,
      { ts: "2026-04-27T17:04:51.000Z" },
      null,
    ]);
  });

  it("is idempotent on already-normalised payloads", () => {
    const input = {
      created_at: "2026-04-27 17:04:51",
      nested: [{ ts: "2026-04-27 17:04:52" }],
    };
    const once = normalizeTimestampsDeep(input);
    const twice = normalizeTimestampsDeep(once);
    // Same shape, and the second pass returns the same reference (no rewrite
    // needed) because everything already has `Z`.
    expect(twice).toBe(once);
  });
});
