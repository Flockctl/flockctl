import * as React from "react";
import { Pin, PinOff, Trash2 } from "lucide-react";

import { LiveDot, StatusPill } from "@/components/design";
import { cn, timeAgo } from "@/lib/utils";
import { formatCost, formatTokens } from "@/lib/format";
import type { ChatResponse } from "@/lib/types/chat";

/**
 * ChatRow — a single row in the `/chats` list (slice 24-02 T01).
 *
 * Layout matches `.flockctl/plan/ui-prototype.html`:
 *
 *     ┌────────────────────────────────────────────────────────────┐
 *     │ [project]   Title text                       ● live │ 12m  │
 *     │             Last message preview (line-clamp-2)            │
 *     └────────────────────────────────────────────────────────────┘
 *
 * Status indicator (right column, top):
 *   - `is_streaming` → `<LiveDot state="live" pulse />` + emerald `live`
 *     label (the prototype's "live" affordance).
 *   - `awaitingAnswer` → amber `<StatusPill tone="warning">awaiting
 *     answer</StatusPill>`. Wins over `live` when both are true — a
 *     pending question is the more actionable state for the user.
 *   - Neither → no pill, just the relative time below.
 *
 * Click — fires `onSelect(chat.id)`. We use a real `<button>` so
 * keyboard activation, focus rings, and a11y come for free.
 *
 * Selected state — when `selected` is true, the row paints
 * `bg-zinc-100 dark:bg-zinc-800/60` (a touch denser than the hover
 * shade so a focused-and-selected row still reads as selected).
 *
 * Truncation — title gets a single-line `truncate`; excerpt uses
 * Tailwind's `line-clamp-2`. The right column is `shrink-0` so a long
 * title never pushes the time off-screen.
 *
 * No hooks, no fetches — purely presentational. The page that owns the
 * list passes in `awaitingAnswer` from its existing live-state hook
 * (`useChatListLiveState().pendingCount`); the row itself never opens a
 * subscription.
 */

/**
 * Subset of `ChatResponse` the row actually consumes. Keeping the prop
 * type narrow makes tests trivial (no need to fabricate every column on
 * `chats` just to render a row) and documents which fields the row is
 * coupled to.
 */
export type ChatRowChat = Pick<
  ChatResponse,
  | "id"
  | "title"
  | "project_name"
  | "workspace_name"
  | "is_streaming"
  | "updated_at"
  | "metrics"
> & {
  /**
   * Server-side pinned flag. When true the chat sticks to the top of the
   * list (backend `(pinned DESC, last_message_at DESC)` sort) and the
   * pin toggle button stays visible without hover so the user can unpin
   * without hunting for a hover affordance.
   */
  pinned?: boolean | null;
  /**
   * Worktree branch name for chats running with `isolation='worktree'`,
   * once the first message has materialised the worktree. NULL on
   * non-isolated chats AND on isolated chats whose first message
   * hasn't fired yet — both legitimately render the row without the
   * worktree pill. Surfacing the branch (e.g. `flockctl/chat-7`) lets
   * the operator distinguish parallel isolated chats on the same
   * project at a glance, since titles often look alike (auto-titled
   * "Untitled chat").
   */
  worktree_branch?: string | null;
};

