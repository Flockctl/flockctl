import { useState, useEffect, useRef, useCallback } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  createChat,
  fetchChats,
  fetchChat,
  fetchChatDiff,
  fetchEntityChat,
  sendMessage,
  deleteChat,
  updateChat,
  fetchChatMetrics,
  fetchChatTodos,
  fetchChatTodoHistory,
  fetchChatTodoAgents,
  type ChatTodosResponse,
  type ChatTodoHistoryItem,
  type ChatTodoAgentsResponse,
} from "../api";
import type {
  ChatCreate,
  ChatResponse,
  ChatDetailResponse,
  ChatMessageCreate,
  ChatUpdate,
} from "../types";
import { queryKeys } from "./core";

// --- Chat hooks ---

export interface ChatsFilter {
  projectId?: string;
  workspaceId?: string;
  entityType?: string;
  entityId?: string;
  /** Free-text search over chat title, message content, and project/workspace name. */
  q?: string;
}

export function useChats(
  filter?: ChatsFilter,
  options?: Partial<UseQueryOptions<ChatResponse[]>>,
) {
  const { projectId, workspaceId, entityType, entityId, q } = filter ?? {};
  return useQuery({
    queryKey: [...queryKeys.chats, { projectId, workspaceId, entityType, entityId, q }],
    queryFn: () => fetchChats({ projectId, workspaceId, entityType, entityId, q }),
    ...options,
  });
}

export function useEntityChat(
  projectId: string | undefined,
  entityType: string | undefined,
  entityId: string | undefined,
) {
  return useQuery({
    queryKey: ["entityChat", projectId, entityType, entityId],
    queryFn: () => fetchEntityChat(projectId!, entityType!, entityId!),
    enabled: !!projectId && !!entityType && !!entityId,
  });
}

export function useChat(
  chatId: string | null,
  options?: Partial<UseQueryOptions<ChatDetailResponse>>,
) {
  return useQuery({
    queryKey: queryKeys.chat(chatId!),
    queryFn: () => fetchChat(chatId!),
    enabled: !!chatId,
    ...options,
  });
}

export function useCreateChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ChatCreate) => createChat(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chats });
      // Entity-scoped chats (milestone/slice/task dialogs) look up an existing
      // chat via the ["entityChat", …] query. Invalidate it so a freshly-created
      // chat is picked up on remount (e.g. reopening the plan-chat dialog).
      queryClient.invalidateQueries({ queryKey: ["entityChat"] });
    },
  });
}

export function useSendMessage(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ChatMessageCreate) => sendMessage(chatId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    },
  });
}

export function useDeleteChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (chatId: string) => deleteChat(chatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    },
  });
}

export function useUpdateChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, data }: { chatId: string; data: ChatUpdate }) =>
      updateChat(chatId, data),
    onSuccess: (_, { chatId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    },
  });
}

export function useChatMetrics(chatId: string | null) {
  return useQuery({
    queryKey: ["chatMetrics", chatId],
    queryFn: () => fetchChatMetrics(chatId!),
    enabled: !!chatId,
  });
}

/**
 * Latest TodoWrite snapshot + counts for a chat, kept reactive via the
 * `chat:<id>` WS channel already owned by `useChatEventStream`.
 *
 * The query seeds from `GET /chats/:id/todos`; live `todo_updated` frames are
 * folded into the same query cache key from inside `useChatEventStream`, so
 * this hook intentionally does NOT open its own WebSocket — both the
 * streaming handler (permission/session events) and the progress bar share
 * one subscription.
 *
 * Returns the React Query result; `.data` is `null` until the chat emits its
 * first TodoWrite snapshot (server responds 204 which surfaces as null).
 */
export function useChatTodos(chatId: string | null) {
  return useQuery<ChatTodosResponse | null>({
    queryKey: chatId
      ? queryKeys.chatTodos(chatId)
      : ["chats", "__none__", "todos"],
    queryFn: () => fetchChatTodos(chatId!),
    enabled: !!chatId,
  });
}

/**
 * Paginated TodoWrite snapshot history for a chat, newest first, with a
 * cursor-based "load more" affordance.
 *
 * Model: the hook keeps the accumulated list of snapshots in local state and
 * advances the offset on each `loadMore()`. `hasMore` is derived from the
 * server's `total` vs. the accumulated length — same shape the rest of the
 * codebase uses with offset/limit pagination. We deliberately avoid
 * `useInfiniteQuery` because (a) nothing else in the UI uses it, and (b) the
 * drawer is read-only and short-lived, so the simpler state machine matches
 * the existing style better than pulling in another query pattern.
 *
 * The first page is fetched via React Query (so the initial open is cached
 * across drawer toggles); subsequent pages go through a plain mutation because
 * they're cursor-forward and never re-read. The WS `todo_updated` handler in
 * `useChatEventStream` invalidates `chatTodos` — the history cache is
 * intentionally NOT invalidated there: the drawer is a historical view, and
 * flushing mid-scroll would reshuffle the list under the user. Close + reopen
 * to see newly appended snapshots.
 */
