/**
 * Notification → SPA route mapping.
 *
 * Pure function. Takes a `Notifiable` (the same payload the dispatcher
 * fans into the OS notification) and returns the SPA path the user
 * should land on when they click that notification. No router,
 * `window.location`, or DOM access — the function is trivially
 * unit-testable and reused by both the React hook
 * (`useNotificationClickRouter`) and any future surface that needs the
 * same mapping (e.g. a hypothetical "open" button on an inbox row).
 *
 * Routing rules:
 *
 *   - `source: "task_terminal"` → `/tasks/{taskId}` when `taskId` is
 *     present, `/attention` otherwise. Terminal task notifications never
 *     have an `item` (they're WebSocket frames, not inbox rows), so the
 *     dedicated `taskId` field on `Notifiable` is the only signal.
 *
 *   - `category: "chatReply"` (the WebSocket `chat_assistant_final`
 *     event) → `/chats/{chatId}#message-{messageId}` when both are
 *     present, `/chats/{chatId}` when only `chatId` is present, and
 *     `/attention` when neither is. The `#message-…` fragment hooks
 *     into the chat-detail deep-link-to-message scroll behaviour
 *     (added in a separate slice); emitting the fragment here is a
 *     no-op for surfaces that don't yet read it. Symmetry with the
 *     four task / chat M14 cases is the whole point — no scroll code
 *     lives in the click router itself.
 *
 *   - `source: "attention"` (or any other source carrying an `item`):
 *     read the discriminated `kind` and pick `/tasks/{task_id}` or
 *     `/chats/{chat_id}` accordingly. `task_question` and `chat_question`
 *     map onto the parent entity (not the request_id) — the question
 *     surface lives inside the task / chat detail page.
 *
 *   - Anything else (no `item`, no `taskId`, or an unrecognised `kind`)
 *     falls back to `/attention`. The inbox is the universal landing
 *     page — the user can re-pick the row from there. We deliberately do
 *     NOT throw on a malformed payload; a click that lands on `/attention`
 *     is far less surprising than a click that does nothing.
 *
 * Path strings here MUST stay in sync with the routes registered in
 * `ui/src/main.tsx` (`tasks/:taskId`, `chats/:chatId`, `attention`). A
 * silent drift would land users on a 404 — there's no compile-time link
 * between this map and the router config, so a unit test pins each
 * branch explicitly.
 */

import type { Notifiable } from "./notification-dispatcher";

export function routeForNotification(n: Notifiable): string {
  if (n.source === "task_terminal") {
    return n.taskId ? `/tasks/${n.taskId}` : "/attention";
  }
  // chatReply (= WebSocket `chat_assistant_final`): route by the
  // dedicated chatId/messageId pair on the Notifiable. We check the
  // category rather than `source` because the upstream chat-reply runner
  // doesn't set a `source` (chat-reply notifications are neither attention
  // rows nor task-terminal events — they're a third origin). Hash fragment
  // is included whenever `messageId` is present so the chat-detail
  // deep-link-to-message scroll behaviour can pick it up.
  if (n.category === "chatReply") {
    if (!n.chatId) return "/attention";
    return n.messageId
      ? `/chats/${n.chatId}#message-${n.messageId}`
      : `/chats/${n.chatId}`;
  }
  const item = n.item;
  if (!item) return "/attention";
  switch (item.kind) {
    case "task_approval":
    case "task_permission":
    case "task_question":
      // Every task_* attention kind carries `task_id` per the
      // AttentionItem discriminated union. The `?? "/attention"` guard
      // is defence-in-depth against a future schema change that drops
      // the field rather than something the current types allow.
      return item.task_id ? `/tasks/${item.task_id}` : "/attention";
    case "chat_approval":
    case "chat_permission":
    case "chat_question":
      return item.chat_id ? `/chats/${item.chat_id}` : "/attention";
    default:
      // Exhaustiveness fallback. Unreachable while AttentionItem's union
      // matches the cases above; left in so a new kind doesn't silently
      // become a no-op click.
      return "/attention";
  }
}
