import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  useGitCommitProject,
  useGitCommitWorkspace,
  useGitStatusProject,
  useGitStatusWorkspace,
} from "@/lib/hooks";
import type {
  GitCommitFailure,
  GitCommitResult,
  GitStatusEntry,
} from "@/lib/types";
import type { GitTarget } from "./git-dropdown-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * GitCommitDialog — stage-selection + message editor + submit.
 *
 * Wired in three states:
 *   1. **Loading** — porcelain query in flight. Renders a single spinner
 *      centred in the body so the dialog frame is stable.
 *   2. **Form** (default) — checkbox list of dirty paths + message
 *      textarea + Commit / Cancel. Submit button is enabled iff message
 *      is non-empty AND ≥ 1 path is selected. Empty working tree
 *      collapses the body to a "nothing to commit" notice with the
 *      Commit button forced disabled.
 *   3. **Success** — "Committed {sha7} ({n} files)" with a single Close
 *      button. The body of the dialog is replaced wholesale (no fade
 *      cross-over) so the operator can't accidentally hit Commit twice.
 *
 * Failure paths surface as inline error text BELOW the textarea, never
 * a separate modal: the user is mid-edit, so the recovery copy lives
 * inline where they're already looking. Reasons surfaced:
 *   - `empty_index`   → working tree changed externally; refresh.
 *   - `detached_head` → terminal-grade fix, not button-grade.
 *   - `unknown_path`  → selected paths vanished; we refetch status.
 *   - `auth_failed`   → impossible for commit (local-only) — guarded
 *                       at the type level by exhaustive switch below.
 *
 * Test-id contract:
 *   - `git-commit-dialog`        — DialogContent root.
 *   - `git-commit-status-list`   — scroll container holding the rows.
 *   - `git-commit-row-{path}`    — one row per dirty path.
 *   - `git-commit-message`       — Textarea.
 *   - `git-commit-submit`        — Commit button.
 *   - `git-commit-cancel`        — Cancel button.
 *   - `git-commit-error`         — inline error region (failure only).
 *   - `git-commit-success`       — replaces body on `ok:true`.
 *   - `git-commit-close`         — Close button on success state.
 *   - `git-commit-empty`         — empty-tree notice.
 */
export interface GitCommitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Which entity this dialog is committing against. The dispatch on
   * `target.kind` picks between the project- and workspace-scoped
   * status + commit hooks; the rest of the form is target-agnostic.
   */
  target: GitTarget;
}

