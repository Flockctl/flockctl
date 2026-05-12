import { useCallback, useRef, useState } from "react";
import { GripVertical, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { QueuedChatMessage } from "@/lib/chat-queue-store";

/**
 * Numbered, drag-and-drop reorderable list of queued messages — replaces the
 * pre-M25 thin "Queued (N)" bar. Renders the queue as an explicit
 * sequence: each entry shows its position (`#1`, `#2`, …), a drag handle,
 * the prompt text, and an ✕ to drop the entry from the queue. The first
 * entry's badge is rendered in the indigo primary so the user can spot
 * "what runs next" at a glance.
 *
 * Reorder is implemented on top of the native HTML5 drag-and-drop API —
 * keeps the bundle clean (no @dnd-kit) and is enough for a short vertical
 * list with mouse-only desktop usage. For accessibility, every item also
 * accepts Alt+↑ / Alt+↓ keyboard shortcuts that bypass the DnD entirely
 * and call the same `onReorder(from, to)` handler. Both paths reject the
 * reorder when the chat is mid-drain (the `disabled` prop) — see
 * `reorderQueue` in chat-queue-store.ts for why.
 *
 * The component is purely presentational: parent owns the queue array
 * (via `useChatQueue`) and the three callbacks (`onRemove`, `onClearAll`,
 * `onReorder`). That mirrors how `ChatComposer` is wired to the rest of
 * the chat surface and keeps the test surface identical to the pre-M25
 * bar — chat-conversation.tsx still drives the data, only the markup
 * has moved.
 */
export interface QueuedMessagesListProps {
  /** The live queue snapshot for the current chat. Empty array → render nothing. */
  items: readonly QueuedChatMessage[];
  /** Called when the user clicks the ✕ on a single item. */
  onRemove: (id: string) => void;
  /** Called when the user clicks "Clear all". */
  onClearAll: () => void;
  /**
   * Called by both the DnD handler and the keyboard fallback. Returns
   * `true` if the reorder landed (parent forwards the `reorderQueue`
   * return value); the component uses the boolean to decide whether to
   * restore keyboard focus to the moved row's new position.
   */
  onReorder: (fromIndex: number, toIndex: number) => boolean;
  /**
   * Disables both DnD and keyboard reorder. Set to `true` while a drain
   * is in flight — the store would reject the reorder anyway, but the
   * `aria-disabled` state surfaces the rejection visually rather than
   * leaving the user wondering why their drag didn't take.
   */
  disabled?: boolean;
}

export function QueuedMessagesList({
  items,
  onRemove,
  onClearAll,
  onReorder,
  disabled,
}: QueuedMessagesListProps) {
  // `draggedIndex` — the row the user is currently dragging (set in
  // onDragStart, cleared in onDragEnd). `dropTargetIndex` — the row the
  // cursor is currently hovering over inside the list (drives the
  // "drop here" indicator + the list's eventual reorder commit). Both
  // are local to this component; the actual reorder lands via
  // `onReorder` only at the end of the gesture.
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);

  // Refs to each row button so the keyboard-reorder path can re-focus
  // the moved row at its new index. Without this the focus ring stays
  // on the *original* DOM node, which is now somewhere else in the
  // list — disorienting for keyboard users.
  const rowRefs = useRef<Array<HTMLLIElement | null>>([]);

  const handleDragStart = useCallback(
    (index: number) => (e: React.DragEvent<HTMLLIElement>) => {
      if (disabled) {
        e.preventDefault();
        return;
      }
      setDraggedIndex(index);
      // Required for Firefox — without setData the drag never starts.
      // The string itself is irrelevant; we use indices via React state.
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index));
    },
    [disabled],
  );

  const handleDragOver = useCallback(
    (index: number) => (e: React.DragEvent<HTMLLIElement>) => {
      if (disabled || draggedIndex === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      // Only update if the target actually changed — otherwise this
      // fires once per pixel of vertical movement and trashes React's
      // reconciler with no-op updates.
      if (dropTargetIndex !== index) setDropTargetIndex(index);
    },
    [disabled, draggedIndex, dropTargetIndex],
  );

  const handleDragLeave = useCallback(
    (index: number) => (e: React.DragEvent<HTMLLIElement>) => {
      // Only clear if the leave event targets the row itself; child
      // elements (the grip svg, the ✕ button) fire their own dragleave
      // events as the cursor crosses their borders, which would
      // otherwise make the indicator flicker.
      if (e.currentTarget !== e.target) return;
      if (dropTargetIndex === index) setDropTargetIndex(null);
    },
    [dropTargetIndex],
  );

  const handleDrop = useCallback(
    (targetIndex: number) => (e: React.DragEvent<HTMLLIElement>) => {
      e.preventDefault();
      if (disabled) return;
      if (draggedIndex === null || draggedIndex === targetIndex) return;
      onReorder(draggedIndex, targetIndex);
      setDraggedIndex(null);
      setDropTargetIndex(null);
    },
    [disabled, draggedIndex, onReorder],
  );

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null);
    setDropTargetIndex(null);
  }, []);

  const handleKeyDown = useCallback(
    (index: number) => (e: React.KeyboardEvent<HTMLLIElement>) => {
      // Reorder via Alt+↑ / Alt+↓. Alt is the standard modifier in
      // GitHub / Notion / VS Code; Cmd/Meta is reserved for system
      // shortcuts (Cmd+↑ jumps to top of viewport on macOS) so we
      // don't bind to it. Plain ↑/↓ stay as-is so screen-reader users
      // can still arrow through the list to read each entry.
      if (!e.altKey || disabled) return;
      let target: number | null = null;
      if (e.key === "ArrowUp") target = index - 1;
      else if (e.key === "ArrowDown") target = index + 1;
      if (target === null || target < 0 || target >= items.length) return;
      e.preventDefault();
      const ok = onReorder(index, target);
      if (!ok) return;
      // Re-focus the moved row at its new index on the next tick — the
      // store's emit triggers a re-render that reorders the LIs, and
      // calling .focus() before that lands focuses the wrong DOM node.
      queueMicrotask(() => {
        rowRefs.current[target]?.focus();
      });
    },
    [disabled, items.length, onReorder],
  );

  if (items.length === 0) return null;

  return (
    <div
      className="border-t bg-muted/20 px-3 py-2.5"
      data-testid="chat-queued-bar"
    >
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] font-medium">
          {/* Pulsing indigo dot tracks the convention from the M25
              prototype: "queue is alive, runs as soon as the current
              turn ends". A static dot felt too much like a status
              indicator for something inert; the 1.5s pulse is the same
              cadence the rest of the streaming-state UI uses. */}
          <span
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary"
            aria-hidden
          />
          <span className="text-foreground">
            {items.length} queued
          </span>
          <span className="text-muted-foreground">
            · runs after current turn
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={onClearAll}
          aria-label="Clear queued messages"
          data-testid="chat-queued-clear"
        >
          <Trash2 className="h-3 w-3" />
          Clear all
        </Button>
      </div>
      <ul
        className="space-y-1"
        aria-label="Queued messages — drag to reorder, or Alt + Arrow Up / Down on a row"
        aria-disabled={disabled}
      >
        {items.map((item, index) => {
          const isDragging = draggedIndex === index;
          const isDropTarget =
            dropTargetIndex === index && draggedIndex !== null && draggedIndex !== index;
          const isHead = index === 0;
          return (
            <li
              key={item.id}
              ref={(el) => {
                rowRefs.current[index] = el;
              }}
              draggable={!disabled}
              tabIndex={0}
              onDragStart={handleDragStart(index)}
              onDragOver={handleDragOver(index)}
              onDragLeave={handleDragLeave(index)}
              onDrop={handleDrop(index)}
              onDragEnd={handleDragEnd}
              onKeyDown={handleKeyDown(index)}
              className={cn(
                "group flex items-center gap-2 rounded-lg border bg-card px-1.5 py-1.5 text-xs outline-none transition-all",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                disabled && "cursor-not-allowed opacity-60",
                !disabled && "cursor-grab active:cursor-grabbing hover:border-foreground/20",
                isDragging && "opacity-40",
                isDropTarget && "border-primary ring-1 ring-primary",
              )}
              data-testid="chat-queued-item"
              data-index={index}
              data-head={isHead || undefined}
            >
              <GripVertical
                className={cn(
                  "h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-colors",
                  !disabled && "group-hover:text-muted-foreground",
                )}
                aria-hidden
              />
              <span
                className={cn(
                  "flex h-5 min-w-[1.5rem] shrink-0 items-center justify-center rounded-md px-1 font-mono text-[10.5px] font-medium",
                  isHead
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground",
                )}
                aria-label={`Position ${index + 1}`}
              >
                #{index + 1}
              </span>
              <span
                className="min-w-0 flex-1 truncate"
                title={item.data.content}
              >
                {item.data.content}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  // Stop propagation so the <li>'s drag-related handlers
                  // (which trigger on a click-and-hold) don't pick up the
                  // pointer event when the user is just trying to remove
                  // a single entry.
                  e.stopPropagation();
                  onRemove(item.id);
                }}
                aria-label={`Remove queued message at position ${index + 1}`}
                data-testid="chat-queued-remove"
              >
                <X className="h-3 w-3" />
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
