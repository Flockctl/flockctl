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
  fetchChatsPage,
  fetchChat,
  fetchChatDiff,
  fetchEntityChat,
  sendMessage,
  deleteChat,
  batchDeleteChats,
  endChatSession,
  applyChatWorktree,
  updateChat,
  fetchChatMetrics,
  fetchChatTodos,
  fetchChatTodoHistory,
  fetchChatTodoAgents,
  type ApplyChatWorktreeResponse,
  type BatchDeleteChatsResponse,
  type ChatEndSessionResponse,
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

/**
 * Paginated `/chats` reader for the dedicated `/chats` page.
 *
 * Why a second hook instead of extending `useChats`: most callers
 * (entity-scoped lookups, sidebar mini-lists) want a flat array and don't
 * paginate at all — wiring an accumulator + offset cursor through every
 * call site would just be noise. The chats page is the only surface that
 * needs to scroll past the server's default page size, so it gets its
 * own hook with the load-more state machine baked in.
 *
 * Shape mirrors {@link useChatTodoHistory}: first page via React Query
 * for cache + auto-refetch, subsequent pages through a plain async call
 * that appends to the in-memory accumulator. The accumulator is keyed
 * on `(perPage, filter)` — flipping any of those resets the list, same
 * way switching chats resets the todo-history drawer.
 *
 * Returns:
 *   - `items`        — every loaded chat, in server-ordered (pinned
 *                      first, then last_message_at desc) sequence.
 *   - `total`        — server's authoritative total for the active
 *                      filter. Lets the page render "X of Y" copy
 *                      without first loading every page.
 *   - `hasMore`      — `items.length < total`.
 *   - `isLoading`    — first-page React Query is still in flight.
 *   - `isError` / `error` — first-page failure surface.
 *   - `loadMore()`   — fetch the next slice and append. No-op while a
 *                      load is already in flight.
 *   - `loadingMore`  — true while `loadMore` is pending.
 *   - `loadMoreError` — last `loadMore` rejection (cleared on next
 *                      successful load).
 */
export function useChatsPaginated(
  perPage = 50,
  filter?: ChatsFilter,
) {
  const { projectId, workspaceId, entityType, entityId, q } = filter ?? {};

  const [items, setItems] = useState<ChatResponse[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<Error | null>(null);

  // Reset accumulator when any filter knob OR the page size changes.
  // Without this, switching from `?q=foo` to `?q=bar` would keep the old
  // `foo` chats above the new `bar` slice — which is what bit the todo
  // history drawer before its agent-tab reset was added.
  useEffect(() => {
    setItems([]);
    setOffset(0);
    setTotal(0);
    setLoadMoreError(null);
  }, [perPage, projectId, workspaceId, entityType, entityId, q]);

  const firstPage = useQuery({
    queryKey: [
      ...queryKeys.chats,
      "paginated",
      { perPage, projectId, workspaceId, entityType, entityId, q },
    ],
    queryFn: () =>
      fetchChatsPage(0, perPage, {
        projectId,
        workspaceId,
        entityType,
        entityId,
        q,
      }),
  });

  // Seed the accumulator from the first page. Guarded with a ref so a
  // re-render with the same `firstPage.data` reference doesn't reset the
  // list after the user has clicked "Load more". This is the same trick
  // `useChatTodoHistory` uses — see that hook for the long form of why
  // we don't lean on `firstPage.data` alone.
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
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await fetchChatsPage(offset, perPage, {
        projectId,
        workspaceId,
        entityType,
        entityId,
        q,
      });
      // De-dupe defensively: if a chat was created mid-pagination it
      // could appear in both the previous and the newly-fetched page
      // because the server orders by `(pinned DESC, last_message_at DESC)`
      // and a fresh chat slots at the top. Skip ids we already hold.
      setItems((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        const merged = [...prev];
        for (const chat of page.items) {
          if (!seen.has(chat.id)) merged.push(chat);
        }
        return merged;
      });
      setOffset((prev) => prev + page.items.length);
      // Server's `total` may have moved (chats added / deleted in
      // another tab) — always trust the latest snapshot rather than the
      // first page's count.
      setTotal(page.total);
    } catch (err) {
      setLoadMoreError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoadingMore(false);
    }
  }, [
    hasMore,
    loadingMore,
    offset,
    perPage,
    projectId,
    workspaceId,
    entityType,
    entityId,
    q,
  ]);

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
    // Accept either a bare id (legacy callers) or a `{ chatId, force }`
    // object so the chat-detail page can re-issue with `force: true`
    // after a 409 "dirty worktree" rejection without breaking the
    // existing single-id callers in the list view.
    mutationFn: (arg: string | { chatId: string; force?: boolean }) => {
      const chatId = typeof arg === "string" ? arg : arg.chatId;
      const force = typeof arg === "string" ? false : Boolean(arg.force);
      return deleteChat(chatId, { force });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    },
  });
}

