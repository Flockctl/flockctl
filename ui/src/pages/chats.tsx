import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams } from "react-router-dom";
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
  useChats,
  useChat,
  useCreateChat,
  useDeleteChat,
  useUpdateChat,
  useChatListLiveState,
  useProjects,
  useWorkspaces,
} from "@/lib/hooks";
import { timeAgo } from "@/lib/utils";
import { markChatRead, useChatReadMap } from "@/lib/chat-read-store";
import {
  Plus,
  Trash2,
  MessageSquare,
  DollarSign,
  Hash,
  FolderOpen,
  Layers,
  Search,
  Pencil,
  PanelLeftClose,
  PanelLeft,
  Bell,
  Pin,
  PinOff,
} from "lucide-react";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";
import { TodoBadge } from "@/components/TodoBadge";
import { ChatConversation } from "@/components/chat-conversation";

export default function ChatsPage() {
  const { chatId: urlChatId } = useParams<{ chatId?: string }>();
  const [selectedChatId, setSelectedChatId] = useState<string | null>(urlChatId ?? null);

  const { data: projectsList } = useProjects();
  const { data: workspacesList } = useWorkspaces();

  // New chat dialog state
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatProjectId, setNewChatProjectId] = useState<string>("");
  const [newChatWorkspaceId, setNewChatWorkspaceId] = useState<string>("");

  // Sidebar search / toggle. `searchQuery` is the raw input; `debouncedQuery`
  // is what we forward to the backend so every keystroke doesn't hit /chats.
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 200);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Sidebar list filters — forwarded to the backend so we don't paginate
  // through unrelated chats. Project/workspace are mutually exclusive because
  // a chat row stores one of them (see New Chat dialog below).
  const [filterProjectId, setFilterProjectId] = useState<string>("");
  const [filterWorkspaceId, setFilterWorkspaceId] = useState<string>("");

  // Inline title editing
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  const { data: chats, isLoading: chatsLoading } = useChats({
    projectId: filterProjectId || undefined,
    workspaceId: filterWorkspaceId || undefined,
    q: debouncedQuery || undefined,
  });
  const { data: chatDetail } = useChat(selectedChatId);
  const { pendingCount: chatPendingMap, running: chatRunningMap } = useChatListLiveState();
  const chatReadMap = useChatReadMap();
  const createChatMutation = useCreateChat();
  const deleteChatMutation = useDeleteChat();
  const updateChatMutation = useUpdateChat();
  const deleteConfirm = useConfirmDialog();

  // Search now runs server-side (GET /chats?q=...) — the backend matches
  // against chat title, message content, and project/workspace name, so the
  // previous client-side filter would only drop valid results (e.g. chats
  // whose match lives inside a message, which the list payload doesn't
  // carry). Just surface whatever the server returns.
  const filteredChats = useMemo(() => chats ?? [], [chats]);

  useEffect(() => {
    if (urlChatId) setSelectedChatId(urlChatId);
  }, [urlChatId]);

  useEffect(() => {
    if (!selectedChatId || !chatDetail?.updated_at) return;
    markChatRead(selectedChatId, chatDetail.updated_at);
  }, [selectedChatId, chatDetail?.updated_at]);

  const handleNewChat = useCallback(() => {
    setNewChatProjectId("");
    setNewChatWorkspaceId("");
    setNewChatOpen(true);
  }, []);

  const handleCreateChat = useCallback(async () => {
    const chat = await createChatMutation.mutateAsync({
      projectId: newChatProjectId ? parseInt(newChatProjectId) : undefined,
      workspaceId: newChatWorkspaceId ? parseInt(newChatWorkspaceId) : undefined,
    });
    setSelectedChatId(chat.id);
    setNewChatOpen(false);
  }, [createChatMutation, newChatProjectId, newChatWorkspaceId]);

  const handleDeleteChat = useCallback(
    async (chatId: string) => {
      await deleteChatMutation.mutateAsync(chatId);
      if (selectedChatId === chatId) setSelectedChatId(null);
    },
    [deleteChatMutation, selectedChatId],
  );

  // Pin toggle — PATCH /chats/:id with { pinned }. The list re-fetches via
  // the mutation's invalidation, so the new order comes straight from the
  // backend's `(pinned DESC, created_at DESC)` sort and filters stay intact.
  const handleTogglePin = useCallback(
    async (chatId: string, nextPinned: boolean) => {
      await updateChatMutation.mutateAsync({
        chatId,
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
    if (!selectedChatId || !titleDraft.trim()) {
      setEditingTitle(false);
      return;
    }
    await updateChatMutation.mutateAsync({
      chatId: selectedChatId,
      data: { title: titleDraft.trim() },
    });
    setEditingTitle(false);
  }, [selectedChatId, titleDraft, updateChatMutation]);

  // On mobile (< md) the list and the conversation can't fit side-by-side —
  // the 288px sidebar leaves no room for the chat. So we flip into a
  // "one-pane-at-a-time" view: show the list until the user picks a chat,
  // then show the chat (with a Back arrow in the conversation header to
  // return to the list). On md+ both panes are visible.
  const showSidebarMobile = !selectedChatId;

  return (
    <div className="flex h-full">
      {/* Left panel — chat list */}
      {sidebarOpen && (
        <div
          className={`flex-col border-r md:flex md:w-72 ${
            showSidebarMobile ? "flex w-full" : "hidden"
          }`}
        >
          <div className="flex items-center gap-2 border-b p-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search chats..."
                className="h-8 pl-7 text-sm"
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={handleNewChat}
              disabled={createChatMutation.isPending}
            >
              <Plus className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setSidebarOpen(false)}
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          </div>
          {/* Project / workspace filters — mutually exclusive; backend does
              the narrowing so the list stays stable under pagination. */}
          <div className="flex items-center gap-1 border-b px-2 py-1.5">
            <Select
              value={filterProjectId || "__all__"}
              onValueChange={(v) => {
                const next = v === "__all__" ? "" : v;
                setFilterProjectId(next);
                if (next) setFilterWorkspaceId("");
              }}
            >
              <SelectTrigger className="h-7 flex-1 text-xs">
                <SelectValue placeholder="All projects" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All projects</SelectItem>
                {projectsList?.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={filterWorkspaceId || "__all__"}
              onValueChange={(v) => {
                const next = v === "__all__" ? "" : v;
                setFilterWorkspaceId(next);
                if (next) setFilterProjectId("");
              }}
            >
              <SelectTrigger className="h-7 flex-1 text-xs">
                <SelectValue placeholder="All workspaces" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All workspaces</SelectItem>
                {workspacesList?.map((w) => (
                  <SelectItem key={w.id} value={String(w.id)}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 overflow-auto">
            {chatsLoading &&
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="px-3 py-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="mt-1 h-3 w-20" />
                </div>
              ))}
            {!chatsLoading && filteredChats.length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">
                {searchQuery ? "No chats match your search." : "No chats yet."}
              </p>
            )}
            {filteredChats.map((chat) => {
              const pending = chatPendingMap[chat.id] ?? 0;
              const isRunning = !!chatRunningMap[chat.id];
              const lastRead = chatReadMap[chat.id];
              const isUnread =
                selectedChatId !== chat.id &&
                !!chat.updated_at &&
                (!lastRead || chat.updated_at > lastRead);
              return (
                <div
                  key={chat.id}
                  className={`group flex cursor-pointer items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent/50 ${
                    selectedChatId === chat.id ? "bg-accent" : ""
                  }`}
                  onClick={() => setSelectedChatId(chat.id)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 font-medium">
                      {(isUnread || pending > 0) && (
                        <span
                          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                            pending > 0 ? "bg-amber-500" : "bg-blue-500"
                          }`}
                          aria-label={pending > 0 ? "Needs approval" : "Unread"}
                        />
                      )}
                      {chat.pinned && (
                        <Pin
                          className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400"
                          aria-label="Pinned"
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">{chat.title || "New chat"}</span>
                      <TodoBadge counts={chat.metrics?.todos_counts} />
                      {pending > 0 && (
                        <span className="ml-auto flex items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                          <Bell className="h-2.5 w-2.5" />
                          {pending}
                        </span>
                      )}
                      {pending === 0 && isRunning && selectedChatId !== chat.id && (
                        <span
                          className="ml-auto inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
                          aria-label="Agent working"
                        />
                      )}
                    </p>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      {chat.project_name && (
                        <span className="flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[10px]">
                          <FolderOpen className="h-2.5 w-2.5" />
                          {chat.project_name}
                        </span>
                      )}
                      {chat.workspace_name && !chat.project_name && (
                        <span className="flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[10px]">
                          <Layers className="h-2.5 w-2.5" />
                          {chat.workspace_name}
                        </span>
                      )}
                      {chat.entity_type && (
                        <span className="rounded bg-muted px-1 py-0.5 text-[10px] capitalize">
                          {chat.entity_type}
                        </span>
                      )}
                      <span>{timeAgo(chat.updated_at)}</span>
                      {chat.metrics && chat.metrics.total_cost_usd > 0 && (
                        <span className="ml-auto tabular-nums">
                          ${chat.metrics.total_cost_usd.toFixed(2)}
                        </span>
                      )}
                      {chat.metrics && chat.metrics.total_cost_usd === 0 && chat.metrics.total_copilot_quota > 0 && (
                        <span className="ml-auto tabular-nums" title="GitHub Copilot premium requests">
                          {chat.metrics.total_copilot_quota.toFixed(2)} PR
                        </span>
                      )}
                    </div>
                    {chat.metrics && chat.metrics.message_count > 0 && (
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-0.5">
                        <span>{chat.metrics.message_count} msgs</span>
                        {chat.metrics.total_input_tokens + chat.metrics.total_output_tokens > 0 && (
                          <span className="tabular-nums">
                            {(
                              (chat.metrics.total_input_tokens + chat.metrics.total_output_tokens) /
                              1000
                            ).toFixed(1)}
                            k tok
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {/* Pin toggle stays visible while pinned (so the user can
                      unpin without hovering) and only on hover otherwise —
                      mirrors the delete button's hover-reveal pattern. */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-6 w-6 shrink-0 ${
                      chat.pinned ? "" : "opacity-0 group-hover:opacity-100"
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleTogglePin(chat.id, !chat.pinned);
                    }}
                    aria-label={chat.pinned ? "Unpin chat" : "Pin chat"}
                    title={chat.pinned ? "Unpin chat" : "Pin chat"}
                  >
                    {chat.pinned ? (
                      <PinOff className="h-3 w-3" />
                    ) : (
                      <Pin className="h-3 w-3" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConfirm.requestConfirm(chat.id);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Right panel — conversation */}
      {!selectedChatId ? (
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-4">
          {!sidebarOpen && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute left-2 top-2"
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          )}
          <MessageSquare className="h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Select a chat or create a new one</p>
          <Button variant="outline" size="sm" onClick={handleNewChat}>
            <Plus className="mr-1 h-3.5 w-3.5" /> New Chat
          </Button>
        </div>
      ) : (
        <ChatConversation
          key={selectedChatId}
          chatId={selectedChatId}
          headerSlot={
            chatDetail ? (
              <div className="flex items-center gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
                {/* Mobile "back to list" — always visible below md when a chat
                    is open. Desktop keeps the existing "reveal collapsed
                    sidebar" affordance when the user has hidden it. */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 md:hidden"
                  onClick={() => setSelectedChatId(null)}
                  aria-label="Back to chat list"
                >
                  <PanelLeft className="h-3.5 w-3.5" />
                </Button>
                {!sidebarOpen && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="hidden h-6 w-6 shrink-0 md:inline-flex"
                    onClick={() => setSidebarOpen(true)}
                  >
                    <PanelLeft className="h-3.5 w-3.5" />
                  </Button>
                )}
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
                    className="h-6 w-48 text-xs"
                  />
                ) : (
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs font-medium text-foreground hover:text-primary"
                    onClick={startEditTitle}
                  >
                    {chatDetail.title || "Untitled chat"}
                    <Pencil className="h-2.5 w-2.5 text-muted-foreground" />
                  </button>
                )}
                {chatDetail.project_name && (
                  <span className="flex items-center gap-1">
                    <FolderOpen className="h-3 w-3" />
                    {chatDetail.project_name}
                  </span>
                )}
                {chatDetail.workspace_name && (
                  <span className="flex items-center gap-1">
                    <Layers className="h-3 w-3" />
                    {chatDetail.workspace_name}
                  </span>
                )}
                {chatDetail.metrics && chatDetail.metrics.message_count > 0 && (
                  <>
                    <span className="flex items-center gap-1">
                      <Hash className="h-3 w-3" />
                      {chatDetail.metrics.message_count} msgs
                    </span>
                    {chatDetail.metrics.total_cost_usd > 0 && (
                      <span className="flex items-center gap-0.5 tabular-nums">
                        <DollarSign className="h-3 w-3" />
                        {chatDetail.metrics.total_cost_usd.toFixed(4)}
                      </span>
                    )}
                    {chatDetail.metrics.total_cost_usd === 0 && chatDetail.metrics.total_copilot_quota > 0 && (
                      <span className="flex items-center gap-0.5 tabular-nums" title="GitHub Copilot premium requests">
                        {chatDetail.metrics.total_copilot_quota.toFixed(2)} PR
                      </span>
                    )}
                  </>
                )}
                <span className="ml-auto text-[10px]">{timeAgo(chatDetail.created_at)}</span>
              </div>
            ) : null
          }
        />
      )}

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={deleteConfirm.onOpenChange}
        title="Delete Chat"
        description="This will permanently delete this chat and all its messages. This action cannot be undone."
        isPending={deleteChatMutation.isPending}
        onConfirm={() => {
          if (deleteConfirm.targetId) {
            handleDeleteChat(deleteConfirm.targetId).then(() => deleteConfirm.reset());
          }
        }}
      />

      <Dialog open={newChatOpen} onOpenChange={setNewChatOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Chat</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Project</label>
              <Select
                value={newChatProjectId}
                onValueChange={(v) => {
                  setNewChatProjectId(v === "__none__" ? "" : v);
                  setNewChatWorkspaceId("");
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="No project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {projectsList?.map((p) => (
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
                value={newChatWorkspaceId}
                onValueChange={(v) => {
                  setNewChatWorkspaceId(v === "__none__" ? "" : v);
                  setNewChatProjectId("");
                }}
                disabled={!!newChatProjectId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="No workspace" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {workspacesList?.map((w) => (
                    <SelectItem key={w.id} value={String(w.id)}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {newChatProjectId && (
                <p className="text-xs text-muted-foreground">
                  Workspace is auto-set from project.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewChatOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateChat} disabled={createChatMutation.isPending}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
