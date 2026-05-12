import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";

import { SegmentToggle } from "@/components/design/SegmentToggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * ChatsToolbar — search input + group toggle (List | By project) +
 * indigo `+ New chat` button. Lives in the header rail of `/chats`
 * (slice 24-02 T02).
 *
 * URL contract (slice spec):
 *
 *   - `?q=`               — committed search query. Debounced 200 ms
 *                           before being written so a typing burst
 *                           doesn't flood router state.
 *   - `?group=list|project` — current group mode. Persisted on the URL
 *                             (not localStorage) so a shareable link
 *                             reproduces the exact view.
 *
 * Three pieces of state, each anchored to the right durability layer:
 *
 *   1. **Search query** — typed into the native `<input>`, debounced
 *      200 ms before being committed to the URL `?q=` param.
 *      `setSearchParams(..., { replace: true })` keeps the address-bar
 *      history clean — typing 8 characters shouldn't produce 8
 *      history entries.
 *
 *   2. **Group mode** — `list` (default) | `project`. Backed by the
 *      URL `?group=` param so a copy-paste link round-trips the
 *      grouping. Invalid values silently fall back to `list`.
 *
 *   3. **+ New chat** — pure call-to-action. The dialog itself lives in
 *      `chats.tsx`; this toolbar surfaces the button and forwards the
 *      click via `onNewChat?` so the parent can open the dialog.
 *
 * The component self-manages all three pieces of state and emits
 * callbacks (`onSearchChange`, `onGroupChange`, `onNewChat`) so the
 * parent can react without re-implementing the same plumbing.
 *
 * For consumers that need the live state without depending on
 * callbacks, the {@link useChatsSearchQuery} and {@link
 * useChatsGroupMode} hooks expose the same source of truth.
 */

export type ChatsGroupMode = "list" | "project";

const ALLOWED_GROUPS: ReadonlyArray<ChatsGroupMode> = ["list", "project"] as const;
const DEFAULT_GROUP: ChatsGroupMode = "list";
const DEFAULT_DEBOUNCE_MS = 200;
const QUERY_PARAM = "q";
const GROUP_PARAM = "group";

function isChatsGroupMode(v: unknown): v is ChatsGroupMode {
  return (
    typeof v === "string" &&
    (ALLOWED_GROUPS as readonly string[]).includes(v)
  );
}

/**
 * URL-backed search query state for the `/chats` page.
 *
 * Returns:
 *   - `draft`        — what the input currently shows (uncommitted typing).
 *   - `query`        — what the URL holds (debounced commit).
 *   - `setDraft(v)`  — update the draft. After `debounceMs`, the draft
 *                      is committed to URL `?q=` (using `replace: true`
 *                      so back/forward isn't polluted).
 *
 * Empty / whitespace-only drafts clear the param entirely (so a clean
 * URL is `/chats` rather than `/chats?q=`). Trimming happens on commit,
 * not on every keystroke — so the user can briefly hold a trailing
 * space without the input fighting them.
 *
 * Because tests want deterministic timing, `debounceMs` is overridable
 * (defaults to 200 ms per slice spec).
 */
export function useChatsSearchQuery(debounceMs: number = DEFAULT_DEBOUNCE_MS): {
  draft: string;
  query: string;
  setDraft: (next: string) => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get(QUERY_PARAM) ?? "";

  const [draft, setDraftState] = useState<string>(urlQuery);

  // If the URL changes externally (e.g. browser back), reflect that
  // back into the draft. We compare against the previous URL value so
  // we don't clobber an in-flight typing session that hasn't committed
  // yet.
  const lastUrlRef = useRef<string>(urlQuery);
  useEffect(() => {
    if (urlQuery !== lastUrlRef.current) {
      lastUrlRef.current = urlQuery;
      setDraftState(urlQuery);
    }
  }, [urlQuery]);

  // Debounced commit. `setSearchParams` with `{ replace: true }` keeps
  // the address-bar history clean — typing 8 characters shouldn't
  // produce 8 history entries.
  useEffect(() => {
    const trimmed = draft.trim();
    if (trimmed === urlQuery) return;
    const timer = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (trimmed) params.set(QUERY_PARAM, trimmed);
          else params.delete(QUERY_PARAM);
          return params;
        },
        { replace: true },
      );
      lastUrlRef.current = trimmed;
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [draft, debounceMs, setSearchParams, urlQuery]);

  const setDraft = useCallback((next: string) => {
    setDraftState(next);
  }, []);

  return { draft, query: urlQuery, setDraft };
}

