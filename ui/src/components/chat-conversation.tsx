import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  AlertCircle,
  RotateCcw,
  ChevronDown,
  X,
  History,
  ArrowDown,
  ListOrdered,
} from "lucide-react";
import { ChatComposer } from "@/components/ChatComposer";
import { ChatMessage } from "@/components/chat-message";
import { AgentQuestionPrompt } from "@/components/AgentQuestionPrompt";
import { TodoProgress } from "@/components/TodoProgress";
import { TodoHistoryDrawer } from "@/components/TodoHistoryDrawer";
import { StoredToolMessageItem, ThinkingBlock } from "@/components/tool-execution";
import { PermissionModeSelect } from "@/components/permission-mode-select";
import { ChatThinkingEffortControl } from "@/components/chat-thinking-effort";
import { SaveAsIncidentDialog } from "@/components/save-as-incident-dialog";
import { InlineDiff } from "@/components/InlineDiff";
import { MultiSelectBar, DefaultEmptyState } from "@/components/chat-conversation-aux";
import { useChatScroll } from "@/components/chat-conversation-scroll";
import { useChatKeyModelSelection } from "@/components/chat-conversation-key-model";
import {
  useChat,
  useChatStream,
  useChatEventStream,
  useChatTodos,
  useChatDiff,
  useMeta,
  useUpdateChat,
  useUpdateProject,
  useUpdateWorkspace,
  useAgentQuestions,
  useAnswerAgentQuestion,
  useProjectConfig,
  useProjectAllowedKeys,
} from "@/lib/hooks";
import { respondToChatPermission } from "@/lib/api";
import type { ChatMessageResponse, PermissionMode, ChatMessageCreate, EffortLevel } from "@/lib/types";
import { useChatDraft } from "@/lib/chat-draft-store";

export interface ChatConversationProps {
  chatId: string | null;
  /** Additional body attached to each streamed message. Used for plan-entity chats. */
  entityContext?: ChatMessageCreate["entity_context"];
  /** Forwarded to `useChatStream` so project tree is invalidated on stream end. */
  projectIdForStream?: string;
  /** Custom header. When omitted, a default header with title editing + metrics is rendered. */
  headerSlot?: React.ReactNode;
  /** Placeholder for the composer textarea. */
  placeholder?: string;
  /** Disables the composer (e.g. while chatId is being lazily resolved). */
  composerDisabled?: boolean;
  /** When chatId is null & no messages yet — show this instead of default empty-state suggestions. */
  emptyState?: React.ReactNode;
  /** Disables multi-select "Save as incident" flow. Defaults to true. */
  enableMultiSelect?: boolean;
}

/**
 * Unified conversation view used by the main chat page, the plan-entity chat
 * dialog, and the workspace chat panel. Owns:
 *   - Message fetch + render (user / assistant / tool)
 *   - Streaming (content + tool executions)
 *   - Permission request cards
 *   - Agent question prompt
 *   - Retry on missing response
 *   - Multi-select "Save as incident"
 *   - TodoWrite progress bar + history drawer
 *   - Composer with model / key / permission-mode pickers and attachments
 *
 * Parent is responsible for resolving chatId (and the chat list / new-chat dialog
 * in the full chat page). Pass `entityContext` for plan-entity chats.
 *
 * Implementation is split across this file + three sibling modules:
 *   - chat-conversation-aux.tsx        — MultiSelectBar, DefaultEmptyState
 *   - chat-conversation-scroll.ts      — useChatScroll (scrollRef, isAtBottom, helpers)
 *   - chat-conversation-key-model.ts   — useChatKeyModelSelection (key/model picker state)
 */
