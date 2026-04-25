import type { Hono } from "hono";
import { getDb } from "../../db/index.js";
import { chats, chatMessages } from "../../db/schema.js";
import { eq, and, sql, desc } from "drizzle-orm";
import { paginationParams } from "../../lib/pagination.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { parseIdParam } from "../../lib/route-params.js";
import {
  listAttachmentsForChat,
  deleteAttachmentFiles,
  loadAttachmentsForMessages,
} from "../../services/attachments.js";
import { getAgent } from "../../services/agents/registry.js";
import { parsePermissionModeBody } from "../_permission-mode.js";
import { chatExecutor } from "../../services/chat-executor.js";
import { resolvePermissionMode } from "../../services/permission-resolver.js";
import {
  coerceKeyId,
  getChatMetrics,
  resolveChatContext,
  resolveChatScope,
  resolveDefaultKeyForChat,
  assertKeyAllowedForChat,
  parseEffortBody,
  parseThinkingEnabledBody,
} from "./helpers.js";
import { resolveAllowedKeyIds } from "../../services/ai/key-selection.js";

export function registerChatCrud(router: Hono): void {
  // POST /chats — create, or return the existing entity-scoped chat.
  //
  // When `projectId`, `entityType` and `entityId` are all supplied the handler
  // first looks up an existing chat with that exact triple and returns it
  // unchanged (HTTP 200) instead of minting a duplicate. This keeps
  // plan-entity chat dialogs idempotent — the UI can POST on every open and
  // rely on getting the same chatId back. Without the triple (e.g. a plain
  // workspace chat), behaviour is unchanged and a fresh row is always created.
  router.post("/", async (c) => {
    const db = getDb();
    const body = await c.req.json();
    const projectId = body.projectId ?? null;
    const entityType = body.entityType ?? null;
    const entityId = body.entityId ?? null;

    if (projectId != null && entityType && entityId) {
      const existing = db.select().from(chats).where(and(
        eq(chats.projectId, projectId),
        eq(chats.entityType, entityType),
        eq(chats.entityId, entityId),
      )).orderBy(desc(chats.createdAt)).limit(1).get();
      if (existing) return c.json(existing, 200);
    }

    // `aiProviderKeyId` and `model` are optional at create-time. Shape is
    // validated via `coerceKeyId`; existence is not (orphan ids fall back to
    // the allow-list-aware default at message-send time, matching the behavior
    // of deactivated keys). When the caller DOES provide a keyId we 422 on
    // disallowed keys up-front — otherwise the first message would fail and
    // leave the chat stuck pointing at a key it can never use.
    const requestedKeyId = coerceKeyId(body.aiProviderKeyId);
    if (requestedKeyId !== undefined) {
      assertKeyAllowedForChat(
        db,
        { projectId: projectId ?? null },
        requestedKeyId,
        "request",
      );
    }

    // When the project has an allow-list that might exclude the user's
    // rc-level default, auto-fill a compliant key on creation so the UI's
    // composer shows a permitted selection immediately. We keep the legacy
    // "NULL on create" contract for unrestricted projects and workspace-only
    // chats — downstream code that uses NULL as a "resolve-at-send-time"
    // signal still works, and existing tests (and clients) that assert NULL
    // for plain chats are unaffected. The write is gated on the allow-list
    // being non-empty: an empty allow-list means "no restriction", so there
    // is nothing for us to defend against here.
    let aiProviderKeyId: number | null = requestedKeyId ?? null;
    if (aiProviderKeyId === null && projectId != null) {
      const allowedIds = resolveAllowedKeyIds({ projectId });
      if (allowedIds.length > 0) {
        aiProviderKeyId = resolveDefaultKeyForChat(db, { projectId }) ?? null;
      }
    }
    const model =
      typeof body.model === "string" && body.model.trim().length > 0
        ? body.model.trim().slice(0, 200)
        : null;

    // `requiresApproval` is an opt-in flag matching the task-side semantics:
    // the chat will flip to `approvalStatus='pending'` after each successful
    // assistant turn and surface as a blocker in `/attention` until the user
    // calls `POST /chats/:id/{approve,reject}`. Default `false`.
    const requiresApproval = body.requiresApproval === true;

    const result = db.insert(chats).values({
      projectId,
      workspaceId: body.workspaceId ?? null,
      title: body.title ?? null,
      entityType,
      entityId,
      aiProviderKeyId,
      model,
      requiresApproval,
    }).returning().get();
    return c.json(result, 201);
  });

  // GET /chats — list
  router.get("/", (c) => {
    const db = getDb();
    const { page, perPage, offset } = paginationParams(c);
    const projectId = c.req.query("project_id");
    const workspaceId = c.req.query("workspace_id");
    const entityType = c.req.query("entity_type");
    const entityId = c.req.query("entity_id");
    const q = c.req.query("q");

    const conditions = [];
    if (projectId) conditions.push(eq(chats.projectId, parseInt(projectId)));
    if (workspaceId) conditions.push(eq(chats.workspaceId, parseInt(workspaceId)));
    if (entityType) conditions.push(eq(chats.entityType, entityType));
    if (entityId) conditions.push(eq(chats.entityId, entityId));

    // Free-text search over chat title and message content. Project/workspace
    // scoping is a separate concern handled by the dedicated filter params
    // above, so we deliberately don't match against their names here. Escapes
    // the LIKE wildcards (`%`, `_`) so a user typing e.g. "50%" doesn't
    // silently match everything. SQLite's default LIKE is case-insensitive
    // for ASCII only — Cyrillic and other non-ASCII remain case-sensitive.
    // That matches user expectation when they type a word the same way it
    // appears in the chat, and avoids pulling in a Unicode collation dep.
    if (q && q.trim().length > 0) {
      const escaped = q.trim().replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
      const pattern = `%${escaped}%`;
      conditions.push(sql`(
        ${chats.title} LIKE ${pattern} ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM chat_messages cm
          WHERE cm.chat_id = ${chats.id}
            AND cm.content LIKE ${pattern} ESCAPE '\\'
        )
      )`);
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Pinned chats float to the top of the filtered set. Filters (projectId,
    // workspaceId, entity_*) are applied first via `where`, so a pinned chat
    // that doesn't match the active filter is still hidden — pinning never
    // leaks chats across a filter boundary. Inside each pin bucket rows
    // preserve the prior newest-first order so the list is stable when no
    // chats are pinned.
    const items = db.select().from(chats).where(where).orderBy(desc(chats.pinned), desc(chats.createdAt)).limit(perPage).offset(offset).all();
    /* v8 ignore next — SQL count(*) always returns one row, so `?? 0` is unreachable */
    const total = db.select({ count: sql<number>`count(*)` }).from(chats).where(where).get()?.count ?? 0;

    const itemsWithMetrics = items.map(chat => ({
      ...chat,
      ...resolveChatContext(db, chat),
      metrics: getChatMetrics(db, chat.id),
    }));

    return c.json({ items: itemsWithMetrics, total, page, perPage });
  });
}

export function registerChatGetById(router: Hono): void {
  // GET /chats/:id — with messages and metrics
  //
  // Each message row is augmented with its linked `attachments` (empty list when
  // none). The UI renders thumbnails directly from this payload without a
  // follow-up per-message round trip — one batched query covers every user
  // message in the transcript.
  router.get("/:id", (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const chat = db.select().from(chats).where(eq(chats.id, id)).get();
    if (!chat) throw new NotFoundError("Chat");

    const messages = db.select().from(chatMessages).where(eq(chatMessages.chatId, id)).orderBy(chatMessages.createdAt).all();
    // Only user messages ever carry attachments (assistant rows never link),
    // so narrow the id set before the batched lookup.
    const userMessageIds = messages.filter((m) => m.role === "user").map((m) => m.id);
    const attachmentsByMsg = loadAttachmentsForMessages(userMessageIds);
    const messagesWithAttachments = messages.map((m) => ({
      ...m,
      attachments: attachmentsByMsg.get(m.id) ?? [],
    }));
    const metrics = getChatMetrics(db, id);
    const context = resolveChatContext(db, chat);
    const isRunning = chatExecutor.isRunning(id);
    return c.json({ ...chat, ...context, messages: messagesWithAttachments, metrics, isRunning });
  });
}

export function registerChatDelete(router: Hono): void {
  // DELETE /chats/:id
  // SQLite cascades chat_attachments rows, but the on-disk blobs need manual
  // cleanup — enumerate them first, then unlink after the row delete commits.
  router.delete("/:id", (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const chat = db.select().from(chats).where(eq(chats.id, id)).get();
    if (!chat) throw new NotFoundError("Chat");

    const attachments = listAttachmentsForChat(id);
    db.delete(chats).where(eq(chats.id, id)).run();
    if (attachments.length > 0) {
      deleteAttachmentFiles(attachments);
    }
    return c.json({ deleted: true });
  });
}

export function registerChatPatch(router: Hono): void {
  // PATCH /chats/:id — update chat (title, etc.)
  router.patch("/:id", async (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const chat = db.select().from(chats).where(eq(chats.id, id)).get();
    if (!chat) throw new NotFoundError("Chat");

    const body = await c.req.json();
    const updates: Partial<{
      title: string;
      permissionMode: string | null;
      aiProviderKeyId: number | null;
      model: string | null;
      requiresApproval: boolean;
      thinkingEnabled: boolean;
      effort: string | null;
      pinned: boolean;
      updatedAt: string;
    }> = {};

    if ("title" in body && typeof body.title === "string") {
      updates.title = body.title.trim().slice(0, 200);
    }
    const permissionMode = parsePermissionModeBody(body);
    if (permissionMode !== undefined) {
      updates.permissionMode = permissionMode;
    }
    // Interactive selector changes PATCH the chat immediately so switching tabs
    // (or another browser window) restores the same pick. `null` explicitly
    // clears — the UI uses that to reset to defaults.
    if ("aiProviderKeyId" in body) {
      const raw = body.aiProviderKeyId;
      if (raw === null) {
        updates.aiProviderKeyId = null;
      } else {
        const parsed = coerceKeyId(raw);
        if (parsed === undefined) {
          throw new ValidationError("aiProviderKeyId must be a positive integer or null");
        }
        updates.aiProviderKeyId = parsed;
      }
    }
    if ("model" in body) {
      const raw = body.model;
      if (raw === null) {
        updates.model = null;
      } else if (typeof raw === "string") {
        const trimmed = raw.trim();
        updates.model = trimmed.length === 0 ? null : trimmed.slice(0, 200);
      } else {
        throw new ValidationError("model must be a string or null");
      }
    }
    // Approval opt-in flag. Accept booleans only — no truthy-string coercion
    // so "false" strings from a misbehaving client don't silently enable the
    // pending-approval flow. Toggling this off does NOT retroactively clear
    // `approvalStatus`; a chat currently in `pending` stays pending until
    // explicitly approved or rejected.
    if ("requiresApproval" in body) {
      if (typeof body.requiresApproval !== "boolean") {
        throw new ValidationError("requiresApproval must be a boolean");
      }
      updates.requiresApproval = body.requiresApproval;
    }
    // Adaptive-thinking toggle. Same snake_case-friendly parser the
    // /messages endpoints use, so the UI can send one body shape from
    // either the PATCH or the stream path.
    const thinkingEnabled = parseThinkingEnabledBody(body);
    if (thinkingEnabled !== undefined) {
      updates.thinkingEnabled = thinkingEnabled;
    }
    // Reasoning effort. `null` clears the stored pick so the chat falls
    // back to the SDK default (`high`) on the next turn.
    const effort = parseEffortBody(body);
    if (effort !== undefined) {
      updates.effort = effort;
    }
    // Pin toggle. Boolean-only parser (same philosophy as `requiresApproval`
    // above) so a stray string like `"false"` doesn't silently pin a chat.
    if ("pinned" in body) {
      if (typeof body.pinned !== "boolean") {
        throw new ValidationError("pinned must be a boolean");
      }
      updates.pinned = body.pinned;
    }

    if (Object.keys(updates).length === 0) {
      throw new ValidationError("No valid fields to update");
    }

    updates.updatedAt = new Date().toISOString();
    const updated = db.update(chats).set(updates).where(eq(chats.id, id)).returning().get();

    if (updates.title && chat.claudeSessionId) {
      const provider = getAgent();
      await provider.renameSession?.(chat.claudeSessionId, `[FLOCKCTL] ${updates.title}`);
    }

    // Variant-B live propagation: if the PATCH touched `permission_mode` AND
    // the chat has an in-flight AgentSession, push the new EFFECTIVE mode
    // (chat → project → workspace → "auto") into the running session. This
    // is what lets the user flip `default` → `bypassPermissions` while an
    // agent is blocked on a permission prompt and have the pending prompt
    // auto-resolve instead of waiting for the next turn.
    //
    // The DB PATCH already handles the "next turn" case on its own; this
    // block is purely about the CURRENT turn. We skip the work when no
    // session is running — the executor call would no-op anyway, but the
    // scope resolve (project/workspace row fetch + config load) is worth
    // avoiding when it can't affect anything.
    if ("permissionMode" in updates && chatExecutor.isRunning(id)) {
      const { projectConfig, workspaceConfig } = resolveChatScope(db, updated);
      const effective = resolvePermissionMode({
        chat: updated.permissionMode,
        project: projectConfig.permissionMode,
        workspace: workspaceConfig.permissionMode,
      });
      chatExecutor.updatePermissionMode(id, effective);
    }

    return c.json(updated);
  });
}
