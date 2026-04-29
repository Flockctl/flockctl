/**
 * useChatReplyNotifications — bridges the global WebSocket
 * `chat_assistant_final` frame into the notification dispatcher.
 *
 * Mounts once at the app shell as a sibling of
 * `<AttentionNotificationsRunner />` and `<TaskTerminalNotificationsRunner />`
 * (see `ui/src/components/layout.tsx`). For every `chat_assistant_final`
 * frame the hook calls `dispatcher.fire({ category: "chatReply", … })`
 * exactly once. The dispatcher then walks the leader / prefs / permission
 * / dedup gates the way it does for every other source — see
 * `notification-dispatcher.ts`.
 *
 * Why a separate runner from `useChatListLiveState`:
 *   - `useChatListLiveState` is mounted only on the Chats page
 *     (`pages/chats.tsx`) — it powers the per-chat running/pending
 *     indicators rendered in the chat list. If the chat-reply pump lived
 *     there too, navigating to any other route (Dashboard, Tasks, …)
 *     would tear the WS subscription down and silently drop the
 *     `chat_assistant_final` frame, so users miss replies whenever they
 *     are not staring at the chat list. Hoisting the pump into the layout
 *     root mirrors how the attention and task-terminal pipelines already
 *     work.
 *   - The two runners share the same global WS path
 *     (`/ws/ui/chats/events`) but `useGlobalWs` and `useWebSocket` open
 *     independent client sockets, so co-existence on `/chats` produces
 *     two parallel connections. That is fine — the server fans out the
 *     same frames to every connected client and the dispatcher's per-key
 *     dedup TTL collapses the duplicate broadcast inside the 5-second
 *     window.
 *
 * Self-poke suppression:
 *   - Background tab (`hasFocus === false`) → never suppress; the OS
 *     notification IS the call to action.
 *   - Foregrounded AND on the matching chat detail (`/chats/${chatId}`)
 *     → suppress. The user is already looking at the conversation, so
 *     the reply rendering inside `<ChatConversation>` is the call to
 *     action; an OS notification on top is just noise.
 *   - Foregrounded but anywhere else (chat list, another chat,
 *     `/dashboard`, …) → fire normally.
 *
 * Edge cases:
 *   - WS reconnect drops events — any `chat_assistant_final` frame that
 *     fired while the socket was down is lost. We accept the loss rather
 *     than build a server-side replay buffer just for a notification;
 *     the assistant message itself is committed to the DB, so the user
 *     sees it the next time they open the chat.
 *   - The frame intentionally carries no body / preview / title (see
 *     `lib/ws.ts` MessageType comment). The dispatcher uses the
 *     hardcoded "Chat reply" title; click-routing carries `chatId` /
 *     `messageId` through the dispatcher payload so the click-router can
 *     navigate to `/chats/${chatId}`.
 */

import { useCallback, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

import { type WSMessage } from "@/lib/ws";
import { useNotificationDispatcher } from "@/lib/contexts/notification-dispatcher-context";

import { useGlobalWs } from "./global-ws";

/**
 * Self-poke suppression rule for `chat_assistant_final` notifications.
 *
 * Mirrors `isFocusedOnSameEntity` in `use-attention-notifications.ts` —
 * if the user is staring at the chat that just produced the reply, the
 * UI itself is the call to action and an OS notification is just noise.
 *
 *   - `hasFocus === false` (background tab) → never suppress; the OS
 *     notification IS the call to action.
 *   - foregrounded AND on `/chats/${chatId}` → suppress.
 *   - foregrounded but on any other route (e.g. `/chats` list, another
 *     chat, `/dashboard`) → fire normally.
 *
 * Exported for unit testing.
 */
export function isFocusedOnSameChat(
  chatId: string,
  pathname: string,
  hasFocus: boolean,
): boolean {
  if (!hasFocus) return false;
  return pathname === `/chats/${chatId}`;
}

/**
 * Subscribes to the global WebSocket and forwards every
 * `chat_assistant_final` frame into the notification dispatcher.
 * Fire-and-forget; the only observable side-effect is the OS
 * notification.
 *
 * Mount once at the app shell via `<ChatReplyNotificationsRunner />` —
 * mounting under a route would tear the WS subscription down on every
 * navigation and silently drop frames that arrive during the
 * unmount/remount window.
 */
export function useChatReplyNotifications(): void {
  const dispatcher = useNotificationDispatcher();
  const location = useLocation();

  // Hold the latest pathname in a ref so the WS callback (which is
  // identity-stabilised by `useGlobalWs`) reads the *current* route
  // every time a frame lands, not the pathname captured at first
  // render. Using a ref instead of a dep on `useCallback` keeps the WS
  // subscription from tearing down on every navigation. The write is
  // scheduled in an effect so we don't mutate refs during render
  // (react-hooks/refs).
  const pathnameRef = useRef(location.pathname);
  useEffect(() => {
    pathnameRef.current = location.pathname;
  }, [location.pathname]);

  const onMessage = useCallback(
    (msg: WSMessage) => {
      if (msg.type !== "chat_assistant_final") return;

      // `chat_assistant_final` is broadcast directly via `_send` (not
      // `broadcastChat`) and so carries snake-case `chat_id` /
      // `message_id` on the envelope rather than the camelCase shape
      // `broadcastChat` injects. Read both forms defensively.
      const raw = msg as unknown as Record<string, unknown>;
      const finalChatId =
        raw.chat_id != null
          ? String(raw.chat_id)
          : raw.chatId != null
            ? String(raw.chatId)
            : null;
      const finalMessageId =
        raw.message_id != null
          ? String(raw.message_id)
          : raw.messageId != null
            ? String(raw.messageId)
            : null;
      if (!dispatcher || !finalChatId || !finalMessageId) return;

      const hasFocus =
        typeof document !== "undefined" ? document.hasFocus() : false;
      if (isFocusedOnSameChat(finalChatId, pathnameRef.current, hasFocus)) {
        return;
      }

      dispatcher.fire({
        category: "chatReply",
        // Per (chat, message) dedup — a duplicate broadcast for the
        // same assistant reply (e.g. when this runner co-exists with
        // `useChatListLiveState`'s legacy listener during a transition,
        // or simply because two tabs are open) collapses inside the
        // dispatcher's TTL window.
        key: `chat_assistant_final:${finalChatId}:${finalMessageId}`,
        title: "Chat reply",
      });
    },
    [dispatcher],
  );

  useGlobalWs(onMessage);
}

/**
 * Mountable wrapper. Sits next to `<AttentionNotificationsRunner />` and
 * `<TaskTerminalNotificationsRunner />` in the layout root so all three
 * runners share the same provider chain and none remounts on
 * navigation.
 */
export function ChatReplyNotificationsRunner(): null {
  useChatReplyNotifications();
  return null;
}
