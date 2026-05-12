import {
  useCallback,
  useEffect,
  useState,
  type RefObject,
} from "react";

import { useWebSocket, type WSMessage } from "./ws";

/**
 * useViewportLiveness — viewport-scoped per-chat liveness signal.
 *
 * Slice 24-02 T03: the chat list renders dozens of `<ChatRow>`s; opening a
 * `/ws/ui/chats/:id/events` socket per row at mount would flood the daemon
 * with subscriptions that are never read (most rows are off-screen). This
 * hook gates the per-chat subscription on `IntersectionObserver` so a row
 * only connects when it's actually visible to the user, and tears the
 * connection down the moment it scrolls off-viewport (or unmounts).
 *
 * Contract:
 *   - signature: `useViewportLiveness(rowRef, chatId): { isStreaming }`
 *   - opens **zero** WS subscriptions before any row reports
 *     `isIntersecting === true`. The initial render of a 50-chat list is
 *     therefore a no-op WS-wise.
 *   - closes the subscription on `isIntersecting === false` AND on unmount
 *     (the inner `useWebSocket({ enabled: false })` branch tears the socket
 *     down; the IntersectionObserver is `disconnect()`-ed in the cleanup
 *     callback).
 *   - `isStreaming` resets to `false` whenever the row falls off-viewport so
 *     a stale `true` from a prior subscription cannot leak back in once the
 *     row scrolls back into view (the next `session_started` frame from the
 *     fresh subscription will flip it back).
 *
 * The lookup `useChatStream(chatId, { enabled })` mentioned in the slice
 * brief is intentionally NOT used here — that hook owns SSE message
 * streaming and queue draining, both of which are far heavier than what a
 * list row needs (a single boolean). Using `useWebSocket` directly against
 * the per-chat events socket gives us the same `session_started` /
 * `session_ended` truth without dragging in the queue store, the optimistic
 * cache writes, or the abort/retry plumbing.
 */
export interface UseViewportLivenessResult {
  /** True while a chat session is currently running on the daemon. */
  isStreaming: boolean;
}

export function useViewportLiveness(
  rowRef: RefObject<HTMLElement | null>,
  chatId: string,
): UseViewportLivenessResult {
  const [isVisible, setIsVisible] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  // Observe the row element. The observer is created lazily on mount and
  // torn down on unmount or when the ref's underlying element changes
  // identity (the latter is rare in a virtualized list — ref objects are
  // stable across renders — but we re-run on `rowRef` changes for safety).
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    // SSR / jsdom-without-shim guard. `useWebSocket` already guards `enabled`
    // so we just leave `isVisible=false` and the WS path stays inert.
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        setIsVisible(entry.isIntersecting);
      },
      { threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rowRef]);

  // Reset the streaming flag whenever we go off-viewport. The fresh
  // subscription opened on the next intersect will repaint `isStreaming`
  // from authoritative WS frames, so stale state never leaks across the
  // off→on boundary.
  useEffect(() => {
    if (!isVisible) setIsStreaming(false);
  }, [isVisible]);

  const onMessage = useCallback(
    (msg: WSMessage) => {
      // Per-chat events socket already filters server-side, but a defensive
      // chatId match keeps us robust against the daemon ever fanning out a
      // global frame onto the per-chat path.
      const raw = msg as unknown as Record<string, unknown>;
      const incoming = raw.chatId != null ? String(raw.chatId) : null;
      if (incoming != null && incoming !== chatId) return;

      if (msg.type === "session_started") setIsStreaming(true);
      else if (msg.type === "session_ended") setIsStreaming(false);
    },
    [chatId],
  );

  // The crux of the hook: `enabled` is gated on viewport visibility AND a
  // truthy chatId. While `enabled === false` `useWebSocket` does not
  // construct a `WebSocket` — that's how a 50-row initial render produces
  // 0 subscriptions.
  useWebSocket({
    path: chatId ? `/ws/ui/chats/${chatId}/events` : "",
    onMessage,
    enabled: isVisible && Boolean(chatId),
  });

  return { isStreaming };
}

export default useViewportLiveness;
