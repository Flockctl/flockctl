import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileX2, Loader2 } from "lucide-react";

import { CodeEditor } from "@/components/CodeEditor";
import { useGitShow } from "@/lib/hooks/git-show";
import {
  EMPTY_TREE_SHA,
  fetchGitDiff,
  type GitDiffResult,
} from "@/lib/api/git-show";
import { cn } from "@/lib/utils";
import {
  commitTabId,
  tabStore,
  type CommitTab,
} from "@/components/code-mode/tab-store";
import type { GitShowFile } from "@/lib/types";

/**
 * CommitDetailTab — read-only commit-detail pane backing the
 * `/projects/:id/git/commit/:sha` (and the matching `/workspaces/…`)
 * deep link.
 *
 * Layout:
 *
 *   ┌──────────────────┬────────────────────────────────────────────┐
 *   │  File list       │  CodeDiffEditor (Monaco DiffEditor)         │
 *   │  (left, ~280px)  │  - original = pre-commit blob               │
 *   │                  │  - modified = post-commit blob              │
 *   │                  │                                             │
 *   │  M  src/foo.ts   │                                             │
 *   │  A  src/bar.ts   │  Selected file is local state — clicking a │
 *   │  D  src/old.ts   │  row triggers a lazy `/git-diff` fetch.     │
 *   │  R  src/new.ts   │                                             │
 *   └──────────────────┴────────────────────────────────────────────┘
 *
 * Data flow:
 *   - On mount, `useGitShow` fires `GET /:scope/:id/git-show?sha=<sha>`
 *     and resolves with `{ commit, files }`. The commit metadata seeds
 *     the tab title (`<shortSha> <subject-truncated>`) by writing into
 *     the {@link tabStore}.
 *   - Selecting a file fires a per-file `useGitDiff` query keyed on
 *     `(scope, entityId, sha, path)`. The diff is fetched lazily — never
 *     pre-loaded — so a 1000-file commit only pays for the file the
 *     user is looking at.
 *   - `base = sha~1` for normal commits; `base = EMPTY_TREE_SHA` for the
 *     initial commit (commit.parents.length === 0). git's well-known
 *     empty-tree SHA exists for exactly this purpose.
 *
 * Test-id contract:
 *   - `commit-detail-tab`            — outer container.
 *   - `commit-detail-loading`        — spinner while git-show is in flight.
 *   - `commit-detail-error`          — failure copy when git-show errors.
 *   - `commit-detail-header`         — commit header (subject + sha + author).
 *   - `commit-detail-files`          — `<ul>` of file rows.
 *   - `commit-detail-file-<idx>`     — individual file row, indexed for
 *                                       virtualised lookup.
 *   - `commit-detail-file-empty`     — copy when files is `[]`.
 *   - `commit-detail-diff`           — wrapper around the Monaco diff editor.
 *   - `commit-detail-diff-loading`   — spinner while a per-file diff loads.
 *   - `commit-detail-diff-error`     — failure copy for a per-file diff.
 *   - `commit-detail-empty`          — placeholder when no file is selected.
 */
export interface CommitDetailTabProps {
  scope: "projects" | "workspaces";
  entityId: string;
  sha: string;
}