export interface ChatRowProps {
  chat: ChatRowChat;
  /**
   * True when the chat has at least one pending tool/permission question
   * waiting on the operator. Sourced upstream from
   * `useChatListLiveState().pendingCount[chat.id] > 0`. Wins over
   * `is_streaming` when both flags are set — pending answers are a more
   * urgent state to surface.
   */
  awaitingAnswer?: boolean;
  /**
   * True when the chat's agent session is currently active on the
   * server. Sourced upstream from `useChatListLiveState().running`.
   * Merged with `chat.is_streaming` to produce the "live" indicator —
   * either signal alone is enough to mark the chat as alive (the row
   * field is server-fresh; the live map updates over WS as turns
   * start/end). Distinct from `awaitingAnswer`: a chat can be running
   * without having a pending operator question.
   */
  running?: boolean;
  /**
   * True when the chat has activity newer than the last time the user
   * opened it. Sourced upstream from comparing
   * `useChatReadMap()[chat.id]` to `chat.updated_at`. Renders a small
   * blue dot before the title — yields to `awaitingAnswer` (which
   * already grabs attention via the amber pill) so the row never wears
   * two competing markers at once.
   */
  unread?: boolean;
  /** Whether this row is the currently selected chat. */
  selected?: boolean;
  /** Fires when the row is clicked or activated by keyboard. */
  onSelect?: (chatId: string) => void;
  /**
   * Optional row-level mutators. When supplied, the row renders a small
   * action cluster on the trailing edge: a pin toggle (always visible
   * while pinned, hover-revealed otherwise — same affordance pattern as
   * the legacy two-pane sidebar) and a delete trash. When omitted, no
   * mutators render — keeps the row safe to use in read-only surfaces
   * (e.g. picker dialogs) without accidentally exposing destructive
   * actions.
   */
  onTogglePin?: (chatId: string, nextPinned: boolean) => void;
  onDelete?: (chatId: string) => void;
  /**
   * Multi-select state for batch operations (currently powering bulk-
   * delete on `/chats`). Distinct from `selected`, which marks the
   * single currently-active chat in the conversation view. When
   * `onToggleMultiSelect` is wired the row renders a leading checkbox
   * (hover-revealed by default, persistent when `multiSelected` is
   * true). Click on the checkbox toggles selection; click on the row
   * body still fires `onSelect` for navigation.
   */
  multiSelected?: boolean;
  onToggleMultiSelect?: (chatId: string, next: boolean) => void;
  className?: string;
  "data-testid"?: string;
}

const ROW_BASE_CLASSES =
  "group/row w-full text-left px-3 py-2 flex items-start gap-3 cursor-pointer transition-colors";
const ROW_HOVER_CLASSES =
  "hover:bg-zinc-50 dark:hover:bg-zinc-800/40";
const ROW_DIVIDER_CLASSES =
  "border-b border-zinc-100 dark:border-zinc-800/60";
const ROW_SELECTED_CLASSES = "bg-zinc-100 dark:bg-zinc-800/60";

/**
 * The row's "last message timestamp" display value: prefer
 * `metrics.last_message_at`, fall back to the chat row's
 * `updated_at` (so empty chats still get a relative-time label).
 */
function pickLastTimestamp(chat: ChatRowChat): string | null {
  return chat.metrics?.last_message_at ?? chat.updated_at ?? null;
}

