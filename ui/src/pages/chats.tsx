import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTrackRecent } from "@/lib/recent-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  useChatsPaginated,
  useChat,
  useCreateChat,
  useDeleteChat,
  useEndChatSession,
  useApplyChatWorktree,
  useBatchDeleteChats,
  useUpdateChat,
  useChatListLiveState,
  useProjects,
  useWorkspaces,
} from "@/lib/hooks";
import { cn, timeAgo } from "@/lib/utils";
import { formatCost, formatTokens } from "@/lib/format";
import { markChatRead, useChatReadMap } from "@/lib/chat-read-store";
import {
  Trash2,
  MessageSquare,
  ArrowLeft,
  Pin,
  PinOff,
  Plus,
} from "lucide-react";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";
import { ChatConversation } from "@/components/chat-conversation";
import { SectionHeader } from "@/components/design";
import { EmptyState } from "@/components/EmptyState";
import { ApiError } from "@/lib/api";
import { enqueueMessage } from "@/lib/chat-queue-store";
import { buildOpenPrPrompt } from "@/lib/open-pr-prompt";

/**
 * Recognise the backend's "this chat's worktree has uncommitted changes"
 * 409 from `DELETE /chats/:id` (and `POST /chats/:id/end-session`). The
 * server emits `ConflictError` with `details.reason === "dirty"` — the
 * caller is expected to re-issue with `force: true` after operator
 * confirmation, otherwise the deletion is silently lost (which is the
 * exact bug this gate protects against).
 */
function isDirtyWorktreeError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status !== 409) return false;
  const reason =
    err.details && typeof err.details === "object"
      ? (err.details as { reason?: unknown }).reason
      : undefined;
  return reason === "dirty";
}

/**
 * Pull the `details` payload off an `ApiError` for the apply-worktree
 * 409 family. Returns `null` for non-`ApiError` rejections, non-409
 * statuses, or details-less errors. The handler narrows on
 * `details.reason` to surface the right copy ("commit your WIP first" /
 * "resolve conflicts manually" / etc.) without re-parsing the message
 * string.
 */
function applyWorktreeErrorDetails(err: unknown):
  | {
      reason: string;
      sourceBranch?: string;
      targetBranch?: string;
      conflicts?: string[];
    }
  | null {
  if (!(err instanceof ApiError)) return null;
  if (err.status !== 409) return null;
  const d = err.details;
  if (!d || typeof d !== "object") return null;
  const obj = d as {
    reason?: unknown;
    source_branch?: unknown;
    target_branch?: unknown;
    conflicts?: unknown;
  };
  if (typeof obj.reason !== "string") return null;
  return {
    reason: obj.reason,
    sourceBranch:
      typeof obj.source_branch === "string" ? obj.source_branch : undefined,
    targetBranch:
      typeof obj.target_branch === "string" ? obj.target_branch : undefined,
    conflicts: Array.isArray(obj.conflicts)
      ? (obj.conflicts.filter((x) => typeof x === "string") as string[])
      : undefined,
  };
}

import {
  ChatsToolbar,
  filterChatsByQuery,
  type ChatsGroupMode,
} from "@/pages/chats-components/ChatsToolbar";
import { ChatsList } from "@/pages/chats-components/ChatsList";

/**
 * `/chats` page assembly (slice 24-02 T04).
 *
 * Two render modes, gated by the URL:
 *
 *   - `/chats` (no `:chatId`) → the redesigned flat list page:
 *
 *       ┌─────────────────────────────────────────────────────────┐
 *       │ <SectionHeader title="Chats"                            │
 *       │   subtitle="{liveCount} live · {totalCount} total"      │
 *       │   action={<ChatsToolbar />}                             │
 *       │ />                                                      │
 *       │                                                         │
 *       │ <ChatsList chats={filtered} group={group} … />          │
 *       │                                                         │
 *       │   — empty / filtered-empty fall back to <EmptyState>.   │
 *       └─────────────────────────────────────────────────────────┘
 *
 *     Search lives in the URL (`?q=`) and is driven by the toolbar's
 *     debounced `onSearchChange` so a copy-paste link round-trips the
 *     query. Group mode lives in `?group=list|project`. Clicking a row
 *     navigates to `/chats/:id` — the conversation view below takes
 *     over.
 *
 *   - `/chats/:chatId` → the legacy two-pane layout: chat list on the
 *     left rail, conversation on the right. That surface is owned by
 *     slice 24-03 (chat-conversation); this slice intentionally leaves
 *     it intact so the redesign rolls out one screen at a time.
 *
 * Visual baselines for the list view (list/grouped × light/dark + empty
 * + filtered) live in `ui/e2e/chats.spec.ts`.
 */
export default function ChatsPage() {
  const { chatId: urlChatId } = useParams<{ chatId?: string }>();
  // When chatId is in the URL we hand off to the (still-legacy)
  // conversation surface. Otherwise we render the redesigned list page.
  if (urlChatId) {
    return <ChatsConversationView urlChatId={urlChatId} />;
  }
  return <ChatsListView />;
}

/* ------------------------------------------------------------------ */
/* List view (redesigned per slice 24-02)                              */
/* ------------------------------------------------------------------ */

