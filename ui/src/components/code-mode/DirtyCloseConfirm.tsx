/**
 * DirtyCloseConfirm — three-button modal that mediates the dirty-close
 * handshake of the editor tab store.
 *
 * Render contract:
 *
 *   - Subscribes to {@link useEditorTabsStore}; renders a dialog when at
 *     least one tab carries `pendingClose: true`. When several tabs are
 *     pending (rare — closing many at once), the FIRST in store order is
 *     surfaced; resolving it pops it from the queue and the next tab's
 *     dialog opens.
 *   - Three buttons: **Save**, **Don't save**, **Cancel**.
 *       - Save → calls the supplied `onSaveTab` callback. On a clean
 *         save (`{ ok: true }`) the tab is closed via
 *         `confirmClose("save")`. On `{ ok: false }` (sha conflict /
 *         write error) the dialog stays open and surfaces the message
 *         inline so the operator can pick "Don't save" or "Cancel" with
 *         full information.
 *       - Don't save → `confirmClose("dont")` — buffer is discarded and
 *         the tab is removed.
 *       - Cancel → `confirmClose("cancel")` — buffer remains dirty, the
 *         tab stays open.
 *   - When `onSaveTab` is omitted (e.g. test frames that only exercise
 *     the cancel path) the Save button degrades to "save without
 *     mutation" — it simply calls `confirmClose("save")` so the unit
 *     test can lock down the wiring without spinning up a real save
 *     mutation.
 *
 * Test-id contract:
 *   - `dirty-close-confirm`         — the dialog content wrapper.
 *   - `dirty-close-confirm-title`   — the "Save changes to <path>?" line.
 *   - `dirty-close-save`            — Save button.
 *   - `dirty-close-discard`         — Don't save button.
 *   - `dirty-close-cancel`          — Cancel button.
 *   - `dirty-close-conflict`        — banner shown when `onSaveTab`
 *                                     reports `ok: false`.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  useEditorTabsStore,
  type EditorTab,
} from "./tab-store";

/** Outcome envelope the parent's save callback returns. */
export interface SaveResult {
  /** True when the file was written cleanly. */
  ok: boolean;
  /**
   * Optional human-readable message — surfaced in the dialog when
   * `ok === false`. Typically the conflict description from the
   * server's `fs_sha_conflict` envelope.
   */
  message?: string;
}

export interface DirtyCloseConfirmProps {
  /**
   * Save the dirty tab's buffer. Returns the success/failure envelope —
   * a falsy / ok=true result triggers `confirmClose("save")`; an
   * `ok: false` result keeps the dialog open with the message banner.
   *
   * Optional: when omitted, Save is treated as "user agrees the buffer
   * has been written elsewhere" and immediately closes the tab. This
   * keeps the component usable in tests / contexts that don't need to
   * run a real save mutation.
   */
  onSaveTab?: (tab: EditorTab) => Promise<SaveResult | void> | SaveResult | void;
}

export function DirtyCloseConfirm({ onSaveTab }: DirtyCloseConfirmProps) {
  const tabs = useEditorTabsStore((s) => s.tabs);
  const confirmClose = useEditorTabsStore((s) => s.confirmClose);

  // First-in-store-order — tabs is left-to-right, so closing many tabs
  // in a burst surfaces them in the order the user (or shortcut) issued
  // the close request. Resolving one pops it from the list and the next
  // pending tab takes over.
  const pendingTab = tabs.find((t) => t.pendingClose) ?? null;

  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!pendingTab) {
    // Nothing to confirm — render nothing so React doesn't keep a
    // mounted Radix portal around when the queue drains.
    return null;
  }

  const handleSave = async () => {
    setSaving(true);
    setConflict(null);
    try {
      const result = onSaveTab ? await onSaveTab(pendingTab) : undefined;
      if (result && result.ok === false) {
        setConflict(result.message ?? "Save failed — file changed on disk.");
        return;
      }
      confirmClose(pendingTab.id, "save");
    } catch (err) {
      setConflict(
        err instanceof Error ? err.message : "Save failed unexpectedly.",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDontSave = () => {
    confirmClose(pendingTab.id, "dont");
  };

  const handleCancel = () => {
    setConflict(null);
    confirmClose(pendingTab.id, "cancel");
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Radix dispatches `onOpenChange(false)` on Esc / overlay click.
        // We treat that as Cancel — the operator dismissed the dialog
        // without picking save/discard, so the tab stays open dirty.
        if (!open) handleCancel();
      }}
    >
      <DialogContent className="sm:max-w-sm" data-testid="dirty-close-confirm">
        <DialogHeader>
          <DialogTitle data-testid="dirty-close-confirm-title">
            Save changes to {pendingTab.path}?
          </DialogTitle>
          <DialogDescription>
            Your changes will be lost if you don&apos;t save them.
          </DialogDescription>
        </DialogHeader>
        {conflict ? (
          <div
            data-testid="dirty-close-conflict"
            className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {conflict}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            data-testid="dirty-close-cancel"
            onClick={handleCancel}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="ghost"
            data-testid="dirty-close-discard"
            onClick={handleDontSave}
            disabled={saving}
          >
            Don&apos;t save
          </Button>
          <Button
            type="button"
            data-testid="dirty-close-save"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default DirtyCloseConfirm;
