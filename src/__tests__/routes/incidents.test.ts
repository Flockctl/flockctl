import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, closeDb } from "../../db/index.js";

describe("Incidents CRUD (/incidents)", () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterEach(() => {
    closeDb();
  });

  // ─── POST /incidents ───

  it("POST creates an incident with minimal body (title only)", async () => {
    const res = await app.request("/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Disk filled up" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; title: string; tags: unknown };
    expect(body.id).toBeGreaterThan(0);
    expect(body.title).toBe("Disk filled up");
    expect(body.tags).toBeNull();
  });

  it("POST stores tags as JSON and returns them as an array", async () => {
    const res = await app.request("/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Auth regression",
        symptom: "401 on all requests",
        tags: ["auth", "regression"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; tags: string[]; symptom: string };
    expect(body.tags).toEqual(["auth", "regression"]);
    expect(body.symptom).toBe("401 on all requests");
  });

  it("POST rejects missing title with 422", async () => {
    const res = await app.request("/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symptom: "No title" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; details: Record<string, string[]> };
    expect(body.error).toMatch(/invalid body/i);
    expect(body.details.title).toBeDefined();
  });

  it("POST rejects empty title with 422", async () => {
    const res = await app.request("/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST rejects non-array tags with 422", async () => {
    const res = await app.request("/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Oops", tags: "not-an-array" }),
    });
    expect(res.status).toBe(422);
  });

  it("POST rejects tags containing non-strings with 422", async () => {
    const res = await app.request("/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Oops", tags: ["ok", 42] }),
    });
    expect(res.status).toBe(422);
  });

  // ─── GET /incidents ───

  it("GET returns paginated list newest-first", async () => {
    const titles = ["first", "second", "third"];
    for (const t of titles) {
      await app.request("/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t }),
      });
    }
    const res = await app.request("/incidents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ title: string }>;
      total: number;
      page: number;
      perPage: number;
    };
    expect(body.total).toBe(3);
    expect(body.items.map((x) => x.title)).toEqual(["third", "second", "first"]);
  });

  it("GET respects per_page pagination", async () => {
    for (let i = 0; i < 5; i++) {
      await app.request("/incidents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `t${i}` }),
      });
    }
    const res = await app.request("/incidents?page=1&per_page=2");
    const body = (await res.json()) as { items: unknown[]; total: number; perPage: number };
    expect(body.total).toBe(5);
    expect(body.items.length).toBe(2);
    expect(body.perPage).toBe(2);
  });

  // ─── GET /incidents/:id ───

  it("GET /:id returns the incident", async () => {
    const create = await app.request("/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "single", tags: ["x"] }),
    });
    const created = (await create.json()) as { id: number };

    const res = await app.request(`/incidents/${created.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; title: string; tags: string[] };
    expect(body.id).toBe(created.id);
    expect(body.title).toBe("single");
    expect(body.tags).toEqual(["x"]);
  });

  it("GET /:id returns 404 for missing", async () => {
    const res = await app.request("/incidents/9999");
    expect(res.status).toBe(404);
  });

  it("GET /:id rejects non-numeric id with 422", async () => {
    const res = await app.request("/incidents/abc");
    expect(res.status).toBe(422);
  });

  // ─── PUT /incidents/:id ───

  it("PUT updates title and tags", async () => {
    const create = await app.request("/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "orig", tags: ["a"] }),
    });
    const created = (await create.json()) as { id: number };

    const res = await app.request(`/incidents/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "updated", tags: ["b", "c"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; tags: string[] };
    expect(body.title).toBe("updated");
    expect(body.tags).toEqual(["b", "c"]);
  });

  it("PUT can clear tags by passing empty array", async () => {
    const create = await app.request("/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "t", tags: ["a"] }),
    });
    const created = (await create.json()) as { id: number };

    const res = await app.request(`/incidents/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: unknown };
    expect(body.tags).toBeNull();
  });

  it("PUT rejects empty title with 422", async () => {
    const create = await app.request("/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "t" }),
    });
    const created = (await create.json()) as { id: number };

    const res = await app.request(`/incidents/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });
    expect(res.status).toBe(422);
  });

  it("PUT returns 404 for missing id", async () => {
    const res = await app.request("/incidents/9999", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  // ─── DELETE /incidents/:id ───

  it("DELETE removes the incident", async () => {
    const create = await app.request("/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "to delete" }),
    });
    const created = (await create.json()) as { id: number };

    const del = await app.request(`/incidents/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as { deleted: boolean };
    expect(delBody.deleted).toBe(true);

    const after = await app.request(`/incidents/${created.id}`);
    expect(after.status).toBe(404);
  });

  it("DELETE returns 404 for missing id", async () => {
    const res = await app.request("/incidents/9999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
