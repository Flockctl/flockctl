import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWebSocket, type WSMessage } from "../ws";
import {
  fetchChatPendingPermissions,
  type AgentQuestionItem,
  type ChatTodosResponse,
  type ChatTodoCounts,
} from "../api";
import type { ChatDetailResponse } from "../types/chat";
import { queryKeys, type PermissionRequestUI } from "./core";

export function useChatEventStream(chatId: string | null) {
  const [permissionRequests, setPermissionRequests] = useState<PermissionRequestUI[]>([]);
  const [sessionRunning, setSessionRunning] = useState<boolean | null>(null);
  const queryClient = useQueryClient();

  // Reset live session flag when switching chats — otherwise a previous chat's
  // running state leaks into a new selection until the first WS event arrives.
  // Also refetch the chat: the WS does not replay, so any `session_ended`
  // that fired while we were subscribed to a different chat is lost and the
  // cached `isRunning` would otherwise stay stale (either stuck `true` from
  // a prior session or stuck `false` from the pre-send snapshot). A fresh
  // GET /chats/:id realigns the UI with the server's actual state — correct
  // `isRunning`, and the assistant message when the session has finished.
  useEffect(() => {
    setSessionRunning(null);
    setPermissionRequests([]);
    if (chatId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    }
  }, [chatId, queryClient]);

  // Hydrate pending permission requests on mount / chatId change. See the
  // matching comment in useTaskLogStream: WS doesn't replay on reconnect, so
  // a reload mid-prompt would otherwise hide the card while the session stays
  // stuck waiting for a response.
  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    fetchChatPendingPermissions(chatId)
      .then((res) => {
        if (cancelled) return;
        setPermissionRequests((prev) => {
          const existing = new Set(prev.map((r) => r.request_id));
          const merged = [...prev];
          for (const item of res.items) {
            if (!existing.has(item.request_id)) merged.push(item);
          }
          return merged;
        });
      })
      .catch(() => { /* no active session — nothing to hydrate */ });
    return () => { cancelled = true; };
  }, [chatId]);

  const onMessageRef = useRef<(msg: WSMessage) => void>(() => {});
  onMessageRef.current = useCallback((msg: WSMessage) => {
    const raw = msg as unknown as Record<string, unknown>;
    // Messages from broadcastChat carry a top-level `chatId` — filter on it so
    // cross-chat events don't leak into this stream.
    if (!chatId || String(raw.chatId ?? "") !== chatId) return;
    const data = (msg.payload ?? msg) as Record<string, unknown>;
    if (msg.type === "permission_request") {
      const req: PermissionRequestUI = {
        request_id: String(data.request_id),
        tool_name: String(data.tool_name),
        tool_input: (data.tool_input as Record<string, unknown>) ?? {},
        title: data.title ? String(data.title) : null,
        display_name: data.display_name ? String(data.display_name) : null,
        description: data.description ? String(data.description) : null,
        decision_reason: data.decision_reason ? String(data.decision_reason) : null,
        tool_use_id: String(data.tool_use_id ?? ""),
      };
      setPermissionRequests((prev) =>
        prev.some((r) => r.request_id === req.request_id) ? prev : [...prev, req],
      );
    } else if (msg.type === "agent_question") {
      // Shared agent-question cache — see matching comment in useTaskLogStream.
      const item: AgentQuestionItem = {
        id: Number(data.db_id ?? 0),
        requestId: String(data.request_id),
        question: String(data.question ?? ""),
        toolUseId: String(data.tool_use_id ?? ""),
        createdAt: data.created_at ? String(data.created_at) : null,
      };
      queryClient.setQueryData<{ items: AgentQuestionItem[] }>(
        queryKeys.agentQuestion("chat", chatId),
        (prev) => {
          const items = prev?.items ?? [];
          if (items.some((q) => q.requestId === item.requestId)) {
            return prev ?? { items };
          }
          return { items: [...items, item] };
        },
      );
    } else if (msg.type === "permission_resolved") {
      // Fires for both manual UI allow/deny AND bulk auto-resolve after a
      // permission-mode swap (variant B). In the manual path the card is
      // removed optimistically by `resolvePermissionRequest`, so the filter
      // here is a no-op. In the auto path the card was never touched by the
      // UI, so this frame is the only signal to drop it from the pending
      // list. `request_id` is the canonical key — match on it.
      const requestId = String(data.request_id);
      setPermissionRequests((prev) => prev.filter((r) => r.request_id !== requestId));
    } else if (msg.type === "chat_permission_mode_changed") {
      // Another client (or the backend's auto-resolver path) mutated the
      // chat's permission mode. Patch the cached ChatDetailResponse in
      // place so PermissionModeSelect's `value` prop updates without a
      // round-trip GET. `current` carries the new string literal.
      const current = data.current as ChatDetailResponse["permission_mode"];
      queryClient.setQueryData<ChatDetailResponse | undefined>(
        queryKeys.chat(chatId),
        (prev) => (prev ? { ...prev, permission_mode: current } : prev),
      );
    } else if (msg.type === "agent_question_resolved") {
      const requestId = String(data.request_id);
      queryClient.setQueryData<{ items: AgentQuestionItem[] }>(
        queryKeys.agentQuestion("chat", chatId),
        (prev) => {
          if (!prev) return { items: [] };
          return {
            items: prev.items.filter((q) => q.requestId !== requestId),
          };
        },
      );
    } else if (msg.type === "session_started") {
      setSessionRunning(true);
    } else if (msg.type === "session_ended") {
      // Order matters: refetch BEFORE flipping sessionRunning to false.
      //
      // `serverRunning` in chat-conversation.tsx is `sessionRunning ??
      // chatDetail?.isRunning`. `false` is not nullish, so once we flip
      // sessionRunning to false the chatDetail fallback is bypassed. If we did
      // that while the chat cache still held the optimistic state from
      // `startStream` (isRunning=true, messages ending with the user turn),
      // the fallback condition `!serverRunning && last message is user` would
      // briefly become true and render the "Response was not received" bubble
      // until the GET /chats/:id response lands. On a slow network or after a
      // chat switch (where the fresh WS connection fires session_ended in
      // close succession with other refetches) that flash was long enough for
      // the user to see.
      //
      // Refetching first guarantees the assistant message is in cache by the
      // time sessionRunning flips, so serverRunning transitions straight from
      // true → false only once messages actually end with the assistant row.
      queryClient
        .refetchQueries({ queryKey: queryKeys.chat(chatId) })
        .catch(() => { /* network error — the next natural refetch will recover */ })
        .finally(() => setSessionRunning(false));
      queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    } else if (msg.type === "chat_diff_updated") {
      // The backend just appended file-edit journal entries for this chat
      // (Edit/Write/MultiEdit tool call). Invalidate the cached diff so the
      // "Changes" card at the bottom of the chat re-fetches and picks up
      // both the updated summary and, if currently expanded, the fresh
      // unified-diff body. See chat-executor.ts + routes/chats/diff.ts.
      queryClient.invalidateQueries({ queryKey: queryKeys.chatDiff(chatId) });
    } else if (msg.type === "todo_updated") {
      // Fold the live counts into the React Query cache under the same key
      // `useChatTodos` reads from — that way the todos hook stays a plain
      // `useQuery` (no per-hook WS plumbing) and any other subscriber
      // (e.g. chat-list indicator) sees the update immediately.
      const counts = data.counts as ChatTodoCounts | undefined;
      if (counts) {
        queryClient.setQueryData<ChatTodosResponse | null>(
          queryKeys.chatTodos(chatId),
          (prev) => {
            // Preserve whichever snapshot we already have — the WS frame only
            // carries counts + snapshot_id, not the full todos array. A query
            // invalidation below refetches the snapshot body asynchronously.
            const snapshot = prev?.snapshot ?? {
              id: Number(data.snapshot_id ?? 0),
              created_at: new Date().toISOString(),
              todos: [],
            };
            return { snapshot, counts };
          },
        );
        // Refresh the snapshot body so the todos array catches up with the
        // new counts on next render — cheap GET, and it no-ops when the cache
        // is already fresh.
        queryClient.invalidateQueries({ queryKey: queryKeys.chatTodos(chatId) });
        // The per-agent grouping powers the Todo history drawer's tab strip.
        // A new sub-agent's first snapshot only shows up there after this
        // invalidates — without it the drawer would silently miss new tabs
        // until the user closed and reopened it. Cheap (one row per agent).
        queryClient.invalidateQueries({ queryKey: queryKeys.chatTodoAgents(chatId) });
      }
    }
  }, [chatId, queryClient]);

  const stableOnMessage = useCallback(
    (msg: WSMessage) => onMessageRef.current(msg),
    [],
  );

  useWebSocket({
    path: chatId ? `/ws/ui/chats/${chatId}/events` : "",
    onMessage: stableOnMessage,
    enabled: !!chatId,
  });

  const dismissPermissionRequest = useCallback((requestId: string) => {
    setPermissionRequests((prev) => prev.filter((r) => r.request_id !== requestId));
  }, []);

  return { permissionRequests, dismissPermissionRequest, sessionRunning };
}
