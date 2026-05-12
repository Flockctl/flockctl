import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronRight,
  CloudDownload,
  Layers,
  Loader2,
  RefreshCw,
} from "lucide-react";

import {
  useGitStatusProject,
  useGitStatusWorkspace,
  useGitCommitProject,
  useGitCommitWorkspace,
  useGitDiscardProject,
  useGitDiscardWorkspace,
  useGitFetchProject,
  useGitFetchWorkspace,
} from "@/lib/hooks";
import type {
  GitCommitFailure,
  GitCommitResult,
  GitStatusEntry,
} from "@/lib/types";
import type { GitDiscardResult, GitFetchResult } from "@/lib/api/git";
import type { GitTarget } from "./git-dropdown-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { ChangedFileRow } from "./ChangedFileRow";
import { DiscardConfirm } from "./DiscardConfirm";
import { HistoryList } from "./HistoryList";
import { BranchPicker } from "./BranchPicker";
import { StashSection } from "./StashSection";
import { StashPushDialog } from "./StashPushDialog";
import { tabStore } from "@/components/code-mode/tab-store";

/**
 * SourceControlPanel — the VSCode-style SCM side panel mounted in Code mode.
 *
 * Layout (top → bottom):
 *   1. Header: branch + ahead/behind counts + refresh button.
 *   2. Inline commit composer: textarea + Commit button. The button is
 *      disabled until the message is non-empty AND ≥ 1 path is selected.
 *      On success the message clears and selection is rebuilt from the
 *      next porcelain peek.
 *   3. Changes group (unstaged / untracked): every entry whose `worktree`
 *      code is non-blank lands here.
 *   4. Staged Changes group: every entry whose `index` code is non-blank.
 *      An entry that lives in both buckets renders twice — that mirrors
 *      VSCode and matches `git status --short`.
 *   5. History (collapsed by default). M03 fills this with the last 10
 *      commits — for now it's a placeholder so the layout reserves the
 *      space.
 *
 * Out-of-scope here (per slice contract):
 *   - Stage/unstage as separate ops — v2.
 *   - History list rendering — M03.
 *   - Diff click — slice 02.
 *   - Branch picker UI — slice 01.
 *
 * Test-id contract:
 *   - `scm-panel`              — root container.
 *   - `scm-header`             — branch + ahead/behind row.
 *   - `scm-branch`             — branch name.
 *   - `scm-ahead`              — "↑N" pill.
 *   - `scm-behind`             — "↓N" pill.
 *   - `scm-refresh`            — manual-refetch button.
 *   - `scm-message`            — commit message Textarea.
 *   - `scm-commit-submit`      — Commit button.
 *   - `scm-commit-error`       — inline error region (failure only).
 *   - `scm-commit-success`     — inline success banner.
 *   - `scm-changes-header`     — Changes group label + count.
 *   - `scm-staged-header`      — Staged group label + count.
 *   - `scm-changes-list`       — Changes group ul.
 *   - `scm-staged-list`        — Staged group ul.
 *   - `scm-empty`              — clean working tree message.
 *   - `scm-history-toggle`     — history disclosure trigger.
 *   - `scm-history`            — history body (placeholder for M03).
 */
export interface SourceControlPanelProps {
  /** The entity (project or workspace) the panel acts on. */
  target: GitTarget;
  /**
   * Snapshot of "ahead/behind" counts. The current git status API does
   * not return these — the parent passes them in (e.g. from a separate
   * `useGitInfo*` query in slice 01). When omitted we render
   * `↑0 ↓0` as a neutral placeholder rather than blank space, so the
   * header shape is stable across loading transitions.
   */
  aheadBehind?: { ahead: number; behind: number } | null;
  /**
   * Threshold above which the changes/staged lists swap to a virtualised
   * row renderer. The plain DOM list is fine up to a few hundred rows;
   * virtualisation only earns its keep on monorepo-grade churn.
   * Defaults to 100; tests can lower this to validate the virtualiser
   * branch without seeding 101 rows.
   */
  virtualizeThreshold?: number;
}

