/**
 * Primitives for minting and displaying remote-access bearer tokens.
 *
 * Extracted from `src/cli.ts` so that any future server route (e.g. a `POST
 * /tokens` endpoint or a UI "rotate token" button) can mint / fingerprint
 * tokens with the same recipe, without the CLI being the single source of
 * truth.
 *
 * These helpers are intentionally one-liners — the value is having a named
 * import everyone agrees on, not hiding logic.
 */
import { randomBytes, createHash } from "crypto";

/** 32 random bytes rendered as URL-safe base64 (`base64url`). */
export function generateRemoteAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Short stable identifier for a token suitable for display in `token list`.
 * First 8 hex chars of SHA-256(token). Not reversible; not a secret.
 */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}
