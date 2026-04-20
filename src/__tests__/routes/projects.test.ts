import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";

describe("Projects API", () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeAll(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });
  afterAll(() => testDb.sqlite.close());

  it("GET /projects returns list", async () => {
    const res = await app.request("/projects");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toBeDefined();
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("GET /projects/:id returns 404 for missing project", async () => {
    const res = await app.request("/projects/999");
    expect(res.status).toBe(404);
  });
});
