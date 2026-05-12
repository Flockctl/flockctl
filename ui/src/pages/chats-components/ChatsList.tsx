import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { SectionHeader } from "@/components/design";
import { cn } from "@/lib/utils";
import {
  ChatRow,
  type ChatRowChat,
} from "@/pages/chats-components/ChatRow";

/**
 * Pixel height the virtualizer estimates per row. ChatRow renders a
 * fixed two-line layout with px-3 py-2 padding; in practice rows
 * settle at roughly this height. The virtualizer measures actual
 * sizes via `measureElement` to correct any drift.
 */
const ESTIMATED_ROW_HEIGHT = 64;

/**
 * Below this row count we skip virtualization. Mounting the
 * virtualizer + a phantom container adds non-zero overhead, and the
 * native scroll path already handles small lists perfectly. The
 * threshold maps roughly to "fits on one screen without scrolling".
 */
const VIRTUALIZE_THRESHOLD = 30;

/**
 * ChatsList — the body of the `/chats` page (slice 24-02 T01).
 *
 * Two render modes, gated by `group`:
 *
 *   - `group="list"` (default) — flat list, sorted by `last_message_at`
 *     descending (nulls last). Mirrors the prototype's default view.
 *   - `group="project"` — chats grouped under a `<SectionHeader
 *     size="section">` per project, then the chat rows inside. Within
 *     each section, the same `last_message_at desc` ordering applies.
 *     Chats without a project group under "No project" so the user
 *     never has chats silently dropped from a grouped view.
 *
 * Sorting is stable across re-renders because we sort a copy of the
 * incoming array (never mutate the prop) and tie-break on `id`. That
 * matters for React keys and for tests that pin specific row order.
 *
 * Pending / live state is opaque to this component: the parent passes
 * `pendingByChatId` (the existing `useChatListLiveState().pendingCount`
 * map) and the row reads its own entry. We intentionally don't open
 * any subscription here — slice 24-02 T03 owns the viewport-scoped
 * IntersectionObserver hook for that.
 *
 * Edge cases:
 *   - `chats` empty → returns `null` so the parent can show whatever
 *     empty-state matches its current filter (the page already owns
 *     the search-empty + zero-chats messaging).
 *   - In `group="project"` mode, projects are listed alphabetically,
 *     with the `No project` bucket appended last (a normal Latin sort
 *     would put it between `M` and `O`, which reads weirdly).
 */

const NO_PROJECT_KEY = "__none__";
const NO_PROJECT_LABEL = "No project";

export type ChatsListGroupMode = "list" | "project";

export interface ChatsListProps {
  chats: ReadonlyArray<ChatRowChat>;
  /** Flat list (default) or by-project sections. */
  group?: ChatsListGroupMode;
  /** Currently selected chat (highlights the matching row). */
  selectedId?: string | null;
  /** Map of `chatId → pending question count`. 0 / missing means no pending. */
  pendingByChatId?: Readonly<Record<string, number>>;
  /**
   * Map of `chatId → running flag`. Sourced from
   * `useChatListLiveState().running` — the WS-driven "agent is currently
   * working" signal. Forwarded into `ChatRow.running` so the live dot
   * stays in sync as turns start/end without waiting on a chat-list
   * refetch.
   */
  runningByChatId?: Readonly<Record<string, boolean>>;
  /**
   * Map of `chatId → ISO timestamp of last read`. Sourced from
   * `useChatReadMap()`. A row is considered unread when its
   * `updated_at` is strictly newer than its entry here (or no entry
   * exists). Missing map → no unread markers anywhere.
   */
  lastReadByChatId?: Readonly<Record<string, string | undefined>>;
  /** Forwarded to each row. */
  onSelect?: (chatId: string) => void;
  /** Forwarded to each row's trailing pin button. Omit to hide. */
  onTogglePin?: (chatId: string, nextPinned: boolean) => void;
  /** Forwarded to each row's trailing delete button. Omit to hide. */
  onDelete?: (chatId: string) => void;
  /**
   * Set of chat ids currently checked for batch operations (e.g. bulk-
   * delete). When `onToggleMultiSelect` is wired, every row renders a
   * leading checkbox; rows whose id is in this set render with the
   * checkbox checked + persistently visible. Distinct from `selectedId`,
   * which marks the single chat the user has navigated into.
   */
  multiSelectedIds?: ReadonlySet<string>;
  /**
   * Forwarded to each row's leading checkbox. Omit to hide the checkbox
   * across the whole list — pickers and read-only surfaces should leave
   * this `undefined` so they don't accidentally expose batch UI.
   */
  onToggleMultiSelect?: (chatId: string, next: boolean) => void;
  className?: string;
  "data-testid"?: string;
}

