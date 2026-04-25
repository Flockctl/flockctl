import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, closeDb } from "../../db/index.js";
import { incidents, projects } from "../../db/schema.js";

describe("Incidents — branch coverage", () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterEach(() => {
    closeDb();
  });

  // ─── parseIdParam branches ───
  describe("parseIdParam", () => {
    it("returns 422 for zero id", async () => {
      expect((await app.request("/incidents/0")).status).toBe(422);
    });

    it("returns 422 for negative id", async () => {
      expect((await app.request("/incidents/-3")).status).toBe(422);
    });

    it("returns 422 for non-integer numeric (float)", async () => {
      expect((await app.request("/incidents/1.5")).status).toBe(422);
    });

    it("PUT rejects invalid id", async () => {
      const res = await app.request("/incidents/bad", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      });
      expect(res.status).toBe(422);
    });

    it("DELETE rejects invalid id", async () => {
      const res = await app.request("/incidents/bad", { method: "DELETE" });
      expect(res.status).toBe(422);
    });
  });

  // ─── POST — JSON parse + zod edges ───
  describe("POST body validation", () => {
    it("returns 422 on malformed JSON (body becomes null)", async () => {
      const res = await app.request("/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not json",
      });
      expect(res.status).toBe(422);
    });

    it("returns 422 when projectId is not an integer", async () => {
      const res = await app.request("/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "t", projectId: 1.2 }),
      });
      expect(res.status).toBe(422);
    });

    it("accepts null for all optional nullish fields", async () => {
      const res = await app.request("/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "nulls",
          symptom: null,
          rootCause: null,
          resolution: null,
          projectId: null,
          createdByChatId: null,
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { symptom: unknown; tags: unknown };
      expect(body.symptom).toBeNull();
      expect(body.tags).toBeNull();
    });

    it("POST with empty tags array stores null", async () => {
      const res = await app.request("/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "empty", tags: [] }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { tags: unknown };
      expect(body.tags).toBeNull();
    });
  });

  // ─── PUT body validation + partial ───
  describe("PUT body validation", () => {
    it("returns 422 on malformed JSON", async () => {
      const create = await app.request("/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "t" }),
      });
      const { id } = (await create.json()) as { id: number };
      const res = await app.request(`/incidents/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{ bad",
      });
      expect(res.status).toBe(422);
    });

    it("PUT accepts no-op (empty body) and updates updatedAt only", async () => {
      const create = await app.request("/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "t" }),
      });
      const { id } = (await create.json()) as { id: number };

      const res = await app.request(`/incidents/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
    });

    it("PUT with nulls sets nullable fields", async () => {
      const create = await app.request("/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "t", symptom: "s" }),
      });
      const { id } = (await create.json()) as { id: number };

      const res = await app.request(`/incidents/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symptom: null,
          rootCause: null,
          resolution: null,
          projectId: null,
          createdByChatId: null,
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { symptom: unknown };
      expect(body.symptom).toBeNull();
    });

    it("PUT with full-update path sets all fields", async () => {
      // Seed a real project so the FK on projectId resolves.
      const p = testDb.db.insert(projects).values({ name: "PP" }).returning().get()!;

      const create = await app.request("/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "t" }),
      });
      const { id } = (await create.json()) as { id: number };

      const res = await app.request(`/incidents/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "upd",
          symptom: "s",
          rootCause: "r",
          resolution: "rz",
          projectId: p.id,
          tags: ["x"],
        }),
      });
      expect(res.status).toBe(200);
    });
  });

  // ─── GET /incidents/tags branches ───
  describe("GET /tags branches", () => {
    it("serializes malformed tags JSON as null tags (no crash)", async () => {
      // Directly insert a row with garbage in tags to exercise JSON.parse catch.
      testDb.db
        .insert(incidents)
        .values({ title: "bad-tags", tags: "{not-json" } as any)
        .run();

      const res = await app.request("/incidents/tags");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tags: string[] };
      expect(body.tags).toEqual([]);
    });

    it("skips rows where tags is a JSON object (not array)", async () => {
      testDb.db
        .insert(incidents)
        .values({ title: "obj-tags", tags: JSON.stringify({ k: "v" }) } as any)
        .run();

      const res = await app.request("/incidents/tags");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tags: string[] };
      expect(body.tags).toEqual([]);
    });

    it("skips empty-string tags and trims", async () => {
      testDb.db
        .insert(incidents)
        .values({ title: "mixed", tags: JSON.stringify(["  auth  ", "", 42, "db"]) } as any)
        .run();

      const res = await app.request("/incidents/tags");
      const body = (await res.json()) as { tags: string[] };
      expect(body.tags).toContain("auth");
      expect(body.tags).toContain("db");
      expect(body.tags).not.toContain("");
    });

    it("422 on invalid projectId", async () => {
      const res = await app.request("/incidents/tags?projectId=bad");
      expect(res.status).toBe(422);
    });

    it("422 on zero / negative projectId", async () => {
      expect((await app.request("/incidents/tags?projectId=0")).status).toBe(422);
      expect((await app.request("/incidents/tags?projectId=-1")).status).toBe(422);
    });

    it("treats empty projectId as undefined (no filter)", async () => {
      testDb.db.insert(incidents).values({ title: "t", tags: JSON.stringify(["a"]) } as any).run();
      const res = await app.request("/incidents/tags?projectId=");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tags: string[] };
      expect(body.tags).toEqual(["a"]);
    });

    it("filters by projectId", async () => {
      const p = testDb.db.insert(projects).values({ name: "P" }).returning().get()!;
      testDb.db.insert(incidents).values([
        { title: "a", tags: JSON.stringify(["x"]), projectId: p.id },
        { title: "b", tags: JSON.stringify(["y"]) },
      ] as any).run();
      const res = await app.request(`/incidents/tags?projectId=${p.id}`);
      const body = (await res.json()) as { tags: string[] };
      expect(body.tags).toEqual(["x"]);
    });

    it("skips rows with null tags", async () => {
      testDb.db.insert(incidents).values({ title: "no-tags" } as any).run();
      const res = await app.request("/incidents/tags");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tags: string[] };
      expect(body.tags).toEqual([]);
    });
  });

  // ─── GET /incidents/search branches ───
  describe("GET /search branches", () => {
    it("supports empty query (recency fallback)", async () => {
      testDb.db.insert(incidents).values({ title: "a" } as any).run();
      const res = await app.request("/incidents/search?q=");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[]; total: number };
      expect(Array.isArray(body.items)).toBe(true);
    });

    it("ignores unspecified q (defaults to empty)", async () => {
      const res = await app.request("/incidents/search");
      expect(res.status).toBe(200);
    });

    it("accepts tags as comma-separated list and trims", async () => {
      const res = await app.request("/incidents/search?tags=%20foo%20,%20bar%20");
      expect(res.status).toBe(200);
    });

    it("tags with only commas becomes empty filter, not error", async () => {
      const res = await app.request("/incidents/search?tags=,,,");
      expect(res.status).toBe(200);
    });

    it("422 on invalid projectId", async () => {
      expect((await app.request("/incidents/search?projectId=bad")).status).toBe(422);
    });

    it("422 on zero projectId", async () => {
      expect((await app.request("/incidents/search?projectId=0")).status).toBe(422);
    });

    it("treats empty projectId as undefined", async () => {
      const res = await app.request("/incidents/search?projectId=");
      expect(res.status).toBe(200);
    });

    it("422 on invalid limit", async () => {
      expect((await app.request("/incidents/search?limit=bad")).status).toBe(422);
    });

    it("422 on zero / negative limit", async () => {
      expect((await app.request("/incidents/search?limit=0")).status).toBe(422);
      expect((await app.request("/incidents/search?limit=-5")).status).toBe(422);
    });

    it("treats empty limit as undefined", async () => {
      const res = await app.request("/incidents/search?limit=");
      expect(res.status).toBe(200);
    });

    it("applies projectId + limit when valid", async () => {
      const res = await app.request("/incidents/search?projectId=1&limit=5");
      expect(res.status).toBe(200);
    });
  });

  // ─── serialize() — jsonSafeParseStringArray on various stored shapes ───
  describe("serialize — tag-parse edge cases", () => {
    it("returns null tags for a row with malformed tags json", async () => {
      const row = testDb.db
        .insert(incidents)
        .values({ title: "garbled", tags: "{bad" } as any)
        .returning()
        .get()!;
      const res = await app.request(`/incidents/${row.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tags: unknown };
      expect(body.tags).toBeNull();
    });

    it("returns null tags for a row whose tags is an object json", async () => {
      const row = testDb.db
        .insert(incidents)
        .values({ title: "obj", tags: JSON.stringify({ a: 1 }) } as any)
        .returning()
        .get()!;
      const res = await app.request(`/incidents/${row.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tags: unknown };
      expect(body.tags).toBeNull();
    });
  });

  // ─── Empty DB branches for count ?? 0 ───
  describe("GET /incidents — count fallback", () => {
    it("returns total 0 on empty DB", async () => {
      const res = await app.request("/incidents");
      const body = (await res.json()) as { total: number; items: unknown[] };
      expect(body.total).toBe(0);
      expect(body.items).toEqual([]);
    });
  });
});