export function ChatConversation({
  chatId,
  entityContext,
  projectIdForStream,
  headerSlot,
  placeholder,
  composerDisabled,
  emptyState,
  enableMultiSelect = true,
}: ChatConversationProps) {
  const { data: meta } = useMeta();
  const allActiveKeys = meta?.keys?.filter((k) => k.is_active) ?? [];
  const allModels = meta?.models ?? [];
  const defaultModel = meta?.defaults?.model ?? "claude-sonnet-4-6";
  const defaultKeyId = meta?.defaults?.key_id ?? null;

  // Draft text is kept in a shared module-level store keyed by chatId so that
  // switching to another chat (which remounts this component via the
  // `key={selectedChatId}` on the parent) preserves each chat's unsent input.
  // The composer calls `setInputValue("")` after a successful send, which
  // clears the stored draft for this chat.
  const [inputValue, setInputValue] = useChatDraft(chatId);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [incidentDialogOpen, setIncidentDialogOpen] = useState(false);
  const [todoHistoryOpen, setTodoHistoryOpen] = useState(false);

  const { data: chatDetail, isLoading: chatLoading } = useChat(chatId);
  const {
    startStream,
    cancelStream,
    isStreaming,
    liveBlocks,
    queuedMessages,
    enqueueMessage,
    removeFromQueue,
    error: streamError,
  } = useChatStream();
  const { permissionRequests, dismissPermissionRequest, sessionRunning } =
    useChatEventStream(chatId);
  const { question: agentQuestion } = useAgentQuestions({ kind: "chat", id: chatId });
  const answerAgentQuestionMutation = useAnswerAgentQuestion();
  const { data: chatTodos } = useChatTodos(chatId);
  // Synthesized per-chat diff (see services/file-edit-journal.ts). Drives
  // the "Changes" card at the bottom of the message list. Kept as a live
  // query — useChatEventStream invalidates the key on `chat_diff_updated`
  // WS frames, so the summary updates turn-by-turn without a reload.
  const { data: chatDiff } = useChatDiff(chatId);
  const [showChatDiff, setShowChatDiff] = useState(false);
  const updateChatMutation = useUpdateChat();
  const updateProjectMutation = useUpdateProject();
  const updateWorkspaceMutation = useUpdateWorkspace();

  const projectIdForConfig = chatDetail?.project_id ? String(chatDetail.project_id) : "";
  const { data: chatProjectConfig } = useProjectConfig(projectIdForConfig);
  // Resolve the project's effective AI-key allow-list (with workspace
  // inheritance applied server-side) so we only surface keys the user is
  // actually permitted to use for this project. Chats without a project —
  // e.g. the global /chats page — fall back to every active key.
  const { data: chatAllowedKeys } = useProjectAllowedKeys(projectIdForConfig, {
    enabled: !!projectIdForConfig,
  });

  // Key + model dropdowns share reconciliation logic (persisted seed,
  // project allow-list filter, auto-pick on key change). All of that lives
  // in a companion hook so this file stays focused on layout + handlers.
  const {
    chatKeyId,
    chatModel,
    keys,
    models,
    setChatKeyIdFromUser,
    setChatModelFromUser,
  } = useChatKeyModelSelection({
    chatId,
    allActiveKeys,
    allModels,
    defaultModel,
    defaultKeyId,
    projectIdForConfig,
    chatAllowedKeys,
    chatProjectConfig,
    persistedKeyId: chatDetail?.ai_provider_key_id ?? null,
    persistedModel: chatDetail?.model ?? null,
  });

  // "Is the server still working on this chat?" — true when EITHER the live
  // WS signal (`sessionRunning`) or the persisted `is_running` flag says so.
  //
  // We intentionally use an OR over both sources instead of the previous
  // `sessionRunning ?? chatDetail?.is_running` coalescing. `??` treats `false`
  // as non-nullish, so the moment `session_ended` flipped `sessionRunning` to
  // `false` for turn N, the optimistic `is_running=true` from turn N+1's
  // `startStream` was silently ignored — leaving a brief window where
  // `serverRunning=false` even though the UI had already kicked off a new
  // turn. That window is exactly the "Response was not received" flash this
  // component keeps accreting fixes for. Using OR means any source reporting
  // "running" wins, and we only report "idle" when BOTH explicitly say so.
  //
  // The field is snake_case because apiFetch deep-converts response keys —
  // reading `chatDetail.isRunning` would always be `undefined`, hiding the
  // Stop button after a page reload while a turn was still in flight on the
  // daemon. See the 2026-04-23 fix that renamed the field.
  const serverRunning = sessionRunning === true || chatDetail?.is_running === true;

  // Reset per-chat local state when switching chats
  useEffect(() => {
    setSelectedMessageIds(new Set());
    setSelectMode(false);
    setTodoHistoryOpen(false);
  }, [chatId]);

  const toggleMessageSelected = useCallback((id: string) => {
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const { scrollRef, isAtBottom, scrollToBottom, scrollToMessage, autoScrollToTail } =
    useChatScroll(chatId);
  const [showPromptHistory, setShowPromptHistory] = useState(false);

  // Close the prompt-history panel whenever the user switches to a different
  // chat. Scroll-anchor tracking is reset inside useChatScroll.
  useEffect(() => {
    setShowPromptHistory(false);
  }, [chatId]);

  const messages = chatDetail?.messages ?? [];

  // "Response was not received" fallback is a silent-failure detector: when
  // nothing is actively streaming (`isStreaming`), nothing is server-running
  // (`serverRunning`), no explicit stream error arrived, and the transcript
  // ends on a user turn — we infer the server swallowed the request. That
  // inference is only safe AFTER the normal send → setup → first-byte window
  // has elapsed; before that, any transient combination (e.g. stale
  // `sessionRunning=false` from the prior turn, an optimistic cache that
  // didn't seed because `setQueryData(old => old)` bailed on an empty cache,
  // backend SSE setup still running `injectAgentGuidance`) briefly matches
  // the same condition and flashes the pill on every turn.
  //
  // The debounce below requires the condition to hold continuously for
  // `FALLBACK_GRACE_MS` before we actually render the pill. Any signal of
  // server activity (SSE event → `liveBlocks` grows, WS
  // `session_started`/`tool_call` → `sessionRunning` flips, stream starts →
  // `isStreaming` flips true) resets the timer via the effect's cleanup.
  const fallbackConditionMet =
    !isStreaming &&
    !serverRunning &&
    !streamError &&
    messages.length > 0 &&
    messages[messages.length - 1]?.role === "user";
  const [showMissingResponseFallback, setShowMissingResponseFallback] =
    useState(false);
  useEffect(() => {
    if (!fallbackConditionMet) {
      setShowMissingResponseFallback(false);
      return;
    }
    const FALLBACK_GRACE_MS = 3500;
    const timer = setTimeout(
      () => setShowMissingResponseFallback(true),
      FALLBACK_GRACE_MS,
    );
    return () => clearTimeout(timer);
  }, [fallbackConditionMet]);

  // Auto-scroll anchor — recomputed whenever either the persisted transcript
  // or the live block list changes. We sum block content lengths for text /
  // thinking so intra-block deltas (token-by-token streaming) also push
  // scroll-to-bottom, not just new-block additions.
  const scrollTrigger =
    messages.length +
    liveBlocks.length +
    liveBlocks.reduce(
      (acc, b) =>
        acc +
        (b.kind === "text" || b.kind === "thinking" ? b.content.length : 0),
      0,
    );

  useEffect(() => {
    autoScrollToTail();
  }, [scrollTrigger, autoScrollToTail]);

  const handleComposerSend = useCallback(
    async (content: string, attachmentIds: number[]) => {
      if (!chatId) return;
      const data = {
        content,
        model: chatModel,
        keyId: chatKeyId ? parseInt(chatKeyId) : undefined,
        attachment_ids: attachmentIds.length > 0 ? attachmentIds : undefined,
        entity_context: entityContext,
      };
      const opts = projectIdForStream ? { projectId: projectIdForStream } : undefined;
      // When a turn is already in flight — either our own fetch (`isStreaming`)
      // or a detached server session we picked up after a reload
      // (`serverRunning`) — drop the message on the queue instead of starting
      // a second concurrent stream. The drain effect in useChatStream pops
      // the head as soon as the current turn finishes. Matches Claude Code:
      // you can line up follow-ups without waiting for a response.
      if (isStreaming || serverRunning) {
        enqueueMessage(chatId, data, opts);
        return;
      }
      await startStream(chatId, data, opts);
    },
    [
      chatId,
      startStream,
      enqueueMessage,
      isStreaming,
      serverRunning,
      chatModel,
      chatKeyId,
      entityContext,
      projectIdForStream,
    ],
  );

  const handleRetry = useCallback(() => {
    if (!chatId || isStreaming || messages.length === 0) return;
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return;
    startStream(
      chatId,
      {
        content: lastUserMsg.content,
        model: chatModel,
        keyId: chatKeyId ? parseInt(chatKeyId) : undefined,
        entity_context: entityContext,
      },
      projectIdForStream ? { projectId: projectIdForStream } : undefined,
    );
  }, [chatId, isStreaming, messages, startStream, chatModel, chatKeyId, entityContext, projectIdForStream]);

  async function handleAllowChatPermission(
    requestId: string,
    scope: "once" | "chat" | "project" | "workspace",
  ) {
    try {
      if (scope === "chat" && chatId) {
        await updateChatMutation.mutateAsync({
          chatId,
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
      if (chatId) {
        await respondToChatPermission(chatId, requestId, "allow");
      }
    } finally {
      dismissPermissionRequest(requestId);
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {headerSlot}

      {/* Multi-select action bar */}
      {enableMultiSelect && (
        <MultiSelectBar
          active={selectMode}
          selectedCount={selectedMessageIds.size}
          onToggle={() =>
            setSelectMode((prev) => {
              if (prev) setSelectedMessageIds(new Set());
              return !prev;
            })
          }
          onSaveAsIncident={() => setIncidentDialogOpen(true)}
          onClearSelection={() => setSelectedMessageIds(new Set())}
        />
      )}

      {/* TodoWrite progress bar */}
      {chatTodos && chatTodos.counts.total > 0 && (
        <div className="border-b bg-muted/30 px-4 py-2 flex items-center gap-3">
          <TodoProgress counts={chatTodos.counts} className="flex-1" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs shrink-0"
            onClick={() => setTodoHistoryOpen(true)}
            data-testid="todo-history-button"
          >
            <History className="h-3.5 w-3.5 mr-1" />
            History
          </Button>
        </div>
      )}

      {/* Message list (wrapped in a relative container so the floating
          "scroll to bottom" / "prompt history" buttons and the right-hand
          history panel can overlay the scroll area without being clipped
          by the composer layout below). */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-4">
        {chatLoading &&
          Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className={`flex ${i % 2 === 0 ? "justify-end" : "justify-start"}`}
            >
              <Skeleton className="h-10 w-48 rounded-lg" />
            </div>
          ))}
        {!chatLoading && messages.length === 0 && !isStreaming && (emptyState ?? (
          <DefaultEmptyState onPick={(prompt) => setInputValue(prompt)} />
        ))}
        {messages.map((msg: ChatMessageResponse) => {
          if (msg.role === "tool") {
            return (
              <div key={msg.id} className="flex justify-start" data-testid="tool-message">
                <div className="max-w-[92%] sm:max-w-[85%] lg:max-w-[80%] min-w-0 flex-1">
                  <StoredToolMessageItem id={msg.id} content={msg.content} />
                </div>
              </div>
            );
          }
          if (msg.role === "thinking") {
            return (
              <div key={msg.id} className="flex justify-start" data-testid="thinking-message">
                <div className="max-w-[92%] sm:max-w-[85%] lg:max-w-[80%] min-w-0 flex-1">
                  <ThinkingBlock content={msg.content} />
                </div>
              </div>
            );
          }
          const checked = selectedMessageIds.has(msg.id);
          if (enableMultiSelect && selectMode) {
            return (
              <div
                key={msg.id}
                className={`flex items-start gap-2 rounded-md p-1 transition-colors ${
                  checked ? "bg-accent/40" : "hover:bg-muted/30"
                }`}
                data-testid="chat-message-row"
              >
                <Checkbox
                  className="mt-3"
                  checked={checked}
                  onCheckedChange={() => toggleMessageSelected(msg.id)}
                  aria-label="Select message"
                  data-testid="chat-message-checkbox"
                />
                <div className="flex-1 min-w-0">
                  <ChatMessage
                    role={msg.role as "user" | "assistant"}
                    content={msg.content}
                    inputTokens={msg.input_tokens}
                    outputTokens={msg.output_tokens}
                    costUsd={msg.cost_usd}
                    createdAt={msg.created_at}
                    chatId={chatId ?? undefined}
                    attachments={msg.attachments}
                    messageId={msg.id}
                  />
                </div>
              </div>
            );
          }
          return (
            <ChatMessage
              key={msg.id}
              role={msg.role as "user" | "assistant"}
              content={msg.content}
              inputTokens={msg.input_tokens}
              outputTokens={msg.output_tokens}
              costUsd={msg.cost_usd}
              createdAt={msg.created_at}
              chatId={chatId ?? undefined}
              attachments={msg.attachments}
              messageId={msg.id}
            />
          );
        })}
        {/*
          Render the live transcript only while a turn is actually in flight.
          Once both the local fetch (`isStreaming`) AND the server session
          (`serverRunning`) have wrapped up, the persisted assistant row has
          already landed in `messages` via the `session_ended` refetch — so
          showing liveBlocks here would render the final response twice (once
          from the DB row, once from the residual live block). Gating on
          `isStreaming || serverRunning` keeps the live transcript visible for
          the whole turn and drops it the instant the server confirms the
          turn is done, without us having to mutate liveBlocks on every
          boundary and racing the drain effect for the next queued turn.
        */}
        {(isStreaming || serverRunning) && liveBlocks.map((block) => {
          if (block.kind === "thinking") {
            return (
              <div key={block.id} className="flex justify-start">
                <div className="max-w-[92%] sm:max-w-[85%] lg:max-w-[80%] min-w-0 flex-1">
                  <ThinkingBlock content={block.content} streaming={block.streaming} />
                </div>
              </div>
            );
          }
          if (block.kind === "tool_call") {
            return (
              <div key={block.id} className="flex justify-start">
                <div className="max-w-[92%] sm:max-w-[85%] lg:max-w-[80%] min-w-0 flex-1">
                  <StoredToolMessageItem
                    id={block.id}
                    content={{ kind: "call", name: block.name, input: block.input, summary: block.summary }}
                  />
                </div>
              </div>
            );
          }
          if (block.kind === "tool_result") {
            return (
              <div key={block.id} className="flex justify-start">
                <div className="max-w-[92%] sm:max-w-[85%] lg:max-w-[80%] min-w-0 flex-1">
                  <StoredToolMessageItem
                    id={block.id}
                    content={{ kind: "result", name: block.name, output: block.output, summary: block.summary }}
                  />
                </div>
              </div>
            );
          }
          return (
            <ChatMessage
              key={block.id}
              role="assistant"
              content={block.content || "\u00A0"}
              isStreaming={block.streaming}
            />
          );
        })}
        {(isStreaming || serverRunning) && liveBlocks.length === 0 && (
          <ChatMessage role="assistant" content={"\u00A0"} isStreaming />
        )}
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
                      <p className="mt-1 text-sm text-muted-foreground italic">
                        {req.decision_reason}
                      </p>
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
                        <DropdownMenuItem
                          onSelect={() => handleAllowChatPermission(req.request_id, "chat")}
                        >
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
                        if (chatId) {
                          await respondToChatPermission(chatId, req.request_id, "deny");
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
            <div className="max-w-[92%] sm:max-w-[85%] lg:max-w-[80%] rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
              Error: {streamError}
            </div>
          </div>
        )}
        {/* Second "still working" placeholder — only when we've already
            shown at least one live block and the local stream has finished
            but the server session is still running. When liveBlocks is
            empty the placeholder above (line ~548) already covers this
            state; rendering both produced two stacked indicators. */}
        {!isStreaming && serverRunning && liveBlocks.length > 0 && (
          <ChatMessage role="assistant" content={"\u00A0"} isStreaming />
        )}
        {showMissingResponseFallback && (
          <div className="flex justify-start">
            <div className="flex max-w-[92%] sm:max-w-[85%] lg:max-w-[80%] items-center gap-2 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
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

        {/* Synthesized diff card — lists files the agent has edited in this
            chat and, on demand, expands to the full unified diff. Summary
            and diff are both session-isolated (journal-based, not
            `git diff` of the shared working tree) — see
            src/services/file-edit-journal.ts for why. Hidden when the
            agent has not made any Edit/Write/MultiEdit calls yet. */}
        {chatDiff && chatDiff.total_entries > 0 && chatDiff.summary && (
          <div className="space-y-2" data-testid="chat-diff-card">
            {/* Collapsed summary: the Card itself already supplies `py-4`, so
                CardContent must not add its own vertical padding — otherwise
                the paddings stack and the one-line summary sits in a ~64px
                block. Zeroing CardContent's py- here halves the height. */}
            <Card>
              <CardContent className="flex items-center gap-4 py-0">
                <div className="flex-1">
                  <p className="font-mono text-sm">{chatDiff.summary}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowChatDiff(v => !v)}
                  data-testid="chat-diff-toggle"
                >
                  {showChatDiff ? "Hide Diff" : "Show Diff"}
                </Button>
              </CardContent>
            </Card>
            {showChatDiff && (
              <Card>
                <CardContent>
                  <InlineDiff diff={chatDiff.diff} truncated={chatDiff.truncated} />
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>

        {/* Floating "your prompts" toggle — lists every user turn in this
            chat and, on click, scrolls the message list to that prompt.
            Stays visible regardless of scroll position so the user can
            jump to an older prompt from anywhere. */}
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="absolute right-3 top-3 h-8 w-8 rounded-full shadow-md"
          onClick={() => setShowPromptHistory((v) => !v)}
          aria-label="Prompt history"
          aria-pressed={showPromptHistory}
          title="Your prompts"
          data-testid="prompt-history-toggle"
        >
          <ListOrdered className="h-4 w-4" />
        </Button>

        {/* Floating "scroll to bottom" — only visible while the user has
            scrolled up away from the tail. Clicking re-anchors scroll to
            the latest message and re-enables auto-scroll-on-new-content. */}
        {!isAtBottom && (
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="absolute bottom-3 right-3 h-8 w-8 rounded-full shadow-md"
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
            title="Scroll to bottom"
            data-testid="scroll-to-bottom"
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
        )}

        {/* Prompt history side panel — slides in from the right inside
            the chat area. Overlays the message list; does not unmount
            when hidden so the transform transition animates both ways. */}
        <div
          className={`absolute inset-y-0 right-0 flex w-72 max-w-[85%] transform flex-col border-l bg-background shadow-lg transition-transform duration-200 ${
            showPromptHistory ? "translate-x-0" : "translate-x-full pointer-events-none"
          }`}
          aria-hidden={!showPromptHistory}
          data-testid="prompt-history-panel"
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-medium">Your prompts</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setShowPromptHistory(false)}
              aria-label="Close prompt history"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          {/* Only mount the list while the panel is open. Two reasons:
              (1) prevents duplicate content in the accessibility tree /
              findByText queries while the panel is hidden off-screen,
              (2) keeps the render cost off the hot path for chats with
              hundreds of prompts when the panel is not in use. */}
          <div className="flex-1 space-y-1 overflow-auto p-2">
            {showPromptHistory && (() => {
              const userPrompts = messages.filter((m) => m.role === "user");
              if (userPrompts.length === 0) {
                return (
                  <p className="p-4 text-center text-xs text-muted-foreground">
                    No prompts yet
                  </p>
                );
              }
              return userPrompts.map((m, idx) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    scrollToMessage(m.id);
                    setShowPromptHistory(false);
                  }}
                  className="w-full rounded-md border border-transparent px-2 py-1.5 text-left text-xs transition-colors hover:border-border hover:bg-muted"
                  data-testid="prompt-history-item"
                >
                  <div className="mb-0.5 text-[10px] text-muted-foreground">
                    #{idx + 1}
                  </div>
                  <div className="line-clamp-3 whitespace-pre-wrap break-words">
                    {m.content}
                  </div>
                </button>
              ));
            })()}
          </div>
        </div>
      </div>

      {/* Agent-raised clarification question */}
      {agentQuestion && chatId && (
        <div className="px-3 pt-2">
          <AgentQuestionPrompt
            question={agentQuestion.question}
            requestId={agentQuestion.requestId}
            onAnswer={async (answer) => {
              await answerAgentQuestionMutation.mutateAsync({
                kind: "chat",
                id: chatId,
                requestId: agentQuestion.requestId,
                answer,
              });
            }}
          />
        </div>
      )}

      {/*
        Queued-messages bar — shows prompts the user lined up while a turn
        was in flight. Matches Claude Code: queued items drain automatically
        into the next turn as soon as the current one ends. Each chip has a
        ✕ to un-queue before it runs. Pressing Stop (in the composer) only
        aborts the turn in flight; the queue keeps draining.
      */}
      {queuedMessages.length > 0 && (
        <div
          className="border-t bg-muted/20 px-3 py-2 space-y-1"
          data-testid="chat-queued-bar"
        >
          <div className="text-[11px] font-medium text-muted-foreground">
            Queued ({queuedMessages.length})
          </div>
          <div className="space-y-1">
            {queuedMessages.map((q) => (
              <div
                key={q.id}
                className="flex items-center gap-2 rounded bg-background px-2 py-1 text-xs"
                data-testid="chat-queued-item"
              >
                <span className="min-w-0 flex-1 truncate" title={q.data.content}>
                  {q.data.content}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 shrink-0"
                  onClick={() => removeFromQueue(q.id)}
                  aria-label="Remove from queue"
                  data-testid="chat-queued-remove"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <ChatComposer
        chatId={chatId}
        value={inputValue}
        onChange={setInputValue}
        // Show the Stop button whenever EITHER this tab is actively reading
        // the SSE stream OR the backend reports the session is still running
        // (WS `sessionRunning`, falling back to the persisted `isRunning`
        // on the chat row). Without the `serverRunning` half the Stop button
        // disappears after a page reload while a turn is in flight, even
        // though the session on the daemon is very much alive — leaving the
        // user with no way to abort it short of restarting the daemon.
        // When true, the composer keeps Send enabled too: submissions are
        // routed into `queuedMessages` by `handleComposerSend` above.
        isStreaming={isStreaming || serverRunning}
        onSend={handleComposerSend}
        // Pass the chatId through so the hook can still POST /cancel after a
        // reload (its local `streamingChatIdRef` is null in that case because
        // this tab did not originate the stream).
        onCancel={() => cancelStream(chatId ?? undefined)}
        disabled={!!agentQuestion || composerDisabled || !chatId}
        placeholder={placeholder}
        toolbar={
          <>
            <Select
              value={chatKeyId}
              onValueChange={(v) => {
                setChatKeyIdFromUser(v);
                // Persist the pick so a tab switch / reload keeps it. Fire-
                // and-forget: the optimistic local state already updated the
                // dropdown, and the mutation invalidates `useChat` on success
                // so any concurrent tab picks up the new value.
                if (chatId && v) {
                  updateChatMutation.mutate({
                    chatId,
                    data: { aiProviderKeyId: parseInt(v) },
                  });
                }
              }}
            >
              <SelectTrigger
                className="h-8 w-40 text-xs"
                data-testid="chat-key-select"
              >
                <SelectValue placeholder="Key..." />
              </SelectTrigger>
              <SelectContent>
                {keys.map((k) => (
                  <SelectItem key={k.id} value={String(k.id)}>
                    {k.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={chatModel}
              onValueChange={(v) => {
                setChatModelFromUser(v);
                if (chatId && v) {
                  updateChatMutation.mutate({
                    chatId,
                    data: { model: v },
                  });
                }
              }}
            >
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue placeholder="Model" />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="w-56">
              <PermissionModeSelect
                value={chatDetail?.permission_mode}
                onChange={(mode: PermissionMode | null) => {
                  if (!chatId) return;
                  updateChatMutation.mutate({
                    chatId,
                    data: { permission_mode: mode },
                  });
                }}
                inheritLabel="inherit from project / workspace"
                compact
              />
            </div>
            <ChatThinkingEffortControl
              // Default to "adaptive thinking on" whenever the chat detail
              // hasn't resolved yet — matches the DB default + SDK default.
              // Without this the button would render an "off" state during
              // the initial fetch, causing a visual flicker every time the
              // user opens a chat.
              thinkingEnabled={chatDetail?.thinking_enabled ?? true}
              effort={(chatDetail?.effort as EffortLevel | null | undefined) ?? null}
              disabled={!chatId}
              onThinkingChange={(next) => {
                if (!chatId) return;
                updateChatMutation.mutate({
                  chatId,
                  data: { thinkingEnabled: next },
                });
              }}
              onEffortChange={(next) => {
                if (!chatId) return;
                updateChatMutation.mutate({
                  chatId,
                  data: { effort: next },
                });
              }}
            />
          </>
        }
        hint={
          <>
            {navigator.platform?.includes("Mac") ? "⌘" : "Ctrl"}+Enter to send
          </>
        }
      />

      <TodoHistoryDrawer
        chatId={chatId}
        open={todoHistoryOpen}
        onOpenChange={setTodoHistoryOpen}
      />

      {enableMultiSelect && (
        <SaveAsIncidentDialog
          open={incidentDialogOpen}
          onOpenChange={(open) => {
            setIncidentDialogOpen(open);
            if (!open) {
              setSelectMode(false);
              setSelectedMessageIds(new Set());
            }
          }}
          chatId={chatId}
          messageIds={Array.from(selectedMessageIds)
            .map((id) => parseInt(id))
            .filter((n) => Number.isFinite(n))}
          projectId={chatDetail?.project_id ?? null}
        />
      )}
    </div>
  );
}

// MultiSelectBar + DefaultEmptyState live in chat-conversation-aux.tsx;
// re-exported above for callers that reach past this component's surface.