/**
 * Mutation wrapping `POST /chats/:id/end-session`. Used by the chat
 * detail page's "End session" button. Mirrors `claude --worktree`'s
 * exit prompt — the chat row stays alive, only the worktree is
 * touched. On a 409 (dirty), the caller catches and re-prompts the
 * user before issuing again with `force: true`.
 */
export function useEndChatSession() {
  const queryClient = useQueryClient();
  return useMutation<
    ChatEndSessionResponse,
    Error,
    { chatId: string; force?: boolean }
  >({
    mutationFn: ({ chatId, force }) => endChatSession(chatId, { force }),
    onSuccess: (_, { chatId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    },
  });
}

/**
 * Mutation wrapping `POST /chats/:id/worktree/apply`. Used by the chat
 * detail page's "Apply" button — counterpart to "End session". Lands
 * the agent's commits on the project's currently-checked-out branch
 * via `git merge --no-ff`; the worktree itself is NOT removed (the
 * operator may keep iterating in the chat after the merge).
 *
 * On 409 the caller introspects `details.reason` to surface the right
 * actionable message: `worktree_dirty` / `project_dirty` ask the
 * operator to commit first; `conflict` lists the conflicting files for
 * manual resolution; `project_detached` says "checkout a branch
 * first".
 */
export function useApplyChatWorktree() {
  const queryClient = useQueryClient();
  return useMutation<ApplyChatWorktreeResponse, Error, string>({
    mutationFn: (chatId) => applyChatWorktree(chatId),
    onSuccess: (_, chatId) => {
      // Touch the chat detail (server bumps updatedAt on the row when
      // the merge lands) and the list page so the activity bar /
      // last-touched timestamp reflect the new commit.
      queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.chats });
    },
  });
}

/**
 * Bulk-delete a set of chats via `POST /chats/batch-delete`. Mirrors
 * {@link useDeleteChat} but takes an array of chat ids and surfaces the
 * server's partial-success response so the caller can show "Deleted X of Y"
 * messaging when some ids were already gone.
 *
 * Invalidates the chats list query on success — callers that pin per-chat
 * caches (`queryKeys.chat(id)`) for the deleted ids should clear those
 * themselves; we don't enumerate the ids here because the deletion outcome
 * already proves the rows are gone server-side.
 */
export function useBatchDeleteChats() {
  const queryClient = useQueryClient();
  return useMutation<BatchDeleteChatsResponse, Error, ReadonlyArray<string>>({
    mutationFn: (chatIds) => batchDeleteChats(chatIds),
    onSuccess: (_, chatIds) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chats });
      // Drop the per-chat caches for every id we attempted to delete — even
      // the ones the server reported as `missing`, since they're definitively
      // not coming back. Stops a stale conversation view from rendering after
      // navigation if the user revisits a deleted chat's URL.
      for (const id of chatIds) {
        queryClient.removeQueries({ queryKey: queryKeys.chat(id) });
      }
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
