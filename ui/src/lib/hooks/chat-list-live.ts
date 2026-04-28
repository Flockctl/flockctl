import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWebSocket, type WSMessage } from "../ws";
import { fetchPendingChatPermissions } from "../api";
import { useNotificationDispatcher } from "@/lib/contexts/notification-dispatcher-context";
import { queryKeys } from "./core";

// --- Chat list live state (running + pending approvals per chat) ---

export interface ChatListLiveState {
  /** chatId → number of pending permission requests awaiting UI response */
  pendingCount: Record<string, number>;
  /** chatId → whether a chat session is currently active on the server */
  running: Record<string, boolean>;
}

/**
 * Subscribes to the global chat event stream and tracks live per-chat state
 * for the chat list: whether a session is running and how many permission
 * requests are waiting for the user. Seeded from GET /chats/pending-permissions
 * so reloads mid-session still show the right indicators.
 */
export function useChatListLiveState(enabled = true): ChatListLiveState {
  const [pendingCount, setPendingCount] = useState<Record<string, number>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const queryClient = useQueryClient();
  const dispatcher = useNotificationDispatcher();

  // Seed + refetch whenever the hook is (re-)enabled.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchPendingChatPermissions()
      .then((snap) => {
        if (cancelled) return;
        setPendingCount(snap.pending ?? {});
        const runMap: Record<string, boolean> = {};
        for (const id of snap.running ?? []) runMap[id] = true;
        setRunning(runMap);
      })
      .catch(() => { /* non-fatal — WS will fill in state as events arrive */ });
    return () => { cancelled = true; };
  }, [enabled]);

  const onMessageRef = useRef<(msg: WSMessage) => void>(() => {});
  onMessageRef.current = useCallback((msg: WSMessage) => {
    const raw = msg as unknown as Record<string, unknown>;
    // `chat_assistant_final` is broadcast directly via _send (not
    // broadcastChat) and so carries snake-case `chat_id` / `message_id`
    // rather than the camelCase `chatId` injected by broadcastChat. Pull
    // both keys before the early-return below short-circuits on a missing
    // `chatId`. The chat list itself does not need to update — the
    // assistant message lives in the chat detail, not the list summary —
    // so we only fan the event into the notification dispatcher.
    if (msg.type === "chat_assistant_final") {
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
      if (dispatcher && finalChatId && finalMessageId) {
        dispatcher.fire({
          category: "chatReply",
          // Per (chat, message) dedup — a duplicate broadcast for the same
          // assistant reply collapses inside the dispatcher's TTL window.
          key: `chat_assistant_final:${finalChatId}:${finalMessageId}`,
          title: "Chat reply",
        });
      }
      return;
    }

    const chatId = raw.chatId != null ? String(raw.chatId) : null;
    if (!chatId) return;

    if (msg.type === "session_started") {
      setRunning((prev) => (prev[chatId] ? prev : { ...prev, [chatId]: true }));
    } else if (msg.type === "session_ended") {
      setRunning((prev) => {
        if (!prev[chatId]) return prev;
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
      // A finished session invalidates any outstanding permission requests.
      setPendingCount((prev) => {
        if (!prev[chatId]) return prev;
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
      // Chat list metrics (message count, cost) changed — refresh it.
      queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    } else if (msg.type === "permission_request") {
      setPendingCount((prev) => ({ ...prev, [chatId]: (prev[chatId] ?? 0) + 1 }));
    } else if (msg.type === "permission_resolved") {
      setPendingCount((prev) => {
        const curr = prev[chatId] ?? 0;
        if (curr <= 0) return prev;
        const next = { ...prev };
        if (curr <= 1) delete next[chatId];
        else next[chatId] = curr - 1;
        return next;
      });
    }
  }, [queryClient, dispatcher]);

  const stableOnMessage = useCallback(
    (msg: WSMessage) => onMessageRef.current(msg),
    [],
  );

  useWebSocket({
    path: "/ws/ui/chats/events",
    onMessage: stableOnMessage,
    enabled,
  });

  return { pendingCount, running };
}
