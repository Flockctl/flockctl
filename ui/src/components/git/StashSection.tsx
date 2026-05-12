import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, Layers, Loader2, MoreVertical } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useGitStashListProject,
  useGitStashListWorkspace,
  useGitStashPopProject,
  useGitStashPopWorkspace,
  useGitStashDropProject,
  useGitStashDropWorkspace,
} from "@/lib/hooks";
import type {
  GitStashEntry,
  GitStashPopResult,
  GitStashDropResult,
} from "@/lib/api/git-stash";
import { relativeFromEpochSeconds } from "./HistoryList";
import type { GitTarget } from "./git-dropdown-button";

/**
 * Collapsible "Stashes" section inside the Source Control panel,
 * mounted between the Changes/Staged groups and the History list.
 *
 * Layout:
 *   - Header: chevron + "Stashes" + count. Click toggles the body
 *     open/closed; persisted in `localStorage` per-target like
 *     {@link HistoryList}.
 *   - Body: one row per `stash@{N}` entry from the server. Each row
 *     shows `stash@{N} · message · branch · time` plus a per-row
 *     dropdown menu with Pop / Drop / View Diff. View Diff routes to
 *     the same commit-detail tab (slice 01) by walking on the stash
 *     entry's tip SHA.
 *
 * Test-id contract:
 *   - `scm-stash-toggle`              — disclosure trigger.
 *   - `scm-stash`                     — body container (open).
 *   - `scm-stash-loading`             — first-page spinner.
 *   - `scm-stash-error`               — inline error banner (failure path).
 *   - `scm-stash-empty`               — "No stash entries." copy.
 *   - `scm-stash-list`                — `<ul>` of rows.
 *   - `scm-stash-row-{ref}`           — `<li>` root for one entry.
 *   - `scm-stash-ref-{ref}`           — ref / index span.
 *   - `scm-stash-message-{ref}`       — message span.
 *   - `scm-stash-branch-{ref}`        — branch span (parsed from message).
 *   - `scm-stash-time-{ref}`          — relative-time span.
 *   - `scm-stash-menu-{ref}`          — per-row dropdown trigger.
 *   - `scm-stash-pop-{ref}`           — Pop menu item.
 *   - `scm-stash-drop-{ref}`          — Drop menu item.
 *   - `scm-stash-view-diff-{ref}`     — View Diff menu item.
 */
export interface StashSectionProps {
  target: GitTarget;
  /**
   * Surface info / error toasts through the parent so they land in the
   * SCM panel's toast region.
   */
  onToast?: (kind: "info" | "error", message: string) => void;
  /**
   * Optional override for the navigate handler. Production code lets
   * the component navigate via `react-router-dom`; tests can pass a
   * stub to assert on the routing call without mounting a router.
   */
  onViewDiff?: (sha: string) => void;
}

const STASH_STORAGE_KEY_PREFIX = "flockctl.scm.stash.open.";

function stashStorageKey(target: GitTarget): string {
  return `${STASH_STORAGE_KEY_PREFIX}${target.kind}.${target.id}`;
}

function readPersistedOpen(target: GitTarget): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(stashStorageKey(target)) === "1";
  } catch {
    return false;
  }
}

function writePersistedOpen(target: GitTarget, open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(stashStorageKey(target), open ? "1" : "0");
  } catch {
    /* private-browsing / quota-exceeded — fail silently */
  }
}

