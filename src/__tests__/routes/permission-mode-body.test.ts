// Direct unit tests for the route-layer wrapper around parsePermissionModeField.
// Existing route tests exercise the wrapper transitively but never hit:
//   • neither key present → undefined
//   • body permission_mode: null → null (clear-to-null path)
//   • permissionMode (camelCase) variant
//   • the catch that wraps a non-Error throw with the fallback string

import { describe, it, expect } from "vitest";
import { parsePermissionModeBody } from "../../routes/_permission-mode.js";
import { ValidationError } from "../../lib/errors.js";

describe("parsePermissionModeBody", () => {
  it("returns undefined when neither permission_mode nor permissionMode is set", () => {
    expect(parsePermissionModeBody({})).toBeUndefined();
    expect(parsePermissionModeBody({ unrelated: "foo" })).toBeUndefined();
  });

  it("returns null when body explicitly sets permission_mode: null", () => {
    expect(parsePermissionModeBody({ permission_mode: null })).toBeNull();
  });

  it("returns null when body explicitly sets permissionMode (camelCase): null", () => {
    expect(parsePermissionModeBody({ permissionMode: null })).toBeNull();
  });

  it("dispatches snake_case key when both are present", () => {
    // hasSnake wins (the body could only ever set both via a buggy client,
    // so the snake-case branch is the canonical one).
    const out = parsePermissionModeBody({
      permission_mode: "default",
      permissionMode: "acceptEdits",
    });
    expect(out).toBe("default");
  });

  it("throws a ValidationError when the resolver rejects the input", () => {
    expect(() =>
      parsePermissionModeBody({ permission_mode: "totally-bogus-value" }),
    ).toThrow(ValidationError);
  });
});
