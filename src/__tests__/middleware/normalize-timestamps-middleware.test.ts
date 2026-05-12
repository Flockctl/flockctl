import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, type FlockctlDb } from "../../db/index.js";
import Database from "better-sqlite3";

/**
 * Verify the global timestamp-normalisation middleware in `server.ts` rewrites
 * leaked bare-SQLite timestamps (`"YYYY-MM-DD HH:MM:SS"`) into ISO-Z when
 * routes happen to return them — without depending on any specific
 * production route's normalisation discipline.
 *
 * Two test routes are registered under `/__test_*` paths so the assertions
 * are isolated from the rest of the suite. Like the existing AppError test
 * fixtures in `server.test.ts`, registration runs in `beforeAll` to land
 * before the first `app.request(...)` locks the router.
 */
let db: FlockctlDb;
let sqlite: Database.Database;

beforeAll(() => {
  const t = createTestDb();
  db = t.db;
  sqlite = t.sqlite;
  setDb(db, sqlite);

  app.get("/__test_bare_timestamps", (c) =>
    c.json({
      created_at: "2026-04-27 17:04:51",
      updated_at: "2026-04-27 18:00:00.123",
      nested: [
        { ts: "2026-04-27 17:04:52" },
        { ts: "2026-04-27T17:04:53.000Z" }, // already normalised
      ],
      // Non-timestamp strings must round-trip untouched.
      title: "log line @ 2026-04-27 17:04:51",
      slug: "2026-04-27", // date-only, not a full timestamp
    }),
  );

  app.get("/__test_clean_payload", (c) =>
    c.json({ status: "ok", count: 42 }),
  );
});

afterAll(() => {
  sqlite.close();
});

describe("global timestamp-normalisation middleware", () => {
  it("rewrites bare SQLite timestamps to ISO-Z everywhere in JSON response", async () => {
    const res = await app.request("/__test_bare_timestamps");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.created_at).toBe("2026-04-27T17:04:51.000Z");
    expect(body.updated_at).toBe("2026-04-27T18:00:00.123Z");
    expect((body.nested as Array<{ ts: string }>)[0].ts).toBe(
      "2026-04-27T17:04:52.000Z",
    );
    // Already-normalised timestamp stays as-is.
    expect((body.nested as Array<{ ts: string }>)[1].ts).toBe(
      "2026-04-27T17:04:53.000Z",
    );
    // Non-timestamp strings are NOT rewritten (regex is anchor-strict).
    expect(body.title).toBe("log line @ 2026-04-27 17:04:51");
    expect(body.slug).toBe("2026-04-27");
  });

  it("leaves clean (no timestamps) JSON payloads byte-identical", async () => {
    const res = await app.request("/__test_clean_payload");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "ok", count: 42 });
  });

  it("preserves response status on rewritten responses", async () => {
    // The rewritten Response must inherit status/statusText. Using the
    // existing AppError fixture in server.test.ts as a model — here we
    // confirm 200 isn't downgraded by the rebuild.
    const res = await app.request("/__test_bare_timestamps");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