function ChatRowImpl({
  chat,
  awaitingAnswer,
  running,
  unread,
  selected,
  onSelect,
  onTogglePin,
  onDelete,
  multiSelected,
  onToggleMultiSelect,
  className,
  "data-testid": testId,
}: ChatRowProps): React.JSX.Element {
  const handleClick = React.useCallback(() => {
    onSelect?.(chat.id);
  }, [chat.id, onSelect]);
  // Row-level pin/delete handlers — `stopPropagation` stops the click from
  // bubbling up to the row's outer button (which would otherwise fire
  // `onSelect` and navigate to the chat we're trying to operate on).
  const isPinned = !!chat.pinned;
  const handlePinClick = React.useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      onTogglePin?.(chat.id, !isPinned);
    },
    [chat.id, isPinned, onTogglePin],
  );
  const handleDeleteClick = React.useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      onDelete?.(chat.id);
    },
    [chat.id, onDelete],
  );
  // Multi-select checkbox — same propagation guard as the trailing actions:
  // toggling selection must NOT bubble up to the row body (which would fire
  // `onSelect` and navigate away from the list).
  const isMultiSelected = !!multiSelected;
  const handleMultiSelectChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      e.stopPropagation();
      onToggleMultiSelect?.(chat.id, e.target.checked);
    },
    [chat.id, onToggleMultiSelect],
  );
  const handleMultiSelectClick = React.useCallback(
    (e: React.MouseEvent) => {
      // Block the row's outer onClick — onChange already handles the toggle.
      e.stopPropagation();
    },
    [],
  );

  const title = chat.title?.trim() || "Untitled chat";
  const excerpt = chat.metrics?.last_message_excerpt ?? null;
  const projectName = chat.project_name ?? null;
  const workspaceName = chat.workspace_name ?? null;
  const lastAt = pickLastTimestamp(chat);
  // "Live" merges the row-level streaming flag (the chat row was fetched
  // mid-turn) with the WS-driven `running` signal (more current). Either
  // one alone is enough to mark the chat as alive.
  const isLive = !!chat.is_streaming || !!running;
  const isAwaiting = !!awaitingAnswer;
  // Unread is suppressed while a more urgent state is showing — the
  // amber awaiting pill / live label already pulls the eye and a third
  // concurrent marker just clutters the row.
  const showUnread = !!unread && !isAwaiting;

  // Row is a `<div role="button">` rather than a real `<button>` because
  // the trailing pin / delete affordances are themselves <button>s, and
  // nesting buttons is invalid HTML. We re-implement keyboard activation
  // (Enter / Space) so screen readers and keyboard users still get the
  // same select behaviour they'd get from a native <button>.
  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect?.(chat.id);
      }
    },
    [chat.id, onSelect],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      data-testid={testId ?? "chat-row"}
      data-chat-id={chat.id}
      data-selected={selected ? "true" : "false"}
      data-state={isAwaiting ? "awaiting" : isLive ? "live" : "idle"}
      aria-current={selected ? "true" : undefined}
      className={cn(
        ROW_BASE_CLASSES,
        ROW_HOVER_CLASSES,
        ROW_DIVIDER_CLASSES,
        selected && ROW_SELECTED_CLASSES,
        className,
      )}
    >
      {/* Multi-select checkbox — only renders when batch operations are
          wired (parent passes `onToggleMultiSelect`). Hover-revealed by
          default, persistent when this row is part of the current
          selection. Stops propagation so toggling selection doesn't
          double-fire as a navigation click on the row body. */}
      {onToggleMultiSelect && (
        <label
          onClick={handleMultiSelectClick}
          className={cn(
            "mt-1 shrink-0 flex items-center justify-center cursor-pointer transition-opacity",
            isMultiSelected
              ? "opacity-100"
              : "opacity-0 group-hover/row:opacity-100 focus-within:opacity-100",
          )}
          data-testid="chat-row-multiselect"
          aria-label={isMultiSelected ? "Deselect chat" : "Select chat"}
        >
          <input
            type="checkbox"
            checked={isMultiSelected}
            onChange={handleMultiSelectChange}
            className="h-3.5 w-3.5 cursor-pointer accent-indigo-500"
            data-testid="chat-row-multiselect-input"
          />
        </label>
      )}

      {/* Left column: project (or workspace fallback) pill. The pill is
          omitted entirely when the chat is unscoped — keeps the row from
          growing an empty leading column. */}
      {(projectName || workspaceName) && (
        <StatusPill
          tone="info"
          size="sm"
          data-testid="chat-row-project-pill"
          className="mt-0.5 shrink-0 normal-case tracking-normal font-medium"
        >
          {projectName ?? workspaceName}
        </StatusPill>
      )}

      {/* Worktree-isolation pill — surfaced only when the chat owns a
          live per-chat worktree. `chat-7` is short enough to read at
          a glance; we strip the `flockctl/` prefix because every
          managed branch carries it (the prefix stops being signal
          when it's universal). The amber tint matches the chat
          detail header's "End session" affordance so the two
          surfaces visually link to the same lifecycle. */}
      {chat.worktree_branch && (
        <StatusPill
          tone="warning"
          size="sm"
          data-testid="chat-row-worktree-pill"
          className="mt-0.5 shrink-0 normal-case tracking-normal font-mono"
          title={`Isolated worktree: ${chat.worktree_branch}`}
        >
          {chat.worktree_branch.replace(/^flockctl\//, "")}
        </StatusPill>
      )}

      {/* Middle column: title + last-message preview. `min-w-0` lets the
          flex children truncate inside a constrained parent. */}
      <div className="flex-1 min-w-0">
        <div
          data-testid="chat-row-title"
          className="font-medium text-[13px] truncate text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5"
        >
          {showUnread && (
            <span
              data-testid="chat-row-unread"
              aria-label="Unread activity"
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500"
            />
          )}
          <span className="min-w-0 flex-1 truncate">{title}</span>
        </div>
        {excerpt && (
          <div
            data-testid="chat-row-excerpt"
            className="text-zinc-500 text-[12px] line-clamp-2 mt-0.5 leading-snug"
          >
            {excerpt}
          </div>
        )}
      </div>

      {/* Right column: status pill / live indicator + usage metrics +
          relative time. `shrink-0` so nothing wraps off-screen on a long
          title. Token total + cost mirror the legacy two-pane sidebar so
          users don't lose at-a-glance "how much did this chat burn"
          information after the redesign. */}
      <div className="flex flex-col items-end gap-1 shrink-0">
        {isAwaiting ? (
          <StatusPill
            tone="warning"
            size="sm"
            data-testid="chat-row-awaiting"
          >
            awaiting answer
          </StatusPill>
        ) : isLive ? (
          <span
            data-testid="chat-row-live"
            className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
          >
            <LiveDot state="live" size="xs" />
            live
          </span>
        ) : null}
        <ChatRowMetrics metrics={chat.metrics} />
        <span
          data-testid="chat-row-time"
          className="text-[11px] text-zinc-500 tabular-nums"
        >
          {timeAgo(lastAt)}
        </span>
      </div>

      {/* Trailing action cluster — pin + delete. Both stay visible at all
          times so the user can pin or delete without hunting for a hover
          affordance (operators rely on these on touch devices and
          remote-desktop sessions where hover doesn't behave). The cluster
          only renders when at least one mutator is wired, so picker /
          read-only surfaces never accidentally show destructive actions. */}
      {(onTogglePin || onDelete) && (
        <div
          className="flex items-center gap-0.5 shrink-0 -mr-1"
          data-testid="chat-row-actions"
        >
          {onTogglePin && (
            <button
              type="button"
              onClick={handlePinClick}
              aria-label={isPinned ? "Unpin chat" : "Pin chat"}
              title={isPinned ? "Unpin chat" : "Pin chat"}
              data-testid="chat-row-pin"
              className={cn(
                "p-1 rounded text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:hover:bg-zinc-700 dark:hover:text-zinc-100",
                isPinned && "text-amber-600 dark:text-amber-400",
              )}
            >
              {isPinned ? (
                <PinOff className="h-3.5 w-3.5" />
              ) : (
                <Pin className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={handleDeleteClick}
              aria-label="Delete chat"
              title="Delete chat"
              data-testid="chat-row-delete"
              className="p-1 rounded text-zinc-500 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/30 dark:hover:text-red-400"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Compact tokens + cost label for the row's right column.
 *
 *   `12.3k tok · $0.42`     — both visible.
 *   `12.3k tok · 1.50 PR`   — Copilot premium-request quota fallback when
 *                             cost is reported as 0 (Copilot keys don't
 *                             surface USD).
 *   `12.3k tok`             — cost is 0 and no quota.
 *   `$0.42`                 — token total is 0 (e.g. cached-only turn).
 *
 * Returns null when there's nothing meaningful to show, so the right
 * column collapses cleanly on a brand-new chat.
 */
function ChatRowMetrics({
  metrics,
}: {
  metrics: ChatRowChat["metrics"];
}): React.JSX.Element | null {
  if (!metrics) return null;
  const totalTokens =
    (metrics.total_input_tokens ?? 0) + (metrics.total_output_tokens ?? 0);
  const cost = metrics.total_cost_usd ?? 0;
  const copilotQuota = metrics.total_copilot_quota ?? 0;

  const tokenLabel = totalTokens > 0 ? `${formatTokens(totalTokens)} tok` : null;
  const costLabel = cost > 0
    ? formatCost(cost)
    : copilotQuota > 0
      ? `${copilotQuota.toFixed(2)} PR`
      : null;

  if (!tokenLabel && !costLabel) return null;
  return (
    <span
      data-testid="chat-row-usage"
      className="text-[11px] text-zinc-500 tabular-nums"
      title={
        copilotQuota > 0 && cost === 0
          ? "GitHub Copilot premium requests"
          : undefined
      }
    >
      {tokenLabel}
      {tokenLabel && costLabel && (
        <span className="mx-1 text-zinc-400">·</span>
      )}
      {costLabel}
    </span>
  );
}

/**
 * Memoised wrapper. The chats list is the single biggest re-render
 * surface in the app: every WS event (`chat_status`, `chat_message`,
 * `mission_event`, etc.) refreshes the pending/running maps the page
 * forwards into every row. Without `React.memo`, even rows whose
 * relevant fields didn't change re-render — and `ChatRow` ships a
 * non-trivial amount of JSX per row (LiveDot, StatusPill, timestamp
 * formatting, usage chip).
 *
 * Audit finding: parent passes `onSelect` / `onTogglePin` / `onDelete`
 * / `onToggleMultiSelect` via `useCallback`s already (`chats.tsx:402`
 * + 812), so shallow-equal comparison hits and the row stays mounted
 * without re-render on unrelated state updates.
 */
export const ChatRow = React.memo(ChatRowImpl);
export default ChatRow;
