import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, closeDb, getDb } from "../../db/index.js";
import { usageRecords, projects } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import type { AIClient } from "../../services/ai/client.js";
import {
  extractIncidentFromMessages,
  type ExtractorMessage,
} from "../../services/incidents/extractor.js";

// ─── Mock AI client ──────────────────────────────────────────────────────
// A tiny spy client that captures the last chat() call and returns a
// scripted result. We do NOT import the real `createAIClient` — the
// extractor accepts a client via opts so the Claude Code SDK never enters
// the test graph.
interface ScriptedResult {
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  costUsd?: number;
}

function makeClient(script: ScriptedResult | Error): {
  client: AIClient;
  calls: Array<{ model: string; system: string; messages: unknown[] }>;
} {
  const calls: Array<{ model: string; system: string; messages: unknown[] }> = [];
  const client: AIClient = {
    async chat(opts) {
      calls.push({ model: opts.model, system: opts.system, messages: opts.messages });
      if (script instanceof Error) throw script;
      return {
        text: script.text,
        usage: script.usage ?? {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        costUsd: script.costUsd ?? 0.00042,
      };
    },
  };
  return { client, calls };
}

// ─── Three fixture dialogs ───────────────────────────────────────────────
// Each exercises a different shape of chat — a short user-reports-bug
// exchange, a longer debug thread with an explicit root-cause sentence,
// and a mixed assistant/user transcript where the resolution is proposed
// by the assistant.

const FIXTURE_DB_POOL: ExtractorMessage[] = [
  {
    role: "user",
    content:
      "Our users are getting 503s every afternoon around peak traffic. The DB seems fine but requests pile up.",
  },
  {
    role: "assistant",
    content:
      "Sounds like the database connection pool is exhausted. Try raising max_connections and enabling connection reuse.",
  },
  {
    role: "user",
    content: "That worked — bumped pool from 20 to 80 and enabled reuse. 503s gone.",
  },
];

const FIXTURE_TLS: ExtractorMessage[] = [
  {
    role: "user",
    content: "Upstream calls started failing this morning with 'TLS handshake failure'.",
  },
  {
    role: "assistant",
    content:
      "Likely an expired CA bundle on the runner image. Rebuild the image with a fresh ca-certificates package.",
  },
  {
    role: "user",
    content: "Confirmed — rebuilt runner image with updated CA bundle, all calls succeed now.",
  },
];

const FIXTURE_WS_LEAK: ExtractorMessage[] = [
  {
    role: "user",
    content:
      "The daemon's RAM grows continuously — started at 300MB, now sitting at 2.1GB after 4 days.",
  },
  {
    role: "assistant",
    content:
      "That's a memory leak in the websocket handler — subscribers aren't being removed from the map on disconnect.",
  },
  {
    role: "assistant",
    content:
      "I'll register a cleanup callback on socket close so the map entry is dropped when the client goes away.",
  },
  { role: "user", content: "Deployed the fix. Memory is flat again." },
];

// ─── DB lifecycle ────────────────────────────────────────────────────────

let sqlite: { close(): void };
beforeEach(() => {
  const t = createTestDb();
  sqlite = t.sqlite;
  setDb(t.db);
  // Seed a project so FK-set null doesn't trip and we can assert projectId
  // attribution on usage rows.
  t.db.insert(projects).values({ name: "extract-proj" }).run();
});
afterEach(() => {
  closeDb();
  sqlite.close();
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe("extractIncidentFromMessages — happy path across 3 fixtures", () => {
  it("returns non-empty structured fields for the DB-pool transcript", async () => {
    const scripted = {
      text: JSON.stringify({
        title: "DB connection pool exhausted at peak",
        symptom: "Users see 503s during afternoon peak traffic.",
        root_cause: "Database connection pool was undersized for peak load.",
        resolution: "Raised pool from 20 to 80 and enabled connection reuse.",
        tags: ["db", "performance", "503"],
      }),
    };
    const { client } = makeClient(scripted);

    const draft = await extractIncidentFromMessages(FIXTURE_DB_POOL, { client });

    expect(draft.title.length).toBeGreaterThan(0);
    expect(draft.symptom.length).toBeGreaterThan(0);
    expect(draft.rootCause.length).toBeGreaterThan(0);
    expect(draft.resolution.length).toBeGreaterThan(0);
    expect(draft.tags).toEqual(["db", "performance", "503"]);
    // Sanity: the extractor maps snake_case -> camelCase for rootCause.
    expect(draft.rootCause).toMatch(/pool/i);
  });

  it("returns non-empty structured fields for the TLS transcript", async () => {
    const scripted = {
      text: JSON.stringify({
        title: "Upstream TLS handshake failures",
        symptom: "Outbound calls started failing with TLS handshake errors.",
        rootCause: "Expired CA bundle on the runner image.",
        resolution: "Rebuilt the runner image with refreshed ca-certificates.",
        tags: ["TLS", "Network"],
      }),
    };
    const { client } = makeClient(scripted);

    const draft = await extractIncidentFromMessages(FIXTURE_TLS, { client });

    expect(draft.title).toMatch(/TLS/i);
    expect(draft.symptom).toMatch(/handshake/i);
    expect(draft.rootCause).toMatch(/CA/i);
    expect(draft.resolution).toMatch(/rebuil/i);
    // Tags should be lowercased + deduped-by-pass (here just lowercase).
    expect(draft.tags).toEqual(["tls", "network"]);
  });

  it("returns non-empty structured fields for the websocket-leak transcript", async () => {
    const scripted = {
      text: JSON.stringify({
        title: "WebSocket handler memory leak",
        symptom: "Daemon RAM grows from 300MB to 2.1GB over four days.",
        root_cause: "Websocket subscribers were not removed from the map on disconnect.",
        resolution: "Registered a cleanup callback on socket close.",
        tags: ["memory", "websocket", "leak"],
      }),
    };
    const { client } = makeClient(scripted);

    const draft = await extractIncidentFromMessages(FIXTURE_WS_LEAK, { client });

    for (const k of ["title", "symptom", "rootCause", "resolution"] as const) {
      expect(draft[k]).toBeTruthy();
      expect(draft[k].length).toBeGreaterThan(0);
    }
    expect(draft.tags.length).toBeGreaterThan(0);
    expect(draft.tags).toContain("memory");
  });
});

describe("extractIncidentFromMessages — single LLM call", () => {
  it("makes exactly one chat() call, using the default haiku model", async () => {
    const { client, calls } = makeClient({
      text: JSON.stringify({ title: "x", symptom: "", rootCause: "", resolution: "", tags: [] }),
    });
    await extractIncidentFromMessages(FIXTURE_DB_POOL, { client });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("claude-haiku-4-5");
    expect(calls[0].system).toMatch(/JSON/);
  });

  it("honors a caller-supplied model override", async () => {
    const { client, calls } = makeClient({ text: "{}" });
    await extractIncidentFromMessages(FIXTURE_DB_POOL, {
      client,
      model: "claude-sonnet-4-6",
    });
    expect(calls[0].model).toBe("claude-sonnet-4-6");
  });
});

describe("extractIncidentFromMessages — fallback on LLM error", () => {
  it("returns an empty draft (never throws) when the client errors", async () => {
    const { client } = makeClient(new Error("rate limited"));
    const draft = await extractIncidentFromMessages(FIXTURE_DB_POOL, { client });
    expect(draft).toEqual({
      title: "",
      symptom: "",
      rootCause: "",
      resolution: "",
      tags: [],
    });
  });

  it("returns an empty draft when the LLM returns non-JSON text", async () => {
    const { client } = makeClient({ text: "I'm sorry, I can't help with that." });
    const draft = await extractIncidentFromMessages(FIXTURE_TLS, { client });
    expect(draft).toEqual({
      title: "",
      symptom: "",
      rootCause: "",
      resolution: "",
      tags: [],
    });
  });

  it("returns an empty draft when JSON is malformed", async () => {
    const { client } = makeClient({ text: '{"title": "broken", "symptom":' });
    const draft = await extractIncidentFromMessages(FIXTURE_TLS, { client });
    expect(draft.title).toBe("");
    expect(draft.tags).toEqual([]);
  });

  it("returns an empty draft when the transcript is empty", async () => {
    const { client, calls } = makeClient({ text: "{}" });
    const draft = await extractIncidentFromMessages([], { client });
    expect(draft.title).toBe("");
    // Critical: no LLM call is made when there is nothing to extract from,
    // otherwise we waste tokens on blank prompts.
    expect(calls).toHaveLength(0);
  });

  it("tolerates messages whose content is whitespace-only (no LLM call)", async () => {
    const { client, calls } = makeClient({ text: "{}" });
    const draft = await extractIncidentFromMessages(
      [
        { role: "user", content: "   " },
        { role: "assistant", content: "" },
      ],
      { client },
    );
    expect(draft.title).toBe("");
    expect(calls).toHaveLength(0);
  });
});

describe("extractIncidentFromMessages — output coercion", () => {
  it("strips a ```json fence that the model emitted despite instructions", async () => {
    const payload = {
      title: "Fenced title",
      symptom: "s",
      root_cause: "rc",
      resolution: "r",
      tags: ["a"],
    };
    const { client } = makeClient({
      text: "```json\n" + JSON.stringify(payload) + "\n```",
    });
    const draft = await extractIncidentFromMessages(FIXTURE_DB_POOL, { client });
    expect(draft.title).toBe("Fenced title");
    expect(draft.rootCause).toBe("rc");
  });

  it("lowercases and clamps tags to at most 6 entries", async () => {
    const { client } = makeClient({
      text: JSON.stringify({
        title: "t",
        symptom: "s",
        root_cause: "rc",
        resolution: "r",
        tags: ["DB", "PERF", "C", "D", "E", "F", "G", "H"],
      }),
    });
    const draft = await extractIncidentFromMessages(FIXTURE_DB_POOL, { client });
    expect(draft.tags).toHaveLength(6);
    expect(draft.tags.every((t) => t === t.toLowerCase())).toBe(true);
  });

  it("drops non-string tag entries defensively", async () => {
    const { client } = makeClient({
      text: JSON.stringify({
        title: "t",
        symptom: "s",
        rootCause: "rc",
        resolution: "r",
        tags: ["db", 42, null, "network"],
      }),
    });
    const draft = await extractIncidentFromMessages(FIXTURE_DB_POOL, { client });
    expect(draft.tags).toEqual(["db", "network"]);
  });

  it("accepts both camelCase and snake_case for rootCause", async () => {
    const { client: clientSnake } = makeClient({
      text: JSON.stringify({ title: "t", symptom: "", root_cause: "snake wins", resolution: "", tags: [] }),
    });
    const draftSnake = await extractIncidentFromMessages(FIXTURE_DB_POOL, { client: clientSnake });
    expect(draftSnake.rootCause).toBe("snake wins");

    const { client: clientCamel } = makeClient({
      text: JSON.stringify({ title: "t", symptom: "", rootCause: "camel wins", resolution: "", tags: [] }),
    });
    const draftCamel = await extractIncidentFromMessages(FIXTURE_DB_POOL, { client: clientCamel });
    expect(draftCamel.rootCause).toBe("camel wins");
  });
});

describe("extractIncidentFromMessages — usage recording", () => {
  it("writes a usage_records row with activity_type='incident_extract'", async () => {
    const { client } = makeClient({
      text: JSON.stringify({ title: "t", symptom: "s", root_cause: "rc", resolution: "r", tags: [] }),
      usage: {
        inputTokens: 420,
        outputTokens: 77,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      costUsd: 0.000123,
    });

    await extractIncidentFromMessages(FIXTURE_DB_POOL, {
      client,
      projectId: 1,
    });

    const rows = getDb().select().from(usageRecords).all();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.activityType).toBe("incident_extract");
    expect(row.provider).toBe("anthropic");
    expect(row.model).toBe("claude-haiku-4-5");
    expect(row.inputTokens).toBe(420);
    expect(row.outputTokens).toBe(77);
    expect(row.projectId).toBe(1);
    expect(row.totalCostUsd).toBeCloseTo(0.000123, 8);
    // No task or chat message attribution for extractor calls.
    expect(row.taskId).toBeNull();
    expect(row.chatMessageId).toBeNull();
  });

  it("does NOT write usage when the client errors", async () => {
    const { client } = makeClient(new Error("boom"));
    await extractIncidentFromMessages(FIXTURE_DB_POOL, { client, projectId: 1 });
    const rows = getDb().select().from(usageRecords).all();
    expect(rows).toHaveLength(0);
  });

  it("attributes to project when projectId is provided", async () => {
    const { client } = makeClient({
      text: JSON.stringify({ title: "t", symptom: "", rootCause: "", resolution: "", tags: [] }),
    });
    await extractIncidentFromMessages(FIXTURE_DB_POOL, { client, projectId: 1 });
    const row = getDb().select().from(usageRecords).where(eq(usageRecords.projectId, 1)).get();
    expect(row).toBeDefined();
    expect(row!.activityType).toBe("incident_extract");
  });

  it("leaves projectId NULL when not provided", async () => {
    const { client } = makeClient({
      text: JSON.stringify({ title: "t", symptom: "", rootCause: "", resolution: "", tags: [] }),
    });
    await extractIncidentFromMessages(FIXTURE_DB_POOL, { client });
    const rows = getDb().select().from(usageRecords).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].projectId).toBeNull();
  });
});
