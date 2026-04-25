import { describe, it, expect } from "vitest";
import type { Context } from "hono";

import {
  parseIdParam,
  parseOptionalIdParam,
  parseStringParam,
  parseIdParamOrNotFound,
} from "../../lib/route-params.js";
import { ValidationError, NotFoundError } from "../../lib/errors.js";

/** Minimal Hono-style context stub — only `req.param(name)` is used. */
function makeCtx(params: Record<string, string | undefined>): Context {
  return {
    req: {
      param: (name: string) => params[name],
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

describe("parseOptionalIdParam", () => {
  it("returns undefined when the segment is missing", () => {
    expect(parseOptionalIdParam(makeCtx({}))).toBeUndefined();
  });

  it("returns undefined for an empty-string segment", () => {
    expect(parseOptionalIdParam(makeCtx({ id: "" }))).toBeUndefined();
  });

  it("validates when the segment is present", () => {
    expect(parseOptionalIdParam(makeCtx({ id: "5" }))).toBe(5);
    expect(() => parseOptionalIdParam(makeCtx({ id: "bad" }))).toThrow(
      ValidationError,
    );
  });

  it("honors a custom param name", () => {
    expect(parseOptionalIdParam(makeCtx({ slug: "9" }), "slug")).toBe(9);
    expect(parseOptionalIdParam(makeCtx({}), "slug")).toBeUndefined();
  });
});

describe("parseStringParam", () => {
  it("returns the raw string when present", () => {
    expect(parseStringParam(makeCtx({ slug: "hello" }), "slug")).toBe("hello");
  });

  it("throws ValidationError when missing", () => {
    expect(() => parseStringParam(makeCtx({}), "slug")).toThrow(ValidationError);
    expect(() => parseStringParam(makeCtx({}), "slug")).toThrow(
      /missing route param :slug/,
    );
  });

  it("throws ValidationError for an empty-string segment", () => {
    expect(() => parseStringParam(makeCtx({ slug: "" }), "slug")).toThrow(
      /missing route param :slug/,
    );
  });

  it("does NOT reject non-numeric content (it's a string param!)", () => {
    expect(parseStringParam(makeCtx({ name: "abc-123" }), "name")).toBe(
      "abc-123",
    );
  });
});

describe("parseIdParamOrNotFound", () => {
  it("returns { id, row } when the loader finds something", () => {
    const row = { id: 42, title: "hello" };
    const result = parseIdParamOrNotFound(
      makeCtx({ id: "42" }),
      "task",
      (id) => (id === 42 ? row : undefined),
    );
    expect(result).toEqual({ id: 42, row });
  });

  it("throws NotFoundError when loader returns undefined", () => {
    expect(() =>
      parseIdParamOrNotFound(makeCtx({ id: "99" }), "task", () => undefined),
    ).toThrow(NotFoundError);
    expect(() =>
      parseIdParamOrNotFound(makeCtx({ id: "99" }), "task", () => undefined),
    ).toThrow(/task not found/);
  });

  it("throws NotFoundError when loader returns null", () => {
    expect(() =>
      parseIdParamOrNotFound(makeCtx({ id: "99" }), "project", () => null as any),
    ).toThrow(NotFoundError);
  });

  it("lets ValidationError from parseIdParam bubble up unchanged", () => {
    expect(() =>
      parseIdParamOrNotFound(makeCtx({ id: "bad" }), "task", () => ({})),
    ).toThrow(ValidationError);
  });

  it("honors a custom paramName", () => {
    const row = { id: 1 };
    const result = parseIdParamOrNotFound(
      makeCtx({ chatId: "1" }),
      "chat",
      () => row,
      "chatId",
    );
    expect(result.id).toBe(1);
  });

  it("NotFoundError has status 404", () => {
    try {
      parseIdParamOrNotFound(makeCtx({ id: "99" }), "task", () => undefined);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect((e as NotFoundError).statusCode).toBe(404);
    }
  });
});
