import { useEffect, useMemo, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useGitCheckoutProject,
  useGitCheckoutWorkspace,
} from "@/lib/hooks";
import { BRANCH_NAME_RE } from "@/lib/api/git-branches";
import type { GitTarget } from "./git-dropdown-button";

/**
 * CreateBranchDialog — modal that runs `git checkout -b <name>` against
 * the entity's clone, optionally pinned to a startPoint other than the
 * current branch.
 *
 * Layout:
 *   - Name input + branch-name-regex validation. Submit is disabled
 *     until the input is non-empty AND matches the public regex pinned
 *     in `BRANCH_NAME_RE` (mirror of the server's `BRANCH_NAME` zod
 *     schema). Pre-validating client-side avoids a 422 round-trip and
 *     surfaces the same hint the server would emit.
 *   - "from <currentBranch>" hint — purely informational; we always
 *     branch off the current HEAD. A per-row "branch from this commit"
 *     flow would belong in the History list, not here.
 *
 * Failure surface:
 *   - `branch_already_exists` / `invalid_branch_name` / `dirty_working_tree`
 *     → toast routed through the parent's onToast (so it lands in the
 *     SCM panel's toast region, consistent with checkout failures).
 *
 * Test-id contract:
 *   - `branch-create-dialog`        — dialog content.
 *   - `branch-create-name`          — name input.
 *   - `branch-create-from`          — "from <branch>" caption.
 *   - `branch-create-error`         — inline validation error.
 *   - `branch-create-submit`        — Create button.
 *   - `branch-create-cancel`        — Cancel button.
 */
export interface CreateBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: GitTarget;
  /** The branch HEAD points at, displayed as the start point hint. */
  currentBranch: string | null;
  onToast?: (kind: "info" | "error", message: string) => void;
}

export function CreateBranchDialog({
  open,
  onOpenChange,
  target,
  currentBranch,
  onToast,
}: CreateBranchDialogProps) {
  const [name, setName] = useState("");
  const projectCheckout = useGitCheckoutProject();
  const workspaceCheckout = useGitCheckoutWorkspace();
  const checkout = target.kind === "project" ? projectCheckout : workspaceCheckout;

  // Reset the input every time the dialog re-opens — leaving the previous
  // attempt in place would surprise the operator on the second pass.
  useEffect(() => {
    if (open) setName("");
  }, [open]);

  const trimmed = name.trim();
  const validity = useMemo(() => validateBranchName(trimmed), [trimmed]);
  const canSubmit = validity.ok && !checkout.isPending;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const onSettled = (
      result:
        | { ok: boolean; reason?: string; message?: string; branch?: string }
        | undefined,
      err: Error | null,
    ) => {
      if (err) {
        onToast?.("error", err.message || "Create branch failed.");
        return;
      }
      if (!result) return;
      if (result.ok) {
        onToast?.("info", `Created branch ${trimmed}.`);
        onOpenChange(false);
        return;
      }
      onToast?.("error", createErrorCopy(result, trimmed));
    };

    if (target.kind === "project") {
      projectCheckout.mutate(
        { projectId: target.id, body: { branch: trimmed, create: true } },
        {
          onSuccess: (data) => onSettled(data, null),
          onError: (err) => onSettled(undefined, err),
        },
      );
    } else {
      workspaceCheckout.mutate(
        { workspaceId: target.id, body: { branch: trimmed, create: true } },
        {
          onSuccess: (data) => onSettled(data, null),
          onError: (err) => onSettled(undefined, err),
        },
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" data-testid="branch-create-dialog">
        <DialogHeader>
          <DialogTitle>Create branch</DialogTitle>
          <DialogDescription>
            Create a new branch from the current HEAD and check it out.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            data-testid="branch-create-name"
            autoFocus
            placeholder="feature/my-branch"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            aria-invalid={trimmed.length > 0 && !validity.ok}
            aria-describedby="branch-create-help"
          />
          <p
            id="branch-create-help"
            data-testid="branch-create-from"
            className="text-xs text-muted-foreground"
          >
            from{" "}
            <code className="rounded bg-muted px-1 py-0.5">
              {currentBranch ?? "HEAD"}
            </code>
          </p>
          {trimmed.length > 0 && !validity.ok && (
            <p
              data-testid="branch-create-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {validity.message}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            data-testid="branch-create-cancel"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            data-testid="branch-create-submit"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {checkout.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function validateBranchName(
  name: string,
): { ok: true } | { ok: false; message: string } {
  if (name.length === 0) return { ok: false, message: "Branch name is required." };
  if (name.length > 255)
    return { ok: false, message: "Branch name is too long (max 255)." };
  if (!BRANCH_NAME_RE.test(name)) {
    return {
      ok: false,
      message:
        "Allowed characters: letters, digits, '-', '.', '/', '_', and Cyrillic.",
    };
  }
  return { ok: true };
}

function createErrorCopy(
  result: { reason?: string; message?: string },
  branch: string,
): string {
  switch (result.reason) {
    case "branch_already_exists":
      return `Branch '${branch}' already exists.`;
    case "invalid_branch_name":
      return result.message ?? "Invalid branch name.";
    case "dirty_working_tree":
      return (
        result.message ??
        "Working tree has uncommitted changes. Commit, stash, or discard them first."
      );
    case "not_a_repo":
      return "Not a git repository.";
    case "path_missing":
      return "Project path is missing on disk.";
    case "timeout":
      return "Create branch timed out.";
    default:
      return result.message ?? "Create branch failed.";
  }
}
