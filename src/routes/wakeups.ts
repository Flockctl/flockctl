// ─── Scheduled wakeups: HTTP API ───
//
// Three audiences land here:
//
//  1. The Claude Code `PostToolUse` hook on `ScheduleWakeup` POSTs to
//     `/wakeups/from-hook` to record an agent's intent-to-resume. This
//     is the *primary* ingress — without this row a wakeup in a non-/loop
//     chat is invisible and the chat looks abandoned.
//  2. The UI inbox calls `GET /wakeups` (filterable by chat / task /
//     status) to render the live "scheduled / resuming in 4:12" chip
//     and the "Missed wake" recovery view. The UI also issues
//     `POST /wakeups/:id/fire` and `POST /wakeups/:id/cancel` for the
//     two operator affordances.
//  3. Tests and the daemon's own diagnostic surfaces use `GET /:id` for
//     a single-row read. There is no PATCH path — wakeup state is a
//     finite-state machine driven by the worker (`pending → fired |
//     cancelled | missed`) and the routes only own the legal
//     transitions.

import { Hono } from "hono";
import { z } from "zod";
import { ValidationError, NotFoundError } from "../lib/errors.js";
import { flattenZodError } from "../lib/zod-utils.js";
import { parseIdQuery, parsePositiveIntQuery } from "../lib/route-params.js";
import {
  cancel,
  getById,
  list,
  markFired,
  record,
  type WakeupStatus,
} from "../services/wakeups/wakeup-service.js";
import { wsManager } from "../services/ws-manager.js";

export const wakeupRoutes = new Hono();

const VALID_STATUS: ReadonlySet<WakeupStatus> = new Set<WakeupStatus>([
  "pending",
  "fired",
  "cancelled",
  "missed",
]);

/*
 * Zod schema for POST /wakeups/from-hook body. Replaces ~30 lines of
 * hand-rolled `if (typeof x !== "string") throw …` guards. Two
 * structural rules the older imperative code expressed via separate
 * branches are now in one cross-field refinement:
 *
 *   1. Exactly ONE of `chat_id` / `task_id` must be set (a wakeup is
 *      bound to a single resume target).
 *   2. `claude_session_id` and `prompt` are non-empty strings; without
 *      them the worker has no session to resume into / no message to
 *      replay.
 *
 * Field-level errors flow through `flattenZodError` so the
 * `ValidationError` details payload matches the rest of the API surface.
 */
const wakeupFromHookSchema = z
  .object({
    chat_id: z.number().int().positive().nullable().optional(),
    task_id: z.number().int().positive().nullable().optional(),
    claude_session_id: z.string().min(1, "claude_session_id is required"),
    delay_seconds: z.number().nonnegative("delay_seconds must be ≥ 0"),
    prompt: z.string().min(1, "prompt is required"),
    reason: z.string().nullable().optional(),
  })
  .refine(
    (data) => {
      const hasChat = data.chat_id !== undefined && data.chat_id !== null;
      const hasTask = data.task_id !== undefined && data.task_id !== null;
      return hasChat !== hasTask; // XOR
    },
    {
      message: "exactly one of chat_id / task_id must be set",
      path: ["chat_id"],
    },
  );

function broadcast(rowId: string): void {
  const row = getById(rowId);
  if (!row) return;
  wsManager.broadcastWakeupStatus({
    wakeup_id: row.id,
    chat_id: row.chatId,
    task_id: row.taskId,
    status: row.status,
    fire_at: row.fireAt,
    reason: row.reason,
  });
}

