import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync as realExistsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// The server resolves its UI dir from the location of server.ts (in tests, src/)
// so we materialize src/ui/ with an index.html + a sample asset, then force
// fresh re-import of server.ts to exercise the bundled-UI block.
const srcDir = dirname(fileURLToPath(import.meta.url)).replace(/\/__tests__$/, "");
const fixtureUiDir = join(srcDir, "ui");
const fixtureIndex = join(fixtureUiDir, "index.html");
const fixtureAsset = join(fixtureUiDir, "assets", "bundle.js");
const fixtureMissingAsset = "/assets/nope.js";

let createdUiDir = false;
let createdAssetsDir = false;

beforeAll(() => {
  if (!realExistsSync(fixtureUiDir)) {
    mkdirSync(fixtureUiDir, { recursive: true });
    createdUiDir = true;
  }
  if (!realExistsSync(join(fixtureUiDir, "assets"))) {
    mkdirSync(join(fixtureUiDir, "assets"), { recursive: true });
    createdAssetsDir = true;
  }
  writeFileSync(fixtureIndex, "<!doctype html><html><body>SPA</body></html>");
  writeFileSync(fixtureAsset, "console.log('bundle');");
});

afterAll(() => {
  try { rmSync(fixtureAsset, { force: true }); } catch {}
  try { rmSync(fixtureIndex, { force: true }); } catch {}
  if (createdAssetsDir) {
    try { rmSync(join(fixtureUiDir, "assets"), { recursive: true, force: true }); } catch {}
  }
  if (createdUiDir) {
    try { rmSync(fixtureUiDir, { recursive: true, force: true }); } catch {}
  }
});

describe("server.ts — bundled UI block", () => {
  it("serves index.html for a navigation request (Accept: text/html)", async () => {
    vi.resetModules();
    const { app } = await import("../server.js");
    const res = await app.request("/", {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("SPA");
  });

  it("serves a real asset with correct MIME type", async () => {
    vi.resetModules();
    const { app } = await import("../server.js");
    const res = await app.request("/assets/bundle.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    const body = await res.text();
    expect(body).toContain("console.log");
  });

  it("falls through for missing asset files", async () => {
    vi.resetModules();
    const { app } = await import("../server.js");
    const res = await app.request(fixtureMissingAsset);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("falls through for API clients (Accept: application/json)", async () => {
    vi.resetModules();
    const { app } = await import("../server.js");
    const res = await app.request("/tasks/99999", {
      headers: { Accept: "application/json" },
    });
    // UI block must not hijack API requests — response must not be the SPA index.html.
    // Status depends on DB state (404 for missing task vs 500 on empty test DB), so
    // we verify content-type and that it is not the 200-OK SPA response.
    expect(res.status).not.toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).not.toContain("text/html");
  });

  it("does not intercept POST requests", async () => {
    vi.resetModules();
    const { app } = await import("../server.js");
    const res = await app.request("/", {
      method: "POST",
      headers: { Accept: "text/html" },
    });
    // POST is not a navigation — the UI block ignores it; routes 404
    expect(res.status).toBe(404);
  });

  it("rejects path-traversal asset requests", async () => {
    vi.resetModules();
    const { app } = await import("../server.js");
    const res = await app.request("/../outside.js");
    // Either 404 or falls through safely — must not serve anything outside uiDist
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("server.ts — CORS with remote auth", () => {
  it("uses whitelist-based CORS when remoteAccessToken is configured", async () => {
    vi.resetModules();
    vi.doMock("../config.js", async () => {
      const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
      return {
        ...actual,
        hasRemoteAuth: () => true,
        getCorsAllowedOrigins: () => ["https://app.example.com"],
      };
    });
    try {
      const { app } = await import("../server.js");
      const res = await app.request("/health", {
        headers: { Origin: "https://app.example.com" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    } finally {
      vi.doUnmock("../config.js");
      vi.resetModules();
    }
  });

  it("falls back to wildcard CORS when whitelist is empty", async () => {
    vi.resetModules();
    vi.doMock("../config.js", async () => {
      const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
      return {
        ...actual,
        hasRemoteAuth: () => true,
        getCorsAllowedOrigins: () => [],
      };
    });
    try {
      const { app } = await import("../server.js");
      const res = await app.request("/health", {
        headers: { Origin: "https://any.example.com" },
      });
      expect(res.status).toBe(200);
    } finally {
      vi.doUnmock("../config.js");
      vi.resetModules();
    }
  });
});
