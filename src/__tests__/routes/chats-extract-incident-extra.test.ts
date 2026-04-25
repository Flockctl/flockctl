/**
 * Covers the branches of POST /chats/:id/extract-incident that
 * chats-extract-incident.test.ts doesn't:
 *  - happy path: active key present + extractor returns a non-empty draft
 *  - extractor throws → coerced to empty draft (catch branch)
 *  - messageIds filter yields zero matches → empty draft
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../services/incidents/extractor", () => ({
  extractIncidentFromMessages: vi.fn(),
}));

import { app } from "../../server.js";
import { createTestDb, seedActiveKey } from "../helpers.js";
import { setDb, closeDb } from "../../db/index.js";
import { chats, chatMessages } from "../../db/schema.js";
import { extractIncidentFromMessages } from "../../services/incidents/extractor.js";

const mockExtract = extractIncidentFromMessages as unknown as ReturnType<typeof vi.fn>;

describe("POST /chats/:id/extract-incident (extractor path)", () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
    seedActiveKey(testDb.sqlite);
    mockExtract.mockReset();
  });

  afterEach(() => {
    closeDb();
  });

  function seedChat(numMessages: number): { chatId: number; msgIds: number[] } {
    const chat = testDb.db.insert(chats).values({ title: "x" }).returning().get();
    const msgIds: number[] = [];
    for (let i = 0; i < numMessages; i++) {
      const m = testDb.db
        .insert(chatMessages)
        .values({
          chatId: chat.id,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `message ${i}`,
        })
        .returning()
        .get();
      msgIds.push(m.id);
    }
    return { chatId: chat.id, msgIds };
  }

  it("returns the extractor's draft on success", async () => {
    const { chatId } = seedChat(2);
    const draft = {
      title: "DB outage",
      symptom: "502s",
      rootCause: "disk full",
      resolution: "cleared logs",
      tags: ["db", "prod"],
    };
    mockExtract.mockResolvedValue(draft);

    const res = await app.request(`/chats/${chatId}/extract-incident`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft).toEqual(draft);
    // extractor was called with messages+context
    expect(mockExtract).toHaveBeenCalledTimes(1);
    const [messages, context] = mockExtract.mock.calls[0]!;
    expect(Array.isArray(messages)).toBe(true);
    expect(messages).toHaveLength(2);
    expect(context.chatId).toBe(chatId);
    expect(context.abortSignal).toBeDefined();
  });

  it("filters by messageIds when provided", async () => {
    const { chatId, msgIds } = seedChat(3);
    mockExtract.mockResolvedValue({
      title: "t",
      symptom: "",
      rootCause: "",
      resolution: "",
      tags: [],
    });

    const res = await app.request(`/chats/${chatId}/extract-incident`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageIds: [msgIds[0], msgIds[1]] }),
    });
    expect(res.status).toBe(200);
    expect(mockExtract).toHaveBeenCalledTimes(1);
    const messages = mockExtract.mock.calls[0]![0];
    expect(messages).toHaveLength(2);
  });

  it("returns empty draft when messageIds filter matches zero existing messages", async () => {
    const { chatId } = seedChat(2);

    const res = await app.request(`/chats/${chatId}/extract-incident`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageIds: [999_999] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft.title).toBe("");
    expect(body.draft.tags).toEqual([]);
    // extractor should not be called when there's nothing to extract
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("coerces extractor throws into an empty draft (never 5xx)", async () => {
    const { chatId } = seedChat(1);
    mockExtract.mockRejectedValue(new Error("SDK exploded"));

    const res = await app.request(`/chats/${chatId}/extract-incident`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft).toEqual({
      title: "",
      symptom: "",
      rootCause: "",
      resolution: "",
      tags: [],
    });
  });

  it("passes a valid AbortSignal that can be observed by the extractor", async () => {
    const { chatId } = seedChat(1);
    mockExtract.mockImplementation(async (_msgs, ctx) => {
      expect(ctx.abortSignal.aborted).toBe(false);
      return {
        title: "",
        symptom: "",
        rootCause: "",
        resolution: "",
        tags: [],
      };
    });
    const res = await app.request(`/chats/${chatId}/extract-incident`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("skipExtract: true still works even when keys are configured", async () => {
    const { chatId } = seedChat(1);
    const res = await app.request(`/chats/${chatId}/extract-incident`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skipExtract: true }),
    });
    expect(res.status).toBe(200);
    expect(mockExtract).not.toHaveBeenCalled();
  });
});
