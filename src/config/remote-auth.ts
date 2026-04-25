import { timingSafeEqual } from "crypto";
import { loadRc, saveRc } from "./paths.js";

const MIN_TOKEN_LENGTH = 32;

export interface RemoteAccessToken {
  label: string;
  token: string;
}

/**
 * Merge the legacy single-token field (`remoteAccessToken`) with the new
 * labeled-array field (`remoteAccessTokens`). Both sources are filtered for
 * minimum length; short tokens emit one warning per invalid entry.
 *
 * Legacy single token becomes `{label: "default", token}`. If both the legacy
 * field and an array entry labeled "default" exist, the array entry wins
 * (the user has explicitly migrated).
 */
export function getConfiguredTokens(): RemoteAccessToken[] {
  const rc = loadRc();
  const out: RemoteAccessToken[] = [];
  const seenLabels = new Set<string>();

  if (Array.isArray(rc.remoteAccessTokens)) {
    for (const entry of rc.remoteAccessTokens) {
      if (!entry || typeof entry !== "object") continue;
      const label = typeof entry.label === "string" ? entry.label : null;
      const token = typeof entry.token === "string" ? entry.token : null;
      if (!label || !token) continue;
      if (token.length < MIN_TOKEN_LENGTH) {
        console.warn(
          `[SECURITY] remoteAccessTokens[${label}] is too short ` +
            `(${token.length} chars, min ${MIN_TOKEN_LENGTH}). Skipping. ` +
            `Generate a secure token with: flockctl token generate`,
        );
        continue;
      }
      if (seenLabels.has(label)) continue;
      seenLabels.add(label);
      out.push({ label, token });
    }
  }

  if (typeof rc.remoteAccessToken === "string" && !seenLabels.has("default")) {
    const token = rc.remoteAccessToken;
    if (token.length >= MIN_TOKEN_LENGTH) {
      out.push({ label: "default", token });
    } else if (token.length > 0) {
      console.warn(
        `[SECURITY] remoteAccessToken is too short (${token.length} chars, ` +
          `min ${MIN_TOKEN_LENGTH}). Generate a secure token with: flockctl token generate`,
      );
    }
  }

  return out;
}

export function hasRemoteAuth(): boolean {
  return getConfiguredTokens().length > 0;
}

/**
 * Timing-safe comparison of `provided` against every configured token.
 * Iterates the full list unconditionally so the loop's runtime does not
 * depend on where (or whether) a match exists.
 */
export function findMatchingToken(provided: string): { label: string } | null {
  if (typeof provided !== "string") return null;
  const tokens = getConfiguredTokens();
  let match: { label: string } | null = null;
  for (const { label, token } of tokens) {
    if (provided.length !== token.length) continue;
    let eq = false;
    try {
      eq = timingSafeEqual(Buffer.from(provided, "utf-8"), Buffer.from(token, "utf-8"));
    } catch {
      /* v8 ignore next — defensive: timingSafeEqual only throws on length mismatch which we already filter */
      eq = false;
    }
    if (eq && match === null) match = { label };
  }
  return match;
}

/** @deprecated prefer `hasRemoteAuth()` / `findMatchingToken()` */
export function getRemoteAccessToken(): string | null {
  const tokens = getConfiguredTokens();
  return tokens[0]?.token ?? null;
}

export function addRemoteAccessToken(label: string, token: string): void {
  if (!label || typeof label !== "string") {
    throw new Error("Token label is required");
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`Token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const rc = { ...loadRc() };
  const existing: Array<{ label: string; token: string }> = Array.isArray(rc.remoteAccessTokens)
    ? rc.remoteAccessTokens.filter(
        (e: any) =>
          e && typeof e === "object" && typeof e.label === "string" && typeof e.token === "string",
      )
    : [];
  if (existing.some((e) => e.label === label)) {
    throw new Error(`A token labeled "${label}" already exists. Revoke it first.`);
  }
  existing.push({ label, token });

  if (typeof rc.remoteAccessToken === "string" && rc.remoteAccessToken.length > 0) {
    if (!existing.some((e) => e.label === "default")) {
      existing.unshift({ label: "default", token: rc.remoteAccessToken });
    }
    delete rc.remoteAccessToken;
  }

  rc.remoteAccessTokens = existing;
  saveRc(rc);
}

export function removeRemoteAccessToken(label: string): boolean {
  const rc = { ...loadRc() };
  let removed = false;

  if (Array.isArray(rc.remoteAccessTokens)) {
    const before = rc.remoteAccessTokens.length;
    rc.remoteAccessTokens = rc.remoteAccessTokens.filter(
      (e: any) => !(e && typeof e === "object" && e.label === label),
    );
    if (rc.remoteAccessTokens.length !== before) removed = true;
  }

  if (label === "default" && typeof rc.remoteAccessToken === "string") {
    delete rc.remoteAccessToken;
    removed = true;
  }

  if (removed) saveRc(rc);
  return removed;
}

export function getCorsAllowedOrigins(): string[] | null {
  const rc = loadRc();
  if (Array.isArray(rc.corsOrigins) && rc.corsOrigins.every((v) => typeof v === "string")) {
    return rc.corsOrigins;
  }
  return null;
}
