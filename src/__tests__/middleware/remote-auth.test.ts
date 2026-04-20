import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import {
  remoteAuth,
  verifyWsToken,
  safeCompare,
  isLoopbackBindHost,
  getClientIp,
  _resetRateLimiter,
} from "../../middleware/remote-auth.js";
import * as config from "../../config.js";

const VALID_TOKEN = "0123456789abcdef0123456789abcdef0123";
const SECOND_TOKEN = "fedcba9876543210fedcba9876543210fedc";

function makeApp() {
  const app = new Hono();
  app.use("/*", remoteAuth);
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/secret", (c) => c.json({ secret: true }));
  return app;
}

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

function mockTokens(tokens: Array<{ label: string; token: string }>) {
  vi.spyOn(config, "hasRemoteAuth").mockReturnValue(tokens.length > 0);
  vi.spyOn(config, "findMatchingToken").mockImplementation((provided) => {
    const hit = tokens.find((t) => t.token === provided);
    return hit ? { label: hit.label } : null;
  });
}

describe("remoteAuth middleware", () => {
  beforeEach(() => {
    _resetRateLimiter();
    vi.restoreAllMocks();
  });

  it("skips auth entirely when no token is configured", async () => {
    mockTokens([]);
    const res = await makeApp().request("/secret", {}, remoteEnv());
    expect(res.status).toBe(200);
  });

  it("allows localhost to bypass even when token is set", async () => {
    mockTokens([{ label: "default", token: VALID_TOKEN }]);
    const res = await makeApp().request("/secret", {}, localhostEnv());
    expect(res.status).toBe(200);
  });

  it("does NOT accept x-forwarded-for as localhost", async () => {
    mockTokens([{ label: "default", token: VALID_TOKEN }]);
    const res = await makeApp().request(
      "/secret",
      { headers: { "x-forwarded-for": "127.0.0.1" } },
      remoteEnv("203.0.113.9"),
    );
    expect(res.status).toBe(401);
  });

  it("rejects requests without a bearer token", async () => {
    mockTokens([{ label: "default", token: VALID_TOKEN }]);
    const res = await makeApp().request("/secret", {}, remoteEnv());
    expect(res.status).toBe(401);
  });

  it("rejects requests with a wrong bearer token", async () => {
    mockTokens([{ label: "default", token: VALID_TOKEN }]);
    const res = await makeApp().request(
      "/secret",
      { headers: { authorization: `Bearer ${"x".repeat(VALID_TOKEN.length)}` } },
      remoteEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("accepts a valid bearer token", async () => {
    mockTokens([{ label: "default", token: VALID_TOKEN }]);
    const res = await makeApp().request(
      "/secret",
      { headers: { authorization: `Bearer ${VALID_TOKEN}` } },
      remoteEnv(),
    );
    expect(res.status).toBe(200);
  });

  it("accepts any matching token when multiple are configured", async () => {
    mockTokens([
      { label: "phone", token: VALID_TOKEN },
      { label: "laptop", token: SECOND_TOKEN },
    ]);
    const app = makeApp();
    const first = await app.request(
      "/secret",
      { headers: { authorization: `Bearer ${VALID_TOKEN}` } },
      remoteEnv(),
    );
    const second = await app.request(
      "/secret",
      { headers: { authorization: `Bearer ${SECOND_TOKEN}` } },
      remoteEnv(),
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("rate-limits after 5 failed attempts", async () => {
    mockTokens([{ label: "default", token: VALID_TOKEN }]);
    const app = makeApp();
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/secret", {}, remoteEnv("198.51.100.9"));
      expect(res.status).toBe(401);
    }
    const sixth = await app.request("/secret", {}, remoteEnv("198.51.100.9"));
    expect(sixth.status).toBe(429);
  });

  it("always allows GET /health without a token", async () => {
    mockTokens([{ label: "default", token: VALID_TOKEN }]);
    const res = await makeApp().request("/health", {}, remoteEnv());
    expect(res.status).toBe(200);
  });

  it("allows CORS preflight OPTIONS without a token", async () => {
    mockTokens([{ label: "default", token: VALID_TOKEN }]);
    const app = makeApp();
    app.options("/secret", (c) => c.body(null, 204));
    const res = await app.request("/secret", { method: "OPTIONS" }, remoteEnv());
    expect(res.status).toBeLessThan(400);
  });
});

describe("verifyWsToken", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("is a no-op when no token is configured", () => {
    mockTokens([]);
    const fakeCtx = {
      env: remoteEnv(),
      req: { query: () => undefined },
    } as any;
    expect(verifyWsToken(fakeCtx).ok).toBe(true);
  });

  it("allows localhost without a token", () => {
    mockTokens([{ label: "default", token: VALID_TOKEN }]);
    const fakeCtx = {
      env: localhostEnv(),
      req: { query: () => undefined },
    } as any;
    expect(verifyWsToken(fakeCtx).ok).toBe(true);
  });

  it("rejects remote WS without a token", () => {
    mockTokens([{ label: "default", token: VALID_TOKEN }]);
    const fakeCtx = {
      env: remoteEnv(),
      req: { query: () => undefined },
    } as any;
    expect(verifyWsToken(fakeCtx).ok).toBe(false);
  });

  it("accepts remote WS with matching token", () => {
    mockTokens([{ label: "default", token: VALID_TOKEN }]);
    const fakeCtx = {
      env: remoteEnv(),
      req: { query: () => VALID_TOKEN },
    } as any;
    expect(verifyWsToken(fakeCtx).ok).toBe(true);
  });

  it("rejects remote WS with a token that matches no labeled entry", () => {
    mockTokens([{ label: "phone", token: VALID_TOKEN }]);
    const fakeCtx = {
      env: remoteEnv(),
      req: { query: () => "wrongtoken" },
    } as any;
    expect(verifyWsToken(fakeCtx).ok).toBe(false);
  });
});

describe("safeCompare", () => {
  it("returns true for equal strings", () => {
    expect(safeCompare("abc", "abc")).toBe(true);
  });
  it("returns false for different-length strings", () => {
    expect(safeCompare("abc", "abcd")).toBe(false);
  });
  it("returns false for same-length, different content", () => {
    expect(safeCompare("aaa", "aab")).toBe(false);
  });
  it("returns false when either argument is non-string", () => {
    expect(safeCompare("abc", 123 as unknown as string)).toBe(false);
    expect(safeCompare(undefined as unknown as string, "abc")).toBe(false);
  });
});

describe("getClientIp", () => {
  it("returns 'unknown' when env has no incoming socket info", () => {
    const ctx = { env: undefined } as any;
    expect(getClientIp(ctx)).toBe("unknown");
  });
  it("returns 'unknown' when socket has no remoteAddress", () => {
    const ctx = { env: { incoming: { socket: {} } } } as any;
    expect(getClientIp(ctx)).toBe("unknown");
  });
  it("returns the socket remoteAddress when present", () => {
    const ctx = { env: { incoming: { socket: { remoteAddress: "1.2.3.4" } } } } as any;
    expect(getClientIp(ctx)).toBe("1.2.3.4");
  });
});

describe("isLoopbackBindHost", () => {
  it("accepts loopback addresses", () => {
    expect(isLoopbackBindHost("127.0.0.1")).toBe(true);
    expect(isLoopbackBindHost("::1")).toBe(true);
    expect(isLoopbackBindHost("localhost")).toBe(true);
  });
  it("rejects any-interface addresses", () => {
    expect(isLoopbackBindHost("0.0.0.0")).toBe(false);
    expect(isLoopbackBindHost("::")).toBe(false);
  });
  it("rejects arbitrary public-looking addresses", () => {
    expect(isLoopbackBindHost("192.168.1.10")).toBe(false);
    expect(isLoopbackBindHost("203.0.113.7")).toBe(false);
  });
});
