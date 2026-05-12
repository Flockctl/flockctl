import * as React from "react";
import { Ban, Copy, Eye, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { bulkMutate } from "@/lib/bulk-mutate";
import type { BulkMutateResult } from "@/lib/bulk-mutate";

/**
 * TasksBulkToolbar — sticky-top multi-select action bar (slice 24-00 T03).
 *
 * Shape & visibility
 * ------------------
 *   Renders nothing when `selectedIds.length === 0`. When selection ≥ 1, it
 *   sticks to the top of the page surface (`sticky top-0 z-20`) so it stays
 *   visible while the user scrolls a long table.
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │  3 selected · [Cancel queued] [Mark watched] [Copy IDs] [Delete ⓘ] ✕ │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * Button contract (per slice negative-tests)
 * ------------------------------------------
 *   - "Cancel queued" — enabled iff at least one selected row has status
 *     `queued`. The toolbar receives the row→status map via `selectedStatuses`
 *     and only forwards the `queued` ids to `onCancelQueued`. Disabled with
 *     a "no queued tasks selected" tooltip when none qualify.
 *   - "Mark watched"  — always enabled. Reuses an existing per-task
 *     watch mutation supplied by the parent.
 *   - "Copy IDs"      — always enabled. Copies the FULL ids (not the
 *     8-char display form) joined with newlines.
 *   - "Delete"        — DISABLED with a "Coming soon" tooltip. The slice
 *     intentionally defers destructive bulk actions until the per-task
 *     delete UI lands; this button is a visible affordance, not a stub.
 *
 * Result reporting
 * ----------------
 *   Each successful action invokes `onResult(action, result)` with the
 *   ok / failed split returned by {@link bulkMutate}. The parent owns the
 *   actual toast surface — this component is presentational + orchestration
 *   only. The `summarize` helper (exported for tests) renders the
 *   "Cancelled 3 of 5 — failed: id1, id3" string the parent shows in either
 *   an emerald success toast or an amber partial-success toast.
 *
 *   Toast tone derivation:
 *     - `failed.length === 0`           → success (emerald)
 *     - `failed.length > 0 && ok.length > 0` → partial (amber, with details)
 *     - `ok.length === 0`               → error (red, with details)
 *
 * The parent controls the `selectedIds` array; clicking ✕ clears the
 * selection via `onClearSelection`.
 */

export type TasksBulkAction =
  | "cancel_queued"
  | "mark_watched"
  | "copy_ids"
  | "delete";

export interface TasksBulkToolbarProps {
  /** Currently-selected row ids (full uuids, not the 8-char display form). */
  selectedIds: ReadonlyArray<string>;
  /**
   * Map of selected id → status (`queued` / `running` / …). Used to derive
   * the enabled state of "Cancel queued" and to forward only the `queued`
   * subset to `onCancelQueued`.
   */
  selectedStatuses?: Readonly<Record<string, string>>;
  /**
   * Per-task cancel mutation. The toolbar fans out via `bulkMutate` and
   * reports the partial-success split through `onResult`. Required when
   * any selected row is `queued`; if omitted the button is disabled.
   */
  onCancelQueued?: (id: string, signal?: AbortSignal) => Promise<unknown>;
  /**
   * Per-task watch mutation. Always-enabled button.
   */
  onMarkWatched?: (id: string, signal?: AbortSignal) => Promise<unknown>;
  /**
   * Result handler — fires after `bulkMutate` settles for any action that
   * runs through it. Parent decides the toast surface.
   */
  onResult?: (
    action: Exclude<TasksBulkAction, "delete" | "copy_ids">,
    result: BulkMutateResult<string>,
  ) => void;
  /**
   * Fired on Copy IDs. The component already wrote to the clipboard; this
   * exists so the parent can surface a "Copied 3 ids" toast.
   */
  onCopyIds?: (ids: string[]) => void;
  /**
   * Fired when the user clicks the ✕ on the right side. Parent should clear
   * its `selectedIds` state.
   */
  onClearSelection?: () => void;
  className?: string;
  "data-testid"?: string;
}

const QUEUED_STATUSES = new Set<string>(["queued"]);

const TOOLBAR =
  "sticky top-0 z-20 flex items-center gap-2 border-b border-zinc-200 bg-zinc-50/95 backdrop-blur px-3 py-2 text-[12.5px] dark:border-zinc-800 dark:bg-zinc-900/95";

export function TasksBulkToolbar({
  selectedIds,
  selectedStatuses,
  onCancelQueued,
  onMarkWatched,
  onResult,
  onCopyIds,
  onClearSelection,
  className,
  "data-testid": testId,
}: TasksBulkToolbarProps): React.JSX.Element | null {
  const [busy, setBusy] = React.useState<TasksBulkAction | null>(null);

  if (selectedIds.length === 0) {
    return null;
  }

  const queuedIds = selectedIds.filter((id) =>
    QUEUED_STATUSES.has(selectedStatuses?.[id] ?? ""),
  );
  const cancelEnabled = Boolean(onCancelQueued) && queuedIds.length > 0;
  const watchEnabled = Boolean(onMarkWatched);

  const cancelTitle = !onCancelQueued
    ? "Cancel mutation not provided"
    : queuedIds.length === 0
      ? "No queued tasks selected"
      : `Cancel ${queuedIds.length} queued task${queuedIds.length === 1 ? "" : "s"}`;

  const handleCancelQueued = async () => {
    if (!cancelEnabled || !onCancelQueued || busy) return;
    setBusy("cancel_queued");
    try {
      const result = await bulkMutate({
        items: queuedIds,
        mutateFn: onCancelQueued,
      });
      onResult?.("cancel_queued", result);
    } finally {
      setBusy(null);
    }
  };

  const handleMarkWatched = async () => {
    if (!watchEnabled || !onMarkWatched || busy) return;
    setBusy("mark_watched");
    try {
      const result = await bulkMutate({
        items: [...selectedIds],
        mutateFn: onMarkWatched,
      });
      onResult?.("mark_watched", result);
    } finally {
      setBusy(null);
    }
  };

  const handleCopyIds = async () => {
    if (busy) return;
    const text = selectedIds.join("\n");
    // Best-effort clipboard write. jsdom + older browsers may not expose
    // navigator.clipboard; in those cases we fall back to letting the parent
    // handle it via `onCopyIds`.
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      /* swallow — parent's onCopyIds receives the ids regardless. */
    }
    onCopyIds?.([...selectedIds]);
  };

  return (
    <div
      data-testid={testId ?? "tasks-bulk-toolbar"}
      role="toolbar"
      aria-label={`Bulk actions for ${selectedIds.length} selected tasks`}
      className={cn(TOOLBAR, className)}
    >
      <span
        data-testid="tasks-bulk-toolbar-count"
        className="text-zinc-700 dark:text-zinc-200 font-medium"
      >
        {selectedIds.length} selected
      </span>
      <span aria-hidden="true" className="text-zinc-400">
        ·
      </span>

      <Button
        type="button"
        size="xs"
        variant="outline"
        data-testid="tasks-bulk-toolbar-cancel-queued"
        disabled={!cancelEnabled || busy === "cancel_queued"}
        title={cancelTitle}
        aria-label={cancelTitle}
        onClick={handleCancelQueued}
      >
        <Ban className="size-3.5" aria-hidden="true" />
        Cancel queued
        {queuedIds.length > 0 && (
          <span className="ml-1 text-zinc-500">({queuedIds.length})</span>
        )}
      </Button>

      <Button
        type="button"
        size="xs"
        variant="outline"
        data-testid="tasks-bulk-toolbar-mark-watched"
        disabled={!watchEnabled || busy === "mark_watched"}
        onClick={handleMarkWatched}
      >
        <Eye className="size-3.5" aria-hidden="true" />
        Mark watched
      </Button>

      <Button
        type="button"
        size="xs"
        variant="outline"
        data-testid="tasks-bulk-toolbar-copy-ids"
        onClick={handleCopyIds}
      >
        <Copy className="size-3.5" aria-hidden="true" />
        Copy IDs
      </Button>

      <Button
        type="button"
        size="xs"
        variant="outline"
        data-testid="tasks-bulk-toolbar-delete"
        // Slice T03 negative-test: "Delete button disabled with tooltip".
        disabled
        aria-disabled="true"
        title="Coming soon"
        aria-label="Delete (coming soon)"
        className="text-destructive opacity-60"
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
        Delete
      </Button>

      <span className="ml-auto" />

      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        data-testid="tasks-bulk-toolbar-clear"
        aria-label="Clear selection"
        onClick={onClearSelection}
      >
        <X className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}

/**
 * Render a human-readable summary of a {@link BulkMutateResult} for the
 * toast surface. Exported so the parent's toast-firing code AND the unit
 * tests share the same string.
 *
 * Examples
 * --------
 *   ok=3, failed=0     → "Cancelled 3 tasks"          (success tone)
 *   ok=2, failed=1     → "Cancelled 2 of 3 — 1 failed (id-1)"  (amber)
 *   ok=0, failed=2     → "Failed to cancel 2 tasks (id-1, id-2)" (red)
 */
export function summarize(
  action: Exclude<TasksBulkAction, "delete" | "copy_ids">,
  result: BulkMutateResult<string>,
): {
  tone: "success" | "warning" | "error";
  message: string;
  failedIds: string[];
} {
  const verb = action === "cancel_queued" ? "Cancelled" : "Marked watched";
  const verbLow =
    action === "cancel_queued" ? "cancel" : "mark watched";
  const total = result.ok.length + result.failed.length;
  const failedIds = result.failed.map((f) => shortId(f.id));

  if (result.failed.length === 0) {
    return {
      tone: "success",
      message: `${verb} ${result.ok.length} task${result.ok.length === 1 ? "" : "s"}`,
      failedIds: [],
    };
  }

  if (result.ok.length === 0) {
    return {
      tone: "error",
      message: `Failed to ${verbLow} ${result.failed.length} task${result.failed.length === 1 ? "" : "s"} (${failedIds.join(", ")})`,
      failedIds,
    };
  }

  return {
    tone: "warning",
    message: `${verb} ${result.ok.length} of ${total} — ${result.failed.length} failed (${failedIds.join(", ")})`,
    failedIds,
  };
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export default TasksBulkToolbar;
