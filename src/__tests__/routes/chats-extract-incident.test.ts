// Tests for POST /chats/:id/extract-incident. The extractor itself is covered
// by services/incidents/extractor tests; here we verify the route wiring:
// - 404 on missing chat
// - empty draft when no active keys are configured (short-circuit path)
// - empty draft when `skipExtract: true` (manual path)
// - validation on malformed `messageIds`

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { app } from "../../server.js";
import { createTestDb } from "../helpers.js";
import { setDb, closeDb } from "../../db/index.js";
import { chats, chatMessages } from "../../db/schema.js";

describe("POST /chats/:id/extract-incident", () => {
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();
    setDb(testDb.db, testDb.sqlite);
  });

  afterEach(() => {
    closeDb();
  });

  async function createChatWithMessages(): Promise<{ chatId: number; msgIds: number[] }> {
    const chat = testDb.db
      .insert(chats)
      .values({ title: "Production outage" })
      .returning()
      .get();

    const msg1 = testDb.db
      .insert(chatMessages)
      .values({ chatId: chat.id, role: "user", content: "DB is down — 502 on every endpoint" })
      .returning()
      .get();

    const msg2 = testDb.db
      .insert(chatMessages)
      .values({ chatId: chat.id, role: "assistant", content: "Root cause: disk at 100% on primary." })
      .returning()
      .get();

    return { chatId: chat.id, msgIds: [msg1.id, msg2.id] };
  }

  it("returns 404 for an unknown chat id", async () => {
    const res = await app.request("/chats/9999/extract-incident", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("returns an empty draft immediately when skipExtract is true", async () => {
    const { chatId } = await createChatWithMessages();

    const res = await app.request(`/chats/${chatId}/extract-incident`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skipExtract: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      draft: { title: string; tags: string[] };
      projectId: number | null;
    };
    expect(body.draft).toEqual({
      title: "",
      symptom: "",
      rootCause: "",
      resolution: "",
      tags: [],
    });
  });

  it("returns an empty draft (no extractor call) when no active keys are configured", async () => {
    const { chatId } = await createChatWithMessages();

    // No AI provider keys in the fresh test DB → short-circuit path. The
    // extractor would throw inside the SDK call otherwise; the route must
    // avoid calling it at all and return an empty draft.
    const res = await app.request(`/chats/${chatId}/extract-incident`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { draft: { title: string; tags: string[] } };
    expect(body.draft.title).toBe("");
    expect(body.draft.tags).toEqual([]);
  });

  it("rejects a malformed messageIds list with 422", async () => {
    const { chatId } = await createChatWithMessages();

    const res = await app.request(`/chats/${chatId}/extract-incident`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageIds: ["not-a-number"] }),
    });
    expect(res.status).toBe(422);
  });

  it("accepts a valid messageIds subset (no-op when no keys are set)", async () => {
    const { chatId, msgIds } = await createChatWithMessages();

    const res = await app.request(`/chats/${chatId}/extract-incident`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageIds: [msgIds[0]] }),
    });
    expect(res.status).toBe(200);
  });
});
