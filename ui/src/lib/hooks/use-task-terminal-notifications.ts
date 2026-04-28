/**
 * useTaskTerminalNotifications — bridges live task lifecycle frames into
 * the notification dispatcher.
 *
 * Mounts once at the app shell as a sibling of `<AttentionNotificationsRunner />`
 * (see `ui/src/main.tsx` / `ui/src/components/layout.tsx`). For every
 * `task_status` frame on the global WebSocket whose status is one of the
 * terminal set (`done`, `failed`, `cancelled`, `timed_out`) the hook calls
 * `dispatcher.fire({ source: "task_terminal", … })` exactly once. The
 * dispatcher then walks the leader / prefs / permission / dedup gates the
 * way it does for every other source — see `notification-dispatcher.ts`.
 *
 * Why a separate runner from the attention pipeline:
 *   - Attention rows are `pending_*` items the user must act on. The diff
 *     baseline + `resolveByKey` lifecycle assumes an inbox row that
 *     appears, then disappears. Terminal task events are point-in-time —
 *     there is no "row" to resolve. They use the dispatcher's
 *     `source: "task_terminal"` auto-close TTL instead.
 *   - Self-poke suppression is intentionally NOT applied here: knowing
 *     the task you're currently watching just finished is still useful
 *     (the page may not auto-refresh fast enough, or the user may be
 *     looking at logs and miss the status flip). Documented decision.
 *
 * Edge cases:
 *   - WS reconnect drops events — any task_status frame that fired while
 *     the socket was down is lost. The attention path's reconnect-refetch
 *     covers the high-value case (still-pending approvals); for terminal
 *     events we accept the loss rather than build a server-side replay
 *     buffer just for a notification.
 *   - Title resolution races the frame — a brand-new task may not have
 *     hydrated into the React Query cache yet. The "Task <id-prefix>"
 *     fallback handles that without dropping the notification.
 */

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { MessageType, type WSMessage } from "@/lib/ws";
import { useNotificationDispatcher } from "@/lib/contexts/notification-dispatcher-context";
import enLocale from "@/locales/en.json";

import { queryKeys } from "./core";
import { useGlobalWs } from "./global-ws";

const T = enLocale.notifications;

/**
 * The four task statuses we treat as "terminal enough to ping the user
 * about". `pending_approval` is intentionally NOT in this set — that's
 * the attention pipeline's job, and double-firing would produce two OS
 * notifications for the same logical event.
 */
const TERMINAL_STATUSES = new Set<string>([
  "done",
  "failed",
  "cancelled",
  "timed_out",
]);

type TerminalStatus = "done" | "failed" | "cancelled" | "timed_out";

/**
 * Maps a task terminal status onto the dispatcher's category enum. `done`
 * and `failed` map 1:1; `cancelled` and `timed_out` collapse onto
 * `blocked` because they share the user-visible category label
 * ("Task cancelled or timed out") in `en.json` and the same per-category
 * pref toggle (`onTaskBlocked`).
 */
const STATUS_TO_CATEGORY: Record<TerminalStatus, "done" | "failed" | "blocked"> = {
  done: "done",
  failed: "failed",
  cancelled: "blocked",
  timed_out: "blocked",
};

const TITLE_MAX_LEN = 120;
const TITLE_TRIM_LEN = 117;

/**
 * Truncate the body string at `TITLE_MAX_LEN` characters, appending an
 * ellipsis. Keeps the OS notification body readable on platforms (macOS,
 * GNOME) that crop or wrap aggressively past ~120 chars and stops a
 * pathological multi-paragraph prompt from filling half a notification
 * center entry. Exported for unit testing — callers should not use it
 * directly.
 */
export function truncateTitle(s: string): string {
  return s.length > TITLE_MAX_LEN ? `${s.slice(0, TITLE_TRIM_LEN)}…` : s;
}