export function CommitDetailTab({
  scope,
  entityId,
  sha,
}: CommitDetailTabProps) {
  const showQuery = useGitShow(scope, entityId, sha);
  const commit = showQuery.data?.commit ?? null;
  const files: readonly GitShowFile[] = useMemo(
    () => showQuery.data?.files ?? [],
    [showQuery.data?.files],
  );

  // Diff base: `sha~1` for the common case, empty-tree SHA for the
  // initial commit (no parent). `useMemo` because the value is read
  // by both the per-file query key and the React-Query enabled gate;
  // recomputing on every render would invalidate the cache.
  const base = useMemo(() => {
    if (!commit) return null;
    return commit.parents.length === 0 ? EMPTY_TREE_SHA : `${sha}~1`;
  }, [commit, sha]);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // Auto-select the first file once the file list lands so the user
  // sees a diff immediately rather than an empty pane. Only fires
  // when the user hasn't manually picked yet.
  useEffect(() => {
    if (selectedPath === null && files.length > 0) {
      setSelectedPath(files[0]!.path);
    }
  }, [files, selectedPath]);

  // Register / upgrade the tab's title in the global tab store. The
  // tab is opened in a placeholder state on first mount (title=null)
  // and the title is patched in once `commit` resolves. This lets a
  // future tab-bar render the placeholder while git-show is in flight
  // without blocking on it.
  useEffect(() => {
    const id = commitTabId(scope, entityId, sha);
    const placeholder: CommitTab = {
      kind: "commit",
      id,
      scope,
      entityId,
      sha,
      title: null,
    };
    tabStore.openTab(placeholder);
  }, [scope, entityId, sha]);

  useEffect(() => {
    if (!commit) return;
    const id = commitTabId(scope, entityId, sha);
    tabStore.update(id, { title: makeTabTitle(commit.sha, commit.message) });
  }, [scope, entityId, sha, commit]);

  if (showQuery.isLoading) {
    return (
      <div
        data-testid="commit-detail-loading"
        className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading commit {sha.slice(0, 7)}…
      </div>
    );
  }

  if (showQuery.error) {
    const reason = (showQuery.error as Error & { reason?: string }).reason;
    return (
      <div
        data-testid="commit-detail-error"
        data-reason={reason ?? "unknown"}
        className="flex h-full items-center justify-center px-4 text-center text-sm text-destructive"
      >
        Could not load commit {sha.slice(0, 7)}: {showQuery.error.message}
      </div>
    );
  }

  if (!commit) return null;

  return (
    <div
      data-testid="commit-detail-tab"
      data-sha={commit.sha}
      className="flex h-full w-full flex-col"
    >
      <header
        data-testid="commit-detail-header"
        className="border-b px-4 py-3"
      >
        <div className="text-sm font-medium leading-tight">
          {commit.message || "(no subject)"}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          <span data-testid="commit-detail-sha" className="font-mono">
            {commit.sha.slice(0, 7)}
          </span>
          {" · "}
          <span>{commit.author}</span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <FileList
          files={files}
          selectedPath={selectedPath}
          onSelect={setSelectedPath}
        />

        <main className="min-w-0 flex-1">
          {selectedPath === null ? (
            <div
              data-testid="commit-detail-empty"
              className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground"
            >
              Select a file from the list to view its diff.
            </div>
          ) : (
            <DiffPane
              scope={scope}
              entityId={entityId}
              sha={sha}
              base={base}
              path={selectedPath}
            />
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * Tab-title helper. Format: `"<shortSha> <subject>"`, with the subject
 * truncated to 60 chars (to match the tab-bar's typical width budget).
 * Exported for unit tests so the format invariant is pinned alongside
 * the consumer.
 */
export function makeTabTitle(sha: string, subject: string): string {
  const short = sha.slice(0, 7);
  const trimmed = subject.length > 60 ? `${subject.slice(0, 57)}…` : subject;
  return `${short} ${trimmed}`.trim();
}

interface FileListProps {
  files: readonly GitShowFile[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

/**
 * Left-side file list. Marked virtualised in the spec — we render a
 * simple unordered list for now and rely on browser-native scrolling;
 * a virtualisation pass (react-virtuoso / @tanstack/react-virtual)
 * lands in a follow-up if commit-detail tabs ever start showing
 * 10k-file changesets. Keeping the API surface (`files` + `selectedPath`
 * + `onSelect`) means the swap will not ripple into consumers.
 */
function FileList({ files, selectedPath, onSelect }: FileListProps) {
  if (files.length === 0) {
    return (
      <aside
        data-testid="commit-detail-files"
        className="flex w-[280px] shrink-0 flex-col overflow-auto border-r"
      >
        <div
          data-testid="commit-detail-file-empty"
          className="px-3 py-4 text-xs text-muted-foreground"
        >
          No files changed in this commit.
        </div>
      </aside>
    );
  }

  return (
    <aside
      data-testid="commit-detail-files"
      className="flex w-[280px] shrink-0 flex-col overflow-auto border-r"
    >
      <ul className="flex flex-col py-1">
        {files.map((f, idx) => {
          const isActive = f.path === selectedPath;
          return (
            <li key={f.path}>
              <button
                type="button"
                data-testid={`commit-detail-file-${idx}`}
                data-path={f.path}
                data-status={f.status}
                data-active={isActive ? "true" : "false"}
                onClick={() => onSelect(f.path)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-accent",
                  isActive && "bg-accent text-accent-foreground",
                )}
              >
                <span
                  className="inline-block w-4 shrink-0 text-center font-mono text-[10px] uppercase text-muted-foreground"
                  title={statusLabel(f.status)}
                >
                  {f.status}
                </span>
                <span className="min-w-0 flex-1 truncate" title={f.path}>
                  {f.path}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  +{f.added} −{f.removed}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function statusLabel(s: GitShowFile["status"]): string {
  switch (s) {
    case "M":
      return "Modified";
    case "A":
      return "Added";
    case "D":
      return "Deleted";
    case "R":
      return "Renamed";
    case "C":
      return "Copied";
    case "T":
      return "Type changed";
    case "U":
      return "Unmerged";
    /* v8 ignore next 2 — exhaustive switch keeps types tight. */
    default:
      return s;
  }
}

interface DiffPaneProps {
  scope: "projects" | "workspaces";
  entityId: string;
  sha: string;
  /** `<sha>~1` for normal commits; `EMPTY_TREE_SHA` for the initial commit. */
  base: string | null;
  path: string;
}

function DiffPane({ scope, entityId, sha, base, path }: DiffPaneProps) {
  const diffQuery = useQuery<GitDiffResult, Error>({
    queryKey: [scope, entityId, "git-diff", sha, base, path],
    queryFn: () => fetchGitDiff(scope, entityId, { path, base: base!, head: sha }),
    enabled: !!base && !!path,
    staleTime: Infinity,
  });

  if (diffQuery.isLoading) {
    return (
      <div
        data-testid="commit-detail-diff-loading"
        className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading diff for {path}…
      </div>
    );
  }

  if (diffQuery.error) {
    return (
      <div
        data-testid="commit-detail-diff-error"
        className="flex h-full items-center justify-center gap-2 px-4 text-center text-sm text-destructive"
      >
        <FileX2 className="h-4 w-4" aria-hidden />
        Could not load diff: {diffQuery.error.message}
      </div>
    );
  }

  if (!diffQuery.data || diffQuery.data.ok !== true) {
    const reason =
      diffQuery.data && diffQuery.data.ok === false
        ? diffQuery.data.reason
        : "unknown";
    return (
      <div
        data-testid="commit-detail-diff-error"
        data-reason={reason}
        className="flex h-full items-center justify-center px-4 text-center text-sm text-destructive"
      >
        Diff unavailable ({reason}).
      </div>
    );
  }

  const patch = diffQuery.data.patch;

  return (
    <div
      data-testid="commit-detail-diff"
      data-path={path}
      className="h-full w-full"
    >
      <CodeEditor
        value={patch}
        path={`${path}.patch`}
        language="diff"
        height="100%"
      />
    </div>
  );
}

export default CommitDetailTab;
