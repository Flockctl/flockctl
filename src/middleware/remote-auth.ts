import { createMiddleware } from "hono/factory";
import { timingSafeEqual } from "crypto";
import type { Context } from "hono";
import { findMatchingToken, hasRemoteAuth } from "../config/index.js";
import { authRateLimiter } from "../lib/rate-limit.js";

/** @internal — reset for tests only */
export function _resetRateLimiter() {
  authRateLimiter.reset();
}

export function safeCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
  } catch {
    /* v8 ignore next — defensive: timingSafeEqual throws only on length mismatch which we already filter */
    return false;
  }
}

/** Get real client IP from Node.js socket, NOT from headers. */
export function getClientIp(c: Context): string {
  const env = c.env as Record<string, unknown> | undefined;
  const incoming = env?.incoming as
    | { socket?: { remoteAddress?: string } }
    | undefined;
  return incoming?.socket?.remoteAddress ?? "unknown";
}

export function isLocalhost(ip: string): boolean {
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip === "localhost"
  );
}

/**
 * Classify a *bind* address. Loopback means the server is only reachable from
 * the same machine. `0.0.0.0` / `::` are NOT loopback — they are any-interface
 * binds that expose the server to every network the host is attached to.
 * This is intentionally stricter than `isLocalhost` (which classifies a
 * client's source IP).
 */
export function isLoopbackBindHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** Paths that are always accessible (needed for connection testing). */
function isPublicPath(method: string, path: string): boolean {
  if (method === "GET" && path === "/health") return true;
  if (method === "OPTIONS") return true; // CORS preflight
  return false;
}

export const remoteAuth = createMiddleware(async (c, next) => {
  if (!hasRemoteAuth()) {
    return next();
  }

  if (isPublicPath(c.req.method, c.req.path)) {
    return next();
  }

  const clientIp = getClientIp(c);
  if (isLocalhost(clientIp)) {
    return next();
  }

  if (authRateLimiter.isLimited(clientIp)) {
    return c.json({ error: "Too many failed attempts. Try again later." }, 429);
  }

  const authHeader = c.req.header("Authorization");
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  const match = provided ? findMatchingToken(provided) : null;
  if (!match) {
    authRateLimiter.recordFailure(clientIp);
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("authTokenLabel" as never, match.label as never);
  return next();
});

/**
 * Loopback-only gate. A per-route middleware that 403s any non-localhost
 * caller, even if they hold a valid bearer token. This is intentionally
 * ADDITIVE to `remoteAuth`: bearer tokens remain valid for every other
 * endpoint; only routes that explicitly wrap themselves in `requireLoopback()`
 * get the extra restriction.
 *
 * Use for endpoints whose threat model assumes the caller already has
 * filesystem-level access to the machine (e.g. `/fs/browse`), where exposing
 * them to a remote token holder — even a legitimate one — would broaden the
 * attack surface far beyond what the token was meant to grant.
 */
export const requireLoopback = createMiddleware(async (c, next) => {
  // In local-only mode the server is already bound to 127.0.0.1 by
  // server-entry.ts, so there is no remote caller to block — the gate is a
  // no-op to keep the local CLI workflow (and in-memory `app.request` tests,
  // which carry no socket info) unimpeded. The gate only becomes meaningful
  // once remote access is opted in: the control plane now accepts bearer
  // tokens, so we must reject those tokens on routes that are not safe to
  // expose off-box.
  if (!hasRemoteAuth()) {
    return next();
  }
  const clientIp = getClientIp(c);
  if (!isLocalhost(clientIp)) {
    return c.json({ error: "endpoint is loopback-only" }, 403);
  }
  return next();
});

/** Verify token supplied via WebSocket query param `?token=...`. */
export function verifyWsToken(c: Context): { ok: true } | { ok: false; reason: string } {
  if (!hasRemoteAuth()) return { ok: true };

  const clientIp = getClientIp(c);
  if (isLocalhost(clientIp)) return { ok: true };

  const provided = c.req.query("token");
  if (!provided) return { ok: false, reason: "Missing token" };
  if (!findMatchingToken(provided)) return { ok: false, reason: "Invalid token" };
  return { ok: true };
}
