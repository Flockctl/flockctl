import { useEffect, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { WSMessage } from "../ws";
import { fetchAttention, type AttentionResponse } from "../api";
import { getActiveServerId } from "../server-store";
import { queryKeys } from "./core";
import { useGlobalWs } from "./global-ws";

// --- Attention hook ---

export interface UseAttentionResult {
  items: AttentionResponse["items"];
  total: number;
  isLoading: boolean;
  error: unknown;
  connectionState: ReturnType<typeof useGlobalWs>["state"];
}

/**
 * Live-refreshing list of items that currently require user action
 * (task approvals, task/chat permission prompts).
 *
 * Data flow:
 *  1. Initial + background fetch via React Query under the
 *     `['attention', serverId]` key.
 *  2. The hook listens on the global WS stream (shared by every consumer
 *     through `useGlobalWs`). When a message of type `attention_changed`
 *     arrives, we invalidate the query — the list is re-fetched from the
 *     server. We never store items in component state; React Query owns
 *     the cache.
 *  3. On WS reconnect (connectionState transitioning to `'open'`) we
 *     invalidate the same query. This is the stale-cache safety net for
 *     frames missed while the socket was down — the server does not
 *     replay events on reconnect.
 */
export function useAttention(): UseAttentionResult {
  const queryClient = useQueryClient();
  const serverId = getActiveServerId();
  const queryKey = queryKeys.attention(serverId);

  const { data, isLoading, error } = useQuery<AttentionResponse>({
    queryKey,
    queryFn: fetchAttention,
  });

  const onMessage = useCallback(
    (msg: WSMessage) => {
      // `attention_changed` isn't in the shared MessageType enum — the
      // server broadcasts it opportunistically via `broadcastAll`.
      if ((msg.type as string) === "attention_changed") {
        queryClient.invalidateQueries({ queryKey });
      }
    },
    [queryClient, queryKey],
  );

  const { state: connectionState } = useGlobalWs(onMessage);

  // Stale-cache safety net: re-fetch whenever the socket (re)opens.
  const prevConnectionState = useRef(connectionState);
  useEffect(() => {
    if (
      prevConnectionState.current !== "open" &&
      connectionState === "open"
    ) {
      queryClient.invalidateQueries({ queryKey });
    }
    prevConnectionState.current = connectionState;
  }, [connectionState, queryClient, queryKey]);

  return {
    items: data?.items ?? [],
    total: data?.total ?? 0,
    isLoading,
    error,
    connectionState,
  };
}