function ChatsListView() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // URL is the source of truth — the toolbar writes ?q= and ?group= on
  // a debounced commit, the page re-reads them every render. That means
  // a paste-in link `/chats?q=plan&group=project` lands users in the
  // exact view they captured.
  const query = searchParams.get("q") ?? "";
  const groupRaw = searchParams.get("group");
  const group: ChatsGroupMode = groupRaw === "project" ? "project" : "list";

  // Paginated read against `/chats`. The server defaults to a 20-row
  // page, which used to leave anyone with more than 20 chats with a
  // silently-truncated list. The hook here keeps an in-memory
  // accumulator and exposes `loadMore()` for the trailing button below.
  //
  // We deliberately keep `q` OUT of the server-side filter so the
  // toolbar's `filterChatsByQuery` predicate (centralised in
  // ChatsToolbar) stays the sole authority on what "matches the
  // search" — same invariant the contract tests in
  // chats-search.test.tsx rely on. The trade-off: when the user types
  // a query, only the chats already loaded are searched. The page
  // surfaces this honestly via the load-more button (still visible
  // whenever `hasMore` is true) so the user can pull in more rows
  // before deciding the search has nothing.
  const {
    items: chats,
    total: chatsTotal,
    hasMore,
    isLoading,
    loadMore,
    loadingMore,
    loadMoreError,
  } = useChatsPaginated(50);
  const { pendingCount: chatPendingMap, running: chatRunningMap } =
    useChatListLiveState();
  const chatReadMap = useChatReadMap();

  // New-chat dialog — opened from the toolbar button + the empty-state
  // CTA so both share one mounted instance.
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatProjectId, setNewChatProjectId] = useState<string>("");
  const [newChatWorkspaceId, setNewChatWorkspaceId] = useState<string>("");
  const [newChatIsolate, setNewChatIsolate] = useState(false);
  const { data: projectsList } = useProjects();
  const { data: workspacesList } = useWorkspaces();
  const createChatMutation = useCreateChat();
  const updateChatMutation = useUpdateChat();
  const deleteChatMutation = useDeleteChat();
  const batchDeleteChatMutation = useBatchDeleteChats();
  const deleteConfirm = useConfirmDialog();
  // Batch-delete confirmation dialog. Reuses ConfirmDialog but keys off
  // `batchDeleteOpen` because `useConfirmDialog` only carries a single
  // `targetId` — the multi-select payload lives in `selectedIds` below.
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);

  // Multi-select state for bulk operations. Stored as a Set for O(1)
  // membership checks during render. Cleared on successful batch delete
  // and whenever the underlying chat list shrinks below the selection
  // (so a row that disappears from a server refresh doesn't leave a
  // ghost id pinned in the bar).
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const handleToggleMultiSelect = useCallback(
    (id: string, next: boolean) => {
      setSelectedIds((prev) => {
        const isSelected = prev.has(id);
        if (next === isSelected) return prev;
        const updated = new Set(prev);
        if (next) updated.add(id);
        else updated.delete(id);
        return updated;
      });
    },
    [],
  );
  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);
  const handleBatchDelete = useCallback(async () => {
    // Note: we deliberately bind to `selectedIds` here, not the derived
    // `effectiveSelectedIds`. If a stale id slipped into the canonical
    // state we still ship it — the server reports it as `missing` and
    // we move on. Filtering client-side risks a short window where the
    // chat list is mid-refetch and an id looks "missing" locally but
    // would still match server-side.
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    try {
      await batchDeleteChatMutation.mutateAsync(ids);
      setSelectedIds(new Set());
      setBatchDeleteOpen(false);
    } catch {
      // Error surface is React Query's mutation state — leave the dialog
      // open so the user can retry without losing the selection.
    }
  }, [batchDeleteChatMutation, selectedIds]);

  // Per-row mutators — hover-revealed on the list rows. Same handlers as
  // the conversation view's header buttons, just exposed at the row level
  // so the user can pin / delete without opening the chat first.
  const handleTogglePin = useCallback(
    (id: string, nextPinned: boolean) => {
      updateChatMutation.mutate({
        chatId: id,
        data: { pinned: nextPinned },
      });
    },
    [updateChatMutation],
  );
  const handleDeleteRowConfirmed = useCallback(
    async (id: string) => {
      // Worktree-isolated chats: the backend refuses to drop the row when
      // the per-chat worktree has uncommitted changes (409 with
      // `details.reason === "dirty"`). Mirror the End-Session "discard?"
      // handshake: prompt the operator, then re-issue with `force: true`.
      // Without this branch the mutation rejection is swallowed by the
      // dialog's `.then()` and the user sees "ничего не происходит".
      try {
        await deleteChatMutation.mutateAsync(id);
      } catch (err: unknown) {
        if (isDirtyWorktreeError(err)) {
          const ok = window.confirm(
            "This chat's worktree has uncommitted changes. Discard them and delete the chat anyway?",
          );
          if (!ok) return;
          await deleteChatMutation.mutateAsync({ chatId: id, force: true });
          return;
        }
        // Surface any other failure — silent rejection is what produced
        // the "delete does nothing" bug in the first place.
        const message = err instanceof Error ? err.message : String(err);
        window.alert(`Failed to delete chat: ${message}`);
        throw err;
      }
    },
    [deleteChatMutation],
  );

  const handleNewChat = useCallback(() => {
    setNewChatProjectId("");
    setNewChatWorkspaceId("");
    setNewChatIsolate(false);
    setNewChatOpen(true);
  }, []);

  const handleCreateChat = useCallback(async () => {
    const chat = await createChatMutation.mutateAsync({
      projectId: newChatProjectId ? parseInt(newChatProjectId) : undefined,
      workspaceId: newChatWorkspaceId ? parseInt(newChatWorkspaceId) : undefined,
      // Worktree isolation only meaningful when the chat is bound to a
      // project — workspaces don't host a git repo by themselves.
      ...(newChatIsolate && newChatProjectId ? { isolation: "worktree" as const } : {}),
    });
    setNewChatOpen(false);
    navigate(`/chats/${chat.id}`);
  }, [
    createChatMutation,
    newChatProjectId,
    newChatWorkspaceId,
    newChatIsolate,
    navigate,
  ]);

  const allChats = useMemo(() => chats ?? [], [chats]);
  const filtered = useMemo(
    () => filterChatsByQuery(allChats, query),
    [allChats, query],
  );
  const loadedCount = allChats.length;

  // Drop selected ids that no longer exist in the underlying chat list
  // before they reach the UI. Stale ids accumulate naturally — after a
  // successful batch delete the cache invalidation lands before any
  // optimistic clear we'd run client-side, and another browser tab
  // deleting a checked chat would leave a ghost id in our Set. We
  // derive the effective set at render time instead of mutating state
  // in an effect: avoids the cascading-render warning and keeps the
  // canonical `selectedIds` simple (stale ids stay in state and are
  // pruned next time the user toggles or clears).
  const effectiveSelectedIds = useMemo<ReadonlySet<string>>(() => {
    if (selectedIds.size === 0) return selectedIds;
    if (isLoading) return selectedIds;
    const allIds = new Set(allChats.map((c) => c.id));
    let allPresent = true;
    for (const id of selectedIds) {
      if (!allIds.has(id)) {
        allPresent = false;
        break;
      }
    }
    if (allPresent) return selectedIds;
    const pruned = new Set<string>();
    for (const id of selectedIds) if (allIds.has(id)) pruned.add(id);
    return pruned;
  }, [allChats, isLoading, selectedIds]);

  // `total` from the server is authoritative — it's the count for the
  // active filter, not just what we've paginated into memory. Falls
  // back to `loadedCount` only on the very first render before the
  // first page has resolved (otherwise the subtitle would briefly
  // flash "0 total").
  const totalCount = chatsTotal > 0 ? chatsTotal : loadedCount;
  // Live count is computed off the global `useChatListLiveState` maps
  // so it reflects activity across ALL chats, not just paginated-in
  // ones. `is_streaming` from a row is folded in for already-loaded
  // chats so a transient row that the live snapshot hasn't caught yet
  // still counts. Set-based union keeps double counts from happening
  // when a chat is both running AND has pending answers.
  const liveCount = useMemo(() => {
    const liveIds = new Set<string>();
    for (const id of Object.keys(chatRunningMap)) {
      if (chatRunningMap[id]) liveIds.add(id);
    }
    for (const id of Object.keys(chatPendingMap)) {
      if ((chatPendingMap[id] ?? 0) > 0) liveIds.add(id);
    }
    for (const c of allChats) {
      if (c.is_streaming) liveIds.add(c.id);
    }
    return liveIds.size;
  }, [allChats, chatPendingMap, chatRunningMap]);

  const subtitle = useMemo(() => {
    if (isLoading) return undefined;
    // Surface the load progress when not everything is paginated in
    // yet, so the user knows the list is partial without having to
    // scroll to find the load-more button. "X live · Y of Z total"
    // collapses to the original "X live · Z total" once everything is
    // loaded — visual chrome only appears when relevant.
    const totalSegment =
      hasMore && loadedCount < totalCount
        ? `${loadedCount} of ${totalCount} total`
        : `${totalCount} total`;
    return `${liveCount} live · ${totalSegment}`;
  }, [hasMore, isLoading, liveCount, loadedCount, totalCount]);

  const handleSelect = useCallback(
    (chatId: string) => navigate(`/chats/${chatId}`),
    [navigate],
  );

  const showInitialEmpty = !isLoading && allChats.length === 0;
  const showFilteredEmpty =
    !isLoading && allChats.length > 0 && filtered.length === 0;

  return (
    <div data-testid="chats-page" className="max-w-4xl">
      <SectionHeader
        title="Chats"
        subtitle={subtitle}
        action={<ChatsToolbar onNewChat={handleNewChat} />}
      />

      {isLoading && (
        <div className="space-y-2" data-testid="chats-loading">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      )}

      {showInitialEmpty && (
        <EmptyState
          icon={MessageSquare}
          title="No chats yet"
          description="Start a chat to talk to an agent about a project, workspace, or just to think out loud."
          action={
            <Button
              type="button"
              size="sm"
              onClick={handleNewChat}
              data-testid="chats-empty-cta"
            >
              <Plus aria-hidden="true" />
              New chat
            </Button>
          }
          data-testid="chats-empty-state"
        />
      )}

      {showFilteredEmpty && (
        <EmptyState
          icon={MessageSquare}
          title="No chats match your search"
          description="Try a different title or message excerpt."
          action={
            <Button
              type="button"
              size="sm"
              onClick={handleNewChat}
              data-testid="chats-filtered-empty-cta"
            >
              <Plus aria-hidden="true" />
              New chat
            </Button>
          }
          data-testid="chats-filtered-empty-state"
        />
      )}

      {/* Selection bar — only rendered when at least one chat is checked.
          Keeps the page chrome quiet in the common case (no selection)
          and surfaces a single concentrated affordance when the user is
          mid-batch. Sticks just above the list so the count + delete
          button stay glanceable while the user keeps checking rows. */}
      {effectiveSelectedIds.size > 0 && (
        <div
          data-testid="chats-selection-bar"
          className="mb-2 flex items-center justify-between gap-2 rounded border border-indigo-200 bg-indigo-50 px-3 py-2 text-[12.5px] dark:border-indigo-900/60 dark:bg-indigo-950/40"
        >
          <span
            className="font-medium text-indigo-900 dark:text-indigo-200"
            data-testid="chats-selection-count"
          >
            {effectiveSelectedIds.size} selected
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={handleClearSelection}
              data-testid="chats-selection-clear"
            >
              Clear
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => setBatchDeleteOpen(true)}
              disabled={batchDeleteChatMutation.isPending}
              data-testid="chats-selection-delete"
            >
              Delete {effectiveSelectedIds.size}
            </Button>
          </div>
        </div>
      )}

      {!isLoading && filtered.length > 0 && (
        <ChatsList
          chats={filtered}
          group={group}
          pendingByChatId={chatPendingMap}
          runningByChatId={chatRunningMap}
          lastReadByChatId={chatReadMap}
          onSelect={handleSelect}
          onTogglePin={handleTogglePin}
          onDelete={(id) => deleteConfirm.requestConfirm(id)}
          multiSelectedIds={effectiveSelectedIds}
          onToggleMultiSelect={handleToggleMultiSelect}
          data-testid="chats-list"
        />
      )}

      {/* Load-more affordance — only renders when the server reports
          more rows than we currently hold. Lives outside the
          `filtered.length > 0` guard above because a filtered-empty
          state should still let the user pull in additional pages
          (the search filter runs only over what's been loaded). */}
      {!isLoading && hasMore && (
        <div
          data-testid="chats-load-more"
          className="mt-3 flex flex-col items-center gap-1"
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void loadMore();
            }}
            disabled={loadingMore}
            data-testid="chats-load-more-button"
          >
            {loadingMore
              ? "Loading…"
              : `Load more (${Math.max(0, totalCount - loadedCount)} remaining)`}
          </Button>
          {loadMoreError && (
            <p
              className="text-[11px] text-red-500"
              data-testid="chats-load-more-error"
            >
              {loadMoreError.message || "Failed to load more chats."}
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete Chat"
        description="This will permanently delete this chat and all its messages. This action cannot be undone."
        isPending={deleteChatMutation.isPending}
        onConfirm={() => {
          if (deleteConfirm.targetId) {
            // `.finally` instead of `.then`: the handler may reject
            // (network / backend error after we surface the alert) or
            // resolve early when the operator declines the dirty-worktree
            // discard prompt. Either way the dialog must close — leaving
            // it open with no feedback is exactly the symptom the
            // worktree-delete bug produced.
            handleDeleteRowConfirmed(deleteConfirm.targetId)
              .catch(() => {
                /* already surfaced inside handleDeleteRowConfirmed */
              })
              .finally(() => deleteConfirm.reset());
          }
        }}
      />

      {/* Batch-delete confirmation. Description spells out the count so a
          user with many rows checked can sanity-check before committing —
          the row-level dialog above is fine with a generic description
          because it always operates on exactly one chat. */}
      <ConfirmDialog
        open={batchDeleteOpen}
        onOpenChange={(open) => {
          if (!batchDeleteChatMutation.isPending) setBatchDeleteOpen(open);
        }}
        title={
          effectiveSelectedIds.size === 1
            ? "Delete chat"
            : `Delete ${effectiveSelectedIds.size} chats`
        }
        description={
          effectiveSelectedIds.size === 1
            ? "This will permanently delete this chat and all its messages. This action cannot be undone."
            : `This will permanently delete ${effectiveSelectedIds.size} chats and all their messages. This action cannot be undone.`
        }
        isPending={batchDeleteChatMutation.isPending}
        onConfirm={handleBatchDelete}
      />

      <NewChatDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        projectId={newChatProjectId}
        workspaceId={newChatWorkspaceId}
        onProjectChange={(v) => {
          setNewChatProjectId(v);
          if (v) setNewChatWorkspaceId("");
        }}
        onWorkspaceChange={(v) => {
          setNewChatWorkspaceId(v);
          if (v) setNewChatProjectId("");
        }}
        projects={projectsList ?? []}
        workspaces={workspacesList ?? []}
        onCreate={handleCreateChat}
        creating={createChatMutation.isPending}
        isolateWorktree={newChatIsolate}
        onIsolateChange={setNewChatIsolate}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Conversation view (legacy two-pane — owned by slice 24-03)          */
/* ------------------------------------------------------------------ */

/**
 * Conversation view (variant C, slice 24-XX rework).
 *
 * Uses the same shell as the redesigned `/chats` list — `<SectionHeader>`
 * up top, content below — instead of the legacy two-pane layout. The
 * sidebar (its own search, filters, and inline list rows) is gone:
 * navigation between chats happens via the back link to `/chats`, which
 * already owns the canonical search / group / list surface.
 *
 *     ┌─────────────────────────────────────────────────────────────┐
 *     │ ← Chats / <Title (click to edit)>      [Pin] [Delete] [+ New]│
 *     │ project · workspace · 12 msgs · 12.3k tok · $0.42 · 3m ago   │
 *     │ ───────────────────────────────────────────────────────────── │
 *     │ <ChatConversation>                                           │
 *     │   (messages, todo bar, composer, …)                          │
 *     └─────────────────────────────────────────────────────────────┘
 *
 * The inner `ChatConversation` keeps its own message scroll area + composer
 * — we just give it a custom `headerSlot={null}` because the section header
 * above already carries the title and metrics it would otherwise render.
 */
function ChatsConversationView({ urlChatId }: { urlChatId: string }) {
  const navigate = useNavigate();
  const chatId = urlChatId;

  const { data: projectsList } = useProjects();
  const { data: workspacesList } = useWorkspaces();

  // New chat dialog state — we keep the affordance on this page so a user
  // who's deep inside one chat can spin up another without bouncing back to
  // the list view first.
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatProjectId, setNewChatProjectId] = useState<string>("");
  const [newChatWorkspaceId, setNewChatWorkspaceId] = useState<string>("");
  const [newChatIsolate, setNewChatIsolate] = useState(false);

  // Inline title editing — same affordance as the legacy compact header,
  // promoted into the page-level h1.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  const { data: chatDetail } = useChat(chatId);
  useTrackRecent({
    kind: "chat",
    id: chatId,
    label: chatDetail?.title ?? `Chat ${chatId.slice(0, 7)}`,
    href: `/chats/${chatId}`,
  });
  const createChatMutation = useCreateChat();
  const deleteChatMutation = useDeleteChat();
  const updateChatMutation = useUpdateChat();
  const endSessionMutation = useEndChatSession();
  const applyWorktreeMutation = useApplyChatWorktree();
  const deleteConfirm = useConfirmDialog();
  // "Open PR" dialog state — operator can add a one-liner of extra
  // context (issue link, target reviewer, scope clarification) which
  // gets appended to the boilerplate prompt before it goes into the
  // chat queue. Lives next to the worktree affordances because both
  // are gated on `chatDetail?.worktree_path`.
  const [openPrDialogOpen, setOpenPrDialogOpen] = useState(false);
  const [openPrContext, setOpenPrContext] = useState("");

  useEffect(() => {
    if (!chatDetail?.updated_at) return;
    markChatRead(chatId, chatDetail.updated_at);
  }, [chatId, chatDetail?.updated_at]);

  // "End session" handler — wraps `POST /chats/:id/end-session` with a
  // 409-on-dirty handshake. The server returns 409 with `details.reason
  // === "dirty"` when the worktree carries uncommitted changes; we
  // surface a confirm prompt and re-issue with `force: true` if the
  // operator opts to discard. Lives inside the chat detail component
  // because both `chatDetail.worktree_path` and the mutation handle
  // are local to it.
  const handleEndSession = useCallback(async () => {
    if (!chatDetail?.worktree_path) return;
    try {
      const r = await endSessionMutation.mutateAsync({ chatId });
      window.alert(
        r.removed
          ? `Worktree removed (${r.reason}).`
          : `Worktree kept: ${r.reason}.`,
      );
    } catch (err: unknown) {
      // Pre-`ApiError` this branch was silently dead — `apiFetch` threw a
      // plain `Error` whose `.status` / `.details` were always undefined,
      // so the dirty-worktree confirm prompt never fired. With `ApiError`
      // in place we narrow on the class and read its preserved fields
      // directly; same protocol the chat-delete handlers above rely on.
      if (isDirtyWorktreeError(err)) {
        const ok = window.confirm(
          "This chat's worktree has uncommitted changes. Discard them and remove the worktree?",
        );
        if (!ok) return;
        const r = await endSessionMutation.mutateAsync({ chatId, force: true });
        window.alert(`Worktree force-removed (${r.reason}).`);
      } else {
        throw err;
      }
    }
  }, [chatDetail?.worktree_path, chatId, endSessionMutation]);

  /**
   * "Apply" handler — counterpart to End session. Calls
   * `POST /chats/:id/worktree/apply` which merges the chat's worktree
   * branch into whatever branch is currently checked out in the
   * project's main directory. Surfaces every actionable failure mode
   * (`worktree_dirty`, `project_dirty`, `project_detached`, `conflict`)
   * with concrete copy so the operator knows what to fix before
   * retrying.
   */
  const handleApplyWorktree = useCallback(async () => {
    if (!chatDetail?.worktree_path) return;
    try {
      const r = await applyWorktreeMutation.mutateAsync(chatId);
      const sha = r.merge_commit ? ` (${r.merge_commit.slice(0, 8)})` : "";
      window.alert(
        r.reason === "already_merged"
          ? `Already merged: ${r.source_branch} is reachable from ${r.target_branch}${sha}.`
          : `Merged ${r.source_branch} into ${r.target_branch}${sha}.`,
      );
    } catch (err: unknown) {
      const d = applyWorktreeErrorDetails(err);
      if (!d) {
        const message = err instanceof Error ? err.message : String(err);
        window.alert(`Apply failed: ${message}`);
        return;
      }
      switch (d.reason) {
        case "worktree_dirty":
          window.alert(
            "The chat's worktree has uncommitted changes — ask the agent to commit them, then retry.",
          );
          return;
        case "project_dirty":
          window.alert(
            "The project's main directory has uncommitted changes — commit, stash, or discard them, then retry.",
          );
          return;
        case "project_detached":
          window.alert(
            "The project is on a detached HEAD — checkout a branch first.",
          );
          return;
        case "conflict": {
          const list = d.conflicts && d.conflicts.length > 0
            ? `\n\nConflicting files:\n  ${d.conflicts.join("\n  ")}`
            : "";
          window.alert(
            `Merge conflict — ${d.sourceBranch ?? "the worktree branch"} into ${
              d.targetBranch ?? "the current branch"
            } produced conflicts.${list}\n\nResolve manually in the project, or ask the agent to rebase.`,
          );
          return;
        }
        case "not_a_git_repo":
          window.alert("Project is not a git working tree.");
          return;
        default:
          window.alert(`Apply failed: ${d.reason}`);
      }
    }
  }, [applyWorktreeMutation, chatDetail?.worktree_path, chatId]);

  /**
   * "Open PR" — drops a structured prompt into the chat queue. The
   * agent runs the prompt next time it's idle: commit anything still
   * outstanding (with operator confirmation for unfamiliar drift),
   * push the branch, and open a PR via `gh pr create` with a
   * properly-filled title/body. Optional context the operator types
   * in the dialog gets appended to the prompt verbatim.
   */
  const handleOpenPrConfirm = useCallback(() => {
    if (!chatDetail?.worktree_path) return;
    const prompt = buildOpenPrPrompt(openPrContext);
    enqueueMessage(chatId, { content: prompt });
    setOpenPrContext("");
    setOpenPrDialogOpen(false);
  }, [chatDetail?.worktree_path, chatId, openPrContext]);

  const handleNewChat = useCallback(() => {
    setNewChatProjectId("");
    setNewChatWorkspaceId("");
    setNewChatIsolate(false);
    setNewChatOpen(true);
  }, []);

  const handleCreateChat = useCallback(async () => {
    const chat = await createChatMutation.mutateAsync({
      projectId: newChatProjectId ? parseInt(newChatProjectId) : undefined,
      workspaceId: newChatWorkspaceId ? parseInt(newChatWorkspaceId) : undefined,
      // Worktree isolation only meaningful when the chat is bound to a
      // project — workspaces don't host a git repo by themselves.
      ...(newChatIsolate && newChatProjectId ? { isolation: "worktree" as const } : {}),
    });
    setNewChatOpen(false);
    navigate(`/chats/${chat.id}`);
  }, [
    createChatMutation,
    newChatProjectId,
    newChatWorkspaceId,
    newChatIsolate,
    navigate,
  ]);

  const handleDeleteChat = useCallback(
    async (id: string) => {
      // Same 409→force handshake as the row-level delete (see
      // `handleDeleteRowConfirmed`). The detail-page header's Delete
      // button hits the same backend gate, and without this the chat
      // appears to "do nothing" when the worktree is dirty.
      try {
        await deleteChatMutation.mutateAsync(id);
      } catch (err: unknown) {
        if (isDirtyWorktreeError(err)) {
          const ok = window.confirm(
            "This chat's worktree has uncommitted changes. Discard them and delete the chat anyway?",
          );
          if (!ok) return;
          await deleteChatMutation.mutateAsync({ chatId: id, force: true });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          window.alert(`Failed to delete chat: ${message}`);
          return;
        }
      }
      navigate("/chats");
    },
    [deleteChatMutation, navigate],
  );

  const handleTogglePin = useCallback(
    async (id: string, nextPinned: boolean) => {
      await updateChatMutation.mutateAsync({
        chatId: id,
        data: { pinned: nextPinned },
      });
    },
    [updateChatMutation],
  );

  const startEditTitle = useCallback(() => {
    setTitleDraft(chatDetail?.title || "");
    setEditingTitle(true);
  }, [chatDetail?.title]);

  const saveTitle = useCallback(async () => {
    if (!titleDraft.trim()) {
      setEditingTitle(false);
      return;
    }
    await updateChatMutation.mutateAsync({
      chatId,
      data: { title: titleDraft.trim() },
    });
    setEditingTitle(false);
  }, [chatId, titleDraft, updateChatMutation]);

  // Subtitle assembled from whatever metadata we have. Mirrors the legacy
  // compact header's information density (project · workspace · msgs ·
  // tokens · cost · age) but rendered as the SectionHeader's plain
  // `subtitle` line so it visually matches the list page.
  const subtitle = useMemo(() => {
    if (!chatDetail) return undefined;
    const parts: string[] = [];
    if (chatDetail.project_name) parts.push(chatDetail.project_name);
    if (chatDetail.workspace_name && !chatDetail.project_name) {
      parts.push(chatDetail.workspace_name);
    }
    const m = chatDetail.metrics;
    if (m && m.message_count > 0) {
      parts.push(`${m.message_count} msgs`);
      const tokens = (m.total_input_tokens ?? 0) + (m.total_output_tokens ?? 0);
      if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
      if (m.total_cost_usd > 0) {
        parts.push(formatCost(m.total_cost_usd));
      } else if (m.total_copilot_quota > 0) {
        parts.push(`${m.total_copilot_quota.toFixed(2)} PR`);
      }
    }
    if (chatDetail.updated_at) parts.push(timeAgo(chatDetail.updated_at));
    return parts.length > 0 ? parts.join(" · ") : undefined;
  }, [chatDetail]);

  const isPinned = !!chatDetail?.pinned;

  // Title displayed in the header. While loading we fall back to a stable
  // placeholder so the SectionHeader doesn't reflow when chatDetail lands.
  const headerTitle = chatDetail?.title?.trim() || "Untitled chat";

  return (
    // `overflow-hidden` on the page wrapper is what pins the header at
    // top and the composer at bottom: NewShell's `<main>` carries
    // `overflow-auto` for ordinary pages, but for a conversation we want
    // *only* the message list to scroll. Hiding overflow at this layer
    // prevents the page from outgrowing main and forces the inner
    // ChatConversation's own scroll area to take ownership of the
    // overflow. `min-h-0` lets the flex chain resolve so the inner
    // scroll resolves to a finite height instead of `auto`.
    <div
      data-testid="chats-page"
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      <div className="mb-2 shrink-0">
        {/* Breadcrumb back to the list — only navigation affordance the
            page needs (no second sidebar, no in-page filters). */}
        <button
          type="button"
          onClick={() => navigate("/chats")}
          className="mb-1 inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          data-testid="chats-back"
        >
          <ArrowLeft className="h-3 w-3" />
          Chats
        </button>

        {/* Title row + actions. Title doubles as the rename trigger
            (click anywhere on the h1 to start editing) — no separate
            "rename" pencil button taking up vertical real estate. */}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            {editingTitle ? (
              <Input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveTitle();
                  if (e.key === "Escape") setEditingTitle(false);
                }}
                className="h-7 max-w-lg text-[13px] font-semibold"
                data-testid="chat-header-title-input"
              />
            ) : (
              <h1
                onClick={chatDetail ? startEditTitle : undefined}
                title={chatDetail ? "Click to rename" : undefined}
                className={cn(
                  "text-[13px] font-semibold truncate leading-tight",
                  chatDetail &&
                    "cursor-text hover:text-zinc-700 dark:hover:text-zinc-300",
                )}
                data-testid="chat-header-title"
              >
                {headerTitle}
              </h1>
            )}
            {subtitle && (
              <p className="text-zinc-500 text-[11px] truncate leading-tight">
                {subtitle}
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => handleTogglePin(chatId, !isPinned)}
              aria-label={isPinned ? "Unpin chat" : "Pin chat"}
              title={isPinned ? "Unpin chat" : "Pin chat"}
              data-testid="chat-header-pin"
            >
              {isPinned ? (
                <PinOff className="h-3.5 w-3.5" />
              ) : (
                <Pin className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-red-500 hover:text-red-600"
              onClick={() => deleteConfirm.requestConfirm(chatId)}
              aria-label="Delete chat"
              title="Delete chat"
              data-testid="chat-header-delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
            {/* Worktree-isolation badge + "End session" affordance.
                Only rendered when the chat actually owns a live
                worktree (`worktree_path` set after the first message
                materialises it); legacy non-isolated chats see the
                old toolbar exactly as before. */}
            {chatDetail?.worktree_path && (
              <>
                {/* "Apply" — counterpart to End session: lands the
                    chat's worktree branch on the project's currently-
                    checked-out branch via `git merge --no-ff` instead
                    of throwing it away. Worktree itself is preserved. */}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleApplyWorktree}
                  disabled={applyWorktreeMutation.isPending}
                  title={`Merge ${chatDetail.worktree_branch ?? "?"} into the project's current branch`}
                  data-testid="chat-header-apply-worktree"
                >
                  {applyWorktreeMutation.isPending ? "Applying…" : "Apply"}
                </Button>
                {/* "Open PR" — drops a structured prompt into the chat
                    queue asking the agent to commit, push, and `gh pr
                    create` with proper title/body. Operator can add a
                    one-liner of context first. */}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setOpenPrDialogOpen(true)}
                  title="Ask the agent to push this branch and open a PR"
                  data-testid="chat-header-open-pr"
                >
                  Open PR
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleEndSession}
                  disabled={endSessionMutation.isPending}
                  title={`Worktree: ${chatDetail.worktree_branch ?? "?"}\n${chatDetail.worktree_path}`}
                  data-testid="chat-header-end-session"
                >
                  {endSessionMutation.isPending ? "Ending…" : "End session"}
                </Button>
              </>
            )}
            {/* Bare New chat button — the full ChatsToolbar (search,
                List/By project toggle) doesn't belong here: those are
                list-page concerns, not chat-page concerns. */}
            <Button
              type="button"
              size="sm"
              onClick={handleNewChat}
              data-testid="chat-header-new-chat"
            >
              <Plus aria-hidden="true" />
              New chat
            </Button>
          </div>
        </div>
      </div>

      {/* Conversation. `min-h-0` is required for the inner scroll area to
          resolve a height (flex children default to `min-height: auto`,
          which would force overflow into the page rather than the inner
          `overflow-auto` scroller). */}
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatConversation
          key={chatId}
          chatId={chatId}
          headerSlot={null}
          enableMultiSelect={false}
        />
      </div>

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete Chat"
        description="This will permanently delete this chat and all its messages. This action cannot be undone."
        isPending={deleteChatMutation.isPending}
        onConfirm={() => {
          if (deleteConfirm.targetId) {
            // Always close the dialog — see the comment on the row-level
            // ConfirmDialog above for why `.finally` rather than `.then`.
            handleDeleteChat(deleteConfirm.targetId)
              .catch(() => {
                /* already surfaced inside handleDeleteChat */
              })
              .finally(() => deleteConfirm.reset());
          }
        }}
      />

      {/* Open-PR dialog: lets the operator add a one-liner of extra
          context before the boilerplate prompt fires into the chat
          queue. The agent will pick it up next time it's idle and
          commit/push/PR. */}
      <Dialog open={openPrDialogOpen} onOpenChange={setOpenPrDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Open a pull request</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-[13px]">
            <p className="text-muted-foreground">
              The agent will commit any pending work, push{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[12px]">
                {chatDetail?.worktree_branch ?? "the current branch"}
              </code>{" "}
              to <code className="rounded bg-muted px-1 py-0.5 text-[12px]">origin</code>, and open
              a PR via <code className="rounded bg-muted px-1 py-0.5 text-[12px]">gh pr create</code>{" "}
              with a properly-filled title and body.
            </p>
            <div className="space-y-1">
              <label
                htmlFor="open-pr-context"
                className="text-[12px] font-medium text-muted-foreground"
              >
                Optional context for the PR (issue link, reviewer, scope notes…)
              </label>
              <textarea
                id="open-pr-context"
                value={openPrContext}
                onChange={(e) => setOpenPrContext(e.target.value)}
                rows={3}
                placeholder="Closes #123. Target reviewer: @somebody."
                className="w-full resize-none rounded border border-input bg-background px-2 py-1.5 text-[13px] outline-none focus:ring-1 focus:ring-ring"
                data-testid="open-pr-context"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setOpenPrContext("");
                setOpenPrDialogOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleOpenPrConfirm}
              data-testid="open-pr-confirm"
            >
              Send to agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <NewChatDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        projectId={newChatProjectId}
        workspaceId={newChatWorkspaceId}
        onProjectChange={(v) => {
          setNewChatProjectId(v);
          if (v) setNewChatWorkspaceId("");
        }}
        onWorkspaceChange={(v) => {
          setNewChatWorkspaceId(v);
          if (v) setNewChatProjectId("");
        }}
        projects={projectsList ?? []}
        workspaces={workspacesList ?? []}
        onCreate={handleCreateChat}
        creating={createChatMutation.isPending}
        isolateWorktree={newChatIsolate}
        onIsolateChange={setNewChatIsolate}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared NewChatDialog                                                */
/* ------------------------------------------------------------------ */

/**
 * Single source of truth for the "+ New chat" modal. Used by both the
 * list view (`ChatsListView`) and the open-chat view
 * (`ChatsConversationView`) — keeping the markup in one place stops the
 * two views from drifting visually as the dialog evolves.
 *
 * Pure presentational + dispatcher component — the parent owns the
 * project/workspace state and the create mutation so each surface can
 * decide what to do after the chat is created (the list view navigates
 * to it; the conversation view does the same, just from a different
 * starting URL).
 */
function NewChatDialog({
  open,
  onOpenChange,
  projectId,
  workspaceId,
  onProjectChange,
  onWorkspaceChange,
  projects,
  workspaces,
  onCreate,
  creating,
  isolateWorktree,
  onIsolateChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  workspaceId: string;
  onProjectChange: (next: string) => void;
  onWorkspaceChange: (next: string) => void;
  projects: ReadonlyArray<{ id: number | string; name: string }>;
  workspaces: ReadonlyArray<{ id: number | string; name: string }>;
  onCreate: () => void;
  creating: boolean;
  isolateWorktree: boolean;
  onIsolateChange: (next: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Chat</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">Project</label>
            <Select
              value={projectId}
              onValueChange={(v) => onProjectChange(v === "__none__" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="No project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Workspace</label>
            <Select
              value={workspaceId}
              onValueChange={(v) =>
                onWorkspaceChange(v === "__none__" ? "" : v)
              }
              disabled={!!projectId}
            >
              <SelectTrigger>
                <SelectValue placeholder="No workspace" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={String(w.id)}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {projectId && (
              <p className="text-xs text-muted-foreground">
                Workspace is auto-set from project.
              </p>
            )}
          </div>
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3">
            <input
              id="newchat-isolate"
              type="checkbox"
              className="mt-1"
              checked={isolateWorktree}
              onChange={(e) => onIsolateChange(e.target.checked)}
              disabled={!projectId}
            />
            <label
              htmlFor="newchat-isolate"
              className="cursor-pointer text-sm"
            >
              <div className="font-medium">Run in isolated git worktree</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                Creates a per-chat worktree (
                <code>flockctl/chat-&lt;id&gt;</code>) on the first message so
                edits don't collide with parallel chats. Requires a project; the
                chat row is unaffected if the project isn't a git repo.
              </div>
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onCreate} disabled={creating}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
