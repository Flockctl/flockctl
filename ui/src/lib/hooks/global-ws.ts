import { useRef, useCallback } from "react";
import { useWebSocket, type WSMessage } from "../ws";

// --- Global WS subscription (shared fan-out for broadcastAll frames) ---

/**
 * Subscribes to the single global WebSocket stream the server pushes
 * `broadcastAll` frames over. Every caller passes a stable `onMessage`;
 * we wrap it in a ref so the underlying `useWebSocket` never tears down
 * and reconnects when a consumer re-renders with a new function identity.
 *
 * The path is the same one `useChatListLiveState` uses — any connected
 * client ends up in `wsManager.allClients`, so `broadcastAll` events
 * (e.g. `attention_changed`) reach it regardless of the endpoint's
 * nominal scope. Consumers should multiplex through the React Query
 * cache rather than keeping their own in-hook state.
 */
export function useGlobalWs(
  onMessage: (msg: WSMessage) => void,
  enabled = true,
) {
  const onMessageRef = useRef<(msg: WSMessage) => void>(() => {});
  onMessageRef.current = onMessage;

  const stableOnMessage = useCallback(
    (msg: WSMessage) => onMessageRef.current(msg),
    [],
  );

  return useWebSocket({
    path: "/ws/ui/chats/events",
    onMessage: stableOnMessage,
    enabled,
  });
}
