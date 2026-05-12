import { useRef, useState } from "react";
import { Loader2, Upload, AlertTriangle } from "lucide-react";

import { useGitPushProject, useGitPushWorkspace } from "@/lib/hooks";
import type { GitPushReason, GitPushResult } from "@/lib/types";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Pre-flight summary of the local clone, fed into the push dialog by the
 * parent. Sourced from `GET /projects/:id/git-info` (a small endpoint
 * piggybacking on the same git-operations service module — see the
 * task brief). The shape mirrors the three things the dialog actually
 * needs to render:
 *
 * - `branch`        — the current branch name to display in the summary row.
 * - `remote`        — the remote we'd push to (typically `origin`).
 * - `hasUpstream`   — whether `branch` already has an `@{u}` upstream;
 *                     when `false` the "Set upstream" toggle is enabled
 *                     and pre-checked, otherwise it's disabled with a
 *                     hint that the upstream is already configured.
 *
 * Passing `gitInfo: null` puts the dialog in a "loading" presentation so
 * the parent can defer rendering until the query resolves.
 */
export interface GitInfo {
  branch: string;
  remote: string;
  hasUpstream: boolean;
}

export interface GitPushDialogProps {
  /**
   * Which entity this dialog is pushing for. The dispatch on
   * `target.kind` picks between the project- and workspace-scoped push
   * hook; the rest of the dialog (summary, advanced disclosure, force
   * gate) is target-agnostic.
   */
  target: GitTarget;
  /** Controlled open state. */
  open: boolean;
  /** Controlled open-state setter; called with `false` on Cancel / Close / outside-click. */
  onOpenChange: (open: boolean) => void;
  /**
   * Pre-fetched local-clone summary. `null` → still loading (the dialog
   * renders a placeholder summary line and disables both push buttons).
   */
  gitInfo: GitInfo | null;
}

/**
 * "Push…" dialog from the project-detail Git dropdown.
 *
 * Shape (collapsed-by-default):
 * 1. **Summary row** — "Push branch `<branch>` to `<remote>`" using
 *    values from {@link GitInfo}.
 * 2. **Push** + Cancel buttons. Push fires the standard, safe push
 *    (no force, no setUpstream unless toggled on in Advanced).
 * 3. **Advanced** disclosure (collapsed by default), containing:
 *    - "Set upstream" toggle. Enabled iff `gitInfo.hasUpstream === false`
 *      (no point setting an upstream that already exists). Pre-checked
 *      when enabled, since the most common reason to expand Advanced
 *      from a no-upstream state is exactly to flip this on.
 *    - **Force push** danger zone with red border. Body warns about
 *      history rewrite. Below: an `<input>` labelled
 *      "Type 'force' to enable" + a "Force push" button. The button
 *      is disabled until the input value is exactly the literal string
 *      `"force"` (case-sensitive), and on click it re-reads the LIVE
 *      input value via a ref BEFORE submitting — so a stale state
 *      snapshot can never bypass the gate.
 *
 * State machine:
 *   idle → loading → (success | error)
 * Errors render inline (replacing the action area) keyed on
 * {@link GitPushReason}; the headline copy is operator-friendly and the
 * `auth_failed` branch has a dedicated card with a docs link, since
 * credential setup is the most common recovery path.
 *
 * Visual baselines (Playwright screenshot tests):
 *   - `push-dialog-default`              — collapsed, idle
 *   - `push-dialog-advanced-expanded`    — collapsed=false, force input empty
 *   - `push-dialog-auth-failed-state`    — error.reason === 'auth_failed'
 */
