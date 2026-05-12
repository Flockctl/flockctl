import { ConfirmDialog } from "@/components/confirm-dialog";

/**
 * DiscardConfirm — the modal that gates a per-row "Discard" click in the
 * source-control rail. Wraps {@link ConfirmDialog} so the underlying
 * Radix wiring (focus trap, escape-to-close, button mechanics) stays in
 * one place.
 *
 * Body layout (top → bottom):
 *
 *   1. (Optional) "This file is open in a tab with unsaved changes …"
 *      warning paragraph — rendered when `dirtyTab` is true. The parent
 *      decides dirtiness because the tab/editor store lives outside
 *      this component; we just surface the consequence.
 *   2. The repo-relative path, in a monospace block so an operator who
 *      double-checks before confirming can read it precisely.
 *   3. The literal "This cannot be undone." reminder. Same copy git
 *      itself uses in the porcelain `git checkout -- <path>` warning.
 *
 * The confirm button label is intentionally `Discard` (not `Delete`) —
 * this matches git's own vocabulary and avoids implying that the file
 * itself goes away (untracked files, which would actually disappear,
 * are rejected upstream as `unknown_path` so we never see them here).
 *
 * Test-id contract:
 *   - `discard-confirm`              — DialogContent root.
 *   - `discard-confirm-warning`      — dirty-tab warning paragraph.
 *   - `discard-confirm-path`         — monospace path block.
 *   - `discard-confirm-undo-warning` — "cannot be undone" line.
 *   - `discard-confirm-confirm`      — Discard button (delegated to
 *                                      ConfirmDialog's destructive
 *                                      variant; we add the testid via
 *                                      a wrapper so e2e can target it).
 */
export interface DiscardConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Repo-relative path of the file the operator is about to revert.
   * Empty string is allowed (the parent may render the dialog in a
   * closed state with stale state) but the dialog should never be
   * `open` while empty.
   */
  path: string;
  /**
   * `true` when the file is currently open in an editor tab AND that
   * tab has unsaved changes. Triggers the additional warning paragraph
   * at the top of the body. Default `false` — the editor / tab store
   * isn't centralised yet, so for now most call sites will pass false.
   */
  dirtyTab?: boolean;
  isPending?: boolean;
  onConfirm: () => void;
}

export function DiscardConfirm({
  open,
  onOpenChange,
  path,
  dirtyTab = false,
  isPending = false,
  onConfirm,
}: DiscardConfirmProps) {
  // Build the body as a ReactNode so we can stack three regions —
  // ConfirmDialog accepts ReactNode for `description` precisely so a
  // bespoke confirm like this can render structured content without
  // re-implementing the Dialog scaffolding.
  const body = (
    <div data-testid="discard-confirm" className="space-y-2">
      {dirtyTab && (
        <p
          data-testid="discard-confirm-warning"
          role="alert"
          className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300"
        >
          This file is open in a tab with unsaved changes. Discarding will
          overwrite the working-tree copy on disk; the editor will offer
          to reload or keep your in-memory edits.
        </p>
      )}
      <p
        data-testid="discard-confirm-path"
        className="break-all rounded bg-muted px-2 py-1.5 font-mono text-xs"
      >
        {path}
      </p>
      <p
        data-testid="discard-confirm-undo-warning"
        className="text-xs text-muted-foreground"
      >
        This cannot be undone.
      </p>
    </div>
  );

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Discard changes?"
      description={body}
      confirmLabel="Discard"
      cancelLabel="Cancel"
      isPending={isPending}
      onConfirm={onConfirm}
    />
  );
}
