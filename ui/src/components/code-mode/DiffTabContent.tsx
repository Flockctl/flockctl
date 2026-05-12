/**
 * DiffTabContent — read-only Monaco DiffEditor pane for one project /
 * workspace-relative path. Mounted by the Code-mode shell whenever the
 * active tab's `kind` is `'diff'`.
 *
 * Wire shape:
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ <header data-testid="diff-tab-header">                  │
 *   │   <relative-path>      <mode badge>                     │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ <CodeEditor diff={{ original }} value={modified} />      │
 *   │   (read-only Monaco DiffEditor — Save is a no-op)        │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Data flow:
 *   - `useGitDiff` fetches the patch + both side buffers via the
 *     `?contents=true` opt-in. The hook returns the discriminated
 *     `{ ok: true | false }` envelope; we render fallback copy on
 *     `ok: false` and a "too large" banner when either side comes back
 *     null because of the per-side cap.
 *   - The two buffers feed Monaco's DiffEditor directly. We do NOT
 *     re-fetch the working-tree side via `/fs/file` here — that would
 *     race the git-diff response (the patch is computed against a
 *     specific worktree snapshot; refetching the file separately could
 *     show a never-was-on-screen state if the user edited mid-fetch).
 *
 * Out of scope for v1 (matching the task brief):
 *   - Editing the modified side. The editor is read-only by construction.
 *   - Hunk-level discard. Per-file discard ships in the SCM panel.
 *   - "Switch sides" / "View as unified". The DiffEditor's own toolbar
 *     covers these.
 */
import { useMemo } from "react";
import { Loader2, X } from "lucide-react";

import { CodeEditor } from "@/components/CodeEditor";
import { useGitDiff } from "@/lib/hooks";
import { tabStore, type DiffTab } from "./tab-store";

export interface DiffTabContentProps {
  tab: DiffTab;
}

export function DiffTabContent({ tab }: DiffTabContentProps) {
  const mode = useMemo(
    () => ({
      ...(tab.staged === true ? { staged: true } : {}),
      ...(tab.base !== undefined ? { base: tab.base } : {}),
      ...(tab.head !== undefined ? { head: tab.head } : {}),
    }),
    [tab.staged, tab.base, tab.head],
  );
  const query = useGitDiff(tab.scope, tab.entityId, tab.path, mode);

  // Loading / fetch-error branches FIRST. `useGitDiff` does NOT throw on
  // structured failure (`ok: false`) — we surface those inline below.
  if (query.isLoading) {
    return (
      <div
        data-testid="diff-tab-loading"
        className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading diff for {tab.path}…
      </div>
    );
  }

  if (query.error) {
    return (
      <div
        data-testid="diff-tab-error"
        className="flex h-full items-center justify-center px-4 text-center text-sm text-destructive"
      >
        Failed to load diff for {tab.path}: {query.error.message}
      </div>
    );
  }

  const data = query.data;
  if (!data) {
    // Shouldn't be reachable given the `enabled: !!entityId && !!path`
    // gating in `useGitDiff`, but TS strictness wants the branch.
    /* v8 ignore next 5 */
    return (
      <div data-testid="diff-tab-empty" className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No diff data available.
      </div>
    );
  }

  if (!data.ok) {
    return (
      <div
        data-testid="diff-tab-failure"
        data-reason={data.reason}
        className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground"
      >
        <p>{diffFailureCopy(data.reason)}</p>
        {data.message && (
          <p className="font-mono text-xs text-muted-foreground/80">
            {data.message}
          </p>
        )}
      </div>
    );
  }

  // ok: true — but the side buffers may be null (binary, oversize, or
  // a one-sided A/D path that we encoded as `""`). Render fallback copy
  // for the truly-null cases; A/D collapses cleanly to an empty side.
  const original = data.original_content;
  const modified = data.modified_content;

  if (data.status === "binary") {
    return (
      <div
        data-testid="diff-tab-binary"
        className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground"
      >
        Binary diff — cannot render in editor. Use{" "}
        <span className="ml-1 font-mono">git diff -- {tab.path}</span> to
        inspect on the command line.
      </div>
    );
  }

  if (original === null || modified === null) {
    return (
      <div
        data-testid="diff-tab-too-large"
        className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground"
      >
        <p>One or both sides exceed the 2.5 MiB per-side cap.</p>
        <p className="font-mono text-xs">
          git diff {tab.staged ? "--cached " : ""}-- {tab.path}
        </p>
      </div>
    );
  }

  if (data.status === "unchanged") {
    return (
      <div
        data-testid="diff-tab-unchanged"
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        No changes to display for {tab.path}.
      </div>
    );
  }

  return (
    <div
      data-testid="diff-tab-content"
      data-open-path={tab.path}
      data-mode={
        tab.staged ? "staged" : tab.base && tab.head ? "ref" : "working"
      }
      className="flex h-full w-full flex-col"
    >
      <header
        data-testid="diff-tab-header"
        className="flex items-center justify-between gap-2 border-b px-3 py-1.5"
      >
        <span className="truncate font-mono text-xs" title={tab.path}>
          {tab.path}
        </span>
        <span className="shrink-0 rounded bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
          {modeBadge(tab)}
        </span>
        <button
          type="button"
          data-testid="diff-tab-close"
          aria-label={`Close diff for ${tab.path}`}
          title="Close diff"
          onClick={() => tabStore.closeTab(tab.id)}
          className="ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </header>
      <div className="min-h-0 flex-1">
        <CodeEditor
          diff={{ original }}
          value={modified}
          path={tab.path}
          height="100%"
          // No onChange — the editor is read-only by construction.
        />
      </div>
    </div>
  );
}

/**
 * Operator-friendly fallback for an `ok:false` diff response. Reuses
 * the same vocabulary the SCM panel uses for `git-status` failures so
 * an operator sees consistent copy across the surface.
 */
function diffFailureCopy(reason: string | undefined): string {
  switch (reason) {
    case "not_a_repo":
      return "Not a git repository.";
    case "path_missing":
      return "Repository path no longer exists on disk.";
    case "bad_revision":
      return "Diff request was rejected — invalid path or ref.";
    case "git_patch_too_large":
      return "Diff exceeds the 5 MiB cap. Open in a terminal for the full output.";
    case "timeout":
      return "git diff timed out.";
    default:
      return "Could not load diff.";
  }
}

function modeBadge(tab: DiffTab): string {
  if (tab.staged === true) return "staged";
  if (tab.base !== undefined && tab.head !== undefined) {
    // Truncate ref labels to keep the badge thin — full SHA / branch
    // is in the tab id and on hover via the surrounding title.
    const fmt = (s: string) =>
      s.length > 12 ? `${s.slice(0, 7)}…` : s;
    return `${fmt(tab.base)}…${fmt(tab.head)}`;
  }
  return "working";
}

export default DiffTabContent;