/**
 * URL-backed group-mode state for the `/chats` page.
 *
 * Returns `[mode, setMode]`. Mode is read from the URL `?group=` param;
 * unknown / missing values resolve to `'list'`. `setMode` writes back
 * to the URL with `replace: true` so toggling doesn't pollute history.
 */
export function useChatsGroupMode(): [ChatsGroupMode, (next: ChatsGroupMode) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(GROUP_PARAM);
  const mode: ChatsGroupMode = isChatsGroupMode(raw) ? raw : DEFAULT_GROUP;

  const setMode = useCallback(
    (next: ChatsGroupMode) => {
      if (!isChatsGroupMode(next)) return;
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          // Default mode rendered as a clean URL (no ?group=list noise).
          if (next === DEFAULT_GROUP) params.delete(GROUP_PARAM);
          else params.set(GROUP_PARAM, next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return [mode, setMode];
}

/**
 * Filter helper exported so the page can apply the same case-insensitive
 * substring match the toolbar contracts for. Centralising the predicate
 * keeps URL state and rendered list strictly consistent.
 *
 * Matches against `title`, `last_message_excerpt`, `project_name` and
 * `workspace_name` — the fields a user would naturally search by.
 */
export function filterChatsByQuery<
  T extends {
    title?: string | null;
    last_message_excerpt?: string | null;
    project_name?: string | null;
    workspace_name?: string | null;
  },
>(rows: ReadonlyArray<T>, query: string): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [...rows];
  return rows.filter((row) => {
    const haystacks: string[] = [
      (row.title ?? "").toLowerCase(),
      (row.last_message_excerpt ?? "").toLowerCase(),
      (row.project_name ?? "").toLowerCase(),
      (row.workspace_name ?? "").toLowerCase(),
    ];
    return haystacks.some((s) => s.includes(trimmed));
  });
}

export interface ChatsToolbarProps {
  /**
   * Fired with the committed (debounced) search query whenever it
   * changes. The string is already trimmed.
   */
  onSearchChange?: (query: string) => void;
  /** Fired when the user activates a different group mode. */
  onGroupChange?: (group: ChatsGroupMode) => void;
  /**
   * Fired when the user clicks `+ New chat`. The parent owns the
   * actual dialog; the toolbar just surfaces the button.
   */
  onNewChat?: () => void;
  /**
   * Override the search debounce. Tests pin this to `0` to keep
   * timer plumbing simple; production uses 200 ms.
   */
  searchDebounceMs?: number;
  className?: string;
  "data-testid"?: string;
}

const GROUP_OPTIONS: ReadonlyArray<{ value: ChatsGroupMode; label: string }> = [
  { value: "list", label: "List" },
  { value: "project", label: "By project" },
] as const;

const SEARCH_INPUT_CLASSES =
  "px-3 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded text-[12.5px] outline-none focus:border-indigo-500 w-56";

export function ChatsToolbar({
  onSearchChange,
  onGroupChange,
  onNewChat,
  searchDebounceMs = DEFAULT_DEBOUNCE_MS,
  className,
  "data-testid": testId,
}: ChatsToolbarProps) {
  const { draft, query, setDraft } = useChatsSearchQuery(searchDebounceMs);
  const [group, setGroup] = useChatsGroupMode();

  // Mirror committed query changes to the parent. Skip the very first
  // emission when the URL is empty so consumers don't get a synthetic
  // "" event on mount they didn't ask for.
  const lastEmittedRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastEmittedRef.current === query) return;
    lastEmittedRef.current = query;
    onSearchChange?.(query);
  }, [query, onSearchChange]);

  const handleGroupChange = useCallback(
    (next: ChatsGroupMode) => {
      setGroup(next);
      onGroupChange?.(next);
    },
    [setGroup, onGroupChange],
  );

  const segmentOptions = useMemo(() => [...GROUP_OPTIONS], []);

  return (
    <div
      data-testid={testId ?? "chats-toolbar"}
      className={cn("flex items-center gap-2", className)}
    >
      <input
        type="text"
        role="searchbox"
        placeholder="Search chats…"
        aria-label="Search chats"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className={SEARCH_INPUT_CLASSES}
        data-testid="chats-search-input"
      />
      <SegmentToggle<ChatsGroupMode>
        options={segmentOptions}
        value={group}
        onChange={handleGroupChange}
        aria-label="Chats group mode"
        data-testid="chats-group-toggle"
      />
      <Button
        type="button"
        size="sm"
        onClick={onNewChat}
        data-testid="chats-new-chat-button"
      >
        <Plus aria-hidden="true" />
        New chat
      </Button>
    </div>
  );
}

export default ChatsToolbar;
