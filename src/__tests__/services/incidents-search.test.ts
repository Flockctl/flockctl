import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, closeDb, getDb } from "../../db/index.js";
import { incidents, projects } from "../../db/schema.js";
import { searchIncidents } from "../../services/incidents/service.js";
import { app } from "../../server.js";

// ─── Fixture ──────────────────────────────────────────────────────────
// 10 incidents spanning five broad themes so the queries below each have
// an obvious "right answer". The search service only indexes
// symptom/root_cause/resolution, so every row's discriminative terms are
// placed inside those three fields (not inside `title` or `tags`).

interface FixtureRow {
  title: string;
  symptom: string;
  rootCause: string;
  resolution: string;
  tags: string[];
  /** Optional — lets us exercise the project filter. */
  projectId?: number | null;
}

const FIXTURE: FixtureRow[] = [
  {
    title: "DB pool exhausted",
    symptom: "Database connection pool exhausted under peak load; users see 503.",
    rootCause: "Max database pool size was too low for the traffic profile.",
    resolution: "Raised database pool size and enabled connection reuse.",
    tags: ["db", "postgres", "performance"],
  },
  {
    title: "Slow list endpoint",
    symptom: "Slow database query in the list endpoint takes five seconds.",
    rootCause: "Missing index on the tasks.project_id column in the sqlite database.",
    resolution: "Added composite index on project_id and created_at.",
    tags: ["performance", "sqlite"],
  },
  {
    title: "TLS handshake failure",
    symptom: "TLS network handshake fails when calling the upstream service.",
    rootCause: "Expired CA bundle on the runner image.",
    resolution: "Refreshed the CA certificates and rebuilt the runner image.",
    tags: ["tls", "network"],
  },
  {
    title: "WebSocket memory leak",
    symptom: "Memory leak in the websocket handler gradually consumes RAM.",
    rootCause: "Subscribers were not removed from the map on socket close.",
    resolution: "Registered a cleanup callback on websocket disconnect.",
    tags: ["websocket", "memory", "leak"],
  },
  {
    title: "OpenAI 429 rate limit",
    symptom: "OpenAI API returns 429 rate limit errors on request bursts.",
    rootCause: "No client-side token bucket throttling outgoing calls.",
    resolution: "Added a token bucket and exponential backoff on 429.",
    tags: ["api", "rate-limit", "openai"],
  },
  {
    title: "Auth 401 regression",
    symptom: "Authentication requests return 401 after the token refresh change.",
    rootCause: "Refresh token not persisted in the new flow.",
    resolution: "Restored refresh token storage and rotated signing keys.",
    tags: ["auth", "regression"],
  },
  {
    title: "Disk full",
    symptom: "Disk full condition prevents writes; log files are dropped.",
    rootCause: "Logrotate was disabled on the host.",
    resolution: "Re-enabled logrotate and purged archived logs.",
    tags: ["disk", "io"],
  },
  {
    title: "CORS error",
    symptom: "CORS network error blocks browser API calls from the UI origin.",
    rootCause: "UI origin was not whitelisted in the CORS network configuration.",
    resolution: "Added the UI origin to the CORS whitelist.",
    tags: ["cors", "network"],
  },
  {
    title: "OAuth redirect loop",
    symptom: "OAuth authentication redirect loop after refresh on Safari.",
    rootCause: "Cookie SameSite=Strict blocked the redirect callback.",
    resolution: "Changed SameSite to Lax for the auth cookies.",
    tags: ["auth", "oauth"],
  },
  {
    title: "Scheduler missed cron",
    symptom: "Scheduler misses a cron job after daylight savings transitions.",
    rootCause: "Cron parser used local time instead of UTC.",
    resolution: "Forced UTC when computing the next cron trigger.",
    tags: ["scheduler", "cron"],
  },
];

function seedFixture(): void {
  // Direct insert bypassing the HTTP layer — we're testing the service.
  for (const row of FIXTURE) {
    getDb()
      .insert(incidents)
      .values({
        title: row.title,
        symptom: row.symptom,
        rootCause: row.rootCause,
        resolution: row.resolution,
        tags: JSON.stringify(row.tags),
        projectId: row.projectId ?? null,
      })
      .run();
  }
}

