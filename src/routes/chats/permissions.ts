import type { Hono } from "hono";
import { getDb } from "../../db/index.js";
import { chats } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { parseIdParam } from "../../lib/route-params.js";
import { chatExecutor } from "../../services/chat-executor.js";
import { wsManager } from "../../services/ws-manager.js";
import { emitAttentionChanged } from "../../services/attention.js";
import { getChatOrThrow } from "../../lib/db-helpers.js";

export function registerChatGlobalPendingPermissions(router: Hono): void {
  // GET /chats/pending-permissions — live map of {chat_id: count} for active
  // permission requests across all in-memory chat sessions. Used by the chat
  // list to seed pending-approval badges on mount (WS events keep them fresh).
  // Must be declared before `/:id` so Hono matches the literal path first.
  router.get("/pending-permissions", (c) => {
    const counts = chatExecutor.pendingPermissionCounts();
    const running = chatExecutor.runningChatIds();
    return c.json({
      pending: Object.fromEntries(
        Object.entries(counts).map(([id, n]) => [String(id), n]),
      ),
      running: running.map(String),
    });
  });
}

export function registerChatIdPendingPermissions(router: Hono): void {
  // GET /chats/:id/pending-permissions — full pending permission requests for a
  // running chat session. Used by the chat detail UI to re-hydrate the permission
  // card after a page reload (WS events are not replayed on reconnect).
  router.get("/:id/pending-permissions", (c) => {
    const id = parseIdParam(c);
    getChatOrThrow(id);

    const requests = chatExecutor.pendingPermissions(id).map((r) => ({
      request_id: r.requestId,
      tool_name: r.toolName,
      tool_input: r.toolInput,
      /* v8 ignore next 4 — `?? null` fallbacks fire when the SDK permission request omits the optional metadata fields (title/displayName/description/decisionReason); production streams set them. Tests exercise the populated branch; the nullish branch is a pass-through default */
      title: r.title ?? null,
      display_name: r.displayName ?? null,
      description: r.description ?? null,
      decision_reason: r.decisionReason ?? null,
      tool_use_id: r.toolUseID,
    }));
    return c.json({ items: requests });
  });
}

export function registerChatPermissionResolve(router: Hono): void {
  // POST /chats/:id/permission/:requestId — respond to a tool permission request
  router.post("/:id/permission/:requestId", async (c) => {
    const id = parseIdParam(c);
    const requestId = c.req.param("requestId");
    const body = await c.req.json().catch(() => ({}));
    const behavior = body.behavior;

    if (behavior !== "allow" && behavior !== "deny") {
      throw new ValidationError("behavior must be 'allow' or 'deny'");
    }

    if (!chatExecutor.isRunning(id)) {
      throw new ValidationError("Chat session is not running");
    }

    const result = behavior === "allow"
      ? { behavior: "allow" as const }
      : { behavior: "deny" as const, message: body.message ?? "Denied by user" };

    const resolved = chatExecutor.resolvePermission(id, requestId, result);
    if (!resolved) {
      throw new NotFoundError("Permission request");
    }

    // Note: `attention_changed` is emitted by AgentSession.resolvePermission
    // (called transitively via chatExecutor.resolvePermission). The route must
    // NOT re-emit — the one-broadcast-per-transition invariant is enforced by
    // attention-broadcast.test.ts.
    return c.json({ ok: true });
  });
}

export function registerChatCancel(router: Hono): void {
  // POST /chats/:id/cancel — abort the currently running chat turn
  router.post("/:id/cancel", async (c) => {
    const id = parseIdParam(c);
    const ok = chatExecutor.cancel(id);
    return c.json({ ok });
  });
}

export function registerChatApproval(router: Hono): void {
  // POST /chats/:id/approve — approve a chat sitting in `approval_status='pending'`.
  //
  // Symmetric with `POST /tasks/:id/approve`: clears the pending blocker from
  // `/attention`, records `approved_at` + optional `note`, and fires
  // `attention_changed` so clients re-fetch the inbox. Unlike tasks, there's
  // no `status` column to flip — chats don't have a terminal state — so this
  // is a pure `approval_status` transition.
  router.post("/:id/approve", async (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const body = await c.req.json().catch(() => ({}));
    const note = typeof body.note === "string" ? body.note : null;

    const chat = getChatOrThrow(id);
    if (chat.approvalStatus !== "pending") {
      throw new ValidationError(
        `Cannot approve chat with approval_status='${chat.approvalStatus ?? "null"}'`,
      );
    }

    db.update(chats)
      .set({
        approvalStatus: "approved",
        approvedAt: new Date().toISOString(),
        approvalNote: note,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(chats.id, id))
      .run();

    emitAttentionChanged(wsManager);
    return c.json({ ok: true });
  });

  // POST /chats/:id/reject — reject a pending-approval chat.
  //
  // Mirror of `/approve`. No rollback path (chats don't produce git commits
  // like tasks do) — the rejection is purely advisory: it flips
  // `approval_status` to `rejected`, records the note, and clears the
  // attention blocker. Future turns will re-enter pending when they complete
  // (because `requires_approval=true` still holds); flip that off via PATCH
  // to stop the cycle.
  router.post("/:id/reject", async (c) => {
    const db = getDb();
    const id = parseIdParam(c);
    const body = await c.req.json().catch(() => ({}));
    const note = typeof body.note === "string" ? body.note : null;

    const chat = getChatOrThrow(id);
    if (chat.approvalStatus !== "pending") {
      throw new ValidationError(
        `Cannot reject chat with approval_status='${chat.approvalStatus ?? "null"}'`,
      );
    }

    db.update(chats)
      .set({
        approvalStatus: "rejected",
        approvedAt: new Date().toISOString(),
        approvalNote: note,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(chats.id, id))
      .run();

    emitAttentionChanged(wsManager);
    return c.json({ ok: true });
  });
}