export function GitCommitDialog({
  open,
  onOpenChange,
  target,
}: GitCommitDialogProps) {
  // ─── Server data ───────────────────────────────────────────────────────
  // Status only when the dialog is open — closed dialogs shouldn't fire a
  // peek every time the user opens / closes the dropdown that owns us.
  // We call BOTH hook pairs unconditionally and dispatch on `target.kind`
  // for the active handle. React's rules-of-hooks require the call order
  // to be stable across renders, and since `target.kind` is a prop the
  // parent doesn't flip mid-life, this is safe; the inactive pair sits
  // disabled (`enabled: false` on the inactive query) and idle (the
  // inactive mutation never has `mutate` called).
  const projectStatus = useGitStatusProject(target.kind === "project" ? target.id : "", {
    enabled: open && target.kind === "project",
    staleTime: 0,
  });
  const workspaceStatus = useGitStatusWorkspace(
    target.kind === "workspace" ? target.id : "",
    {
      enabled: open && target.kind === "workspace",
      staleTime: 0,
    },
  );
  const status = target.kind === "project" ? projectStatus : workspaceStatus;

  const projectCommit = useGitCommitProject();
  const workspaceCommit = useGitCommitWorkspace();

  // ─── Local form state ──────────────────────────────────────────────────
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [success, setSuccess] = useState<{
    sha: string;
    filesCommitted: number;
  } | null>(null);
  const [errorReason, setErrorReason] = useState<
    GitCommitFailure["reason"] | null
  >(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Reset every form field on open. A new commit session should always
  // start from a blank slate — residue from a prior cancel would
  // surprise the user.
  useEffect(() => {
    if (!open) return;
    setMessage("");
    setSelected(new Set());
    setSuccess(null);
    setErrorReason(null);
    setErrorMessage(null);
  }, [open]);

  // Pre-select every dirty path on first arrival of the porcelain list.
  // The "commit everything" workflow is the dominant case; opt-out via
  // unchecking is faster than opt-in via checking each row. We only do
  // this once per open, gated on `success === null` so the success
  // panel doesn't trigger a re-arm of the selection.
  const entries: GitStatusEntry[] = useMemo(() => {
    if (status.data?.ok) return status.data.entries;
    return [];
  }, [status.data]);

  useEffect(() => {
    if (!open || success) return;
    if (entries.length === 0) {
      setSelected(new Set());
      return;
    }
    setSelected((prev) => {
      // Only seed from the porcelain list when the local set is still
      // empty — once the user touches a checkbox, do not clobber.
      if (prev.size > 0) return prev;
      return new Set(entries.map((e) => e.path));
    });
  }, [open, entries, success]);

  // ─── Handlers ──────────────────────────────────────────────────────────
  const togglePath = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // Resolve the in-flight `isPending` flag from whichever mutation
  // matches `target.kind`. Form-disabled states (Submit, Cancel, the
  // textarea) all key off this single boolean so we never end up in a
  // mixed-state UI where the workspace mutation is firing but the
  // project pending flag is what we read.
  const commitIsPending =
    target.kind === "project" ? projectCommit.isPending : workspaceCommit.isPending;

  const canSubmit =
    !commitIsPending &&
    message.trim() !== "" &&
    selected.size > 0 &&
    entries.length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    setErrorReason(null);
    setErrorMessage(null);
    const paths = Array.from(selected);
    const body = { message: message.trim(), paths };
    const callbacks = {
      onSuccess: (result: GitCommitResult) => {
        if (result.ok) {
          setSuccess({
            sha: result.sha,
            filesCommitted: result.files_committed,
          });
          return;
        }
        setErrorReason(result.reason);
        setErrorMessage(result.message ?? null);
        // unknown_path is a "your view of the world is stale" failure
        // — refetch status so the next click works against fresh
        // porcelain rather than a phantom path set.
        if (result.reason === "unknown_path") {
          void status.refetch();
        }
      },
      onError: (err: Error) => {
        setErrorReason("unknown");
        setErrorMessage(err.message || "Commit failed.");
      },
    };
    if (target.kind === "project") {
      projectCommit.mutate({ projectId: target.id, body }, callbacks);
    } else {
      workspaceCommit.mutate({ workspaceId: target.id, body }, callbacks);
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="git-commit-dialog">
        {success ? (
          <CommitSuccessPanel
            sha={success.sha}
            filesCommitted={success.filesCommitted}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Commit</DialogTitle>
              <DialogDescription>
                Pick the paths to stage, write a message, and commit on
                the project's branch.
              </DialogDescription>
            </DialogHeader>

            {status.isLoading ? (
              <div
                className="flex items-center justify-center py-12"
                data-testid="git-commit-loading"
              >
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : entries.length === 0 ? (
              <p
                className="py-8 text-center text-sm text-muted-foreground"
                data-testid="git-commit-empty"
              >
                Working tree is clean — nothing to commit.
              </p>
            ) : (
              <div
                className="max-h-[240px] overflow-y-auto rounded border"
                data-testid="git-commit-status-list"
              >
                <ul className="divide-y">
                  {entries.map((entry) => {
                    const id = `git-commit-checkbox-${entry.path}`;
                    const checked = selected.has(entry.path);
                    return (
                      <li
                        key={entry.path}
                        className="flex items-center gap-2 px-3 py-1.5"
                        data-testid={`git-commit-row-${entry.path}`}
                      >
                        <Checkbox
                          id={id}
                          checked={checked}
                          onCheckedChange={() => togglePath(entry.path)}
                        />
                        <span
                          className="inline-flex h-5 min-w-[1.5rem] items-center justify-center rounded bg-muted px-1 text-xs font-mono"
                          data-testid={`git-commit-status-${entry.path}`}
                          aria-label={`Status: ${formatStatus(entry)}`}
                        >
                          {formatStatus(entry)}
                        </span>
                        <Label
                          htmlFor={id}
                          className="flex-1 cursor-pointer truncate font-mono text-xs"
                          title={entry.path}
                        >
                          {entry.path}
                        </Label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="git-commit-message">Commit message</Label>
              <Textarea
                id="git-commit-message"
                data-testid="git-commit-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Describe this commit"
                rows={3}
                autoFocus={entries.length > 0}
                disabled={commitIsPending || entries.length === 0}
              />
            </div>

            {errorReason && (
              <p
                className="text-sm text-destructive"
                role="alert"
                data-testid="git-commit-error"
              >
                {commitErrorCopy(errorReason, errorMessage)}
              </p>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
                disabled={commitIsPending}
                data-testid="git-commit-cancel"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={!canSubmit}
                data-testid="git-commit-submit"
              >
                {commitIsPending ? (
                  <>
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    Committing…
                  </>
                ) : (
                  "Commit"
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Success panel ──────────────────────────────────────────────────────────

function CommitSuccessPanel({
  sha,
  filesCommitted,
  onClose,
}: {
  sha: string;
  filesCommitted: number;
  onClose: () => void;
}) {
  return (
    <div data-testid="git-commit-success">
      <DialogHeader>
        <DialogTitle>Commit complete</DialogTitle>
        <DialogDescription>
          Committed{" "}
          <span className="font-mono" data-testid="git-commit-success-sha">
            {sha.slice(0, 7)}
          </span>{" "}
          ({filesCommitted} {filesCommitted === 1 ? "file" : "files"})
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button
          variant="outline"
          size="sm"
          onClick={onClose}
          data-testid="git-commit-close"
        >
          Close
        </Button>
      </DialogFooter>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Render the porcelain XY pair as a compact two-character badge. We
 * deliberately preserve git's own vocabulary (e.g. `??` for untracked,
 * `M ` for staged-modified, ` M` for unstaged-modified) so an operator
 * familiar with `git status --short` reads the dialog without
 * translation.
 */
function formatStatus(entry: GitStatusEntry): string {
  const i = entry.index || " ";
  const w = entry.worktree || " ";
  return `${i}${w}`.replace(/\s/g, " ");
}

function commitErrorCopy(
  reason: GitCommitFailure["reason"],
  message: string | null,
): string {
  switch (reason) {
    case "empty_index":
      return "Working tree was modified externally — nothing staged. Refresh and try again.";
    case "detached_head":
      return "HEAD is detached. Switch to a branch from the terminal first.";
    case "unknown_path":
      return "Some selected paths no longer exist. Refreshing…";
    case "empty_message":
      return "Commit message is empty.";
    case "not_a_repo":
      return "Project is not a git repository.";
    case "path_missing":
      return "Project path no longer exists on disk.";
    case "timeout":
      return "git commit timed out.";
    case "auth_failed":
      // `auth_failed` cannot happen for a local commit; surface the raw
      // server-supplied message so the operator sees exactly what came
      // back rather than a confidently-wrong canned line.
      return message ?? "Commit failed.";
    case "ok":
      // Dead branch — `ok` is the success path, not a failure copy.
      // Keep an exhaustive switch so a future GitCommitReason addition
      // tickles the type-checker rather than silently falling through.
      return "Commit failed.";
    case "unknown":
    default:
      return message ?? "Commit failed.";
  }
}