describe("searchIncidents() — FTS5 + tag filter service", () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    seedFixture();
  });

  afterEach(() => {
    closeDb();
  });

  // ─── Precision fixture ────────────────────────────────────────────
  // Five natural-language queries, each with a single "ground-truth" doc.
  // Precision@3 here = fraction of queries whose expected doc is in the
  // top-3 results. The spec requires >= 0.7, i.e. at least 4 of 5 queries
  // must return the expected doc in their top-3.

  it("precision@3 across 5 queries is >= 0.7", () => {
    const queries: Array<{ q: string; expectedTitle: string }> = [
      { q: "database pool exhausted", expectedTitle: "DB pool exhausted" },
      { q: "memory leak websocket", expectedTitle: "WebSocket memory leak" },
      { q: "rate limit openai", expectedTitle: "OpenAI 429 rate limit" },
      { q: "oauth redirect safari", expectedTitle: "OAuth redirect loop" },
      { q: "cron scheduler daylight", expectedTitle: "Scheduler missed cron" },
    ];

    let hits = 0;
    for (const { q, expectedTitle } of queries) {
      const top3 = searchIncidents(q, { limit: 3 });
      if (top3.some((r) => r.title === expectedTitle)) hits += 1;
    }
    const precision = hits / queries.length;
    expect(precision).toBeGreaterThanOrEqual(0.7);
  });

  // ─── Individual behavioural assertions ────────────────────────────

  it("ranks the textually-best match first for a distinctive query", () => {
    const results = searchIncidents("websocket memory leak");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("WebSocket memory leak");
  });

  it("returns results sorted by score descending", () => {
    const results = searchIncidents("database");
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("respects the limit parameter", () => {
    const results = searchIncidents("database", { limit: 1 });
    expect(results.length).toBe(1);
  });

  it("clamps limit to a minimum of 1", () => {
    const results = searchIncidents("database", { limit: 0 });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("boosts score for tag intersection when tags are provided", () => {
    // "performance" matches both docs 1 (DB pool) and 2 (slow SQL).
    // Without the tags filter, doc 1 wins on "database". With tags: ["sqlite"]
    // the filter keeps only doc 2.
    const withoutTags = searchIncidents("database", { limit: 5 });
    expect(withoutTags[0].title).toBe("DB pool exhausted");

    const withTag = searchIncidents("database", { tags: ["sqlite"] });
    // Tag filter removes the DB-pool row (no "sqlite" tag).
    expect(withTag.every((r) => r.tags?.includes("sqlite"))).toBe(true);
    expect(withTag[0].title).toBe("Slow list endpoint");
  });

  it("drops rows that have no intersection with the tags filter", () => {
    const results = searchIncidents("network", { tags: ["cors"] });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.tags).toBeTruthy();
      expect(r.tags!).toContain("cors");
    }
  });

  it("filters by projectId", () => {
    // Seed a project first so the FK constraint on incidents.project_id is
    // satisfied, then add one incident scoped to it.
    const project = getDb()
      .insert(projects)
      .values({ name: "Proj42", path: "/tmp/proj42" })
      .returning()
      .get();

    getDb()
      .insert(incidents)
      .values({
        title: "Project-scoped DB issue",
        symptom: "Database issue that only exists in this particular project.",
        rootCause: "Misconfigured pool for this project.",
        resolution: "Adjusted per-project pool settings.",
        tags: JSON.stringify(["db"]),
        projectId: project.id,
      })
      .run();

    const scoped = searchIncidents("database", { projectId: project.id });
    expect(scoped.length).toBe(1);
    expect(scoped[0].projectId).toBe(project.id);
    expect(scoped[0].title).toBe("Project-scoped DB issue");
  });

  it("falls back to recency when the query is empty", () => {
    const results = searchIncidents("   ", { limit: 5 });
    // All scores are 0 in the fallback path; order is newest-first by
    // insertion, which in our fixture is the last row inserted.
    expect(results.length).toBe(5);
    for (const r of results) expect(r.score).toBe(0);
  });

  it("tolerates punctuation and special characters in the query", () => {
    // FTS5 syntax would otherwise choke on bare punctuation.
    const results = searchIncidents("websocket! (memory) -- leak??");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("WebSocket memory leak");
  });

  it("returns parsed tags as string[] on every result", () => {
    const results = searchIncidents("database", { limit: 3 });
    for (const r of results) {
      expect(Array.isArray(r.tags)).toBe(true);
      for (const t of r.tags!) expect(typeof t).toBe("string");
    }
  });

  // ─── HTTP adapter smoke test (route is a thin adapter) ────────────

  it("GET /incidents/search returns the service output as JSON", async () => {
    const res = await app.request("/incidents/search?q=websocket%20memory");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ title: string; score: number; tags: string[] | null }>;
      total: number;
    };
    expect(body.total).toBeGreaterThan(0);
    expect(body.items[0].title).toBe("WebSocket memory leak");
    expect(typeof body.items[0].score).toBe("number");
  });

  it("GET /incidents/search accepts a tags CSV", async () => {
    const res = await app.request("/incidents/search?q=database&tags=sqlite");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ tags: string[] | null }>;
    };
    for (const item of body.items) {
      expect(item.tags).toContain("sqlite");
    }
  });

  it("GET /incidents/search rejects a non-numeric projectId with 422", async () => {
    const res = await app.request("/incidents/search?q=x&projectId=abc");
    expect(res.status).toBe(422);
  });

  it("GET /incidents/search rejects a non-numeric limit with 422", async () => {
    const res = await app.request("/incidents/search?q=x&limit=abc");
    expect(res.status).toBe(422);
  });

  it("GET /incidents/search accepts a numeric projectId and limit", async () => {
    const project = getDb()
      .insert(projects)
      .values({ name: "Proj99", path: "/tmp/proj99" })
      .returning()
      .get();
    const res = await app.request(
      `/incidents/search?q=database&projectId=${project.id}&limit=5`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    // No incidents belong to the new project yet, so results are empty.
    expect(body.items).toEqual([]);
  });
});
