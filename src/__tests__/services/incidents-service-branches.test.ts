import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, getDb } from "../../db/index.js";
import { incidents, projects } from "../../db/schema.js";
import {
  searchIncidents,
  retrieveRelevantIncidents,
  formatIncidentsForPrompt,
} from "../../services/incidents/service.js";

let t: ReturnType<typeof createTestDb>;

beforeEach(() => {
  t = createTestDb();
  setDb(t.db, t.sqlite);
});

function seed(row: Partial<typeof incidents.$inferInsert> & { title: string }) {
  return getDb().insert(incidents).values(row).returning().get()!;
}

describe("searchIncidents — branch gaps", () => {
  it("returns recency-ordered results when query has no searchable tokens", () => {
    const a = seed({ title: "A", symptom: "old one" });
    const b = seed({ title: "B", symptom: "new one" });
    const r = searchIncidents("   !!!  ", { limit: 10 });
    // Fallback path (no FTS expr) with recency order → newest first
    expect(r.length).toBe(2);
    expect(r[0].id).toBe(b.id);
    expect(r[1].id).toBe(a.id);
    for (const item of r) expect(item.score).toBe(0);
  });

  it("fallback path respects projectId filter", () => {
    const proj = getDb().insert(projects).values({ name: "p" }).returning().get()!;
    seed({ title: "proj-incident", projectId: proj.id, symptom: "abc" });
    seed({ title: "orphan", symptom: "abc" });

    const r = searchIncidents("", { projectId: proj.id });
    expect(r.length).toBe(1);
    expect(r[0].title).toBe("proj-incident");
  });

  it("tags filter drops rows with no overlap (FTS path)", () => {
    seed({ title: "hit", symptom: "database pool exhausted", tags: JSON.stringify(["db"]) });
    seed({ title: "miss", symptom: "database pool exhausted", tags: JSON.stringify(["tls"]) });
    const r = searchIncidents("database pool", { tags: ["db"] });
    expect(r.find((i) => i.title === "hit")).toBeDefined();
    expect(r.find((i) => i.title === "miss")).toBeUndefined();
  });

  it("tags filter with incident missing tags (null tags column) yields 0 overlap", () => {
    seed({ title: "notags", symptom: "abc def" });
    const r = searchIncidents("abc", { tags: ["x"] });
    expect(r).toEqual([]);
  });

  it("parseTags tolerates malformed JSON tags column", () => {
    // Insert raw garbage into tags via SQL, bypassing JSON.stringify
    t.sqlite.prepare("INSERT INTO incidents (title, symptom, tags) VALUES (?, ?, ?)")
      .run("garbage-tags", "abc def", "not a json array");
    const r = searchIncidents("abc");
    expect(r.length).toBe(1);
    expect(r[0].tags).toBeNull();
  });

  it("parseTags rejects non-string-array JSON (returns null)", () => {
    t.sqlite.prepare("INSERT INTO incidents (title, symptom, tags) VALUES (?, ?, ?)")
      .run("weird-tags", "search term", JSON.stringify([1, 2, 3]));
    const r = searchIncidents("search");
    expect(r[0].tags).toBeNull();
  });

  it("limit clamps to at least 1 even when caller passes 0", () => {
    seed({ title: "a", symptom: "searchable" });
    seed({ title: "b", symptom: "searchable" });
    const r = searchIncidents("searchable", { limit: 0 });
    expect(r.length).toBeLessThanOrEqual(1);
    expect(r.length).toBeGreaterThanOrEqual(1);
  });

  it("limit clamps to MAX_LIMIT", () => {
    for (let i = 0; i < 5; i++) seed({ title: `t${i}`, symptom: "searchable" });
    const r = searchIncidents("searchable", { limit: 10000 });
    expect(r.length).toBeLessThanOrEqual(100);
  });
});

describe("retrieveRelevantIncidents", () => {
  it("uses default limit=3", () => {
    for (let i = 0; i < 10; i++) seed({ title: `t${i}`, symptom: "needle found" });
    const r = retrieveRelevantIncidents("needle");
    expect(r.length).toBeLessThanOrEqual(3);
  });

  it("respects explicit limit option", () => {
    for (let i = 0; i < 10; i++) seed({ title: `t${i}`, symptom: "needle found" });
    const r = retrieveRelevantIncidents("needle", { limit: 7 });
    expect(r.length).toBeLessThanOrEqual(7);
  });
});

describe("formatIncidentsForPrompt — branch gaps", () => {
  it("returns empty string for empty array", () => {
    expect(formatIncidentsForPrompt([])).toBe("");
  });

  it("returns empty string for null/undefined", () => {
    expect(formatIncidentsForPrompt(null)).toBe("");
    expect(formatIncidentsForPrompt(undefined)).toBe("");
  });

  it("falls back to `Incident #id` when title is whitespace-only", () => {
    const md = formatIncidentsForPrompt([
      {
        id: 42, title: "   ", symptom: null, rootCause: null,
        resolution: "fixed it", tags: null, projectId: null,
        createdByChatId: null, createdAt: null, updatedAt: null, score: 0,
      },
    ]);
    expect(md).toContain("Incident #42");
  });

  it("omits the resolution when it is null/empty", () => {
    const md = formatIncidentsForPrompt([
      {
        id: 1, title: "t", symptom: null, rootCause: null,
        resolution: null, tags: null, projectId: null,
        createdByChatId: null, createdAt: null, updatedAt: null, score: 0,
      },
    ]);
    expect(md).toContain("- **t**");
    expect(md).not.toContain("—");
  });

  it("truncates long resolutions with ellipsis", () => {
    const longRes = "x".repeat(300);
    const md = formatIncidentsForPrompt([
      {
        id: 1, title: "t", symptom: null, rootCause: null,
        resolution: longRes, tags: null, projectId: null,
        createdByChatId: null, createdAt: null, updatedAt: null, score: 0,
      },
    ]);
    expect(md).toContain("…");
  });
});
