// Verifies that the `/missions` router participates in the same
// cross-cutting remoteAuth middleware that protects every other API route in
// `src/server.ts`. The router itself contains no auth code — that is the
// point: auth is mounted once at app scope (`app.use("/*", remoteAuth)`),
// and mounting `/missions` after that line is what wires it in.
//
// The single test below asserts the full auth contract on `/missions`:
//   1. localhost callers bypass auth (existing behavior, unchanged)
//   2. non-localhost callers without a Bearer token get 401
//   3. non-localhost callers with a wrong Bearer token get 401 + are
//      counted by the rate limiter
//   4. a valid Bearer token unblocks the route (no 401)
//   5. after 5 failed attempts from one IP the limiter trips to 429

import { describe, it, expect, beforeEach, vi } from "vitest";
import { app } from "../../server.js";
import * as config from "../../config/index.js";
import { _resetRateLimiter } from "../../middleware/remote-auth.js";

const VALID_TOKEN = "0123456789abcdef0123456789abcdef0123";

function localhostEnv() {
  return {
    incoming: { socket: { remoteAddress: "127.0.0.1" } },
  } as unknown as Record<string, unknown>;
}

function remoteEnv(ip = "203.0.113.7") {
  return {
    incoming: { socket: { remoteAddress: ip } },
  } as unknown as Record<string, unknown>;
}

function mockRemoteAuth() {
  vi.spyOn(config, "hasRemoteAuth").mockReturnValue(true);
  vi.spyOn(config, "findMatchingToken").mockImplementation((provided) =>
    provided === VALID_TOKEN ? { label: "default" } : null,
  );
}

describe("missions router auth wiring", () => {
  beforeEach(() => {
    _resetRateLimiter();
    vi.restoreAllMocks();
  });

  it("missions_router_honors_remote_auth_middleware", async () => {
    mockRemoteAuth();

    // 1. localhost bypass — no auth header required
    const localRes = await app.request("/missions/__not_a_real_id__", {}, localhostEnv());
    expect(localRes.status).not.toBe(401);
    expect(localRes.status).not.toBe(429);

    // 2. non-localhost without token → 401
    const noToken = await app.request(
      "/missions/__not_a_real_id__",
      {},
      remoteEnv("198.51.100.10"),
    );
    expect(noToken.status).toBe(401);

    // 3. non-localhost with wrong token → 401 (and counts as a failed attempt)
    const wrongToken = await app.request(
      "/missions/__not_a_real_id__",
      { headers: { authorization: `Bearer ${"x".repeat(VALID_TOKEN.length)}` } },
      remoteEnv("198.51.100.10"),
    );
    expect(wrongToken.status).toBe(401);

    // 4. valid token → middleware lets the request through (no 401/429)
    const goodToken = await app.request(
      "/missions/__not_a_real_id__",
      { headers: { authorization: `Bearer ${VALID_TOKEN}` } },
      remoteEnv("198.51.100.11"),
    );
    expect(goodToken.status).not.toBe(401);
    expect(goodToken.status).not.toBe(429);

    // 5. rate-limit (5 fail / 60s / IP) — already 2 failures from .10 above,
    //    accumulate three more to hit the threshold then expect 429.
    for (let i = 0; i < 3; i++) {
      const r = await app.request(
        "/missions/__not_a_real_id__",
        {},
        remoteEnv("198.51.100.10"),
      );
      expect(r.status).toBe(401);
    }
    const sixth = await app.request(
      "/missions/__not_a_real_id__",
      {},
      remoteEnv("198.51.100.10"),
    );
    expect(sixth.status).toBe(429);
  });
});
