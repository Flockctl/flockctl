import { useState } from "react";
import {
  ChevronDown,
  GitBranch,
  GitCommitVertical,
  GitPullRequestArrow,
  Loader2,
  Upload,
} from "lucide-react";

import {
  useGitPullProject,
  useGitPullWorkspace,
} from "@/lib/hooks";
import type { GitPullReason, GitPullResult } from "@/lib/types";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GitCommitDialog } from "./git-commit-dialog";
import { GitPushDialog } from "./git-push-dialog";

/**
 * The entity the Git dropdown is operating on. The same component is
 * mounted from project-detail and workspace-detail; the only thing that
 * differs is which `git-*` REST surface the menu items should fan
 * mutations into. Encoding that as a tagged union (rather than
 * `projectId | workspaceId | …`) keeps every dispatch site exhaustive
 * — adding a new target kind in the future tickles every `switch`
 * over `target.kind` instead of silently picking the project branch
 * when both ids happen to be set.
 *
 * - `kind`  — discriminator. Today: `'project'` or `'workspace'`.
 * - `id`    — the entity id used to scope mutations against the daemon.
 * - `path`  — on-disk path of the entity. When falsy the dropdown is
 *             disabled — there is no clone to operate on. The trigger
 *             tooltip differs between project / workspace so the
 *             operator gets a kind-specific recovery hint instead of a
 *             generic "no path" line.
 */
export type GitTarget =
  | { kind: "project"; id: string; path: string | null | undefined }
  | { kind: "workspace"; id: string; path: string | null | undefined };

/**
 * Header-level "Git" dropdown for the project- and workspace-detail
 * pages.
 *
 * Replaces the standalone Pull button with a single entry point that
 * opens a menu of git operations: **Pull** (fire-and-forget against the
 * target's local clone), **Commit…**, and **Push…**. Commit and Push
 * open dedicated dialogs that own their own stage-selection state — the
 * dropdown only orchestrates which dialog is open. Pull keeps its
 * existing inline flow: clicking the menu item kicks off the mutation
 * immediately and surfaces the outcome through {@link GitPullResultDialog}.
 *
 * The dropdown dispatches on `target.kind` to pick the right hook trio
 * (project vs. workspace) and forwards `target` into both Commit and
 * Push dialogs so each dialog can call the right mutation without
 * duplicating the project/workspace branching at every callsite.
 *
 * The trigger surface deliberately mirrors a small chrome button (outline
 * variant + size sm) so it slots into either page's header alongside the
 * other action buttons (Chat, TODO, …) without a visual rebrand.
 *
 * Test-id contract:
 * - `project-detail-page-git-button` — the dropdown trigger. **Stable** —
 *   the test-id is reused on the workspace surface so existing E2E
 *   selectors targeting it via the project page keep working when the
 *   shared component is mounted on either page.
 * - `project-detail-page-git-pull` — the Pull menu item. **Stable** —
 *   existing E2E specs target this id and the dropdown deliberately
 *   preserves it across the standalone-button → dropdown migration and
 *   across the project → project+workspace mount expansion.
 * - `project-detail-page-git-commit` — Commit menu item.
 * - `project-detail-page-git-push` — Push menu item.
 *
 * Disabled state: when `target.path` is null/empty the entity has no
 * on-disk clone, so every git item is meaningless. We disable the
 * trigger itself rather than each item individually so the user gets a
 * single "no local path" tooltip instead of three.
 */
export interface GitDropdownButtonProps {
  /** The entity (project or workspace) the menu items should act on. */
  target: GitTarget;
}