export function StashSection({ target, onToast, onViewDiff }: StashSectionProps) {
  const [open, setOpen] = useState<boolean>(() => readPersistedOpen(target));
  const navigate = useNavigate();

  useEffect(() => {
    writePersistedOpen(target, open);
  }, [target, open]);

  const scope = target.kind === "project" ? "projects" : "workspaces";

  // Both hook pairs are called unconditionally so the hook call order is
  // stable across the project / workspace target dispatch (rules-of-hooks).
  // The inactive pair sits idle (`enabled: false`) so it never fires.
  const projectQuery = useGitStashListProject(
    target.kind === "project" ? target.id : "",
    { enabled: open && target.kind === "project" },
  );
  const workspaceQuery = useGitStashListWorkspace(
    target.kind === "workspace" ? target.id : "",
    { enabled: open && target.kind === "workspace" },
  );
  const query = target.kind === "project" ? projectQuery : workspaceQuery;

  const projectPop = useGitStashPopProject();
  const workspacePop = useGitStashPopWorkspace();
  const popMut = target.kind === "project" ? projectPop : workspacePop;

  const projectDrop = useGitStashDropProject();
  const workspaceDrop = useGitStashDropWorkspace();
  const dropMut = target.kind === "project" ? projectDrop : workspaceDrop;

  const stashes = useMemo<GitStashEntry[]>(() => {
    if (!query.data || !query.data.ok) return [];
    return query.data.stashes;
  }, [query.data]);

  // Single timestamp reading for every row — keeps relative labels
  // consistent across the list (same trick HistoryList uses).
  const now = useMemo(() => {
    if (query.dataUpdatedAt > 0) return query.dataUpdatedAt;
    // eslint-disable-next-line react-hooks/purity -- bootstrap-only fallback; never visible.
    return Date.now();
  }, [query.dataUpdatedAt]);

  const handlePop = useCallback(
    (ref: string) => {
      const callbacks = {
        onSuccess: (result: GitStashPopResult) => {
          if (result.ok) {
            onToast?.("info", `Popped ${ref}.`);
            return;
          }
          onToast?.("error", popErrorCopy(result.reason, result.message));
        },
        onError: (err: Error) => {
          onToast?.("error", err.message || "Stash pop failed.");
        },
      };
      if (target.kind === "project") {
        projectPop.mutate(
          { projectId: target.id, body: { ref } },
          callbacks,
        );
      } else {
        workspacePop.mutate(
          { workspaceId: target.id, body: { ref } },
          callbacks,
        );
      }
    },
    [target, projectPop, workspacePop, onToast],
  );

  const handleDrop = useCallback(
    (ref: string) => {
      const callbacks = {
        onSuccess: (result: GitStashDropResult) => {
          if (result.ok) {
            onToast?.("info", `Dropped ${ref}.`);
            return;
          }
          onToast?.("error", dropErrorCopy(result.reason, result.message));
        },
        onError: (err: Error) => {
          onToast?.("error", err.message || "Stash drop failed.");
        },
      };
      if (target.kind === "project") {
        projectDrop.mutate({ projectId: target.id, ref }, callbacks);
      } else {
        workspaceDrop.mutate({ workspaceId: target.id, ref }, callbacks);
      }
    },
    [target, projectDrop, workspaceDrop, onToast],
  );

  const handleViewDiff = useCallback(
    (sha: string) => {
      if (onViewDiff) {
        onViewDiff(sha);
        return;
      }
      // Mirror HistoryList — open the commit-detail tab via deep-link.
      navigate(`/${scope}/${target.id}/git/commit/${sha}`);
    },
    [navigate, onViewDiff, scope, target.id],
  );

  const reason =
    query.error && (query.error as Error & { reason?: string }).reason;

  return (
    <div className="border-t">
      <button
        type="button"
        data-testid="scm-stash-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-accent/40"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" aria-hidden />
        ) : (
          <ChevronRight className="h-3 w-3" aria-hidden />
        )}
        <Layers className="h-3.5 w-3.5" aria-hidden />
        <span>Stashes</span>
        {open && stashes.length > 0 && (
          <span
            className="text-muted-foreground/80"
            data-testid="scm-stash-count"
          >
            ({stashes.length})
          </span>
        )}
      </button>
      {open && (
        <div data-testid="scm-stash" className="flex max-h-[40vh] flex-col">
          {query.isLoading && (
            <div
              data-testid="scm-stash-loading"
              className="flex items-center justify-center py-6 text-muted-foreground"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}

          {query.isError && !query.isLoading && (
            <p
              data-testid="scm-stash-error"
              role="alert"
              className="px-3 py-3 text-xs text-destructive"
            >
              {stashListErrorCopy(reason ?? null)}
            </p>
          )}

          {!query.isLoading && !query.isError && (
            <>
              {stashes.length === 0 ? (
                <p
                  data-testid="scm-stash-empty"
                  className="px-3 py-6 text-center text-xs text-muted-foreground"
                >
                  No stash entries.
                </p>
              ) : (
                <ul
                  data-testid="scm-stash-list"
                  className="overflow-y-auto"
                >
                  {stashes.map((entry) => (
                    <StashRow
                      key={entry.ref}
                      entry={entry}
                      relativeTime={relativeFromIso(entry.date, now)}
                      isoTime={entry.date}
                      onPop={handlePop}
                      onDrop={handleDrop}
                      onViewDiff={handleViewDiff}
                      busy={popMut.isPending || dropMut.isPending}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────────

interface StashRowProps {
  entry: GitStashEntry;
  relativeTime: string;
  isoTime: string;
  onPop: (ref: string) => void;
  onDrop: (ref: string) => void;
  onViewDiff: (sha: string) => void;
  /** Disable the menu items while a sibling pop / drop is in flight. */
  busy: boolean;
}

function StashRow({
  entry,
  relativeTime,
  isoTime,
  onPop,
  onDrop,
  onViewDiff,
  busy,
}: StashRowProps) {
  // git's auto-message format: `WIP on <branch>: <sha> <subject>` /
  // `On <branch>: <subject>`. We tease the branch out cheaply for the
  // dedicated badge column; the full message stays on the message span.
  const { branch, subject } = useMemo(() => parseStashMessage(entry.message), [entry.message]);

  return (
    <li
      data-testid={`scm-stash-row-${entry.ref}`}
      className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/40"
    >
      <span
        data-testid={`scm-stash-ref-${entry.ref}`}
        className="shrink-0 font-mono text-[11px] text-muted-foreground"
        title={entry.hash}
      >
        {entry.ref}
      </span>
      <span
        data-testid={`scm-stash-message-${entry.ref}`}
        className="flex-1 truncate"
        title={entry.message}
      >
        {subject}
      </span>
      {branch && (
        <span
          data-testid={`scm-stash-branch-${entry.ref}`}
          className="shrink-0 truncate rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground max-w-[100px]"
          title={branch}
        >
          {branch}
        </span>
      )}
      <span
        data-testid={`scm-stash-time-${entry.ref}`}
        className="shrink-0 text-[11px] text-muted-foreground"
        title={isoTime}
      >
        {relativeTime}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            data-testid={`scm-stash-menu-${entry.ref}`}
            variant="ghost"
            size="sm"
            className="h-5 w-5 p-0"
            aria-label={`Actions for ${entry.ref}`}
            disabled={busy}
          >
            <MoreVertical className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            data-testid={`scm-stash-pop-${entry.ref}`}
            onSelect={() => onPop(entry.ref)}
          >
            Pop
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid={`scm-stash-drop-${entry.ref}`}
            onSelect={() => onDrop(entry.ref)}
            className="text-destructive focus:text-destructive"
          >
            Drop
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid={`scm-stash-view-diff-${entry.ref}`}
            onSelect={() => onViewDiff(entry.hash)}
          >
            View Diff
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Parse git's auto-message into `{ branch, subject }` for richer row
 * display. Falls back to `{ branch: null, subject: <raw> }` when the
 * message is operator-supplied (`-m`) and doesn't match git's pattern.
 *
 * Handles the two canonical forms emitted by `git stash`:
 *   - `WIP on <branch>: <sha> <subject>`
 *   - `On <branch>: <subject>`
 */
function parseStashMessage(message: string): {
  branch: string | null;
  subject: string;
} {
  const wipMatch = /^WIP on ([^:]+): [0-9a-f]+ (.+)$/i.exec(message);
  if (wipMatch) {
    return { branch: wipMatch[1] ?? null, subject: wipMatch[2] ?? message };
  }
  const onMatch = /^On ([^:]+): (.+)$/.exec(message);
  if (onMatch) {
    return { branch: onMatch[1] ?? null, subject: onMatch[2] ?? message };
  }
  return { branch: null, subject: message };
}

/**
 * Format an ISO-8601 date string as a coarse "Xs/m/h/d ago" label.
 * Wrapper over {@link relativeFromEpochSeconds} that takes ISO input
 * (the format `git stash list --format=%cI` emits).
 */
function relativeFromIso(iso: string, now: number): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "—";
  return relativeFromEpochSeconds(Math.floor(ts / 1000), now);
}

function stashListErrorCopy(reason: string | null): string {
  switch (reason) {
    case "not_a_repo":
      return "Not a git repository.";
    case "path_missing":
      return "Path no longer exists on disk.";
    case "timeout":
      return "Loading stashes timed out.";
    default:
      return "Could not load stashes.";
  }
}

function popErrorCopy(
  reason: string | undefined,
  message: string | undefined,
): string {
  switch (reason) {
    case "git_stash_pop_conflict":
      return "Stash applied with conflicts — resolve them, then drop the stash manually.";
    case "not_found":
      return "Stash entry not found.";
    case "invalid_ref":
      return "Invalid stash reference.";
    case "not_a_repo":
      return "Not a git repository.";
    case "path_missing":
      return "Repository path no longer exists on disk.";
    case "timeout":
      return "git stash pop timed out.";
    default:
      return message ?? "Stash pop failed.";
  }
}

function dropErrorCopy(
  reason: string | undefined,
  message: string | undefined,
): string {
  switch (reason) {
    case "not_found":
      return "Stash entry not found.";
    case "invalid_ref":
      return "Invalid stash reference.";
    case "not_a_repo":
      return "Not a git repository.";
    case "path_missing":
      return "Repository path no longer exists on disk.";
    case "timeout":
      return "git stash drop timed out.";
    default:
      return message ?? "Stash drop failed.";
  }
}