export function SourceControlPanel({
  target,
  aheadBehind = null,
  virtualizeThreshold = 100,
}: SourceControlPanelProps) {
  // ─── Server data ─────────────────────────────────────────────────────────
  // We dispatch on `target.kind` for the active query handle. Both hook
  // pairs are called unconditionally — rules-of-hooks demands a stable
  // call order, and the inactive pair sits idle (`enabled: false`) so it
  // never fires a request.
  const projectStatus = useGitStatusProject(
    target.kind === "project" ? target.id : "",
    {
      enabled: target.kind === "project",
      staleTime: 0,
    },
  );
  const workspaceStatus = useGitStatusWorkspace(
    target.kind === "workspace" ? target.id : "",
    {
      enabled: target.kind === "workspace",
      staleTime: 0,
    },
  );
  const status = target.kind === "project" ? projectStatus : workspaceStatus;

  const projectCommit = useGitCommitProject();
  const workspaceCommit = useGitCommitWorkspace();
  const commit = target.kind === "project" ? projectCommit : workspaceCommit;

  // Discard / Fetch — both pairs are called unconditionally so the hook
  // call order stays stable; the inactive pair is harmless because no
  // mutation fires until the user clicks. Wiring the project / workspace
  // dispatch here keeps the JSX below uniform.
  const projectDiscard = useGitDiscardProject();
  const workspaceDiscard = useGitDiscardWorkspace();
  const discard = target.kind === "project" ? projectDiscard : workspaceDiscard;

  const projectFetch = useGitFetchProject();
  const workspaceFetch = useGitFetchWorkspace();
  const fetchMut = target.kind === "project" ? projectFetch : workspaceFetch;

  // ─── Local form state ────────────────────────────────────────────────────
  //
  // Commit message lives inside the memoised `CommitComposer` child so
  // each keystroke only re-renders that subtree — not the file list,
  // history pane, or branch dropdown above. Audit-round-3 finding.
  // The composer exposes an imperative ref so the parent can clear it
  // after a successful commit without lifting state.
  const composerRef = useRef<CommitComposerHandle | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Tracks whether the user has manually touched selection — once they
  // do, we never auto-seed again, even after a fresh porcelain peek.
  const [userTouchedSelection, setUserTouchedSelection] = useState(false);
  const [errorReason, setErrorReason] = useState<
    GitCommitFailure["reason"] | null
  >(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState<{
    sha: string;
    filesCommitted: number;
  } | null>(null);

  // ─── Stash dialog state ─────────────────────────────────────────────────
  // The Stash button in the header opens a small dialog (`StashPushDialog`)
  // for `git stash push [-u] [-m <message>]`. The list / pop / drop / view
  // actions live inside the {@link StashSection} below — only the push
  // surface is hoisted to the header so it can sit next to Fetch.
  const [stashPushOpen, setStashPushOpen] = useState(false);

  // ─── Discard dialog state ────────────────────────────────────────────────
  // The dialog is controlled here so the in-flight mutation state can
  // gate the confirm button. `pendingPath` is the path the operator
  // clicked on; `null` means the dialog is closed. We do not pre-detect
  // dirty-tab state — the editor / tab store isn't centralised yet, so
  // the warning is wired but currently always passes `false`. A future
  // slice that owns the tab store wires the predicate here.
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  // ─── Toasts ──────────────────────────────────────────────────────────────
  // Same minimal-toast pattern AgentsMdEditor uses — we stay off Sonner /
  // any external toast lib to keep the UI bundle narrow. `toastIdRef`
  // gives each toast a stable identity so the timeout-based dismiss can
  // splice it out without prev-state races.
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);
  const pushToast = useCallback((kind: ToastKind, message: string) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ─── Derived data ────────────────────────────────────────────────────────
  const branch = status.data?.ok ? (status.data.branch ?? "—") : "—";
  const detached = status.data?.ok ? !!status.data.detached : false;
  const entries: GitStatusEntry[] = useMemo(() => {
    if (status.data?.ok) return status.data.entries;
    return [];
  }, [status.data]);

  // Split into Changes (worktree dirty) and Staged Changes (index dirty).
  // An entry can appear in both — this matches `git status --short` which
  // also prints staged + worktree changes side-by-side.
  const { changes, staged } = useMemo(() => {
    const c: GitStatusEntry[] = [];
    const s: GitStatusEntry[] = [];
    for (const e of entries) {
      if ((e.worktree ?? " ").trim() !== "") c.push(e);
      if ((e.index ?? " ").trim() !== "") s.push(e);
    }
    return { changes: c, staged: s };
  }, [entries]);

  // Pre-select every dirty path on first arrival of the porcelain list.
  // "Commit everything" is the dominant case; opt-out by unchecking is
  // faster than opt-in by checking each row. Once the user touches the
  // selection (toggle), we stop reseeding so a refetch doesn't clobber
  // their intentional choice.
  useEffect(() => {
    if (success) return;
    if (userTouchedSelection) return;
    if (entries.length === 0) {
      if (selected.size > 0) setSelected(new Set());
      return;
    }
    setSelected(new Set(entries.map((e) => e.path)));
    // We intentionally exclude `selected` from the dep list — including
    // it would loop the effect on every set update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, success, userTouchedSelection]);

  // ─── Handlers ────────────────────────────────────────────────────────────
  const togglePath = (path: string) => {
    setUserTouchedSelection(true);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleRefresh = () => {
    void status.refetch();
  };

  // External commit-disable signal forwarded into the composer. The
  // composer adds its own "message is empty" check on top of this.
  const externalSubmitBlocked =
    commit.isPending || selected.size === 0 || entries.length === 0 || detached;

  const handleSubmit = (rawMessage: string) => {
    if (externalSubmitBlocked) return;
    const trimmed = rawMessage.trim();
    if (trimmed === "") return;
    setErrorReason(null);
    setErrorMessage(null);
    setSuccess(null);
    const paths = Array.from(selected);
    const body = { message: trimmed, paths };
    const callbacks = {
      onSuccess: (result: GitCommitResult) => {
        if (result.ok) {
          setSuccess({
            sha: result.sha,
            filesCommitted: result.files_committed,
          });
          composerRef.current?.clear();
          setSelected(new Set());
          setUserTouchedSelection(false);
          return;
        }
        setErrorReason(result.reason);
        setErrorMessage(result.message ?? null);
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

  // ─── Discard handler ─────────────────────────────────────────────────────
  // Fired from the DiscardConfirm dialog's confirm button. We branch on
  // the active target so the right mutation (project vs workspace) fires
  // and the per-file invalidation in the hook layer reaches the right
  // cache keys. On `ok:false` we still surface a toast — the porcelain
  // peek refresh is handled by the hook's `onSuccess` regardless.
  const handleDiscardConfirm = () => {
    if (!pendingPath) return;
    const path = pendingPath;
    const callbacks = {
      onSuccess: (result: GitDiscardResult) => {
        setPendingPath(null);
        if (result.ok) {
          pushToast("info", `Discarded changes to ${path}`);
        } else {
          pushToast("error", discardErrorCopy(result.reason, result.message));
        }
      },
      onError: (err: Error) => {
        setPendingPath(null);
        pushToast("error", err.message || "Discard failed.");
      },
    };
    if (target.kind === "project") {
      projectDiscard.mutate(
        { projectId: target.id, body: { paths: [path] } },
        callbacks,
      );
    } else {
      workspaceDiscard.mutate(
        { workspaceId: target.id, body: { paths: [path] } },
        callbacks,
      );
    }
  };

  // ─── Fetch handler ───────────────────────────────────────────────────────
  // Single click → spinner → toast on result. We always invalidate the
  // porcelain peek on success (hook handles that); the toast copy mirrors
  // git's own vocabulary so an operator who reads stderr in a terminal
  // recognises the message here.
  const handleFetchClick = () => {
    if (fetchMut.isPending) return;
    const callbacks = {
      onSuccess: (result: GitFetchResult) => {
        if (result.ok) {
          pushToast("info", `Fetched from ${result.remote}`);
        } else {
          pushToast("error", fetchErrorCopy(result.reason, result.message));
        }
      },
      onError: (err: Error) => {
        pushToast("error", err.message || "Fetch failed.");
      },
    };
    if (target.kind === "project") {
      projectFetch.mutate({ projectId: target.id }, callbacks);
    } else {
      workspaceFetch.mutate({ workspaceId: target.id }, callbacks);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────
  const ahead = aheadBehind?.ahead ?? 0;
  const behind = aheadBehind?.behind ?? 0;
  const totalDirty = changes.length + staged.length;

  return (
    <div
      data-testid="scm-panel"
      className="relative flex h-full w-full min-w-[260px] flex-col bg-background text-sm"
    >
      {/* ─── Header ──────────────────────────────────────────────────── */}
      <div
        data-testid="scm-header"
        className="flex items-center gap-2 border-b px-3 py-2"
      >
        <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden />
        <BranchPicker target={target} onToast={pushToast} />
        {/*
         * Kept around as a tiny screen-reader-only mirror so any out-of-tree
         * E2E that still keys off `scm-branch` keeps working until the
         * cleanup pass. The visible branch name lives in the BranchPicker.
         */}
        <span
          data-testid="scm-branch"
          className="sr-only"
          aria-hidden="true"
          title={branch}
        >
          {branch}
        </span>
        <span
          data-testid="scm-ahead"
          className="ml-1 inline-flex items-center font-mono text-[11px] text-muted-foreground"
          title={`${ahead} commit(s) ahead of upstream`}
          aria-label={`${ahead} ahead`}
        >
          ↑{ahead}
        </span>
        <span
          data-testid="scm-behind"
          className="inline-flex items-center font-mono text-[11px] text-muted-foreground"
          title={`${behind} commit(s) behind upstream`}
          aria-label={`${behind} behind`}
        >
          ↓{behind}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 w-6 p-0"
          onClick={() => setStashPushOpen(true)}
          data-testid="scm-stash-push"
          title="Stash changes"
          aria-label="Stash changes"
        >
          <Layers className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={handleFetchClick}
          data-testid="scm-fetch"
          title="Fetch from remote"
          aria-label="Fetch from remote"
          disabled={fetchMut.isPending}
        >
          {fetchMut.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CloudDownload className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={handleRefresh}
          data-testid="scm-refresh"
          title="Refresh"
          aria-label="Refresh git status"
          disabled={status.isFetching}
        >
          {status.isFetching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {/* ─── Commit composer ─────────────────────────────────────────── */}
      <CommitComposer
        ref={composerRef}
        textareaDisabled={commit.isPending || entries.length === 0}
        externalSubmitBlocked={externalSubmitBlocked}
        isPending={commit.isPending}
        onSubmit={handleSubmit}
        errorReason={errorReason}
        errorMessage={errorMessage}
        success={success}
      />

      <Separator className="m-0" />

      {/* ─── Changed-file groups ─────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {status.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : !status.data?.ok ? (
          <p
            className="px-3 py-6 text-center text-xs text-muted-foreground"
            data-testid="scm-not-a-repo"
          >
            {statusFailureCopy(status.data?.reason)}
          </p>
        ) : totalDirty === 0 ? (
          <p
            data-testid="scm-empty"
            className="px-3 py-6 text-center text-xs text-muted-foreground"
          >
            Working tree is clean.
          </p>
        ) : (
          <>
            <FileGroup
              label="Changes"
              testId="changes"
              entries={changes}
              selected={selected}
              onToggle={togglePath}
              onToggleAll={(next) => toggleAll(changes, selected, setSelected, setUserTouchedSelection, next)}
              virtualize={changes.length > virtualizeThreshold}
              onDiscard={(path) => setPendingPath(path)}
              discardDisabled={discard.isPending}
              // "Changes" rows describe worktree-vs-index — open the diff
              // tab in working-tree mode so the editor's left/right sides
              // mirror what `git diff -- <path>` would print.
              onOpenDiff={(path) =>
                tabStore.openDiff(
                  target.kind === "project" ? "projects" : "workspaces",
                  target.id,
                  path,
                  {},
                )
              }
            />
            <FileGroup
              label="Staged Changes"
              testId="staged"
              entries={staged}
              selected={selected}
              onToggle={togglePath}
              onToggleAll={(next) => toggleAll(staged, selected, setSelected, setUserTouchedSelection, next)}
              virtualize={staged.length > virtualizeThreshold}
              onDiscard={(path) => setPendingPath(path)}
              discardDisabled={discard.isPending}
              // "Staged Changes" rows describe index-vs-HEAD — open the
              // diff tab in staged mode so `staged: true` is plumbed
              // through to the underlying `git diff --cached`.
              onOpenDiff={(path) =>
                tabStore.openDiff(
                  target.kind === "project" ? "projects" : "workspaces",
                  target.id,
                  path,
                  { staged: true },
                )
              }
            />
          </>
        )}
      </div>

      {/* ─── Stashes (collapsed by default; per-target persistence) ──── */}
      <StashSection target={target} onToast={pushToast} />

      {/* ─── History (collapsed by default; persistence in HistoryList) ─ */}
      <HistoryList target={target} />

      {/* ─── Discard confirm dialog ────────────────────────────────────── */}
      <DiscardConfirm
        open={pendingPath !== null}
        onOpenChange={(v) => {
          if (!v) setPendingPath(null);
        }}
        path={pendingPath ?? ""}
        // Dirty-tab detection isn't wired yet — the editor / tab store
        // lives outside this component. The prop is plumbed so a future
        // slice that owns the tab store can flip it to `true` without
        // re-shaping this call site.
        dirtyTab={false}
        isPending={discard.isPending}
        onConfirm={handleDiscardConfirm}
      />

      {/* ─── Stash push dialog ─────────────────────────────────────────── */}
      <StashPushDialog
        open={stashPushOpen}
        onOpenChange={setStashPushOpen}
        target={target}
        onToast={pushToast}
      />

      {/* ─── Toasts (Fetch / Discard outcomes) ─────────────────────────── */}
      <ScmToasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────────────────

interface FileGroupProps {
  label: string;
  testId: "changes" | "staged";
  entries: GitStatusEntry[];
  selected: Set<string>;
  onToggle: (path: string) => void;
  onToggleAll: (next: boolean) => void;
  virtualize: boolean;
  onDiscard?: (path: string) => void;
  discardDisabled?: boolean;
  /** Optional row-click handler — opens the diff tab for that path. */
  onOpenDiff?: (path: string) => void;
}

function FileGroup({
  label,
  testId,
  entries,
  selected,
  onToggle,
  onToggleAll,
  virtualize,
  onDiscard,
  discardDisabled,
  onOpenDiff,
}: FileGroupProps) {
  const [open, setOpen] = useState(true);
  if (entries.length === 0) return null;

  // Tri-state: all / some / none. Radix Checkbox represents
  // "indeterminate" via the literal string `"indeterminate"`.
  const checkedCount = entries.filter((e) => selected.has(e.path)).length;
  const allChecked = checkedCount === entries.length;
  const someChecked = checkedCount > 0 && !allChecked;
  const checkedValue: boolean | "indeterminate" = allChecked
    ? true
    : someChecked
      ? "indeterminate"
      : false;

  return (
    <section data-testid={`scm-${testId}-section`}>
      <header
        data-testid={`scm-${testId}-header`}
        className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 hover:text-foreground"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="h-3 w-3" aria-hidden />
          ) : (
            <ChevronRight className="h-3 w-3" aria-hidden />
          )}
          <span>{label}</span>
        </button>
        <span className="text-muted-foreground/80">({entries.length})</span>
        <span className="ml-auto">
          <Checkbox
            data-testid={`scm-${testId}-toggle-all`}
            checked={checkedValue}
            onCheckedChange={(v) => onToggleAll(v === true)}
            aria-label={`Toggle all in ${label}`}
          />
        </span>
      </header>
      {open && (
        <ul
          data-testid={`scm-${testId}-list`}
          className="divide-y divide-transparent"
        >
          {virtualize ? (
            <VirtualRows
              entries={entries}
              selected={selected}
              onToggle={onToggle}
              onDiscard={onDiscard}
              discardDisabled={discardDisabled}
              onOpenDiff={onOpenDiff}
            />
          ) : (
            entries.map((entry) => (
              <ChangedFileRow
                key={entry.path}
                entry={entry}
                checked={selected.has(entry.path)}
                onToggle={onToggle}
                onDiscard={onDiscard}
                discardDisabled={discardDisabled}
                onOpenDiff={onOpenDiff}
              />
            ))
          )}
        </ul>
      )}
    </section>
  );
}

/**
 * Virtualised rendering for large changesets. We use `@tanstack/react-virtual`
 * (already a UI dep) instead of pulling in a second library — the row
 * height is fixed at 28px and react-virtual handles the rest.
 */
function VirtualRows({
  entries,
  selected,
  onToggle,
  onDiscard,
  discardDisabled,
  onOpenDiff,
}: {
  entries: GitStatusEntry[];
  selected: Set<string>;
  onToggle: (path: string) => void;
  onDiscard?: (path: string) => void;
  discardDisabled?: boolean;
  onOpenDiff?: (path: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 8,
  });
  return (
    <div
      ref={parentRef}
      data-testid="scm-virtualised"
      className="max-h-[400px] overflow-y-auto"
    >
      <div
        style={{
          height: rowVirtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((vrow) => {
          const entry = entries[vrow.index];
          // Guard against an out-of-range index — `vrow.index` is bounded
          // by `count` (the entries length we passed in), but TS strict
          // index access still surfaces the `| undefined` here.
          if (!entry) return null;
          return (
            <div
              key={entry.path}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${vrow.start}px)`,
              }}
            >
              <ChangedFileRow
                entry={entry}
                checked={selected.has(entry.path)}
                onToggle={onToggle}
                onDiscard={onDiscard}
                discardDisabled={discardDisabled}
                onOpenDiff={onOpenDiff}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toggleAll(
  group: GitStatusEntry[],
  current: Set<string>,
  setSelected: (next: Set<string>) => void,
  setTouched: (v: boolean) => void,
  next: boolean,
) {
  setTouched(true);
  const out = new Set(current);
  for (const e of group) {
    if (next) out.add(e.path);
    else out.delete(e.path);
  }
  setSelected(out);
}

// ─── Memoised commit composer ─────────────────────────────────────────────
//
// Owns its own message state so each keystroke only re-renders this small
// subtree, not the file lists / history / git-status panes above. Exposes
// an imperative `clear()` handle for the parent to reset the input after
// a successful commit. The button-enabled state is derived locally from
// the trimmed message + the external `externalSubmitBlocked` signal.
//
// React.memo on a forwardRef component is the canonical pattern for this
// kind of "isolated form input" extraction — the parent passes referentially
// stable callbacks (`onSubmit` is stable across renders here because it
// only closes over `setX` calls which are stable themselves) so the memo
// hits 100% of the time, keystrokes never bubble up.

interface CommitComposerHandle {
  clear: () => void;
}

interface CommitComposerProps {
  textareaDisabled: boolean;
  externalSubmitBlocked: boolean;
  isPending: boolean;
  onSubmit: (message: string) => void;
  errorReason: GitCommitFailure["reason"] | "unknown" | null;
  errorMessage: string | null;
  success: { sha: string; filesCommitted: number } | null;
}

const CommitComposer = memo(
  forwardRef<CommitComposerHandle, CommitComposerProps>(function CommitComposer(
    {
      textareaDisabled,
      externalSubmitBlocked,
      isPending,
      onSubmit,
      errorReason,
      errorMessage,
      success,
    },
    ref,
  ) {
    const [message, setMessage] = useState("");
    useImperativeHandle(
      ref,
      () => ({
        clear: () => setMessage(""),
      }),
      [],
    );
    const trimmed = message.trim();
    const canSubmit = !externalSubmitBlocked && trimmed !== "";
    const handleSubmit = () => {
      if (!canSubmit) return;
      onSubmit(message);
    };
    return (
      <div className="space-y-2 border-b px-3 py-2">
        <Textarea
          data-testid="scm-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Message (Cmd+Enter to commit)"
          rows={2}
          disabled={textareaDisabled}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              handleSubmit();
            }
          }}
          className="resize-none text-xs"
        />
        <Button
          size="sm"
          className="w-full"
          onClick={handleSubmit}
          disabled={!canSubmit}
          data-testid="scm-commit-submit"
        >
          {isPending ? (
            <>
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              Committing…
            </>
          ) : (
            "Commit"
          )}
        </Button>
        {errorReason && (
          <p
            className="text-xs text-destructive"
            role="alert"
            data-testid="scm-commit-error"
          >
            {commitErrorCopy(errorReason, errorMessage)}
          </p>
        )}
        {success && (
          <p
            className="text-xs text-emerald-700 dark:text-emerald-300"
            role="status"
            data-testid="scm-commit-success"
          >
            Committed{" "}
            <span className="font-mono">{success.sha.slice(0, 7)}</span> (
            {success.filesCommitted}{" "}
            {success.filesCommitted === 1 ? "file" : "files"})
          </p>
        )}
      </div>
    );
  }),
);

function commitErrorCopy(
  reason: GitCommitFailure["reason"],
  message: string | null,
): string {
  switch (reason) {
    case "empty_index":
      return "Nothing staged — refresh and try again.";
    case "detached_head":
      return "HEAD is detached. Switch to a branch first.";
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
      return message ?? "Commit failed.";
    case "ok":
      return "Commit failed.";
    case "unknown":
    default:
      return message ?? "Commit failed.";
  }
}

function statusFailureCopy(reason: string | undefined): string {
  switch (reason) {
    case "not_a_repo":
      return "Not a git repository.";
    case "path_missing":
      return "Path no longer exists on disk.";
    default:
      return "Could not load git status.";
  }
}

// ─── Discard / Fetch error copy ─────────────────────────────────────────────
//
// Same pattern as `commitErrorCopy` — map the structured `reason` from the
// service to a single-line operator-facing string. Untracked paths surface
// as `unknown_path` (git refuses `checkout --` against them); we don't
// repeat the path itself in the toast because the dialog the operator just
// dismissed already named it.

function discardErrorCopy(
  reason: string | undefined,
  message: string | undefined,
): string {
  switch (reason) {
    case "no_paths":
      return "No paths to discard.";
    case "invalid_path":
      return "Invalid path.";
    case "path_outside_repo":
      return "Path is outside the repository.";
    case "unknown_path":
      return "Path is not tracked by git — refresh and try again.";
    case "not_a_repo":
      return "Not a git repository.";
    case "path_missing":
      return "Repository path no longer exists on disk.";
    case "timeout":
      return "git checkout timed out.";
    default:
      return message ?? "Discard failed.";
  }
}

function fetchErrorCopy(
  reason: string | undefined,
  message: string | undefined,
): string {
  switch (reason) {
    case "auth_failed":
      return "Fetch failed: credentials rejected by remote.";
    case "network_error":
      return "Fetch failed: could not reach remote.";
    case "invalid_remote":
      return "Fetch failed: invalid remote name.";
    case "not_a_repo":
      return "Not a git repository.";
    case "path_missing":
      return "Repository path no longer exists on disk.";
    case "timeout":
      return "git fetch timed out.";
    default:
      return message ?? "Fetch failed.";
  }
}

// ─── Toasts ─────────────────────────────────────────────────────────────────
//
// Minimal in-component toast region. Sized + positioned to sit inside the
// SCM panel so a toast doesn't escape the activity-bar layout column on
// narrow viewports — the AgentsMdEditor variant pins to the viewport
// bottom-right because it's a full-pane editor; here we want the toasts
// scoped to the panel's own footer.

type ToastKind = "info" | "error";
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

function ScmToasts({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      data-testid="scm-toast-region"
      role="region"
      aria-label="Source control notifications"
      className="pointer-events-none absolute bottom-4 right-4 z-40 flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          aria-live={t.kind === "error" ? "assertive" : "polite"}
          data-testid={`scm-toast-${t.kind}`}
          className={`pointer-events-auto rounded border px-3 py-2 text-xs shadow ${
            t.kind === "error"
              ? "border-destructive bg-destructive/10 text-destructive"
              : "border-border bg-background"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <span>{t.message}</span>
            <button
              type="button"
              className="text-xs opacity-60 hover:opacity-100"
              aria-label="Dismiss notification"
              onClick={() => onDismiss(t.id)}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