export function GitPushDialog({
  target,
  open,
  onOpenChange,
  gitInfo,
}: GitPushDialogProps) {
  // ─── Mutation ─────────────────────────────────────────────────────────────
  // Both hooks called unconditionally so React's rules-of-hooks hold;
  // dispatch on `target.kind` picks the active mutation handle. The
  // inactive hook never has `mutate` called, so it just sits idle.
  const gitPushProject = useGitPushProject();
  const gitPushWorkspace = useGitPushWorkspace();
  const gitPush = target.kind === "project" ? gitPushProject : gitPushWorkspace;
  const [result, setResult] = useState<GitPushResult | null>(null);

  // ─── Advanced disclosure state ────────────────────────────────────────────
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // "Set upstream" defaults to true when the branch has no upstream
  // (the only state where the toggle is enabled). We initialise on
  // first render of an enabled toggle; users can flip it off if they
  // really want to push without setting `@{u}`.
  const setUpstreamEnabled = gitInfo?.hasUpstream === false;
  const [setUpstream, setSetUpstream] = useState<boolean>(false);
  // Mirror the input value in state to drive the disabled state of
  // the force button reactively. The CLICK handler additionally
  // re-reads the LIVE input via the ref so a stale state snapshot
  // (e.g. uncontrolled DOM mutation) cannot bypass the gate.
  const [forceLiteral, setForceLiteral] = useState("");
  const forceInputRef = useRef<HTMLInputElement>(null);

  const FORCE_LITERAL = "force";
  const isForceArmed = forceLiteral === FORCE_LITERAL;

  const isLoading = gitPush.isPending;
  const hasError = result !== null && !result.ok;
  const errorReason: GitPushReason | null = hasError ? result.reason : null;

  // ─── Submit handlers ──────────────────────────────────────────────────────
  // Both handlers funnel through the same mutation; the only difference
  // is the `force` flag and the live-input gate on the force path.
  const submit = (force: boolean) => {
    if (!gitInfo) return; // safety: should never fire — buttons disabled
    setResult(null);
    const body = {
      remote: gitInfo.remote,
      set_upstream: setUpstreamEnabled ? setUpstream : false,
      force,
    };
    const callbacks = {
      onSuccess: (r: GitPushResult) => setResult(r),
      onError: (err: Error) =>
        setResult({
          ok: false,
          reason: "unknown" as const,
          message: err.message || "Failed to reach the daemon",
        }),
    };
    if (target.kind === "project") {
      gitPushProject.mutate({ projectId: target.id, body }, callbacks);
    } else {
      gitPushWorkspace.mutate({ workspaceId: target.id, body }, callbacks);
    }
  };

  const handlePush = () => submit(false);

  const handleForcePush = () => {
    // SECURITY: read the LIVE current value of the force input on click,
    // never a stale state snapshot. A clipboard-paste-then-clear race
    // could in principle leave the React state lagging behind the DOM;
    // we guarantee the literal match against the actual input element.
    const live = forceInputRef.current?.value ?? "";
    if (live !== FORCE_LITERAL) return;
    submit(true);
  };

  // Reset transient state whenever the dialog closes so a re-open
  // starts clean (no stale error card, no still-armed force input).
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setResult(null);
      setAdvancedOpen(false);
      setForceLiteral("");
      setSetUpstream(false);
    }
    onOpenChange(next);
  };

  // Close the dialog automatically on a successful push — there's
  // nothing actionable left, and leaving it open just stacks confusion.
  if (result?.ok && open) {
    // Fire-and-forget; React batches the state updates.
    setTimeout(() => handleOpenChange(false), 0);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-lg"
        data-testid="git-push-dialog"
      >
        <DialogHeader>
          <DialogTitle>Push</DialogTitle>
          <DialogDescription>
            {gitInfo ? (
              <>
                Push branch{" "}
                <span className="font-mono" data-testid="git-push-dialog-branch">
                  {gitInfo.branch}
                </span>{" "}
                to{" "}
                <span className="font-mono" data-testid="git-push-dialog-remote">
                  {gitInfo.remote}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">Loading branch info…</span>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* ─── Inline error card ─────────────────────────────────────── */}
        {hasError && errorReason === "auth_failed" && (
          <div
            className="rounded border border-destructive/50 bg-destructive/5 p-3 text-sm"
            data-testid="git-push-dialog-auth-hint"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
              <div>
                <p className="font-medium">Authentication failed.</p>
                <p className="text-muted-foreground">
                  Configure your git credentials and retry.{" "}
                  <a
                    href="https://docs.flockctl.dev/git-auth"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                    data-testid="git-push-dialog-auth-docs-link"
                  >
                    Learn more
                  </a>
                </p>
              </div>
            </div>
          </div>
        )}

        {hasError && errorReason !== "auth_failed" && (
          <div
            className="rounded border border-destructive/50 bg-destructive/5 p-3 text-sm"
            data-testid="git-push-dialog-error"
          >
            <p className="font-medium">{gitPushReasonHeadline(errorReason!)}</p>
            {result && !result.ok && result.message && (
              <p className="mt-1 text-muted-foreground">{result.message}</p>
            )}
          </div>
        )}

        {/* ─── Advanced disclosure ───────────────────────────────────── */}
        <details
          open={advancedOpen}
          onToggle={(e) =>
            setAdvancedOpen((e.target as HTMLDetailsElement).open)
          }
          className="rounded border border-border"
          data-testid="git-push-dialog-advanced"
        >
          <summary
            className="cursor-pointer px-3 py-2 text-sm font-medium select-none"
            data-testid="git-push-dialog-advanced-toggle"
          >
            Advanced
          </summary>

          <div className="space-y-3 px-3 pb-3 pt-1">
            {/* Set upstream */}
            <div className="flex items-start gap-2">
              <Checkbox
                id="git-push-set-upstream"
                checked={setUpstream}
                onCheckedChange={(v) => setSetUpstream(v === true)}
                disabled={!setUpstreamEnabled}
                data-testid="git-push-dialog-set-upstream"
              />
              <div className="text-sm">
                <Label htmlFor="git-push-set-upstream">Set upstream</Label>
                <p className="text-xs text-muted-foreground">
                  {setUpstreamEnabled
                    ? "Configure this branch's @{u} during push (-u)."
                    : "This branch already has an upstream — nothing to set."}
                </p>
              </div>
            </div>

            {/* Force push danger zone */}
            <div
              className="rounded border-2 border-destructive/60 bg-destructive/5 p-3"
              data-testid="git-push-dialog-force-zone"
            >
              <p className="text-sm font-medium text-destructive">
                Force push
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Force push rewrites the remote branch&apos;s history. This is
                dangerous.
              </p>
              <div className="mt-3 space-y-2">
                <Label
                  htmlFor="git-push-force-literal"
                  className="text-xs"
                >
                  Type &apos;force&apos; to enable
                </Label>
                <Input
                  id="git-push-force-literal"
                  ref={forceInputRef}
                  value={forceLiteral}
                  onChange={(e) => setForceLiteral(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="git-push-dialog-force-input"
                />
                <Button
                  variant="destructive"
                  size="sm"
                  type="button"
                  disabled={!isForceArmed || isLoading || !gitInfo}
                  onClick={handleForcePush}
                  data-testid="git-push-dialog-force-submit"
                >
                  {isLoading ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="mr-1 h-4 w-4" />
                  )}
                  Force push
                </Button>
              </div>
            </div>
          </div>
        </details>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => handleOpenChange(false)}
            disabled={isLoading}
            data-testid="git-push-dialog-cancel"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            type="button"
            onClick={handlePush}
            disabled={isLoading || !gitInfo}
            data-testid="git-push-dialog-submit"
          >
            {isLoading ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-1 h-4 w-4" />
            )}
            Push
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Operator-friendly headline for each non-auth `GitPushReason`. The
 * `auth_failed` branch is rendered separately above (with a docs link)
 * because credential setup is the dominant recovery path.
 */
function gitPushReasonHeadline(reason: GitPushReason): string {
  switch (reason) {
    case "protected_branch":
      return "Refusing to force-push `main`/`master`. Force push to protected branches is disabled.";
    case "rejected_non_fast_forward":
      return "Remote has new commits. Pull first, or use force push from the Advanced section if you understand the consequences.";
    case "no_upstream":
      return "Branch has no upstream. Enable 'Set upstream' in Advanced and retry.";
    case "detached_head":
      return "HEAD is detached — there is no branch to push.";
    case "timeout":
      return "git push timed out.";
    case "not_a_repo":
      return "Project is not a git repository.";
    case "path_missing":
      return "Project path no longer exists on disk.";
    case "auth_failed":
      // Handled by the dedicated auth-hint card; included here to keep
      // the switch exhaustive on the union.
      return "Authentication failed. Configure your git credentials and retry.";
    /* v8 ignore next 4 — `ok` is excluded by the caller; `unknown` is the fallback. */
    case "ok":
    case "unknown":
    default:
      return "git push failed.";
  }
}
