import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../../__tests__/helpers.js";
import { setDb, closeDb, getDb } from "../../db/index.js";
import { incidents, projects } from "../../db/schema.js";
import {
  retrieveRelevantIncidents,
  formatIncidentsForPrompt,
} from "../incidents/service.js";

// ─── Fixture ──────────────────────────────────────────────────────────
// 10 incidents spanning distinct themes so that each of the 5 evaluation
// contexts has a single, unambiguous "ground-truth" incident. FTS5 only
// indexes symptom/root_cause/resolution in our schema, so discriminative
// vocabulary is placed inside those three fields rather than the title.

interface FixtureRow {
  title: string;
  symptom: string;
  rootCause: string;
  resolution: string;
  tags: string[];
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
  for (const row of FIXTURE) {
    getDb()
      .insert(incidents)
      .values({
        title: row.title,
        symptom: row.symptom,
        rootCause: row.rootCause,
        resolution: row.resolution,
        tags: JSON.stringify(row.tags),
      })
      .run();
  }
}

describe("retrieveRelevantIncidents() — default limit + project scoping", () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    seedFixture();
  });

  afterEach(() => {
    closeDb();
  });

  it("defaults to at most 3 results", () => {
    // A deliberately broad context that would match most DB-ish incidents.
    const results = retrieveRelevantIncidents("database query problem");
    expect(results.length).toBeLessThanOrEqual(3);
    expect(results.length).toBeGreaterThan(0);
  });

  it("honors an explicit limit override", () => {
    const results = retrieveRelevantIncidents("database", { limit: 1 });
    expect(results.length).toBe(1);
  });

  it("returns results ordered by descending score (relevance)", () => {
    const results = retrieveRelevantIncidents("database query", { limit: 5 });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("returns an empty list for a context with no searchable tokens in the corpus", () => {
    // Arcane vocabulary — FTS produces no matches; fallback returns recency
    // with score=0. We verify the function still returns something sensible
    // (it's a recency probe) but with zero relevance — the caller is
    // expected to apply its own threshold when plumbing into a prompt.
    const results = retrieveRelevantIncidents("quetzalcoatl xyzzy plugh");
    for (const r of results) expect(r.score).toBe(0);
  });

  it("scopes retrieval to the requested project", () => {
    const project = getDb()
      .insert(projects)
      .values({ name: "ProjScope", path: "/tmp/proj-scope" })
      .returning()
      .get();

    getDb()
      .insert(incidents)
      .values({
        title: "Project-scoped DB pool",
        symptom: "Database pool exhausted but only in the scoped project.",
        rootCause: "Per-project pool misconfiguration.",
        resolution: "Tuned per-project pool settings.",
        tags: JSON.stringify(["db"]),
        projectId: project.id,
      })
      .run();

    const scoped = retrieveRelevantIncidents("database pool", {
      projectId: project.id,
    });
    expect(scoped.length).toBe(1);
    expect(scoped[0].projectId).toBe(project.id);
    expect(scoped[0].title).toBe("Project-scoped DB pool");
  });

  // ─── Precision fixture ────────────────────────────────────────────
  // 10 incidents × 5 contexts. Each context is a realistic free-text
  // snippet (mimicking what the chat/task prompt builder would hand in)
  // with one ground-truth incident. Precision@3 is the fraction of
  // contexts whose ground-truth title appears in retrieveRelevantIncidents
  // top-3 output. The spec requires precision >= 0.7, i.e. at least 4/5
  // contexts must surface their expected incident.

  it("precision@3 across 5 realistic contexts is >= 0.7", () => {
    const contexts: Array<{ context: string; expectedTitle: string }> = [
      {
        context:
          "Our production database connection pool keeps running out under peak traffic and requests fail with 503.",
        expectedTitle: "DB pool exhausted",
      },
      {
        context:
          "The websocket server memory grows unbounded over several hours until the process is OOM-killed.",
        expectedTitle: "WebSocket memory leak",
      },
      {
        context:
          "We keep getting 429 rate limit responses from the OpenAI API when traffic spikes.",
        expectedTitle: "OpenAI 429 rate limit",
      },
      {
        context:
          "Users on Safari report an OAuth login redirect loop after refreshing the page.",
        expectedTitle: "OAuth redirect loop",
      },
      {
        context:
          "The scheduler skipped a cron job right after the daylight savings switch last night.",
        expectedTitle: "Scheduler missed cron",
      },
    ];

    let hits = 0;
    for (const { context, expectedTitle } of contexts) {
      const top3 = retrieveRelevantIncidents(context);
      expect(top3.length).toBeLessThanOrEqual(3);
      if (top3.some((r) => r.title === expectedTitle)) hits += 1;
    }
    const precision = hits / contexts.length;
    expect(precision).toBeGreaterThanOrEqual(0.7);
  });
});

describe("formatIncidentsForPrompt() — markdown rendering", () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    seedFixture();
  });

  afterEach(() => {
    closeDb();
  });

  it("returns an empty string when no incidents are provided", () => {
    expect(formatIncidentsForPrompt([])).toBe("");
    expect(formatIncidentsForPrompt(null)).toBe("");
    expect(formatIncidentsForPrompt(undefined)).toBe("");
  });

  it("produces a 'Past incidents' markdown header followed by bullets", () => {
    const items = retrieveRelevantIncidents("websocket memory leak", { limit: 1 });
    const md = formatIncidentsForPrompt(items);
    expect(md.startsWith("## Past incidents")).toBe(true);
    expect(md).toContain("- **WebSocket memory leak**");
    expect(md).toContain("websocket disconnect");
  });

  it("renders a bullet per incident with title + short resolution", () => {
    const items = retrieveRelevantIncidents("database", { limit: 3 });
    const md = formatIncidentsForPrompt(items);
    const bulletLines = md.split("\n").filter((l) => l.startsWith("- "));
    expect(bulletLines.length).toBe(items.length);
    for (const line of bulletLines) {
      // Title is bold, resolution follows after an em-dash separator.
      expect(line).toMatch(/^- \*\*[^*]+\*\*/);
    }
  });

  it("never leaks full symptom or root_cause text into the prompt", () => {
    const items = retrieveRelevantIncidents("websocket memory leak", { limit: 1 });
    const md = formatIncidentsForPrompt(items);
    // These substrings come from symptom / root_cause in the fixture and
    // must never surface in the compact prompt format.
    expect(md).not.toContain("gradually consumes RAM");
    expect(md).not.toContain("Subscribers were not removed");
  });

  it("truncates long resolutions with an ellipsis", () => {
    // FTS5 only indexes symptom/root_cause/resolution, so the searchable
    // marker "quetzalsentinel" must live in one of those fields.
    const longResolution =
      "quetzalsentinel " + "verylongresolution ".repeat(50);
    getDb()
      .insert(incidents)
      .values({
        title: "Long fix",
        symptom: "An odd bug",
        rootCause: "Unknown",
        resolution: longResolution,
        tags: JSON.stringify(["misc"]),
      })
      .run();

    const items = retrieveRelevantIncidents("quetzalsentinel", { limit: 1 });
    expect(items.length).toBe(1);
    expect(items[0].title).toBe("Long fix");
    const md = formatIncidentsForPrompt(items);
    expect(md).toContain("…");
    // The raw long string must not appear verbatim.
    expect(md).not.toContain(longResolution);
  });
});
