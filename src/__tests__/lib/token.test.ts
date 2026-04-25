import { describe, expect, it } from "vitest";
import { generateRemoteAccessToken, tokenFingerprint } from "../../lib/token.js";

describe("src/lib/token", () => {
  describe("generateRemoteAccessToken", () => {
    it("returns a URL-safe base64 string of 32 random bytes", () => {
      const t = generateRemoteAccessToken();
      // 32 bytes → 43 base64url chars (no padding).
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it("produces different values each call", () => {
      const a = generateRemoteAccessToken();
      const b = generateRemoteAccessToken();
      expect(a).not.toBe(b);
    });
  });

  describe("tokenFingerprint", () => {
    it("returns the first 8 hex chars of SHA-256(token)", () => {
      // SHA-256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
      expect(tokenFingerprint("hello")).toBe("2cf24dba");
    });

    it("is stable for the same input", () => {
      const t = "some-token-value";
      expect(tokenFingerprint(t)).toBe(tokenFingerprint(t));
    });

    it("differs for different inputs", () => {
      expect(tokenFingerprint("a")).not.toBe(tokenFingerprint("b"));
    });
  });
});
