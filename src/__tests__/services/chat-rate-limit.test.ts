// ─── chat-rate-limit — unit tests ───
//
// Pins parkChatForRateLimit + the parts of resumeChatAfterRateLimit that
// are reachable without a real provider:
//   • parkChatForRateLimit flips the chat row to status='rate_limited',
//     stamps resume_at, broadcasts a `chat_status` WS frame, and arms the
//     wake-up timer with the rate-limit scheduler.
//   • resumeChatAfterRateLimit bails on:
//       - missing chat row
//       - chat with status != 'rate_limited' (cancelled / status flipped)
//       - chat that has no last user message → flip back to 'idle'

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers.js";
import { setDb } from "../../db/index.js";
import { chats, chatMessages } from "../../db/schema.js";
import {
  parkChatForRateLimit,
  resumeChatAfterRateLimit,
} from "../../services/chat-rate-limit.js";
import { wsManager } from "../../services/ws-manager.js";
import { rateLimitScheduler } from "../../services/agents/rate-limit-scheduler.js";

let dbHandle: ReturnType<typeof createTestDb>;

beforeAll(() => {
  dbHandle = createTestDb();
  setDb(dbHandle.db, dbHandle.sqlite);
});

afterAll(() => {
  dbHandle.sqlite.close();
});

beforeEach(() => {
  dbHandle.sqlite.exec("DELETE FROM chat_messages;");
  dbHandle.sqlite.exec("DELETE FROM chats;");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parkChatForRateLimit", () => {
  it("flips status, stamps resume_at, broadcasts WS, schedules wake-up", () => {
    const chatId = dbHandle.db
      .insert(chats)
      .values({ title: "park-me", status: "running" })
      .returning()
      .get()!.id;

    const broadcastSpy = vi
      .spyOn(wsManager, "broadcastChatStatus")
      .mockImplementation(() => {});
    const scheduleSpy = vi
      .spyOn(rateLimitScheduler, "schedule")
      .mockImplementation(() => {});

    const resumeAtMs = Date.now() + 60_000;
    parkChatForRateLimit({
      chatId,
      resumeAtMs,
      errorMessage: "rate limited until …",
    });

    const row = dbHandle.db
      .select()
      .from(chats)
      .where(eq(chats.id, chatId))
      .get();
    expect(row?.status).toBe("rate_limited");
    expect(row?.resumeAt).toBe(resumeAtMs);

    expect(broadcastSpy).toHaveBeenCalledWith(chatId, "rate_limited", {
      resume_at: resumeAtMs,
      error_message: "rate limited until …",
    });
    expect(scheduleSpy).toHaveBeenCalledWith({
      kind: "chat",
      id: chatId,
      resumeAtMs,
    });
  });
});

describe("resumeChatAfterRateLimit — early-bail branches", () => {
  it("returns silently when the chat row is gone", async () => {
    const broadcastSpy = vi
      .spyOn(wsManager, "broadcastChatStatus")
      .mockImplementation(() => {});

    await resumeChatAfterRateLimit(999_999);

    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it("returns silently when the chat has been moved off rate_limited (cancelled race)", async () => {
    const chatId = dbHandle.db
      .insert(chats)
      .values({ title: "cancelled", status: "idle" })
      .returning()
      .get()!.id;

    const broadcastSpy = vi
      .spyOn(wsManager, "broadcastChatStatus")
      .mockImplementation(() => {});

    await resumeChatAfterRateLimit(chatId);

    expect(broadcastSpy).not.toHaveBeenCalled();
    // status preserved
    const row = dbHandle.db.select().from(chats).where(eq(chats.id, chatId)).get();
    expect(row?.status).toBe("idle");
  });

  it("flips chat back to idle when no last user message exists", async () => {
    const chatId = dbHandle.db
      .insert(chats)
      .values({
        title: "no-user-msg",
        status: "rate_limited",
        resumeAt: Date.now() + 1000,
      })
      .returning()
      .get()!.id;

    const broadcastSpy = vi
      .spyOn(wsManager, "broadcastChatStatus")
      .mockImplementation(() => {});

    await resumeChatAfterRateLimit(chatId);

    const row = dbHandle.db
      .select()
      .from(chats)
      .where(eq(chats.id, chatId))
      .get();
    expect(row?.status).toBe("idle");
    expect(row?.resumeAt).toBeNull();
    expect(broadcastSpy).toHaveBeenCalledWith(chatId, "idle", {
      resume_at: null,
    });
  });

  it("returns silently when called against status='running' (race after resume already started)", async () => {
    const chatId = dbHandle.db
      .insert(chats)
      .values({ title: "running-race", status: "running" })
      .returning()
      .get()!.id;

    const broadcastSpy = vi
      .spyOn(wsManager, "broadcastChatStatus")
      .mockImplementation(() => {});

    await resumeChatAfterRateLimit(chatId);

    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it("flips chat back to idle when only assistant messages exist (no user role)", async () => {
    const chatId = dbHandle.db
      .insert(chats)
      .values({
        title: "assistant-only",
        status: "rate_limited",
        resumeAt: Date.now() + 1000,
      })
      .returning()
      .get()!.id;

    dbHandle.db
      .insert(chatMessages)
      .values({
        chatId,
        role: "assistant",
        content: "hi from assistant",
      })
      .run();

    const broadcastSpy = vi
      .spyOn(wsManager, "broadcastChatStatus")
      .mockImplementation(() => {});

    await resumeChatAfterRateLimit(chatId);

    const row = dbHandle.db
      .select()
      .from(chats)
      .where(eq(chats.id, chatId))
      .get();
    expect(row?.status).toBe("idle");
    expect(broadcastSpy).toHaveBeenCalledWith(chatId, "idle", {
      resume_at: null,
    });
  });
});
