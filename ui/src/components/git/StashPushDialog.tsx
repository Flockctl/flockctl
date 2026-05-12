import { useEffect, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  useGitStashPushProject,
  useGitStashPushWorkspace,
} from "@/lib/hooks";
import type { GitStashPushResult } from "@/lib/api/git-stash";
import type { GitTarget } from "./git-dropdown-button";

/**
 * StashPushDialog — modal for `git stash push [-u] [-m <message>]`.
 *
 * Layout:
 *   - Optional message input. ≤ 4096 bytes server-side; we soft-cap at
 *     the same value so an over-long message fails fast in the UI.
 *   - "Include untracked files" checkbox (`-u`). Off by default — the
 *     bare `git stash push` is the dominant case and untracked includes
 *     surprise users (deleted-untracked rounds-trips break their muscle
 *     memory).
 *   - Submit fires `useGitStashPushProject` / `useGitStashPushWorkspace`.
 *     A `nothing_to_stash` no-op is reported as an info toast (the
 *     panel's toast region) — not an error — and closes the dialog.
 *
 * Test-id contract:
 *   - `stash-push-dialog`              — dialog content.
 *   - `stash-push-message`             — message input.
 *   - `stash-push-include-untracked`   — `-u` checkbox.
 *   - `stash-push-submit`              — Submit button.
 *   - `stash-push-cancel`              — Cancel button.
 *   - `stash-push-error`               — inline error region (failure path).
 */
export interface StashPushDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: GitTarget;
  /**
   * Surface info / error toasts through the parent so they land in the
   * SCM panel's toast region (consistent with checkout / fetch / discard
   * flows).
   */
  onToast?: (kind: "info" | "error", message: string) => void;
}

export function StashPushDialog({
  open,
  onOpenChange,
  target,
  onToast,
}: StashPushDialogProps) {
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const projectStash = useGitStashPushProject();
  const workspaceStash = useGitStashPushWorkspace();
  const stash = target.kind === "project" ? projectStash : workspaceStash;

  // Reset every time the dialog re-opens — leaving stale state in place
  // would surprise the operator on the next pass.
  useEffect(() => {
    if (open) {
      setMessage("");
      setIncludeUntracked(false);
      setErrorMessage(null);
    }
  }, [open]);

  const trimmed = message.trim();
  const canSubmit =
    !stash.isPending && (trimmed === "" || trimmed.length <= 4096);

  const handleSubmit = () => {
    if (!canSubmit) return;
    setErrorMessage(null);
    const body = {
      ...(trimmed !== "" ? { message: trimmed } : {}),
      ...(includeUntracked ? { includeUntracked: true } : {}),
    };
    const callbacks = {
      onSuccess: (result: GitStashPushResult) => {
        if (result.ok) {
          if (result.nothing_to_stash) {
            onToast?.("info", "Nothing to stash — working tree is clean.");
          } else {
            onToast?.("info", "Stashed working tree changes.");
          }
          onOpenChange(false);
          return;
        }
        const copy = stashPushErrorCopy(result.reason, result.message);
        setErrorMessage(copy);
        onToast?.("error", copy);
      },
      onError: (err: Error) => {
        const copy = err.message || "Stash push failed.";
        setErrorMessage(copy);
        onToast?.("error", copy);
      },
    };

    if (target.kind === "project") {
      projectStash.mutate({ projectId: target.id, body }, callbacks);
    } else {
      workspaceStash.mutate({ workspaceId: target.id, body }, callbacks);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" data-testid="stash-push-dialog">
        <DialogHeader>
          <DialogTitle>Stash changes</DialogTitle>
          <DialogDescription>
            Snapshot the working tree onto the stash stack. Your changes are
            saved and the working tree resets to HEAD.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            data-testid="stash-push-message"
            autoFocus
            placeholder="Optional stash message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            maxLength={4096}
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              data-testid="stash-push-include-untracked"
              checked={includeUntracked}
              onCheckedChange={(v) => setIncludeUntracked(v === true)}
            />
            <span>Include untracked files</span>
          </label>
          {errorMessage && (
            <p
              data-testid="stash-push-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {errorMessage}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            data-testid="stash-push-cancel"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={stash.isPending}
          >
            Cancel
          </Button>
          <Button
            data-testid="stash-push-submit"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {stash.isPending ? "Stashing…" : "Stash"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function stashPushErrorCopy(
  reason: string | undefined,
  message: string | undefined,
): string {
  switch (reason) {
    case "nothing_to_stash":
      return "Nothing to stash — working tree is clean.";
    case "not_a_repo":
      return "Not a git repository.";
    case "path_missing":
      return "Repository path no longer exists on disk.";
    case "timeout":
      return "git stash timed out.";
    default:
      return message ?? "Stash push failed.";
  }
}
