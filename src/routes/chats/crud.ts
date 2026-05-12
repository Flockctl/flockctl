import type { Hono } from "hono";
import { getDb } from "../../db/index.js";
import { chats, chatMessages, chatAttachments } from "../../db/schema.js";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
import { paginationParams } from "../../lib/pagination.js";
import { ConflictError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { parseIdParam, parseIdQuery, parseJsonBodySafe } from "../../lib/route-params.js";
import {
  listAttachmentsForChat,
  deleteAttachmentFiles,
  loadAttachmentsForMessages,
} from "../../services/attachments.js";
import { getAgent } from "../../services/agents/registry.js";
import { parsePermissionModeBody } from "../_permission-mode.js";
import { parseIsolationBody } from "../_isolation.js";
import { chatExecutor } from "../../services/chat-executor.js";
import { resolvePermissionMode } from "../../services/permission-resolver.js";
import {
  coerceKeyId,
  getChatMetrics,
  getChatMetricsBatched,
  resolveChatContext,
  resolveChatContextsBatched,
  resolveChatScope,
  resolveDefaultKeyForChat,
  assertKeyAllowedForChat,
  parseEffortBody,
  parseThinkingEnabledBody,
} from "./helpers.js";
import { resolveAllowedKeyIds } from "../../services/ai/key-selection.js";
import { getChatOrThrow, getProjectById } from "../../lib/db-helpers.js";
import {
  cleanupIfClean as cleanupWorktreeIfClean,
  removeWorktree,
} from "../../services/worktree-manager.js";

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
    const body = await parseJsonBodySafe(c);
    const projectId = body.projectId ?? null;
    const workspaceId = body.workspaceId ?? null;
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
        { projectId: projectId ?? null, workspaceId },
        requestedKeyId,
        "request",
      );
    }

    // When the project OR workspace has an allow-list that might exclude
    // the user's rc-level default, auto-fill a compliant key on creation
    // so the UI's composer shows a permitted selection immediately.
    //
    // The workspace branch is what makes "Chat" on the workspace page work
    // correctly: before, only project-scoped chats got auto-filled, so
    // workspace-only chats persisted with `aiProviderKeyId = NULL` and the
    // workspace's own whitelist was silently ignored. The chat would either
    // fall back to the rc default (even if it wasn't in the workspace
    // whitelist) or — more often — show an empty key picker on first load.
    //
    // We keep the legacy "NULL on create" contract for unrestricted scopes
    // (no project + no workspace, or all-allowed): downstream code uses
    // NULL as a "resolve-at-send-time" signal, and existing tests / clients
    // that assert NULL for plain chats are unaffected. The write is gated
    // on the allow-list being non-empty.
    let aiProviderKeyId: number | null = requestedKeyId ?? null;
    if (aiProviderKeyId === null && (projectId != null || workspaceId != null)) {
      const allowedIds = resolveAllowedKeyIds({ projectId, workspaceId });
      if (allowedIds.length > 0) {
        aiProviderKeyId =
          resolveDefaultKeyForChat(db, { projectId, workspaceId }) ?? null;
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

    // Isolation. `'worktree'` opt-in records the operator's intent on
    // the row at creation; the actual git worktree is materialised
    // lazily on the first message (see `resolveChatCwd` in helpers.ts)
    // so empty chats that never get a message don't leave behind
    // worktree directories on disk. Validated up-front against the
    // shared whitelist so a malformed value can't reach the DB.
    const isolation = parseIsolationBody(body);

    const result = db.insert(chats).values({
      projectId,
      workspaceId,
      title: body.title ?? null,
      entityType,
      entityId,
      aiProviderKeyId,
      model,
      requiresApproval,
      ...(isolation !== undefined && { isolation }),
    }).returning().get();
    return c.json(result, 201);
  });

  // GET /chats — list
  router.get("/", (c) => {
    const db = getDb();
    const { page, perPage, offset } = paginationParams(c);
    const projectId = parseIdQuery(c, "project_id");
    const workspaceId = parseIdQuery(c, "workspace_id");
    const entityType = c.req.query("entity_type");
    const entityId = c.req.query("entity_id");
    const q = c.req.query("q");

    const conditions = [];
    if (projectId !== undefined) conditions.push(eq(chats.projectId, projectId));
    if (workspaceId !== undefined) conditions.push(eq(chats.workspaceId, workspaceId));
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

    // Batched aggregations — collapses the per-row N+1 (5 metric queries +
    // 2 context queries per chat) into a constant number of queries per
    // page regardless of N. Roughly: 5 grouped aggregates + 2 inArray
    // lookups instead of (5 + 2) × perPage.
    const chatIds = items.map((c) => c.id);
    const metricsByChat = getChatMetricsBatched(db, chatIds);
    const contextByChat = resolveChatContextsBatched(db, items);
    const itemsWithMetrics = items.map((chat) => ({
      ...chat,
      ...(contextByChat.get(chat.id) ?? { projectName: null, workspaceName: null }),
      metrics: metricsByChat.get(chat.id) ?? getChatMetrics(db, chat.id),
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
    const chat = getChatOrThrow(id);

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
  //
  // Worktree-isolated chats: deleting a chat with a worktree triggers
  // cleanup-if-clean (matches `claude --worktree` exit semantics). A
  // dirty worktree returns 409 — the caller can re-issue with
  // `?force=true` to discard the in-progress changes, or hit
  // `POST /chats/:id/end-session` first to inspect the diff. This is
  // the safety gate that prevents accidental data loss when an
  // operator deletes a chat whose agent committed work the operator
  // hasn't merged yet.
  router.delete("/:id", (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const chat = getChatOrThrow(id);
    const force = c.req.query("force") === "true";

    // Worktree gate: refuse to drop the row while there are
    // uncommitted changes the operator hasn't acknowledged. Done
    // BEFORE the in-flight session teardown so a "delete?" dialog can
    // show before we cancel anything.
    if (chat.worktreePath && chat.worktreeBranch && chat.projectId && !force) {
      const project = getProjectById(chat.projectId);
      if (project?.path) {
        const result = cleanupWorktreeIfClean({
          projectPath: project.path,
          worktreePath: chat.worktreePath,
          branch: chat.worktreeBranch,
        });
        if (!result.removed && result.reason === "dirty") {
          throw new ConflictError(
            "Chat worktree has uncommitted changes — pass ?force=true to discard, or use POST /chats/:id/end-session to review",
            { reason: result.reason, worktreePath: chat.worktreePath, worktreeBranch: chat.worktreeBranch },
          );
        }
      }
    }

    // Tear down any in-flight session before the row goes away — leaving the
    // executor with a session keyed to a deleted chat id leaks the agent
    // process and lets it write to a chat that no longer exists.
    if (chatExecutor.isRunning(id)) {
      chatExecutor.cancel(id);
    }

    // Force-cleanup of worktree if still around (either we passed the
    // gate above with `force=true`, or the gate's clean-cleanup
    // already nuked it but the row still carries the columns; either
    // way `removeWorktree` is idempotent).
    if (chat.worktreePath && chat.worktreeBranch && chat.projectId) {
      const project = getProjectById(chat.projectId);
      if (project?.path) {
        removeWorktree({
          projectPath: project.path,
          worktreePath: chat.worktreePath,
          branch: chat.worktreeBranch,
          force: true,
        });
      }
    }

    const attachments = listAttachmentsForChat(id);
    db.delete(chats).where(eq(chats.id, id)).run();
    if (attachments.length > 0) {
      deleteAttachmentFiles(attachments);
    }
    return c.json({ deleted: true });
  });
}

/**
 * POST /chats/batch-delete — bulk-delete the chats whose ids appear in the
 * body. Modelled as POST (not DELETE-with-body) because not every HTTP client
 * — fetch in older browsers, some proxies — forwards a body on a DELETE,
 * which would silently drop the request and surprise the operator.
 *
 * Body shape: `{ ids: number[] }`. Validation:
 *   - `ids` must be a non-empty array of distinct positive integers.
 *   - `ids.length` is capped at 200 to keep one operation from monopolising
 *     the executor (each cancel walks the agent_questions table) and to keep
 *     the IN(...) list under SQLite's default 999-variable limit by a wide
 *     margin.
 *
 * Semantics: partial success is honest. A request that names two valid chats
 * and one already-deleted id returns 200 with `{ deleted: 2, missing: [<id>],
 * requested: 3 }`. Throwing 404 for the first miss would leave the rest of
 * the batch in an undefined state from the caller's perspective and force
 * the UI to retry one-at-a-time after a single conflict.
 *
 * Side effects mirror the single-id path:
 *   1. Cancel any in-flight chatExecutor session per id (loops outside the
 *      transaction — `chatExecutor.cancel` does its own DB writes for the
 *      agent_questions sweep).
 *   2. Enumerate attachments for every doomed chat.
 *   3. One DB statement: `DELETE FROM chats WHERE id IN (...)`. SQLite FK
 *      cascades sweep chat_messages / chat_attachments / chat_todos.
 *   4. Unlink on-disk attachment files after the DB delete commits.
 */
export function registerChatBatchDelete(router: Hono): void {
  router.post("/batch-delete", async (c) => {
    const db = getDb();
    const body = await c.req.json().catch(() => ({}));

    const rawIds = (body as { ids?: unknown }).ids;
    if (!Array.isArray(rawIds)) {
      throw new ValidationError("ids must be an array of positive integers");
    }
    if (rawIds.length === 0) {
      throw new ValidationError("ids must not be empty");
    }
    if (rawIds.length > 200) {
      throw new ValidationError("ids must not contain more than 200 entries");
    }
    const ids: number[] = [];
    for (const v of rawIds) {
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new ValidationError(
          "ids must be an array of positive integers",
        );
      }
      ids.push(v);
    }
    // De-duplicate while preserving insertion order so the `missing` echo
    // below is stable and the `requested` count matches what the caller
    // *meant* to delete (one mention = one delete).
    const uniqueIds = Array.from(new Set(ids));

    // Pre-flight: which ids actually correspond to a chat row? The IN(...)
    // result is the authoritative "exists" set — anything not returned here
    // is reported back as `missing` so the caller can clear stale rows from
    // its own UI state.
    const existingRows = db
      .select({ id: chats.id })
      .from(chats)
      .where(inArray(chats.id, uniqueIds))
      .all();
    const existing = new Set(existingRows.map((r) => r.id));
    const present = uniqueIds.filter((id) => existing.has(id));
    const missing = uniqueIds.filter((id) => !existing.has(id));

    if (present.length === 0) {
      return c.json({ deleted: 0, missing, requested: uniqueIds.length });
    }

    // Cancel running sessions BEFORE the row delete — same reasoning as the
    // single-id path. `cancel()` is a no-op when no session is registered.
    for (const id of present) {
      if (chatExecutor.isRunning(id)) {
        chatExecutor.cancel(id);
      }
    }

    // Snapshot every attachment row across the doomed chats in a SINGLE
    // batched query — the previous shape ran one `SELECT WHERE chatId = ?`
    // per chat id (audit-round-5 finding) which on a 50-chat bulk-delete
    // fired 50 separate scans. FK cascade will drop the DB rows in the
    // next statement, but the blob files need manual unlinks driven by
    // these snapshots.
    const allAttachments = present.length === 0
      ? []
      : db
          .select()
          .from(chatAttachments)
          .where(inArray(chatAttachments.chatId, present))
          .all();

    db.delete(chats).where(inArray(chats.id, present)).run();

    if (allAttachments.length > 0) {
      deleteAttachmentFiles(allAttachments);
    }

    return c.json({
      deleted: present.length,
      missing,
      requested: uniqueIds.length,
    });
  });
}

export function registerChatPatch(router: Hono): void {
  // PATCH /chats/:id — update chat (title, etc.)
  router.patch("/:id", async (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const chat = getChatOrThrow(id);

    const body = await parseJsonBodySafe(c);
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
