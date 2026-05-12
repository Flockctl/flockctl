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
import {
  useGitBranchDeleteProject,
  useGitBranchDeleteWorkspace,
} from "@/lib/hooks";
import { PROTECTED_BRANCHES } from "@/lib/api/git-branches";
import type { GitTarget } from "./git-dropdown-button";

/**
 * DeleteBranchDialog — modal that runs `git branch -d` (or `-D` with
 * `force`) against the entity's clone.
 *
 * Layout:
 *   - Title + branch name + body warning the operator that this is
 *     irreversible (the audit log keeps the record but the ref does not
 *     stick around).
 *   - "Force delete" checkbox — REQUIRED when the branch is `main` or
 *     `master` (server refuses without `force=true`); recommended when
 *     the branch has unmerged commits (server returns
 *     `not_fully_merged` and we re-render with the force prompt). The
 *     checkbox label changes copy depending on whether the branch is
 *     protected or simply unmerged.
 *   - Audit-log notice: every delete writes a `branch_delete` row to
 *     `git_audit_log` with `{branch, force}`. We surface the existence
 *     of that record so the operator never thinks deletes are silent.
 *
 * Test-id contract:
 *   - `branch-delete-dialog`         — dialog content.
 *   - `branch-delete-name`           — branch-name span.
 *   - `branch-delete-force-checkbox` — force checkbox.
 *   - `branch-delete-protected-hint` — hint visible only on protected branches.
 *   - `branch-delete-audit-hint`     — audit-log notice.
 *   - `branch-delete-submit`         — Delete button.
 *   - `branch-delete-cancel`         — Cancel button.
 */
export interface DeleteBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: GitTarget;
  /** Branch to delete. `null` keeps the dialog closed. */
  branch: string | null;
  /** Branch HEAD points at. We refuse to delete the current branch. */
  currentBranch: string | null;
  onToast?: (kind: "info" | "error", message: string) => void;
}

export function DeleteBranchDialog({
  open,
  onOpenChange,
  target,
  branch,
  currentBranch,
  onToast,
}: DeleteBranchDialogProps) {
  const [force, setForce] = useState(false);
  const projectDelete = useGitBranchDeleteProject();
  const workspaceDelete = useGitBranchDeleteWorkspace();
  const del = target.kind === "project" ? projectDelete : workspaceDelete;

  // Reset force on every re-open so a previous force-tick doesn't ride
  // along into the next attempt.
  useEffect(() => {
    if (open) setForce(false);
  }, [open, branch]);

  if (!branch) return null;

  const isProtected = PROTECTED_BRANCHES.includes(branch);
  const isCurrent = currentBranch === branch;
  // Protected branches require the force tick. We don't disable the
  // submit otherwise — git itself decides between `not_fully_merged`
  // and a clean delete; if the operator hits that path we surface the
  // server's reason as a toast and they can re-tick force on the next
  // pass.
  const canSubmit = !isCurrent && !del.isPending && (!isProtected || force);

  const handleSubmit = () => {
    if (!canSubmit) return;
    const onSettled = (
      result:
        | { ok: boolean; reason?: string; message?: string; branch?: string }
        | undefined,
      err: Error | null,
    ) => {
      if (err) {
        onToast?.("error", err.message || "Delete branch failed.");
        return;
      }
      if (!result) return;
      if (result.ok) {
        onToast?.("info", `Deleted branch ${branch}.`);
        onOpenChange(false);
        return;
      }
      onToast?.("error", deleteErrorCopy(result, branch));
    };

    if (target.kind === "project") {
      projectDelete.mutate(
        { projectId: target.id, branch, body: { force } },
        {
          onSuccess: (data) => onSettled(data, null),
          onError: (err) => onSettled(undefined, err),
        },
      );
    } else {
      workspaceDelete.mutate(
        { workspaceId: target.id, branch, body: { force } },
        {
          onSuccess: (data) => onSettled(data, null),
          onError: (err) => onSettled(undefined, err),
        },
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" data-testid="branch-delete-dialog">
        <DialogHeader>
          <DialogTitle>Delete branch</DialogTitle>
          <DialogDescription>
            Delete the local branch{" "}
            <code data-testid="branch-delete-name" className="rounded bg-muted px-1 py-0.5">
              {branch}
            </code>
            ?
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {isCurrent && (
            <p role="alert" className="text-destructive">
              You can't delete the branch you're currently on. Switch to
              another branch first.
            </p>
          )}
          {isProtected && (
            <p
              data-testid="branch-delete-protected-hint"
              className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
            >
              <strong>{branch}</strong> is a protected branch. Tick the
              force checkbox below to confirm.
            </p>
          )}
          <label className="flex items-start gap-2 text-xs">
            <Checkbox
              data-testid="branch-delete-force-checkbox"
              checked={force}
              onCheckedChange={(v) => setForce(v === true)}
              aria-label="Force delete"
            />
            <span>
              Force delete (
              <code className="rounded bg-muted px-1">git branch -D</code>) —
              required for protected branches (<code>main</code> /{" "}
              <code>master</code>) and for branches whose commits are not
              fully merged into HEAD.
            </span>
          </label>
          <p
            data-testid="branch-delete-audit-hint"
            className="text-xs text-muted-foreground"
          >
            This is recorded in the git audit log (<code>branch_delete</code>).
            The ref is gone from the local clone but the history of the
            action stays.
          </p>
        </div>
        <DialogFooter>
          <Button
            data-testid="branch-delete-cancel"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            data-testid="branch-delete-submit"
            variant="destructive"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {del.isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function deleteErrorCopy(
  result: { reason?: string; message?: string },
  branch: string,
): string {
  switch (result.reason) {
    case "git_protected_branch":
      return (
        result.message ??
        `Refusing to delete protected branch '${branch}'. Tick "Force delete" to override.`
      );
    case "git_cannot_delete_current_branch":
      return `Cannot delete '${branch}' — it is the current branch. Switch first.`;
    case "branch_not_found":
      return `Branch '${branch}' does not exist.`;
    case "not_fully_merged":
      return `Branch '${branch}' has commits not merged into HEAD. Tick "Force delete" to drop them anyway.`;
    case "invalid_branch_name":
      return result.message ?? "Invalid branch name.";
    case "not_a_repo":
      return "Not a git repository.";
    case "path_missing":
      return "Project path is missing on disk.";
    case "timeout":
      return "Delete branch timed out.";
    default:
      return result.message ?? "Delete branch failed.";
  }
}
