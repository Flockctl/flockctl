import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
/**
 * Tailwind class string applied to every selector trigger inside the chat
 * composer footer. Strips the default bordered framing (border / bg /
 * shadow) so the controls read as pill-style children of the composer card
 * rather than free-standing form fields. Hover lifts the background to the
 * `--muted` surface — same affordance the rest of the ghost buttons use.
 *
 * Pulled out as a constant rather than inlined four times because every
 * trigger needs the same set of override tokens, and a typo in any of them
 * surfaces as a one-control "this one looks different from the rest" bug.
 */
const INLINE_TRIGGER_CLS =
  "h-7 gap-1 rounded-md border-transparent bg-transparent px-2 text-xs shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted/50";
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
import { QueuedMessagesList } from "@/components/QueuedMessagesList";
import { ChatMessage } from "@/components/chat-message";
import { cn } from "@/lib/utils";
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
  useWorkspaceAllowedKeys,
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
  const { permissionRequests, dismissPermissionRequest, sessionRunning } =
    useChatEventStream(chatId);
  // "Is the server still working on this chat?" — true when EITHER the live
  // WS signal (`sessionRunning`) or the persisted `is_running` flag says so,
  // OR while the chat detail itself is still loading (we haven't seen
  // `is_running` yet, so we MUST NOT trigger a queue drain optimistically —
  // that would race the actual backend state on first chat mount).
  // Computed BEFORE useChatStream so we can hand it in as `serverBusy`,
  // which gates the queue drain and prevents a queued prompt from kicking
  // off a parallel turn during the SSE-`done`-to-WS-`session_ended` window
  // (or during the initial GET /chats/:id round-trip).
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
  const serverRunning =
    sessionRunning === true ||
    chatDetail?.is_running === true ||
    // Treat "still loading" as busy: until `useChat` resolves we don't
    // know whether the server is mid-turn, and dispatching a queued
    // prompt now could open a parallel turn next to one that's already
    // in flight on the daemon.
    (!!chatId && chatLoading);
  const {
    startStream,
    cancelStream,
    isStreaming,
    liveBlocks,
    queuedMessages,
    enqueueMessage,
    removeFromQueue,
    clearQueue,
    reorderQueue,
    clearChat,
    error: streamError,
  } = useChatStream({ chatId, serverBusy: serverRunning });
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
  // Workspace-only chats (started from the workspace page) have a
  // workspaceId but no projectId — the key picker would otherwise fall
  // back to "every active key" and silently ignore the workspace's
  // own whitelist.
  const workspaceIdForConfig = chatDetail?.workspace_id
    ? String(chatDetail.workspace_id)
    : "";
  const { data: chatProjectConfig } = useProjectConfig(projectIdForConfig);
  // Resolve the project's effective AI-key allow-list (with workspace
  // inheritance applied server-side) so we only surface keys the user is
  // actually permitted to use for this project. Chats without a project —
  // e.g. the global /chats page — fall back to every active key.
  const { data: chatProjectAllowedKeys } = useProjectAllowedKeys(
    projectIdForConfig,
    { enabled: !!projectIdForConfig },
  );
  // Symmetric workspace-level lookup. Only fires for workspace-only chats
  // (no project), so project-scoped chats keep their existing one-query
  // behaviour and unscoped /chats sessions don't issue any allow-list
  // request at all.
  const { data: chatWorkspaceAllowedKeys } = useWorkspaceAllowedKeys(
    workspaceIdForConfig,
    { enabled: !!workspaceIdForConfig && !projectIdForConfig },
  );
  // Project allow-list wins when present (matches backend inheritance
  // rules — project overrides workspace, no merge); otherwise the
  // workspace list applies. `chatAllowedKeys` is the unified shape the
  // selection hook consumes.
  const chatAllowedKeys = projectIdForConfig
    ? chatProjectAllowedKeys
    : chatWorkspaceAllowedKeys;
  // The selection hook's `projectIdForConfig` argument is overloaded as
  // "is there an allow-list scope to wait for?" — pass the workspace id in
  // when there's no project, so the auto-pick effect blocks until the
  // workspace allow-list resolves the same way it currently does for
  // project-scoped chats.
  const allowListScopeId = projectIdForConfig || workspaceIdForConfig;

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
    projectIdForConfig: allowListScopeId,
    chatAllowedKeys,
    chatProjectConfig,
    persistedKeyId: chatDetail?.ai_provider_key_id ?? null,
    persistedModel: chatDetail?.model ?? null,
  });

  // Drop residual liveBlocks once the turn is fully closed (no local stream,
  // no server session). useChatStream intentionally keeps liveBlocks across
  // the SSE `done` boundary to avoid a re-render flash where the live
  // transcript disappeared before the persisted rows landed in
  // `chatDetail.messages`. By the time BOTH flags are false here, the
  // `session_ended` handler in useChatEventStream has already awaited the
  // chat refetch — so messages cache contains the persisted assistant /
  // tool rows, and dropping liveBlocks is safe (no flash, just the same
  // transcript backed by the DB rows instead of in-memory blocks).
  //
  // Without this, a second user turn in the same chat could briefly render
  // both `liveBlocks` (turn N) AND the just-persisted `messages` rows
  // (also turn N) because the optimistic `is_running: true` from
  // startStream flips `serverRunning` back to true, re-opening the
  // `(isStreaming || serverRunning) && liveBlocks.map(...)` gate before
  // `setLiveBlocks([])` from the same call has rendered. After a page
  // reload everything is fine — the in-memory liveBlocks are gone — so
  // the duplicates were always purely a frontend-state artefact.
  useEffect(() => {
    if (!isStreaming && !serverRunning && liveBlocks.length > 0) {
      clearChat();
    }
  }, [isStreaming, serverRunning, liveBlocks.length, clearChat]);

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

  const allMessages = chatDetail?.messages ?? [];

  // ─── Visible window (audit-round-3 mitigation for long-chat jank) ───
  //
  // Long chats accumulate hundreds of messages, each carrying its own
  // markdown bubble (with `ReactMarkdown` + `rehypeHighlight` highlighting
  // every block on every parent re-render). Full virtualization here is
  // tricky because rows are heterogeneous (tool / thinking / multi-select
  // / user / assistant) and the streaming tail row keeps changing height.
  //
  // Practical compromise: only render the most recent `visibleCount`
  // messages. Older messages stay in `allMessages` (for selection state,
  // search-as-you-type, anchor IDs) but skip the markdown render until
  // the user clicks "Show older messages". Default 200 — handles every
  // common case without touching the visual layout. Bumped by +200 on
  // each click; "Show all" once the user has bumped past the total.
  const VISIBLE_PAGE_SIZE = 200;
  const [visibleCount, setVisibleCount] = useState<number>(VISIBLE_PAGE_SIZE);
  // Reset on chat switch so a freshly opened chat starts from the latest
  // 200, not whatever the previous chat had expanded.
  useEffect(() => {
    setVisibleCount(VISIBLE_PAGE_SIZE);
  }, [chatId]);

  // Backwards-compat alias — the existing render path uses `messages`.
  // Slicing from the tail keeps the latest turn at the bottom (which is
  // what auto-scroll cares about) and drops older history that isn't on
  // screen anyway.
  const hiddenOlderCount = Math.max(0, allMessages.length - visibleCount);
  const messages =
    hiddenOlderCount > 0 ? allMessages.slice(hiddenOlderCount) : allMessages;

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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
          by the composer layout below).
          `overflow-hidden` is critical — the prompt-history panel sits
          off-screen at `translate-x-full` while closed; without clipping
          here it overflows the chat area and triggers a horizontal page
          scroll. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/*
        `aria-live="polite"` + `aria-busy={...}` so assistive tech
        announces streaming tokens / turn completion without interrupting
        the user mid-edit. `polite` is the right level — `assertive`
        would barge in. Audit-round-7 finding.
      */}
      <div
        ref={scrollRef}
        aria-live="polite"
        aria-busy={isStreaming || serverRunning ? true : undefined}
        className="flex-1 overflow-auto p-4 space-y-4"
      >
        {hiddenOlderCount > 0 && !chatLoading && (
          <div
            data-testid="chat-show-older"
            className="flex justify-center"
          >
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="text-xs text-muted-foreground"
              onClick={() =>
                setVisibleCount((prev) =>
                  Math.min(allMessages.length, prev + VISIBLE_PAGE_SIZE),
                )
              }
            >
              Show {Math.min(VISIBLE_PAGE_SIZE, hiddenOlderCount)} older
              message{hiddenOlderCount === 1 ? "" : "s"}
              {hiddenOlderCount > VISIBLE_PAGE_SIZE
                ? ` (${hiddenOlderCount} hidden)`
                : ""}
            </Button>
          </div>
        )}
        {chatLoading &&
          Array.from({ length: 3 }).map((_, i) => (
            <div
              key={`skeleton-${i}`}
              className={`flex ${i % 2 === 0 ? "justify-end" : "justify-start"}`}
            >
              <Skeleton className="h-10 w-48 rounded-lg" />
            </div>
          ))}
        {!chatLoading && messages.length === 0 && !isStreaming && (emptyState ?? (
          <DefaultEmptyState onPick={(prompt) => setInputValue(prompt)} />
        ))}
        {messages.map((msg: ChatMessageResponse, i: number) => {
          // Latest assistant turn that's still receiving deltas wears the
          // `.agent-glow` left-rule walk so the active turn reads as alive
          // (CSS handles `prefers-reduced-motion: reduce` — no JS branch
          // needed). Only ever true for the LAST row in `messages` to avoid
          // stale streaming flags on older rows from glowing forever.
          const isLatestStreaming =
            i === messages.length - 1 &&
            msg.role === "assistant" &&
            !!msg.is_streaming;
          if (msg.role === "tool") {
            return (
              <div key={msg.id} className="flex justify-start" data-testid="tool-message">
                <div className="max-w-[92%] sm:max-w-[85%] lg:max-w-[80%] min-w-0 flex-1">
                  <StoredToolMessageItem
                    id={msg.id}
                    content={msg.content}
                    createdAt={msg.created_at}
                  />
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
          const rendered = (
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
          );
          const justify = msg.role === "user" ? "justify-end" : "justify-start";
          return (
            <div
              key={msg.id}
              className={cn("flex", justify, isLatestStreaming && "agent-glow")}
              data-testid={isLatestStreaming ? "agent-glow-turn" : undefined}
            >
              {rendered}
            </div>
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
                    createdAt={block.createdAt}
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
                    createdAt={block.createdAt}
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

        {/* Synthesized diff chip — lists files the agent has edited in this
            chat and, on demand, expands to the full unified diff. Summary
            and diff are both session-isolated (journal-based, not
            `git diff` of the shared working tree) — see
            src/services/file-edit-journal.ts for why. Hidden when the
            agent has not made any Edit/Write/MultiEdit calls yet.

            M25 redesign — collapsed summary renders as a compact pill (file
            count, +added / -removed in semantic colours, "Show diff"
            affordance) instead of a full-width card. The expanded unified
            diff still lives in a Card so monospace diff rendering keeps the
            same surface treatment as before.

            Counts are pulled from `chatDiff.summary` ("N files changed,
            +A / -R") because the API returns the human-readable string
            rather than typed fields — see `summarizeJournal` in
            src/services/file-edit-journal.ts. The regex tolerates both
            singular ("1 file changed") and plural variants. If the parse
            fails for any reason, we fall back to rendering the raw summary
            string so the user still sees something useful. */}
        {chatDiff && chatDiff.total_entries > 0 && chatDiff.summary && (() => {
          const parsed = chatDiff.summary.match(
            /^(\d+)\s+files?\s+changed,\s+\+(\d+)\s+\/\s+-(\d+)$/,
          );
          const files = parsed ? Number(parsed[1]) : null;
          const added = parsed ? Number(parsed[2]) : null;
          const removed = parsed ? Number(parsed[3]) : null;
          return (
            <div className="space-y-2" data-testid="chat-diff-card">
              <div className="flex">
                <button
                  type="button"
                  onClick={() => setShowChatDiff((v) => !v)}
                  className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                  data-testid="chat-diff-toggle"
                  aria-expanded={showChatDiff}
                >
                  {parsed && files !== null && added !== null && removed !== null ? (
                    <>
                      <span className="font-mono text-muted-foreground">
                        {files} {files === 1 ? "file" : "files"}
                      </span>
                      <span className="font-mono text-emerald-500 dark:text-emerald-400">
                        +{added.toLocaleString()}
                      </span>
                      <span className="font-mono text-rose-500 dark:text-rose-400">
                        −{removed.toLocaleString()}
                      </span>
                    </>
                  ) : (
                    <span className="font-mono">{chatDiff.summary}</span>
                  )}
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {showChatDiff ? "Hide" : "Show"}
                  </span>
                </button>
              </div>
              {showChatDiff && (
                <Card>
                  <CardContent>
                    <InlineDiff diff={chatDiff.diff} truncated={chatDiff.truncated} />
                  </CardContent>
                </Card>
              )}
            </div>
          );
        })()}
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
            // Picker-mode fields (M05 slice 02). Both REST hydration
            // (`fetchAgentQuestions` → `pendingQuestions` in chat-executor)
            // and live WS frames (`useChatEventStream`'s `agent_question`
            // branch) populate these — we just forward whichever shape
            // landed in the cache. Undefined/null collapses to free-form.
            {...(agentQuestion.options ? { options: agentQuestion.options } : {})}
            multiSelect={agentQuestion.multiSelect ?? false}
            {...(agentQuestion.header ? { header: agentQuestion.header } : {})}
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
        into the next turn as soon as the current one ends. M25 redesign
        moved the markup into <QueuedMessagesList /> with numbered
        positions, drag-and-drop reorder (Alt+↑/↓ keyboard fallback), and
        an indigo head badge. Pressing Stop in the composer aborts only
        the turn in flight; the queue keeps draining — "Clear all" drops
        the rest at once.

        `disabled` mirrors `serverRunning`: while a drain is in flight the
        store rejects reorders to avoid the head-race documented in
        chat-queue-store.ts → reorderQueue. Surfacing it here makes the
        rejection visible (cursor turns into not-allowed, items lose
        hover affordance) instead of making the user wonder why their
        drag silently bounced.
      */}
      <QueuedMessagesList
        items={queuedMessages}
        onRemove={removeFromQueue}
        onClearAll={clearQueue}
        onReorder={reorderQueue}
        disabled={serverRunning}
      />

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
            {/*
              All four selectors share INLINE_TRIGGER_CLS so the composer
              footer reads as a single uniform row rather than four
              free-floating bordered fields. Width caps (max-w-[10rem]) keep
              long labels (e.g. "Claude Code Personal") truncating with an
              ellipsis instead of pushing Stop/Send off the row.
            */}
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
                className={cn(INLINE_TRIGGER_CLS, "max-w-[10rem]")}
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
              <SelectTrigger
                className={cn(INLINE_TRIGGER_CLS, "max-w-[11rem]")}
              >
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
              triggerClassName={cn(INLINE_TRIGGER_CLS, "w-fit max-w-[14rem]")}
            />
            <ChatThinkingEffortControl
              // Default to "adaptive thinking on" whenever the chat detail
              // hasn't resolved yet — matches the DB default + SDK default.
              // Without this the button would render an "off" state during
              // the initial fetch, causing a visual flicker every time the
              // user opens a chat.
              thinkingEnabled={chatDetail?.thinking_enabled ?? true}
              effort={(chatDetail?.effort as EffortLevel | null | undefined) ?? null}
              disabled={!chatId}
              inline
              triggerClassName="h-7"
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