/**
 * Resolve a human-readable label for the task. Tries, in order:
 *   1. `frame.title` — only set if a future server-side change starts
 *      including the label on the broadcast envelope. Out-of-the-box
 *      `task_status` frames do not carry one (see
 *      `wsManager.broadcastTaskStatus`), so this is a forward-compat hook.
 *   2. The React Query cache for this task — the API row carries `label`
 *      (defined on the SQL table) and `prompt`. We try `label` first
 *      because operators set it intentionally as a short identifier; the
 *      prompt can be a multi-paragraph wall of text.
 *   3. `Task <first-8-of-id>` fallback for brand-new tasks the cache has
 *      not yet hydrated.
 *
 * Exported so the unit test can pin every branch deterministically
 * without driving a real React Query cache.
 */
export function resolveTaskTitle(
  frame: Record<string, unknown>,
  cached: Record<string, unknown> | undefined,
  taskId: string,
): string {
  const fromFrame =
    typeof frame.title === "string" && frame.title.length > 0
      ? frame.title
      : null;
  if (fromFrame) return fromFrame;
  if (cached) {
    const label =
      typeof cached.label === "string" && cached.label.length > 0
        ? cached.label
        : null;
    if (label) return label;
    const prompt =
      typeof cached.prompt === "string" && cached.prompt.length > 0
        ? cached.prompt
        : null;
    if (prompt) return prompt;
  }
  return `Task ${taskId.slice(0, 8)}`;
}

/**
 * Subscribes to the global WebSocket and forwards every terminal
 * `task_status` frame into the notification dispatcher. Fire-and-forget;
 * the only observable side-effect is the OS notification.
 *
 * Mount once at the app shell via `<TaskTerminalNotificationsRunner />` —
 * mounting under a route would tear the WS subscription down on every
 * navigation and silently drop frames that arrive during the
 * unmount/remount window.
 */
export function useTaskTerminalNotifications(): void {
  const dispatcher = useNotificationDispatcher();
  const queryClient = useQueryClient();

  // `useGlobalWs` wraps onMessage in a stable ref internally — reassigning
  // the callback when dispatcher / queryClient identity flips does NOT
  // tear down the underlying WebSocket. We can therefore close over both
  // values directly via the dep array without any ref bookkeeping on our
  // side.
  const onMessage = useCallback(
    (msg: WSMessage) => {
      // Backend sends some frames as `{ type, payload: {...} }` (per-task
      // logs WS) and others as flat `{ type, taskId, status, ... }`
      // (broadcastAll envelopes — see `WSManager.broadcastTaskStatus`).
      // Read both shapes the same way `task-stream.ts` does.
      if (msg.type !== MessageType.TASK_STATUS) return;
      const data = (msg.payload ?? msg) as Record<string, unknown>;
      const taskIdRaw = data.taskId ?? data.task_id;
      if (taskIdRaw == null) return;
      const taskId = String(taskIdRaw);
      const status = String(data.status ?? "");
      if (!TERMINAL_STATUSES.has(status)) return;

      if (!dispatcher) return;

      const cached = queryClient.getQueryData<Record<string, unknown>>(
        queryKeys.task(taskId),
      );
      const rawTitle = resolveTaskTitle(data, cached, taskId);
      const body = truncateTitle(rawTitle);

      const terminal = status as TerminalStatus;
      const category = STATUS_TO_CATEGORY[terminal];

      dispatcher.fire({
        // Title is the localised category banner — same convention as the
        // attention path, so users see "Task completed" / "Task failed"
        // rather than the per-task body twice.
        title: T.cat[category],
        body,
        category,
        // Per-task + per-status dedup key. Including the status means a
        // task that flips failed → re-run → failed twice produces two
        // notifications (different events), but the dispatcher's
        // 5-second dedup TTL still collapses a duplicate broadcast for
        // the same (task, status) pair.
        key: `task_terminal:${taskId}:${terminal}`,
        // `task_terminal` triggers the dispatcher's auto-close TTL —
        // there is no inbox row for it to be resolved by.
        source: "task_terminal",
        // Routing payload for the click-router — terminal events have
        // no inbox row, so we hand the taskId through directly.
        taskId,
      });
    },
    [dispatcher, queryClient],
  );

  useGlobalWs(onMessage);
}

/**
 * Mountable wrapper. Sits next to `<AttentionNotificationsRunner />` in
 * the layout root so both runners share the same provider chain and
 * neither remounts on navigation.
 */
export function TaskTerminalNotificationsRunner(): null {
  useTaskTerminalNotifications();
  return null;
}
