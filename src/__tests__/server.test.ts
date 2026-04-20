import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { app } from "../server.js";
import { createTestDb } from "./helpers.js";
import { setDb, type FlockctlDb } from "../db/index.js";
import Database from "better-sqlite3";
import { AppError } from "../lib/errors.js";

let db: FlockctlDb;
let sqlite: Database.Database;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);

  // Register error-throwing test routes before any request locks the router.
  app.get("/__test_apperror", () => {
    throw new AppError(418, "I am a teapot", { brew: "earl grey" });
  });
  app.get("/__test_unknown_err", () => {
    throw new Error("oops");
  });
});

afterAll(() => {
  sqlite.close();
});

describe("Server integration", () => {
  describe("Health check", () => {
    it("GET /health returns 200 with ok status", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.status).toBe("ok");
    });
  });

  describe("CORS", () => {
    it("responds with CORS headers", async () => {
      const res = await app.request("/health", {
        headers: { "Origin": "http://localhost:5173" },
      });
      expect(res.status).toBe(200);
      // Hono cors middleware should add headers
      expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
    });

    it("handles preflight OPTIONS request", async () => {
      const res = await app.request("/health", {
        method: "OPTIONS",
        headers: {
          "Origin": "http://localhost:5173",
          "Access-Control-Request-Method": "POST",
        },
      });
      // Should return 2xx for preflight
      expect(res.status).toBeLessThan(300);
    });
  });

  describe("404 handler", () => {
    it("returns 404 for unknown routes", async () => {
      const res = await app.request("/nonexistent-route-12345");
      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.error).toBe("Not found");
    });
  });

  describe("Error handler", () => {
    it("routes return proper JSON errors", async () => {
      // Try to get a nonexistent task
      const res = await app.request("/tasks/999999");
      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.error).toBeTruthy();
    });
  });

  describe("Route registration", () => {
    it("tasks routes are mounted", async () => {
      const res = await app.request("/tasks");
      expect(res.status).toBe(200);
    });

    it("projects routes are mounted", async () => {
      const res = await app.request("/projects");
      expect(res.status).toBe(200);
    });

    it("chats routes are mounted", async () => {
      const res = await app.request("/chats");
      expect(res.status).toBe(200);
    });

    it("keys routes are mounted", async () => {
      const res = await app.request("/keys");
      expect(res.status).toBe(200);
    });

    it("templates routes are mounted", async () => {
      const res = await app.request("/templates");
      expect(res.status).toBe(200);
    });

    it("schedules routes are mounted", async () => {
      const res = await app.request("/schedules");
      expect(res.status).toBe(200);
    });

    it("workspaces routes are mounted", async () => {
      const res = await app.request("/workspaces");
      expect(res.status).toBe(200);
    });

    it("usage routes are mounted", async () => {
      const res = await app.request("/usage/summary");
      expect(res.status).toBe(200);
    });

    it("skills routes are mounted", async () => {
      const res = await app.request("/skills/resolved");
      expect(res.status).toBe(200);
    });
  });

  describe("AppError handler", () => {
    it("formats AppError with statusCode and details", async () => {
      const res = await app.request("/__test_apperror");
      expect(res.status).toBe(418);
      const body = await res.json() as any;
      expect(body.error).toBe("I am a teapot");
      expect(body.details).toEqual({ brew: "earl grey" });
    });

    it("masks unknown errors as 500", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await app.request("/__test_unknown_err");
      expect(res.status).toBe(500);
      const body = await res.json() as any;
      expect(body.error).toBe("Internal server error");
      errSpy.mockRestore();
    });
  });
});

describe("startServer", () => {
  it("starts and logs running URL on http(s) host", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { EventEmitter } = await import("events");
    const fakeServer: any = new EventEmitter();
    fakeServer.close = vi.fn();
    const serveSpy = vi.fn().mockReturnValue(fakeServer);
    vi.doMock("@hono/node-server", () => ({ serve: serveSpy }));

    const mod = await import("../server.js");
    mod.startServer(0, "127.0.0.1");
    await new Promise((r) => setTimeout(r, 30));

    expect(serveSpy).toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join(" ")).toContain("running at http://127.0.0.1");
    logSpy.mockRestore();
    vi.doUnmock("@hono/node-server");
  });

  it("logs running on for raw 0.0.0.0 host (no http prefix)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { EventEmitter: EE2 } = await import("events");
    const fakeSrv2: any = new EE2();
    fakeSrv2.close = vi.fn();
    const serveSpy = vi.fn().mockReturnValue(fakeSrv2);
    vi.doMock("@hono/node-server", () => ({ serve: serveSpy }));

    const mod = await import("../server.js");
    mod.startServer(0, "0.0.0.0");
    await new Promise((r) => setTimeout(r, 30));

    expect(logSpy.mock.calls.flat().join(" ")).toContain("running on 0.0.0.0");
    logSpy.mockRestore();
    vi.doUnmock("@hono/node-server");
  });
});
