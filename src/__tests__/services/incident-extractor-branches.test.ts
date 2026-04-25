import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { setDb, getDb } from "../../db/index.js";
import { usageRecords } from "../../db/schema.js";
import type { AIClient } from "../../services/ai/client.js";
import {
  extractIncidentFromMessages,
  type ExtractorMessage,
} from "../../services/incidents/extractor.js";

function client(result: { text: string; usage?: any; costUsd?: number } | Error): AIClient {
  return {
    async chat() {
      if (result instanceof Error) throw result;
      return {
        text: result.text,
        usage: result.usage,
        costUsd: result.costUsd,
      };
    },
  };
}

let t: ReturnType<typeof createTestDb>;
beforeEach(() => {
  t = createTestDb();
  setDb(t.db, t.sqlite);
});

describe("incident extractor — branch gaps", () => {
  it("messages=null → empty draft (no LLM call)", async () => {
    let called = false;
    const c: AIClient = { async chat() { called = true; return { text: "{}", usage: undefined, costUsd: 0 }; } };
    const draft = await extractIncidentFromMessages(null as any, { client: c });
    expect(draft).toEqual({ title: "", symptom: "", rootCause: "", resolution: "", tags: [] });
    expect(called).toBe(false);
  });

  it("empty messages array → empty draft", async () => {
    const draft = await extractIncidentFromMessages([], { client: client({ text: "{}" }) });
    expect(draft.title).toBe("");
  });

  it("non-string message content is dropped from transcript", async () => {
    const msgs: ExtractorMessage[] = [
      { role: "user", content: "real content" },
      { role: "assistant", content: null as any }, // dropped
      { role: "user", content: 42 as any }, // dropped
      { role: "assistant", content: "   " }, // blank → dropped
    ];
    const draft = await extractIncidentFromMessages(msgs, {
      client: client({ text: JSON.stringify({ title: "ok" }) }),
      db: getDb(),
    });
    expect(draft.title).toBe("ok");
  });

  it("extractJsonObject handles escaped backslash inside string", async () => {
    // The response has a \\ inside a quoted string — exercises the escape branch
    const json = `{"title":"a\\\\b","symptom":"","root_cause":"","resolution":"","tags":[]}`;
    const draft = await extractIncidentFromMessages(
      [{ role: "user", content: "hi" }],
      { client: client({ text: `Here is the JSON:\n${json}` }) },
    );
    expect(draft.title).toBe("a\\b");
  });

  it("stripFence handles ```json fence wrapper", async () => {
    const draft = await extractIncidentFromMessages(
      [{ role: "user", content: "hi" }],
      {
        client: client({ text: "```json\n{\"title\":\"fenced\",\"tags\":[\"x\"]}\n```" }),
      },
    );
    expect(draft.title).toBe("fenced");
    expect(draft.tags).toEqual(["x"]);
  });

  it("returns empty draft when JSON is not parseable", async () => {
    const draft = await extractIncidentFromMessages(
      [{ role: "user", content: "hi" }],
      { client: client({ text: "{not valid json at all {{{" }) },
    );
    expect(draft).toEqual({ title: "", symptom: "", rootCause: "", resolution: "", tags: [] });
  });

  it("returns empty draft when no JSON object found in text", async () => {
    const draft = await extractIncidentFromMessages(
      [{ role: "user", content: "hi" }],
      { client: client({ text: "plain text no braces" }) },
    );
    expect(draft).toEqual({ title: "", symptom: "", rootCause: "", resolution: "", tags: [] });
  });

  it("returns empty draft when parsed JSON is an array (not object)", async () => {
    const draft = await extractIncidentFromMessages(
      [{ role: "user", content: "hi" }],
      { client: client({ text: '["a","b"]' }) },
    );
    expect(draft.title).toBe("");
  });

  it("returns empty draft when AI client throws", async () => {
    const draft = await extractIncidentFromMessages(
      [{ role: "user", content: "hi" }],
      { client: client(new Error("boom")) },
    );
    expect(draft).toEqual({ title: "", symptom: "", rootCause: "", resolution: "", tags: [] });
  });

  it("records usage with ?? 0 fallback when fields missing", async () => {
    // Usage object with some nullish fields — exercises the `?? 0` branches
    const msgs: ExtractorMessage[] = [{ role: "user", content: "transcript" }];
    await extractIncidentFromMessages(msgs, {
      // Cast exercises the `?? 0` fallback branches for null/undefined usage
      // fields — the production client never hands back null, but the route
      // is deliberately tolerant.
      client: client({
        text: '{"title":"t"}',
        usage: { inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null },
        costUsd: null,
      } as unknown as { text: string; usage: { inputTokens: number; outputTokens: number }; costUsd: number }),
      projectId: null,
    });
    const rows = getDb().select().from(usageRecords).all();
    expect(rows.length).toBe(1);
    expect(rows[0].inputTokens).toBe(0);
    expect(rows[0].outputTokens).toBe(0);
    expect(rows[0].totalCostUsd).toBe(0);
  });

  it("skips usage when result has no usage field", async () => {
    const msgs: ExtractorMessage[] = [{ role: "user", content: "transcript" }];
    await extractIncidentFromMessages(msgs, {
      client: client({ text: '{"title":"x"}' }),
    });
    const rows = getDb().select().from(usageRecords).all();
    expect(rows.length).toBe(0);
  });

  it("coerces tags: strips empty, lowercases, caps at 6", async () => {
    const draft = await extractIncidentFromMessages(
      [{ role: "user", content: "hi" }],
      {
        client: client({
          text: JSON.stringify({
            title: "t",
            tags: ["A", " b ", "", "C", 1, "D", "E", "F", "G", "H"],
          }),
        }),
      },
    );
    expect(draft.tags.length).toBe(6);
    expect(draft.tags).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("accepts rootCause (camelCase) instead of root_cause", async () => {
    const draft = await extractIncidentFromMessages(
      [{ role: "user", content: "hi" }],
      {
        client: client({
          text: JSON.stringify({ title: "t", rootCause: "camel-case-root" }),
        }),
      },
    );
    expect(draft.rootCause).toBe("camel-case-root");
  });
});
