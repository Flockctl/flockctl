import type { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../../db/index.js";
import { chats, chatMessages, aiProviderKeys } from "../../db/schema.js";
import { eq, sql } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { parseIdParam } from "../../lib/route-params.js";
import { extractIncidentFromMessages } from "../../services/incidents/extractor.js";

export function registerChatIncidents(router: Hono): void {
  // POST /chats/:id/extract-incident — run the incident-extractor LLM pass over
  // a chat transcript (optionally restricted to `messageIds`) and return a
  // structured draft for the "Save as incident" dialog.
  //
  // Body: { messageIds?: number[], skipExtract?: boolean }
  //   - messageIds: optional subset of chat_messages.id to include in the
  //     transcript. Ids that don't belong to this chat are silently ignored.
  //     When omitted, the full chat history is used.
  //   - skipExtract: when true, skip the LLM call entirely and return an empty
  //     draft. Useful for tests and for the "fill in manually" path.
  //
  // Response: { draft: {title,symptom,rootCause,resolution,tags[]}, projectId }
  //
  // Never returns 5xx on LLM failure — the extractor already coerces any error
  // into an empty draft so the dialog can always open and accept manual input.
  router.post("/:id/extract-incident", async (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const chat = db.select().from(chats).where(eq(chats.id, id)).get();
    if (!chat) throw new NotFoundError("Chat");

    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const bodySchema = z.object({
      messageIds: z.array(z.number().int().positive()).optional(),
      skipExtract: z.boolean().optional(),
    });
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        `invalid body: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }
    const { messageIds, skipExtract } = parsed.data;

    // Empty draft is the default — used on `skipExtract`, on no-keys, and on any
    // extractor failure. The UI treats it as a "fill in manually" blank form.
    const emptyDraft = {
      title: "",
      symptom: "",
      rootCause: "",
      resolution: "",
      tags: [] as string[],
    };

    if (skipExtract) {
      return c.json({ draft: emptyDraft, projectId: chat.projectId ?? null });
    }

    // Short-circuit when there are no active AI provider keys — the extractor
    // would just fail inside the SDK call, but we'd still pay the startup cost.
    const activeKeyCount = db
      .select({ count: sql<number>`count(*)` })
      .from(aiProviderKeys)
      .where(eq(aiProviderKeys.isActive, true))
      .get()?.count ?? 0;
    if (activeKeyCount === 0) {
      return c.json({ draft: emptyDraft, projectId: chat.projectId ?? null });
    }

    // Load the transcript. Filter by messageIds when supplied; preserve
    // created_at ordering either way so the extractor sees the conversation
    // in temporal order.
    const allMessages = db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatId, id))
      .orderBy(chatMessages.createdAt)
      .all();
    const idSet = messageIds && messageIds.length > 0 ? new Set(messageIds) : null;
    const selected = idSet ? allMessages.filter((m) => idSet.has(m.id)) : allMessages;

    if (selected.length === 0) {
      return c.json({ draft: emptyDraft, projectId: chat.projectId ?? null });
    }

    // 15s hard cap — extractor is a single Haiku call; anything longer is a
    // stuck SDK call. The catch below coerces the abort into an empty draft.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const draft = await extractIncidentFromMessages(
        selected.map((m) => ({ role: m.role, content: m.content })),
        {
          projectId: chat.projectId ?? null,
          chatId: id,
          abortSignal: controller.signal,
        },
      );
      return c.json({ draft, projectId: chat.projectId ?? null });
    } catch {
      return c.json({ draft: emptyDraft, projectId: chat.projectId ?? null });
    } finally {
      clearTimeout(timer);
    }
  });
}