export function useChatTodoHistory(
  chatId: string | null,
  perPage = 20,
  /** Optional agent filter scoping the history to a single per-agent
   *  timeline. `MAIN_AGENT_KEY` ("main") for the main agent, a `toolu_…`
   *  id for a specific sub-agent, `undefined` for the legacy mixed feed.
   *  Changing this resets the accumulator, same as switching chats. */
  agent?: string,
) {
  const [items, setItems] = useState<ChatTodoHistoryItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<Error | null>(null);

  // Reset accumulator when the chat OR the agent filter changes — otherwise
  // flipping tabs would show a mixed timeline until the first page refetch
  // returns. Same guard mechanism as chat-id changes.
  useEffect(() => {
    setItems([]);
    setOffset(0);
    setTotal(0);
    setLoadMoreError(null);
  }, [chatId, agent]);

  const firstPage = useQuery({
    queryKey: chatId
      ? [...queryKeys.chatTodoHistory(chatId), agent ?? null]
      : ["chats", "__none__", "todos", "history", agent ?? null],
    queryFn: () => fetchChatTodoHistory(chatId!, 0, perPage, agent),
    enabled: !!chatId,
  });

  // Seed the accumulator from the first page's data. Guarded so re-renders
  // with the same `firstPage.data` reference don't reset the list after the
  // user has already loaded additional pages.
  const firstPageData = firstPage.data;
  const lastSeenFirstPageRef = useRef<typeof firstPageData>(undefined);
  useEffect(() => {
    if (!firstPageData) return;
    if (lastSeenFirstPageRef.current === firstPageData) return;
    lastSeenFirstPageRef.current = firstPageData;
    setItems(firstPageData.items);
    setOffset(firstPageData.items.length);
    setTotal(firstPageData.total);
  }, [firstPageData]);

  const hasMore = items.length < total;

  const loadMore = useCallback(async () => {
    if (!chatId || !hasMore || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await fetchChatTodoHistory(chatId, offset, perPage, agent);
      setItems((prev) => [...prev, ...page.items]);
      setOffset((prev) => prev + page.items.length);
      setTotal(page.total);
    } catch (err) {
      setLoadMoreError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoadingMore(false);
    }
  }, [chatId, hasMore, loadingMore, offset, perPage, agent]);

  return {
    items,
    total,
    hasMore,
    isLoading: firstPage.isLoading,
    isError: firstPage.isError,
    error: firstPage.error as Error | null,
    loadMore,
    loadingMore,
    loadMoreError,
  };
}

/**
 * Per-agent grouping for the Todo history drawer's tab strip. Returns one
 * row per distinct `parent_tool_use_id` (NULL coerced to `MAIN_AGENT_KEY`),
 * each with the latest snapshot, snapshot count, and a label resolved from
 * the spawning Task call.
 *
 * The WS `todo_updated` handler in `useChatEventStream` invalidates this
 * cache so a new sub-agent's first snapshot pops a new tab into the drawer
 * without requiring a manual refresh.
 */
export function useChatTodoAgents(chatId: string | null) {
  return useQuery<ChatTodoAgentsResponse>({
    queryKey: chatId
      ? queryKeys.chatTodoAgents(chatId)
      : ["chats", "__none__", "todos", "agents"],
    queryFn: () => fetchChatTodoAgents(chatId!),
    enabled: !!chatId,
  });
}

/**
 * Fetch the synthesized diff for a chat. Powers the "Changes" card rendered
 * at the bottom of `<ChatConversation>`. The WS handler in
 * `useChatEventStream` invalidates this query whenever a `chat_diff_updated`
 * frame arrives, so the summary updates live during an assistant turn
 * without a page reload.
 */
export function useChatDiff(chatId: string | null) {
  return useQuery({
    queryKey: chatId ? queryKeys.chatDiff(chatId) : ["chats", "__none__", "diff"],
    queryFn: () => fetchChatDiff(chatId!),
    enabled: !!chatId,
    // A chat can rack up many file edits in a single turn; don't refetch on
    // every component remount — the WS event already invalidates us when
    // the backend actually has new data.
    staleTime: 60_000,
  });
}
