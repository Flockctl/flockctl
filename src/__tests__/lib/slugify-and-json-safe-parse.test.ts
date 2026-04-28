// Direct unit tests for two tiny lib helpers: slugify and jsonSafeParse.
// Both files have low branch coverage because they're called transitively by
// many routes but never had a focused test that exercises every branch.

import { describe, it, expect } from "vitest";
import { slugify } from "../../lib/slugify.js";
import {
  jsonSafeParse,
  jsonSafeParseStringArray,
} from "../../lib/json-safe-parse.js";

describe("slugify", () => {
  it("collapses spaces, lowercase passthrough, drops illegal chars", () => {
    expect(slugify("Hello World")).toBe("Hello_World");
    expect(slugify("foo!@#bar")).toBe("foobar");
    expect(slugify("multi   space")).toBe("multi_space");
  });

  it("trims trailing/leading underscores and dashes", () => {
    expect(slugify("__hi__")).toBe("hi");
    expect(slugify("--bye--")).toBe("bye");
  });

  it("falls back to 'unnamed' when input collapses to empty", () => {
    // Hits the `|| "unnamed"` branch on line 13 — input is non-empty but
    // every character is stripped, so the chained replaces yield "".
    expect(slugify("!@#$%")).toBe("unnamed");
    expect(slugify("   ")).toBe("unnamed");
    expect(slugify("")).toBe("unnamed");
    expect(slugify("___")).toBe("unnamed");
  });

  it("preserves dots, dashes, underscores, alphanumerics", () => {
    expect(slugify("hello.world-1_2")).toBe("hello.world-1_2");
  });
});

describe("jsonSafeParse", () => {
  it("returns null for null/undefined/empty input", () => {
    expect(jsonSafeParse(null)).toBeNull();
    expect(jsonSafeParse(undefined)).toBeNull();
    expect(jsonSafeParse("")).toBeNull();
  });

  it("parses valid JSON", () => {
    expect(jsonSafeParse('{"a":1}')).toEqual({ a: 1 });
    expect(jsonSafeParse("[1,2,3]")).toEqual([1, 2, 3]);
    expect(jsonSafeParse("true")).toBe(true);
  });

  it("returns null on malformed JSON", () => {
    expect(jsonSafeParse("not json")).toBeNull();
    expect(jsonSafeParse("{bad")).toBeNull();
  });
});

describe("jsonSafeParseStringArray", () => {
  it("returns null for non-array JSON", () => {
    expect(jsonSafeParseStringArray('{"a":1}')).toBeNull();
    expect(jsonSafeParseStringArray("42")).toBeNull();
    expect(jsonSafeParseStringArray(null)).toBeNull();
  });

  it("returns null when array contains non-string items", () => {
    expect(jsonSafeParseStringArray("[1,2,3]")).toBeNull();
    expect(jsonSafeParseStringArray('["a", 2]')).toBeNull();
    expect(jsonSafeParseStringArray('[null, "x"]')).toBeNull();
  });

  it("returns the parsed array of strings on the happy path", () => {
    expect(jsonSafeParseStringArray('["foo","bar"]')).toEqual(["foo", "bar"]);
    expect(jsonSafeParseStringArray("[]")).toEqual([]);
  });
});