export function GitDropdownButton({ target }: GitDropdownButtonProps) {
  // ─── Pull ─────────────────────────────────────────────────────────────────
  // The mutation always resolves with HTTP 200 (failures are encoded in
  // the body's `ok` field — see `useGitPullProject` / `useGitPullWorkspace`).
  // Both hooks are called unconditionally — they don't fire until we
  // call `mutate()`, so it's safe to wire both and dispatch on `kind`
  // at click time. We surface the outcome via {@link GitPullResultDialog}
  // below; on the rare network failure we synthesise a minimal failure
  // result so the user never hits a crashed page.
  const gitPullProject = useGitPullProject();
  const gitPullWorkspace = useGitPullWorkspace();
  const gitPull = target.kind === "project" ? gitPullProject : gitPullWorkspace;
  const [gitPullResult, setGitPullResult] = useState<GitPullResult | null>(null);
  const handlePull = () => {
    gitPull.mutate(target.id, {
      onSuccess: (result) => setGitPullResult(result),
      onError: (err) =>
        setGitPullResult({
          ok: false,
          reason: "unknown",
          message: err.message || "Failed to reach the daemon",
        }),
    });
  };

  // ─── Commit / Push ────────────────────────────────────────────────────────
  // Open-state lives here because the dropdown is the orchestrator;
  // stage selection itself happens inside each dialog. Both dialogs
  // accept the same `target` we received and dispatch internally on
  // `target.kind` to pick the right mutation hook — keeping the
  // project/workspace branching inside the dialogs (where the hooks
  // live) instead of duplicating it at every dropdown mount.
  const [commitOpen, setCommitOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);

  const hasPath = !!target.path;
  const triggerTitle = hasPath
    ? "Git operations: pull, commit, push"
    : target.kind === "workspace"
      ? "This workspace has no git repository attached."
      : "Project has no local path";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasPath}
            title={triggerTitle}
            data-testid="project-detail-page-git-button"
          >
            {gitPull.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <GitBranch className="mr-1 h-4 w-4" />
            )}
            Git
            <ChevronDown className="ml-1 h-3 w-3 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem
            onSelect={(event) => {
              // Radix closes on select by default; we want the same
              // behaviour. Calling the mutation here is fire-and-forget
              // — the result dialog opens once the response lands.
              event.preventDefault();
              handlePull();
            }}
            disabled={gitPull.isPending}
            data-testid="project-detail-page-git-pull"
          >
            {gitPull.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <GitPullRequestArrow className="mr-1 h-4 w-4" />
            )}
            {gitPull.isPending ? "Pulling…" : "Pull"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              setCommitOpen(true);
            }}
            data-testid="project-detail-page-git-commit"
          >
            <GitCommitVertical className="mr-1 h-4 w-4" />
            Commit…
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              setPushOpen(true);
            }}
            data-testid="project-detail-page-git-push"
          >
            <Upload className="mr-1 h-4 w-4" />
            Push…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <GitPullResultDialog
        result={gitPullResult}
        onClose={() => setGitPullResult(null)}
      />

      {/*
        Mount the commit dialog lazily — it pulls react-query hooks
        (`useGitStatusProject` / `useGitStatusWorkspace` for the
        porcelain peek, `useGitCommitProject` / `useGitCommitWorkspace`
        for the mutation) and we don't want every detail-page render
        path to require a QueryClientProvider for a dialog that's only
        mounted on demand. Rendering only when `commitOpen` is true
        keeps the dropdown surface cheap.
      */}
      {commitOpen && (
        <GitCommitDialog
          open={commitOpen}
          onOpenChange={setCommitOpen}
          target={target}
        />
      )}
      {pushOpen && (
        <GitPushDialog
          open={pushOpen}
          onOpenChange={setPushOpen}
          target={target}
          // GitInfo is sourced lazily inside the dialog wrapper for now —
          // the production push surface keeps the same `gitInfo: null`
          // loading-placeholder contract it inherited from the project-only
          // path. Threading a real branch/upstream peek is a separate
          // change; the dropdown's job here is only to mount the dialog.
          gitInfo={null}
        />
      )}
    </>
  );
}

// ─── GitPullResultDialog ────────────────────────────────────────────────────
//
// Single dialog shared between the success and failure paths so the
// user always lands on the same interaction shape regardless of
// outcome. Copy is intentionally short; the value-add is the structured
// summary line + the raw `stderr` block on failure (kept in a
// monospaced <pre> so an operator can copy/paste it into a terminal
// without losing whitespace).

function GitPullResultDialog({
  result,
  onClose,
}: {
  result: GitPullResult | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={result !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg" data-testid="git-pull-result-dialog">
        {result?.ok ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {result.already_up_to_date
                  ? "Already up to date"
                  : "Pull complete"}
              </DialogTitle>
              <DialogDescription>
                Branch <span className="font-mono">{result.branch}</span> ·{" "}
                {result.summary}
              </DialogDescription>
            </DialogHeader>
            {!result.already_up_to_date && (
              <div className="text-xs text-muted-foreground">
                <span className="font-mono">{result.before_sha.slice(0, 7)}</span>{" "}
                →{" "}
                <span className="font-mono">{result.after_sha.slice(0, 7)}</span>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : result ? (
          <>
            <DialogHeader>
              <DialogTitle>Pull failed</DialogTitle>
              <DialogDescription>
                {gitPullReasonHeadline(result.reason)}
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm">{result.message}</p>
            {result.stderr && (
              <pre
                className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs font-mono whitespace-pre-wrap"
                data-testid="git-pull-stderr"
              >
                {result.stderr}
              </pre>
            )}
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function gitPullReasonHeadline(reason: GitPullReason): string {
  switch (reason) {
    case "not_a_git_repo":
      return "Project is not a git repository.";
    case "no_upstream":
      return "Current branch has no upstream.";
    case "dirty_working_tree":
      return "Working tree has uncommitted changes.";
    case "non_fast_forward":
      return "Local and remote have diverged — fast-forward not possible.";
    case "auth_failed":
      return "Authentication with the remote failed.";
    case "network_error":
      return "Could not reach the remote.";
    /* v8 ignore next 2 — unreachable; the union above is exhaustive over GitPullReason */
    case "unknown":
    default:
      return "git pull failed.";
  }
}
