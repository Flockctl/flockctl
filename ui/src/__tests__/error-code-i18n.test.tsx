import { describe, expect, it } from "vitest";

import enLocale from "@/locales/en.json";
import {
  SERVER_ERROR_CODES,
  errorCodeMessage,
  type ServerErrorCode,
} from "@/lib/types/common";

// Vite's `vite/client` ambient types expose JSON imports as `any`. Narrow it
// to the shape this test cares about so key accesses stay type-safe.
const en = enLocale as { errorCode: Record<string, string> };

describe("errorCode i18n parity", () => {
  it("exposes exactly 11 codes in the union", () => {
    // Sanity: the spec calls for 11 new keys. Guarding this catches silent
    // additions/deletions to the ServerErrorCode union.
    expect(SERVER_ERROR_CODES).toHaveLength(11);
  });

  it("every ServerErrorCode value has a matching entry in en.json", () => {
    for (const code of SERVER_ERROR_CODES) {
      expect(
        Object.prototype.hasOwnProperty.call(en.errorCode, code),
        `en.json is missing errorCode.${code}`,
      ).toBe(true);
      expect(typeof en.errorCode[code]).toBe("string");
      expect((en.errorCode[code] ?? "").length).toBeGreaterThan(0);
    }
  });

  it("en.json does not declare any error codes outside the union", () => {
    const allowed = new Set<string>(SERVER_ERROR_CODES);
    for (const key of Object.keys(en.errorCode)) {
      expect(allowed.has(key), `en.json has stray errorCode.${key}`).toBe(true);
    }
  });

  it("errorCodeMessage returns a non-empty string for every union value", () => {
    for (const code of SERVER_ERROR_CODES) {
      const msg = errorCodeMessage(code);
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it("errorCodeMessage falls back to the `unknown` key for undefined/unknown input", () => {
    const unknownMsg = errorCodeMessage("unknown");
    expect(errorCodeMessage(undefined)).toBe(unknownMsg);
    expect(errorCodeMessage("not_a_real_code")).toBe(unknownMsg);
    expect(errorCodeMessage("")).toBe(unknownMsg);
  });

  it("errorCodeMessage matches en.json content for every code", () => {
    for (const code of SERVER_ERROR_CODES) {
      expect(errorCodeMessage(code)).toBe(en.errorCode[code]);
    }
  });

  // Compile-time guard: this assignment only typechecks if ServerErrorCode
  // contains exactly the values enumerated in SERVER_ERROR_CODES.
  it("SERVER_ERROR_CODES is assignable to readonly ServerErrorCode[]", () => {
    const codes: readonly ServerErrorCode[] = SERVER_ERROR_CODES;
    expect(codes).toBe(SERVER_ERROR_CODES);
  });
});
