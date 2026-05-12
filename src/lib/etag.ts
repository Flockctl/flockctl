// ETag / 304 helpers for polled GET endpoints.
//
// Several Flockctl endpoints (the project tree, the workspace dashboard,
// the missions event feed) are polled by the UI every 10–30 s and
// frequently return the SAME payload as the previous tick. Audit-round-3
// flagged the lost bandwidth + needless React re-renders on each repeat.
//
// The pattern these helpers enable:
//
//   const body = buildExpensiveResponse(...);
//   const tag = computeEtag(body);
//   if (etagMatches(c, tag)) return new Response(null, { status: 304 });
//   return c.json(body, 200, { ETag: tag });
//
// We hash the response body (JSON serialised) so the server logic stays
// simple — no need to thread "last modified" timestamps through every
// endpoint. The hash is cheap relative to the response build (which
// already touches the DB / FS), and the win is on the wire (no body
// transfer) and the client (no parse + re-render churn).

import { createHash } from "node:crypto";
import type { Context } from "hono";

/**
 * Compute a strong ETag from an arbitrary JSON-serialisable value.
 * The returned string is quoted per RFC 7232 §2.3.
 */
export function computeEtag(payload: unknown): string {
  const serialised =
    typeof payload === "string" ? payload : JSON.stringify(payload) ?? "null";
  const hash = createHash("sha256").update(serialised).digest("base64url");
  // 12 chars of base64url is ~72 bits — plenty of collision resistance
  // for client cache validation and keeps the header tiny.
  return `"${hash.slice(0, 12)}"`;
}

/**
 * Return true when the request's `If-None-Match` header matches the
 * supplied tag. Hono normalises header names so case-folding is
 * unnecessary; we still trim quotes/whitespace from the client side
 * because some HTTP libraries strip the quotes when echoing.
 */
export function etagMatches(c: Context, tag: string): boolean {
  const header = c.req.header("if-none-match");
  if (!header) return false;
  const normalisedHeader = header.replace(/^W\//, "").trim();
  const stripped = (s: string) => s.replace(/^"|"$/g, "").trim();
  return stripped(normalisedHeader) === stripped(tag);
}
