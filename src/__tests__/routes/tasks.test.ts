import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";

describe("Tasks API", () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });
  afterAll(() => testDb.sqlite.close());

  it("GET /health returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("GET /tasks returns empty list initially", async () => {
    const res = await app.request("/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toBeDefined();
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("GET /tasks/:id returns 404 for missing task", async () => {
    const res = await app.request("/tasks/999");
    expect(res.status).toBe(404);
  });

  it("404 for unknown routes", async () => {
    const res = await app.request("/unknown/route");
    expect(res.status).toBe(404);
  });
});
