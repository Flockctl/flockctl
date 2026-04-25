// Tests for GET /incidents/tags — the typeahead source used by the
// "Save as incident" dialog.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, closeDb } from "../../db/index.js";

describe("GET /incidents/tags", () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterEach(() => {
    closeDb();
  });

  async function createIncident(body: Record<string, unknown>): Promise<{ id: number }> {
    const res = await app.request("/incidents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: number };
  }

  it("returns an empty list when there are no incidents", async () => {
    const res = await app.request("/incidents/tags");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: string[] };
    expect(body.tags).toEqual([]);
  });

  it("returns the distinct union of tags across all incidents, sorted", async () => {
    await createIncident({ title: "a", tags: ["auth", "db"] });
    await createIncident({ title: "b", tags: ["db", "tls"] });
    await createIncident({ title: "c", tags: [] });

    const res = await app.request("/incidents/tags");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: string[] };
    expect(body.tags).toEqual(["auth", "db", "tls"]);
  });

  it("scopes to a single project when projectId is supplied", async () => {
    // Seed two projects directly via the test DB — the /projects route requires
    // fields we don't need here, so raw insert is simpler.
    testDb.sqlite
      .prepare("INSERT INTO projects (id, name, path) VALUES (1, 'p1', '/tmp/p1')")
      .run();
    testDb.sqlite
      .prepare("INSERT INTO projects (id, name, path) VALUES (2, 'p2', '/tmp/p2')")
      .run();

    await createIncident({ title: "a", tags: ["auth"], projectId: 1 });
    await createIncident({ title: "b", tags: ["db"], projectId: 2 });

    const res = await app.request("/incidents/tags?projectId=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: string[] };
    expect(body.tags).toEqual(["auth"]);
  });

  it("rejects a non-numeric projectId with 422", async () => {
    const res = await app.request("/incidents/tags?projectId=abc");
    expect(res.status).toBe(422);
  });
});