/**
 * Compare by pinned first (pinned chats float to the top — same ordering
 * the backend ships), then by `last_message_at` desc with a stable
 * tie-breaker on id. Falls back to `updated_at` when the metric is
 * missing so a brand-new chat (no messages) still slots in by its
 * creation time.
 */
function compareByLastMessageDesc(a: ChatRowChat, b: ChatRowChat): number {
  const aPinned = a.pinned ? 1 : 0;
  const bPinned = b.pinned ? 1 : 0;
  if (aPinned !== bPinned) return bPinned - aPinned;
  const aAt = a.metrics?.last_message_at ?? a.updated_at ?? "";
  const bAt = b.metrics?.last_message_at ?? b.updated_at ?? "";
  if (aAt < bAt) return 1;
  if (aAt > bAt) return -1;
  // Same timestamp → fall back to id for deterministic order.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Group rows by project name (or NO_PROJECT_KEY when unscoped) and
 * return an alphabetically-ordered list of `[label, rows]` tuples
 * with the unscoped bucket appended last.
 */
function groupByProject(
  chats: ReadonlyArray<ChatRowChat>,
): Array<{ key: string; label: string; rows: ChatRowChat[] }> {
  const buckets = new Map<string, { label: string; rows: ChatRowChat[] }>();
  for (const chat of chats) {
    const label = chat.project_name?.trim();
    const key = label ? label : NO_PROJECT_KEY;
    // Use `||` (not `??`) so a server-side empty-string `project_name`
    // is treated the same as `null` / `undefined` and falls into the
    // unscoped bucket. With `??` an empty string survived as the section
    // label, rendering an unlabelled "No project" header.
    const display = label || NO_PROJECT_LABEL;
    const existing = buckets.get(key);
    if (existing) {
      existing.rows.push(chat);
    } else {
      buckets.set(key, { label: display, rows: [chat] });
    }
  }

  const named: Array<{ key: string; label: string; rows: ChatRowChat[] }> = [];
  let unscoped: { key: string; label: string; rows: ChatRowChat[] } | null = null;
  for (const [key, value] of buckets) {
    const sortedRows = [...value.rows].sort(compareByLastMessageDesc);
    const entry = { key, label: value.label, rows: sortedRows };
    if (key === NO_PROJECT_KEY) unscoped = entry;
    else named.push(entry);
  }

  named.sort((a, b) => a.label.localeCompare(b.label));
  return unscoped ? [...named, unscoped] : named;
}

export function ChatsList({
  chats,
  group = "list",
  selectedId,
  pendingByChatId,
  runningByChatId,
  lastReadByChatId,
  onSelect,
  onTogglePin,
  onDelete,
  multiSelectedIds,
  onToggleMultiSelect,
  className,
  "data-testid": testId,
}: ChatsListProps): React.JSX.Element | null {
  // Centralise the unread predicate so both render paths agree on what
  // "unread" means. The selected row is implicitly read — we don't want
  // a blue dot on the chat the user is currently looking at.
  const isUnread = React.useCallback(
    (chat: ChatRowChat): boolean => {
      if (!lastReadByChatId) return false;
      if (selectedId === chat.id) return false;
      const last = lastReadByChatId[chat.id];
      const updated = chat.updated_at;
      if (!updated) return false;
      return !last || updated > last;
    },
    [lastReadByChatId, selectedId],
  );
  // Hooks must run unconditionally — pre-compute both shapes regardless
  // of which one we'll render. The math is cheap (one .sort + one map
  // over what is already a small in-memory list); no need to lazy it.
  const sortedChats = React.useMemo(
    () => [...chats].sort(compareByLastMessageDesc),
    [chats],
  );
  const sections = React.useMemo(() => groupByProject(chats), [chats]);

  if (chats.length === 0) return null;

  if (group === "project") {
    return (
      <div
        data-testid={testId ?? "chats-list"}
        data-group="project"
        className={cn("flex flex-col", className)}
      >
        {sections.map((section) => (
          <section
            key={section.key}
            data-testid="chats-list-section"
            data-section-key={section.key}
            className="mb-4 last:mb-0"
          >
            <div className="px-4">
              <SectionHeader
                size="section"
                title={section.label}
                subtitle={`${section.rows.length} chat${section.rows.length === 1 ? "" : "s"}`}
              />
            </div>
            <div>
              {section.rows.map((chat) => {
                const pending = pendingByChatId?.[chat.id] ?? 0;
                return (
                  <ChatRow
                    key={chat.id}
                    chat={chat}
                    selected={selectedId === chat.id}
                    awaitingAnswer={pending > 0}
                    running={runningByChatId?.[chat.id] ?? false}
                    unread={isUnread(chat)}
                    onSelect={onSelect}
                    onTogglePin={onTogglePin}
                    onDelete={onDelete}
                    multiSelected={multiSelectedIds?.has(chat.id) ?? false}
                    onToggleMultiSelect={onToggleMultiSelect}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
    );
  }

  // Flat list — single sorted block.
  //
  // Virtualization: when the list exceeds VIRTUALIZE_THRESHOLD rows we
  // mount @tanstack/react-virtual so only the visible window (plus a
  // small overscan) lives in the DOM. The chats list grows monotonically
  // as the user clicks "Load more" — without virtualization a
  // multi-hundred-row list re-renders every row on each WS event.
  if (sortedChats.length > VIRTUALIZE_THRESHOLD) {
    return (
      <VirtualisedChatsList
        chats={sortedChats}
        pendingByChatId={pendingByChatId}
        runningByChatId={runningByChatId}
        selectedId={selectedId}
        isUnread={isUnread}
        onSelect={onSelect}
        onTogglePin={onTogglePin}
        onDelete={onDelete}
        multiSelectedIds={multiSelectedIds}
        onToggleMultiSelect={onToggleMultiSelect}
        className={className}
        testId={testId ?? "chats-list"}
      />
    );
  }

  return (
    <div
      data-testid={testId ?? "chats-list"}
      data-group="list"
      className={cn("flex flex-col", className)}
    >
      {sortedChats.map((chat) => {
        const pending = pendingByChatId?.[chat.id] ?? 0;
        return (
          <ChatRow
            key={chat.id}
            chat={chat}
            selected={selectedId === chat.id}
            awaitingAnswer={pending > 0}
            running={runningByChatId?.[chat.id] ?? false}
            unread={isUnread(chat)}
            onSelect={onSelect}
            onTogglePin={onTogglePin}
            onDelete={onDelete}
            multiSelected={multiSelectedIds?.has(chat.id) ?? false}
            onToggleMultiSelect={onToggleMultiSelect}
          />
        );
      })}
    </div>
  );
}

/**
 * Virtualised flat-list renderer. Only rows currently in the scroll
 * viewport (+ overscan) are mounted in the DOM. The scroll container
 * is sized via a phantom div whose height matches the sum of all
 * estimated row heights, so the scroll thumb behaves correctly. Row
 * heights are auto-measured via `measureElement` to absorb wrapping /
 * pinned-row variations.
 */
interface VirtualisedChatsListProps {
  chats: ReadonlyArray<ChatRowChat>;
  pendingByChatId?: Readonly<Record<string, number>>;
  runningByChatId?: Readonly<Record<string, boolean>>;
  selectedId?: string | null;
  isUnread: (chat: ChatRowChat) => boolean;
  onSelect?: (chatId: string) => void;
  onTogglePin?: (chatId: string, nextPinned: boolean) => void;
  onDelete?: (chatId: string) => void;
  multiSelectedIds?: ReadonlySet<string>;
  onToggleMultiSelect?: (chatId: string, next: boolean) => void;
  className?: string;
  testId: string;
}

function VirtualisedChatsList({
  chats,
  pendingByChatId,
  runningByChatId,
  selectedId,
  isUnread,
  onSelect,
  onTogglePin,
  onDelete,
  multiSelectedIds,
  onToggleMultiSelect,
  className,
  testId,
}: VirtualisedChatsListProps): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: chats.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 8,
  });

  return (
    <div
      ref={scrollRef}
      data-testid={testId}
      data-group="list"
      data-virtualised="true"
      className={cn("flex flex-col overflow-auto", className)}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((vItem) => {
          const chat = chats[vItem.index];
          if (!chat) return null;
          const pending = pendingByChatId?.[chat.id] ?? 0;
          return (
            <div
              key={chat.id}
              data-index={vItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vItem.start}px)`,
              }}
            >
              <ChatRow
                chat={chat}
                selected={selectedId === chat.id}
                awaitingAnswer={pending > 0}
                running={runningByChatId?.[chat.id] ?? false}
                unread={isUnread(chat)}
                onSelect={onSelect}
                onTogglePin={onTogglePin}
                onDelete={onDelete}
                multiSelected={multiSelectedIds?.has(chat.id) ?? false}
                onToggleMultiSelect={onToggleMultiSelect}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ChatsList;