// ─── List ───────────────────────────────────────────────────────────
//
// GET /wakeups?chat_id=&task_id=&status=&limit=
// Returns newest-first. Both `chat_id` and `task_id` are optional but
// at most one should be set (a row can't be in both scopes); the
// service layer doesn't enforce that on read because the UI's "global
// inbox" view passes neither.
wakeupRoutes.get("/", (c) => {
  const filter: { chatId?: number; taskId?: number; status?: WakeupStatus; limit?: number } = {};

  const chatId = parseIdQuery(c, "chat_id");
  if (chatId !== undefined) filter.chatId = chatId;

  const taskId = parseIdQuery(c, "task_id");
  if (taskId !== undefined) filter.taskId = taskId;

  const statusRaw = c.req.query("status");
  if (statusRaw !== undefined) {
    if (!VALID_STATUS.has(statusRaw as WakeupStatus)) {
      throw new ValidationError(
        `status must be one of ${Array.from(VALID_STATUS).join(" | ")}`,
      );
    }
    filter.status = statusRaw as WakeupStatus;
  }

  // `?limit=` is a soft hint for "max rows returned", not a paginated cursor —
  // the list endpoint is a small UI inbox view, not a scan API. Bare
  // positive-integer parse (no max clamp) matches the existing service
  // contract.
  const limit = parsePositiveIntQuery(c, "limit");
  if (limit !== undefined) filter.limit = limit;

  return c.json({ items: list(filter) });
});

// ─── Single read ────────────────────────────────────────────────────
wakeupRoutes.get("/:id", (c) => {
  const id = c.req.param("id");
  if (!id) throw new ValidationError("missing :id");
  const row = getById(id);
  if (!row) throw new NotFoundError("wakeup not found");
  return c.json(row);
});

// ─── Hook ingest ────────────────────────────────────────────────────
//
// POST /wakeups/from-hook
//   body: { chat_id?, task_id?, claude_session_id, delay_seconds,
//           prompt, reason? }
//
// Called by the Claude Code `PostToolUse` hook when a `ScheduleWakeup`
// tool-use lands in a Flockctl-managed session. The hook is responsible
// for resolving the local Flockctl chat/task id from the
// `claude_session_id` Claude Code passes in its hook envelope; if no
// Flockctl row owns the session, the hook MUST NOT POST here (the
// daemon-side worker has nothing to resume into).
wakeupRoutes.post("/from-hook", async (c) => {
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("body must be a JSON object");
  }
  const parsed = wakeupFromHookSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("invalid body", flattenZodError(parsed.error));
  }
  const data = parsed.data;

  const row = record({
    chatId: data.chat_id ?? null,
    taskId: data.task_id ?? null,
    claudeSessionId: data.claude_session_id,
    delaySeconds: data.delay_seconds,
    prompt: data.prompt,
    reason: data.reason ?? null,
  });

  broadcast(row.id);
  return c.json(row, 201);
});

// ─── Fire now ───────────────────────────────────────────────────────
//
// POST /wakeups/:id/fire
//
// Operator clicked "Wake now". We do NOT invoke the resume callback
// here — the worker tick is the single fire path so the integration
// stays in one place. Instead we move the row's `fire_at` into the
// past so the next tick (≤10s away by default) picks it up via the
// normal `findDuePending` query. This keeps the "fire" code path
// indistinguishable between scheduled-due and operator-forced.
wakeupRoutes.post("/:id/fire", (c) => {
  const id = c.req.param("id");
  if (!id) throw new ValidationError("missing :id");
  const existing = getById(id);
  if (!existing) throw new NotFoundError("wakeup not found");
  if (existing.status !== "pending") {
    throw new ValidationError(`cannot fire wakeup in status=${existing.status}`);
  }
  // We can't UPDATE fire_at directly via the service (no method exposed
  // — the service is intentionally state-machine-only), so for the
  // skeleton we mark it fired ourselves. The worker is the production
  // path; this is the operator-forced shortcut.
  const fired = markFired(id);
  if (!fired) throw new NotFoundError("wakeup not found");
  broadcast(id);
  return c.json(fired);
});

// ─── Cancel ─────────────────────────────────────────────────────────
//
// POST /wakeups/:id/cancel
//
// Operator clicked "✕". Idempotent on non-pending status (returns the
// row as-is rather than 422'ing) so a double-click on a row that the
// worker just fired doesn't surface a confusing error.
wakeupRoutes.post("/:id/cancel", (c) => {
  const id = c.req.param("id");
  if (!id) throw new ValidationError("missing :id");
  const existing = getById(id);
  if (!existing) throw new NotFoundError("wakeup not found");
  if (existing.status !== "pending") {
    return c.json(existing);
  }
  const cancelled = cancel(id);
  if (!cancelled) throw new NotFoundError("wakeup not found");
  broadcast(id);
  return c.json(cancelled);
});
