import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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
import { useChats, useChat, useCreateChat, useDeleteChat, useUpdateChat, useChatStream, useChatEventStream, useChatListLiveState, useMeta, useProjects, useWorkspaces, useUpdateProject, useUpdateWorkspace, useProjectConfig } from "@/lib/hooks";
import { respondToChatPermission } from "@/lib/api";
import { timeAgo } from "@/lib/utils";
import { markChatRead, useChatReadMap } from "@/lib/chat-read-store";
import { Plus, Send, Square, Trash2, MessageSquare, AlertCircle, RotateCcw, DollarSign, Hash, FolderOpen, Layers, Search, Pencil, PanelLeftClose, PanelLeft, ChevronDown, Bell } from "lucide-react";
import type { ChatMessageResponse, PermissionMode } from "@/lib/types";
import { ConfirmDialog, useConfirmDialog } from "@/components/confirm-dialog";
import { ChatMessage } from "@/components/chat-message";
import { ToolExecutionItem } from "@/components/tool-execution";
import { PermissionModeSelect } from "@/components/permission-mode-select";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

export default function ChatsPage() {
  const { chatId: urlChatId } = useParams<{ chatId?: string }>();
  const [selectedChatId, setSelectedChatId] = useState<string | null>(urlChatId ?? null);
  const [inputValue, setInputValue] = useState("");
  const [chatKeyId, setChatKeyId] = useState<string>("");
  const [chatModel, setChatModel] = useState<string>("");
  // True after the user manually changes the model selector for the current chat —
  // suppresses the project-config auto-pick so we don't clobber their choice.
  const userPickedModelRef = useRef(false);

  const { data: meta } = useMeta();
  const keys = meta?.keys?.filter(k => k.is_active) ?? [];
  const models = meta?.models ?? [];
  const defaultModel = meta?.defaults?.model ?? "claude-sonnet-4-6";
  const defaultKeyId = meta?.defaults?.key_id ?? null;

  const { data: projectsList } = useProjects();
  const { data: workspacesList } = useWorkspaces();

  // New chat dialog state
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatProjectId, setNewChatProjectId] = useState<string>("");
  const [newChatWorkspaceId, setNewChatWorkspaceId] = useState<string>("");

  // Sidebar search / toggle
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Inline title editing
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  // Auto-resize textarea ref
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-select provider key: prefer the global default (if still active), else first available.
  useEffect(() => {
    if (chatKeyId || keys.length === 0) return;
    const preferred = defaultKeyId
      ? keys.find(k => String(k.id) === String(defaultKeyId))
      : null;
    setChatKeyId(String((preferred ?? keys[0]).id));
  }, [keys, chatKeyId, defaultKeyId]);

  const { data: chats, isLoading: chatsLoading } = useChats();
  const { data: chatDetail, isLoading: chatLoading } = useChat(selectedChatId);
  const { pendingCount: chatPendingMap, running: chatRunningMap } = useChatListLiveState();
  // Subscribing to the read map re-renders the list when markChatRead() fires.
  const chatReadMap = useChatReadMap();
  const createChatMutation = useCreateChat();
  const deleteChatMutation = useDeleteChat();
  const updateChatMutation = useUpdateChat();
  const { startStream, cancelStream, isStreaming, streamedContent, error: streamError, toolExecutions } = useChatStream();
  const { permissionRequests, dismissPermissionRequest, sessionRunning } = useChatEventStream(selectedChatId);
  // The chat is considered "running on the server" if either the initial fetch
  // told us so (isRunning from GET /chats/:id) or a live WS event flipped it.
  // WS state takes precedence once it arrives — it's always fresher.
  const serverRunning = sessionRunning ?? chatDetail?.isRunning ?? false;
  const updateProjectMutation = useUpdateProject();
  const updateWorkspaceMutation = useUpdateWorkspace();
  const deleteConfirm = useConfirmDialog();

  // Fetch the chat's project config so we can auto-select its preferred model.
  // Pass an empty string when there's no project — the hook returns nothing then.
  const projectIdForConfig = chatDetail?.project_id ? String(chatDetail.project_id) : "";
  const { data: chatProjectConfig } = useProjectConfig(projectIdForConfig);

  // Reset the "user picked" guard whenever the active chat changes, so the
  // next chat opens with its project's preferred model (not the previous one).
  useEffect(() => {
    userPickedModelRef.current = false;
  }, [selectedChatId]);

  // Auto-select model: project config wins, falls back to global default.
  // Skips if the user has already overridden the model in this chat.
  useEffect(() => {
    if (userPickedModelRef.current) return;
    const projectModel = typeof chatProjectConfig?.model === "string" ? chatProjectConfig.model : null;
    const next = projectModel || defaultModel;
    if (next && next !== chatModel) setChatModel(next);
  }, [chatProjectConfig, defaultModel, chatModel]);

  async function handleAllowChatPermission(
    requestId: string,
    scope: "once" | "chat" | "project" | "workspace",
  ) {
    try {
      if (scope === "chat" && selectedChatId) {
        await updateChatMutation.mutateAsync({
          chatId: selectedChatId,
          data: { permission_mode: "bypassPermissions" },
        });
      } else if (scope === "project" && chatDetail?.project_id) {
        await updateProjectMutation.mutateAsync({
          id: chatDetail.project_id,
          data: { permission_mode: "bypassPermissions" },
        });
      } else if (scope === "workspace" && chatDetail?.workspace_id) {
        await updateWorkspaceMutation.mutateAsync({
          id: chatDetail.workspace_id,
          data: { permission_mode: "bypassPermissions" },
        });
      }
      if (selectedChatId) {
        await respondToChatPermission(selectedChatId, requestId, "allow");
      }
    } finally {
      dismissPermissionRequest(requestId);
    }
  }

  // Filtered chats
  const filteredChats = useMemo(() => {
    if (!chats) return [];
    if (!searchQuery.trim()) return chats;
    const q = searchQuery.toLowerCase();
    return chats.filter(c =>
      (c.title || "").toLowerCase().includes(q) ||
      (c.project_name || "").toLowerCase().includes(q) ||
      (c.workspace_name || "").toLowerCase().includes(q)
    );
  }, [chats, searchQuery]);

  // Sync URL param on mount
  useEffect(() => {
    if (urlChatId) setSelectedChatId(urlChatId);
  }, [urlChatId]);

  // Mark selected chat as read whenever its last-update timestamp advances —
  // this covers both initial selection and new messages arriving while open.
  useEffect(() => {
    if (!selectedChatId || !chatDetail?.updated_at) return;
    markChatRead(selectedChatId, chatDetail.updated_at);
  }, [selectedChatId, chatDetail?.updated_at]);

  // Auto-scroll
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const userScrolledUp = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      userScrolledUp.current = !atBottom;
    };
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  const messages = chatDetail?.messages ?? [];
  const scrollTrigger = messages.length + streamedContent.length;

  useEffect(() => {
    if (!userScrolledUp.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [scrollTrigger]);

  // Auto-resize textarea
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 128) + "px";
  }, []);

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

  // Inline title editing
  const startEditTitle = useCallback(() => {
    setTitleDraft(chatDetail?.title || "");
    setEditingTitle(true);
  }, [chatDetail?.title]);

  const saveTitle = useCallback(async () => {
    if (!selectedChatId || !titleDraft.trim()) {
      setEditingTitle(false);
      return;
    }
    await updateChatMutation.mutateAsync({ chatId: selectedChatId, data: { title: titleDraft.trim() } });
    setEditingTitle(false);
  }, [selectedChatId, titleDraft, updateChatMutation]);

  // Real retry — re-send last user message
  const handleRetry = useCallback(() => {
    if (!selectedChatId || isStreaming || messages.length === 0) return;
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
    if (!lastUserMsg) return;
    startStream(selectedChatId, { content: lastUserMsg.content, model: chatModel, keyId: chatKeyId ? parseInt(chatKeyId) : undefined });
  }, [selectedChatId, isStreaming, messages, startStream, chatModel, chatKeyId]);

  const handleSend = useCallback(async () => {
    const content = inputValue.trim();
    if (!content || !selectedChatId || isStreaming) return;
    setInputValue("");
    // Reset textarea height
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    await startStream(selectedChatId, { content, model: chatModel, keyId: chatKeyId ? parseInt(chatKeyId) : undefined });
  }, [inputValue, selectedChatId, isStreaming, startStream, chatModel, chatKeyId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="flex h-full">
      {/* Left panel — chat list */}
      {sidebarOpen && (
      <div className="flex w-72 flex-col border-r">
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
            // Unread when this chat isn't selected and the list thinks it has
            // activity newer than the last time we opened it. Dismiss once
            // selected — markChatRead fires on detail load.
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
                      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${pending > 0 ? "bg-amber-500" : "bg-blue-500"}`}
                      aria-label={pending > 0 ? "Needs approval" : "Unread"}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">{chat.title || "New chat"}</span>
                  {pending > 0 && (
                    <span className="ml-auto flex items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                      <Bell className="h-2.5 w-2.5" />
                      {pending}
                    </span>
                  )}
                  {pending === 0 && isRunning && selectedChatId !== chat.id && (
                    <span className="ml-auto inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" aria-label="Agent working" />
                  )}
                </p>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  {chat.project_name && (
                    <span className="flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[10px]">
                      <FolderOpen className="h-2.5 w-2.5" />{chat.project_name}
                    </span>
                  )}
                  {chat.workspace_name && !chat.project_name && (
                    <span className="flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[10px]">
                      <Layers className="h-2.5 w-2.5" />{chat.workspace_name}
                    </span>
                  )}
                  {chat.entity_type && (
                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] capitalize">{chat.entity_type}</span>
                  )}
                  <span>{timeAgo(chat.updated_at)}</span>
                  {chat.metrics && chat.metrics.total_cost_usd > 0 && (
                    <span className="ml-auto tabular-nums">${chat.metrics.total_cost_usd.toFixed(2)}</span>
                  )}
                </div>
                {chat.metrics && chat.metrics.message_count > 0 && (
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-0.5">
                    <span>{chat.metrics.message_count} msgs</span>
                    {(chat.metrics.total_input_tokens + chat.metrics.total_output_tokens) > 0 && (
                      <span className="tabular-nums">{((chat.metrics.total_input_tokens + chat.metrics.total_output_tokens) / 1000).toFixed(1)}k tok</span>
                    )}
                  </div>
                )}
              </div>
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
      <div className="flex min-w-0 flex-1 flex-col">
        {!selectedChatId ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4">
            {!sidebarOpen && (
              <Button variant="ghost" size="icon" className="absolute left-2 top-2" onClick={() => setSidebarOpen(true)}>
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
          <>
            {/* Chat context header with inline title editing */}
            {chatDetail && (
              <div className="flex items-center gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
                {!sidebarOpen && (
                  <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => setSidebarOpen(true)}>
                    <PanelLeft className="h-3.5 w-3.5" />
                  </Button>
                )}
                {editingTitle ? (
                  <Input
                    autoFocus
                    value={titleDraft}
                    onChange={e => setTitleDraft(e.target.value)}
                    onBlur={saveTitle}
                    onKeyDown={e => { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") setEditingTitle(false); }}
                    className="h-6 w-48 text-xs"
                  />
                ) : (
                  <button type="button" className="flex items-center gap-1 text-xs font-medium text-foreground hover:text-primary" onClick={startEditTitle}>
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
                  </>
                )}
                <span className="ml-auto text-[10px]">
                  {timeAgo(chatDetail.created_at)}
                </span>
              </div>
            )}
            {/* Message list */}
            <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-3">
              {chatLoading &&
                Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={i}
                    className={`flex ${i % 2 === 0 ? "justify-end" : "justify-start"}`}
                  >
                    <Skeleton className="h-10 w-48 rounded-lg" />
                  </div>
                ))}
              {!chatLoading && messages.length === 0 && !isStreaming && (
                <div className="flex flex-col items-center justify-center py-16 text-sm text-muted-foreground gap-3">
                  <MessageSquare className="h-8 w-8" />
                  <p>Start a conversation</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {["Explain this codebase", "Help me debug an issue", "Write tests for a module"].map(prompt => (
                      <Button
                        key={prompt}
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => setInputValue(prompt)}
                      >
                        {prompt}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((msg: ChatMessageResponse) => (
                <ChatMessage
                  key={msg.id}
                  role={msg.role as "user" | "assistant"}
                  content={msg.content}
                  inputTokens={msg.input_tokens}
                  outputTokens={msg.output_tokens}
                  costUsd={msg.cost_usd}
                  createdAt={msg.created_at}
                />
              ))}
              {/* Tool executions during streaming */}
              {isStreaming && toolExecutions.length > 0 && (
                <div className="space-y-1 pl-2">
                  {toolExecutions.map(tool => (
                    <ToolExecutionItem key={tool.id} tool={tool} />
                  ))}
                </div>
              )}
              {isStreaming && (
                <ChatMessage
                  role="assistant"
                  content={streamedContent || "\u00A0"}
                  isStreaming
                />
              )}
              {/* Permission requests from the agent */}
              {permissionRequests.length > 0 && (
                <div className="space-y-2">
                  {permissionRequests.map((req) => (
                    <Card key={req.request_id} className="border-blue-500">
                      <CardContent className="flex items-start gap-4 py-4">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium">🔐 {req.title ?? `${req.tool_name} permission`}</p>
                          {req.description && (
                            <p className="mt-1 text-sm text-muted-foreground">{req.description}</p>
                          )}
                          {req.decision_reason && (
                            <p className="mt-1 text-sm text-muted-foreground italic">{req.decision_reason}</p>
                          )}
                          <pre className="mt-2 max-h-40 overflow-auto rounded border bg-muted/30 p-2 text-xs">
                            {JSON.stringify(req.tool_input, null, 2)}
                          </pre>
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <Button
                            size="sm"
                            onClick={() => handleAllowChatPermission(req.request_id, "once")}
                          >
                            Allow once
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="sm" variant="outline">
                                Allow always
                                <ChevronDown className="ml-1 h-3 w-3" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56">
                              <DropdownMenuLabel>Bypass scope</DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onSelect={() => handleAllowChatPermission(req.request_id, "chat")}>
                                For this chat
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={!chatDetail?.project_id}
                                onSelect={() => handleAllowChatPermission(req.request_id, "project")}
                              >
                                For the project
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={!chatDetail?.workspace_id}
                                onSelect={() => handleAllowChatPermission(req.request_id, "workspace")}
                              >
                                For the workspace
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={async () => {
                              if (selectedChatId) {
                                await respondToChatPermission(selectedChatId, req.request_id, "deny");
                              }
                              dismissPermissionRequest(req.request_id);
                            }}
                          >
                            Deny
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
              {streamError && (
                <div className="flex justify-start">
                  <div className="max-w-[80%] rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                    Error: {streamError}
                  </div>
                </div>
              )}
              {/* Server is processing a turn that this client isn't streaming —
                  e.g. the user navigated away mid-response and came back. Show a
                  benign "working" indicator instead of the false "not received" error. */}
              {!isStreaming && serverRunning && (
                <ChatMessage role="assistant" content={"\u00A0"} isStreaming />
              )}
              {!isStreaming && !serverRunning && !streamError && messages.length > 0 && messages[messages.length - 1].role === "user" && (
                <div className="flex justify-start">
                  <div className="flex max-w-[80%] items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>Response was not received</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-1 h-6 gap-1 px-2 text-xs text-destructive hover:text-destructive"
                      onClick={handleRetry}
                    >
                      <RotateCcw className="h-3 w-3" /> Retry
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* Input bar — compact selectors inline */}
            <div className="border-t p-3">
              <div className="flex w-full flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <Select value={chatKeyId} onValueChange={setChatKeyId}>
                    <SelectTrigger className="h-8 w-40 text-xs">
                      <SelectValue placeholder="Key..." />
                    </SelectTrigger>
                    <SelectContent>
                      {keys.map((k) => (
                        <SelectItem key={k.id} value={String(k.id)}>{k.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={chatModel}
                    onValueChange={(v) => { userPickedModelRef.current = true; setChatModel(v); }}
                  >
                    <SelectTrigger className="h-8 w-44 text-xs">
                      <SelectValue placeholder="Model" />
                    </SelectTrigger>
                    <SelectContent>
                      {models.map((m) => (
                        <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="w-56">
                    <PermissionModeSelect
                      value={chatDetail?.permission_mode}
                      onChange={(mode: PermissionMode | null) => {
                        if (!selectedChatId) return;
                        updateChatMutation.mutate({
                          chatId: selectedChatId,
                          data: { permission_mode: mode },
                        });
                      }}
                      inheritLabel="inherit from project / workspace"
                      compact
                    />
                  </div>
                </div>
                <div className="flex items-end gap-2">
                  <Textarea
                    ref={textareaRef}
                    value={inputValue}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    placeholder="Type a message..."
                    rows={1}
                    className="max-h-32 min-h-[2.5rem] flex-1 resize-none"
                  />
                  {isStreaming ? (
                    <Button
                      variant="destructive"
                      size="icon"
                      className="shrink-0"
                      onClick={cancelStream}
                    >
                      <Square className="h-4 w-4" />
                    </Button>
                  ) : (
                    <Button
                      size="icon"
                      className="shrink-0"
                      disabled={!inputValue.trim()}
                      onClick={handleSend}
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {navigator.platform?.includes("Mac") ? "⌘" : "Ctrl"}+Enter to send
                </span>
              </div>
            </div>
          </>
        )}
      </div>

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
              <Select value={newChatProjectId} onValueChange={(v) => { setNewChatProjectId(v === "__none__" ? "" : v); setNewChatWorkspaceId(""); }}>
                <SelectTrigger>
                  <SelectValue placeholder="No project" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {projectsList?.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Workspace</label>
              <Select value={newChatWorkspaceId} onValueChange={(v) => { setNewChatWorkspaceId(v === "__none__" ? "" : v); setNewChatProjectId(""); }} disabled={!!newChatProjectId}>
                <SelectTrigger>
                  <SelectValue placeholder="No workspace" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {workspacesList?.map((w) => (
                    <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {newChatProjectId && (
                <p className="text-xs text-muted-foreground">Workspace is auto-set from project.</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewChatOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateChat} disabled={createChatMutation.isPending}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
