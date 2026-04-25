import { describe, it, expect } from "vitest";
import {
  parseGitignoreToggles,
  hasGitignoreToggles,
} from "../../routes/_gitignore-toggles.js";
import { ValidationError } from "../../lib/errors.js";

describe("parseGitignoreToggles", () => {
  it("returns empty object when no toggle keys are present", () => {
    expect(parseGitignoreToggles({})).toEqual({});
    expect(parseGitignoreToggles({ unrelated: "value" })).toEqual({});
  });

  it("accepts boolean true / false for each recognized toggle", () => {
    expect(
      parseGitignoreToggles({
        gitignoreFlockctl: true,
        gitignoreTodo: false,
        gitignoreAgentsMd: true,
      }),
    ).toEqual({
      gitignoreFlockctl: true,
      gitignoreTodo: false,
      gitignoreAgentsMd: true,
    });
  });

  it("only includes fields that were explicitly supplied (undefined is not enumerated)", () => {
    expect(
      parseGitignoreToggles({ gitignoreFlockctl: true }),
    ).toEqual({ gitignoreFlockctl: true });
  });

  it("treats an explicit `undefined` value as present — and rejects it as non-boolean", () => {
    expect(() =>
      parseGitignoreToggles({ gitignoreFlockctl: undefined as any }),
    ).toThrow(ValidationError);
    expect(() =>
      parseGitignoreToggles({ gitignoreFlockctl: undefined as any }),
    ).toThrow(/gitignoreFlockctl must be boolean/);
  });

  it("rejects non-boolean values for each toggle with ValidationError", () => {
    for (const key of ["gitignoreFlockctl", "gitignoreTodo", "gitignoreAgentsMd"] as const) {
      for (const bad of ["true", 1, 0, null, {}, []]) {
        expect(() => parseGitignoreToggles({ [key]: bad as any })).toThrow(
          ValidationError,
        );
        expect(() => parseGitignoreToggles({ [key]: bad as any })).toThrow(
          new RegExp(`${key} must be boolean`),
        );
      }
    }
  });

  it("silently ignores keys that aren't toggles even if they're non-boolean", () => {
    expect(
      parseGitignoreToggles({ unrelated: "not a boolean" }),
    ).toEqual({});
  });

  it("uses its own allowlist (does not touch __proto__ / hasOwnProperty)", () => {
    const body: Record<string, unknown> = Object.create({ gitignoreFlockctl: true });
    // inherited, not own → ignored
    expect(parseGitignoreToggles(body)).toEqual({});
  });
});

describe("hasGitignoreToggles", () => {
  it("true when any toggle is set", () => {
    expect(hasGitignoreToggles({ gitignoreFlockctl: false })).toBe(true);
    expect(hasGitignoreToggles({ gitignoreTodo: true })).toBe(true);
    expect(hasGitignoreToggles({ gitignoreAgentsMd: false })).toBe(true);
  });

  it("false for an empty patch", () => {
    expect(hasGitignoreToggles({})).toBe(false);
  });

  it("treats explicit undefined values as not-set", () => {
    expect(
      hasGitignoreToggles({
        gitignoreFlockctl: undefined,
        gitignoreTodo: undefined,
        gitignoreAgentsMd: undefined,
      }),
    ).toBe(false);
  });
});
