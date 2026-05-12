import { describe, it, expect } from "vitest";
import type { Context } from "hono";

import { parseIdParam, parseIdQuery } from "../../lib/route-params.js";
import { ValidationError } from "../../lib/errors.js";

/** Minimal Hono-style context stub — only `req.param(name)` is used. */
function makeCtx(params: Record<string, string | undefined>): Context {
  return {
    req: {
      param: (name: string) => params[name],
    },
  } as unknown as Context;
}

/** Hono-style stub for `c.req.query(name)`. */
function makeQueryCtx(query: Record<string, string | undefined>): Context {
  return {
    req: {
      query: (name: string) => query[name],
    },
  } as unknown as Context;
}

describe("parseIdParam", () => {
  it("returns the integer id for a well-formed positive number", () => {
    expect(parseIdParam(makeCtx({ id: "42" }))).toBe(42);
    expect(parseIdParam(makeCtx({ id: "1" }))).toBe(1);
  });

  it("accepts a custom param name", () => {
    expect(parseIdParam(makeCtx({ chatId: "7" }), "chatId")).toBe(7);
  });

  it("throws ValidationError when the segment is missing", () => {
    expect(() => parseIdParam(makeCtx({}))).toThrow(ValidationError);
    expect(() => parseIdParam(makeCtx({}))).toThrow(/missing route param :id/);
  });

  it("throws ValidationError when the segment is empty string", () => {
    expect(() => parseIdParam(makeCtx({ id: "" }))).toThrow(ValidationError);
  });

  it("rejects non-numeric strings", () => {
    expect(() => parseIdParam(makeCtx({ id: "abc" }))).toThrow(/invalid :id/);
  });

  it("rejects zero", () => {
    expect(() => parseIdParam(makeCtx({ id: "0" }))).toThrow(/invalid :id/);
  });

  it("rejects negative numbers", () => {
    expect(() => parseIdParam(makeCtx({ id: "-3" }))).toThrow(/invalid :id/);
  });

  it("rejects decimal / non-integer inputs (String(parsed) != raw check)", () => {
    expect(() => parseIdParam(makeCtx({ id: "1.5" }))).toThrow(/invalid :id/);
  });

  it("rejects inputs with leading zeros (String(parsed) != raw check)", () => {
    expect(() => parseIdParam(makeCtx({ id: "007" }))).toThrow(/invalid :id/);
  });

  it("rejects inputs with trailing garbage (parseInt tolerates, we don't)", () => {
    // parseInt("12abc", 10) === 12, but String(12) !== "12abc" → reject.
    expect(() => parseIdParam(makeCtx({ id: "12abc" }))).toThrow(/invalid :id/);
  });

  it("uses the custom param name in error messages", () => {
    expect(() => parseIdParam(makeCtx({}), "taskId")).toThrow(
      /missing route param :taskId/,
    );
    expect(() => parseIdParam(makeCtx({ taskId: "bad" }), "taskId")).toThrow(
      /invalid :taskId/,
    );
  });

  it("thrown ValidationError has status 422", () => {
    try {
      parseIdParam(makeCtx({ id: "bad" }));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).statusCode).toBe(422);
    }
  });
});

describe("parseIdQuery", () => {
  it("returns the integer id for a well-formed positive number", () => {
    expect(parseIdQuery(makeQueryCtx({ project_id: "42" }), "project_id")).toBe(42);
    expect(parseIdQuery(makeQueryCtx({ project_id: "1" }), "project_id")).toBe(1);
  });

  it("returns undefined when the query parameter is missing", () => {
    expect(parseIdQuery(makeQueryCtx({}), "project_id")).toBeUndefined();
  });

  it("returns undefined for an empty-string query value", () => {
    expect(parseIdQuery(makeQueryCtx({ project_id: "" }), "project_id")).toBeUndefined();
  });

  /*
   * Regression: previously `parseInt("abc", 10)` returned NaN and
   * `WHERE col = NaN` silently filtered every row, so the route returned
   * 200 with an empty list instead of telling the client they sent bad
   * input. The helper must reject and surface 422.
   */
  it("throws ValidationError on non-numeric input", () => {
    expect(() => parseIdQuery(makeQueryCtx({ project_id: "abc" }), "project_id")).toThrow(
      ValidationError,
    );
    expect(() => parseIdQuery(makeQueryCtx({ project_id: "abc" }), "project_id")).toThrow(
      /invalid project_id/,
    );
  });

  it("rejects zero and negative numbers", () => {
    expect(() => parseIdQuery(makeQueryCtx({ project_id: "0" }), "project_id")).toThrow(
      ValidationError,
    );
    expect(() => parseIdQuery(makeQueryCtx({ project_id: "-3" }), "project_id")).toThrow(
      ValidationError,
    );
  });

  it("rejects decimals and trailing garbage (round-trip check)", () => {
    expect(() => parseIdQuery(makeQueryCtx({ project_id: "1.5" }), "project_id")).toThrow(
      ValidationError,
    );
    expect(() => parseIdQuery(makeQueryCtx({ project_id: "12abc" }), "project_id")).toThrow(
      ValidationError,
    );
  });

  it("rejects leading-zero inputs (007 != String(7))", () => {
    expect(() => parseIdQuery(makeQueryCtx({ project_id: "007" }), "project_id")).toThrow(
      ValidationError,
    );
  });

  it("uses the parameter name in the error message", () => {
    expect(() =>
      parseIdQuery(makeQueryCtx({ ai_provider_key_id: "bad" }), "ai_provider_key_id"),
    ).toThrow(/invalid ai_provider_key_id/);
  });

  it("thrown ValidationError has status 422", () => {
    try {
      parseIdQuery(makeQueryCtx({ project_id: "bad" }), "project_id");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).statusCode).toBe(422);
    }
  });
});
