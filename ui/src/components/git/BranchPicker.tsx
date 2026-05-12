import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, GitBranch, Loader2, Plus, Settings2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import {
  useGitBranchesProject,
  useGitBranchesWorkspace,
  useGitCheckoutProject,
  useGitCheckoutWorkspace,
} from "@/lib/hooks";
import type {
  GitBranchEntry,
  GitCheckoutResult,
} from "@/lib/api/git-branches";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { GitTarget } from "./git-dropdown-button";
import { CreateBranchDialog } from "./CreateBranchDialog";
import { DeleteBranchDialog } from "./DeleteBranchDialog";

/**
 * BranchPicker — combobox-style trigger that surfaces the current branch
 * and lets the operator switch / create / delete branches without
 * dropping into a terminal.
 *
 * Layout:
 *   - Trigger: small outlined button with a `GitBranch` icon, the
 *     current branch name, and a chevron. Clicking toggles the popover.
 *   - Popover: a filter input pinned at the top, then a scrollable list
 *     of *local* branches (remote refs are filtered out — checking out a
 *     remote ref directly puts the working tree in detached HEAD; the
 *     create flow is the right path for "track origin/foo locally").
 *     The bottom of the popover hosts two static items:
 *       • "+ Create new branch…"  — opens the create dialog (default
 *         starts from the current branch).
 *       • "Manage branches…"      — flips the list into a "delete-mode"
 *         where each row sprouts a trash button. We deliberately do NOT
 *         ship a separate management page; the same popover with a
 *         mode flip is enough for the slice contract and avoids a
 *         router round-trip.
 *
 * Virtualisation:
 *   - On a typical clone the list is < 50 entries; we render the plain
 *     DOM list. Above the threshold (configurable for tests) we swap to
 *     `@tanstack/react-virtual` — same library the SourceControlPanel
 *     uses for the changes list. This avoids pulling in a second virt
 *     library (`react-arborist` / `react-virtuoso`) just for one list.
 *
 * Failure surface:
 *   - Checkout `dirty_working_tree` → toast (handled via the optional
 *     `onToast` prop so the parent SourceControlPanel can route through
 *     its existing toast region).
 *   - Checkout `branch_not_found` / `branch_already_exists` / `unknown`
 *     → toast with the server's `message`.
 *
 * Test-id contract (stable):
 *   - `branch-picker-root`        — outer container.
 *   - `branch-picker-trigger`     — the button that opens the popover.
 *   - `branch-picker-current`     — current-branch label inside the trigger.
 *   - `branch-picker-popover`     — popover root (only present when open).
 *   - `branch-picker-filter`      — filter input.
 *   - `branch-picker-list`        — scroll container for branch rows.
 *   - `branch-picker-item-<name>` — individual branch row (clickable).
 *   - `branch-picker-empty`       — "no branches match" hint.
 *   - `branch-picker-create`      — "+ Create new branch…" trigger.
 *   - `branch-picker-manage`      — "Manage branches…" toggle.
 *   - `branch-picker-delete-<name>` — trash icon (manage mode only).
 *   - `branch-picker-spinner`     — checkout-in-flight spinner.
 */
export interface BranchPickerProps {
  target: GitTarget;
  /**
   * Surface a one-line message in the parent's toast region. Optional —
   * a missing handler just means the failure is swallowed silently
   * (we do not render an inline error inside the popover, because the
   * popover closes the moment a click resolves).
   */
  onToast?: (kind: "info" | "error", message: string) => void;
  /**
   * Threshold above which the branch list swaps to a virtualised
   * renderer. Defaults to 50 — the slice spec's recommended cutoff.
   * Tests lower this to validate the virtualised branch without
   * seeding 51 refs.
   */
  virtualizeThreshold?: number;
}

export function BranchPicker({
  target,
  onToast,
  virtualizeThreshold = 50,
}: BranchPickerProps) {
  // ─── Server data ─────────────────────────────────────────────────────────
  const projectQuery = useGitBranchesProject(
    target.kind === "project" ? target.id : "",
    { enabled: target.kind === "project" },
  );
  const workspaceQuery = useGitBranchesWorkspace(
    target.kind === "workspace" ? target.id : "",
    { enabled: target.kind === "workspace" },
  );
  const branchesQuery = target.kind === "project" ? projectQuery : workspaceQuery;

  const projectCheckout = useGitCheckoutProject();
  const workspaceCheckout = useGitCheckoutWorkspace();
  // Both pairs are called unconditionally so the hook order stays
  // stable across `target.kind` flips; only one ever fires a network
  // request because `runCheckout` dispatches on `target.kind` below.

  // ─── Local UI state ──────────────────────────────────────────────────────
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [manageMode, setManageMode] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [pendingCheckout, setPendingCheckout] = useState<string | null>(null);

  // Reset the filter / mode whenever the popover closes — we do not want a
  // stale filter to bias the next open.
  useEffect(() => {
    if (!open) {
      setFilter("");
      setManageMode(false);
    }
  }, [open]);

  // Click-outside handler. The popover is portalled into `document.body`
  // (so it can escape `overflow-hidden` ancestors like the SCM side
  // panel), so the trigger and the popover live in different DOM
  // subtrees — we accept clicks inside *either* before deciding to
  // close.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onPointerDown(ev: MouseEvent) {
      const root = rootRef.current;
      const pop = popoverRef.current;
      const target = ev.target;
      if (!(target instanceof Node)) return;
      if (root && root.contains(target)) return;
      if (pop && pop.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  // Popover position — anchored under the trigger via `position: fixed`
  // so the popover escapes ancestor `overflow:hidden` containers (the
  // SCM side panel pins itself at 300px wide with `overflow-hidden`,
  // which would otherwise clip a 288px-wide popover sitting on the
  // trigger's left edge).
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    if (!open) return;
    const POPOVER_WIDTH = 288; // matches `w-72` Tailwind class below.
    const MARGIN = 8;
    function reposition() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      // Default: align popover's left edge to the trigger's left edge,
      // sitting just under the trigger. If that overflows the viewport
      // on the right, shift it leftward so the popover stays on screen.
      const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 0;
      let left = rect.left;
      if (viewportWidth > 0 && left + POPOVER_WIDTH + MARGIN > viewportWidth) {
        left = Math.max(MARGIN, viewportWidth - POPOVER_WIDTH - MARGIN);
      }
      setPopoverPos({ top: rect.bottom + 4, left });
    }
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  // ─── Derived data ────────────────────────────────────────────────────────
  const allBranches: GitBranchEntry[] = useMemo(() => {
    const data = branchesQuery.data;
    if (!data || !data.ok) return [];
    return data.branches;
  }, [branchesQuery.data]);

  const localBranches = useMemo(
    () => allBranches.filter((b) => !b.is_remote),
    [allBranches],
  );

  const currentBranch = useMemo(
    () => localBranches.find((b) => b.current)?.name ?? null,
    [localBranches],
  );

  const filteredBranches = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return localBranches;
    return localBranches.filter((b) => b.name.toLowerCase().includes(q));
  }, [localBranches, filter]);

  const virtualize = filteredBranches.length > virtualizeThreshold;

  // ─── Actions ─────────────────────────────────────────────────────────────
  const runCheckout = useCallback(
    (branch: string) => {
      if (branch === currentBranch) {
        setOpen(false);
        return;
      }
      setPendingCheckout(branch);
      const onSettled = (result: GitCheckoutResult | undefined, err: Error | null) => {
        setPendingCheckout(null);
        setOpen(false);
        if (err) {
          onToast?.("error", err.message || "Checkout failed.");
          return;
        }
        if (!result) return;
        if (result.ok) {
          onToast?.("info", `Switched to ${result.branch}.`);
          return;
        }
        onToast?.("error", checkoutErrorCopy(result));
      };
      if (target.kind === "project") {
        projectCheckout.mutate(
          { projectId: target.id, body: { branch } },
          {
            onSuccess: (data) => onSettled(data, null),
            onError: (err) => onSettled(undefined, err),
          },
        );
      } else {
        workspaceCheckout.mutate(
          { workspaceId: target.id, body: { branch } },
          {
            onSuccess: (data) => onSettled(data, null),
            onError: (err) => onSettled(undefined, err),
          },
        );
      }
    },
    [
      target,
      currentBranch,
      onToast,
      projectCheckout,
      workspaceCheckout,
    ],
  );

  // ─── Render ──────────────────────────────────────────────────────────────
  const triggerLabel = currentBranch ?? (branchesQuery.isLoading ? "…" : "—");
  const triggerDisabled = !target.path || branchesQuery.isError;

  return (
    <div
      ref={rootRef}
      data-testid="branch-picker-root"
      className="relative inline-flex"
    >
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        data-testid="branch-picker-trigger"
        disabled={triggerDisabled}
        title={
          !target.path
            ? `${target.kind === "project" ? "Project" : "Workspace"} has no on-disk clone.`
            : "Switch, create, or delete a branch"
        }
        onClick={() => setOpen((v) => !v)}
        className="gap-1.5"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {pendingCheckout ? (
          <Loader2
            data-testid="branch-picker-spinner"
            className="h-3.5 w-3.5 animate-spin"
            aria-hidden
          />
        ) : (
          <GitBranch className="h-3.5 w-3.5" aria-hidden />
        )}
        <span data-testid="branch-picker-current" className="max-w-[180px] truncate">
          {triggerLabel}
        </span>
        <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
      </Button>

      {open && popoverPos && typeof document !== "undefined" && createPortal(
        <div
          ref={popoverRef}
          data-testid="branch-picker-popover"
          role="listbox"
          aria-label="Branches"
          style={{
            position: "fixed",
            top: popoverPos.top,
            left: popoverPos.left,
          }}
          className={cn(
            "z-50 w-72 rounded-md border",
            "border-border bg-popover text-popover-foreground shadow-md",
          )}
        >
          <div className="border-b border-border p-2">
            <Input
              data-testid="branch-picker-filter"
              autoFocus
              placeholder="Filter branches…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter branches"
              className="h-8 text-sm"
            />
          </div>

          <BranchList
            branches={filteredBranches}
            currentBranch={currentBranch}
            virtualize={virtualize}
            manageMode={manageMode}
            pendingCheckout={pendingCheckout}
            onPick={runCheckout}
            onAskDelete={(name) => setDeleteTarget(name)}
          />

          <div className="border-t border-border">
            <button
              type="button"
              data-testid="branch-picker-create"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
              onClick={() => {
                setOpen(false);
                setCreateOpen(true);
              }}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Create new branch…
            </button>
            <button
              type="button"
              data-testid="branch-picker-manage"
              aria-pressed={manageMode}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent",
                manageMode && "bg-accent/50",
              )}
              onClick={() => setManageMode((v) => !v)}
            >
              <Settings2 className="h-3.5 w-3.5" aria-hidden />
              {manageMode ? "Done managing" : "Manage branches…"}
            </button>
          </div>
        </div>,
        document.body,
      )}

      {/* Dialogs are mounted outside the popover so the popover can close
          without unmounting the dialog mid-flight. */}
      <CreateBranchDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        target={target}
        currentBranch={currentBranch}
        onToast={onToast}
      />
      <DeleteBranchDialog
        open={deleteTarget !== null}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
        target={target}
        branch={deleteTarget}
        currentBranch={currentBranch}
        onToast={onToast}
      />
    </div>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────────────────

interface BranchListProps {
  branches: GitBranchEntry[];
  currentBranch: string | null;
  virtualize: boolean;
  manageMode: boolean;
  pendingCheckout: string | null;
  onPick: (name: string) => void;
  onAskDelete: (name: string) => void;
}

function BranchList({
  branches,
  currentBranch,
  virtualize,
  manageMode,
  pendingCheckout,
  onPick,
  onAskDelete,
}: BranchListProps) {
  if (branches.length === 0) {
    return (
      <div
        data-testid="branch-picker-empty"
        className="px-3 py-4 text-center text-xs text-muted-foreground"
      >
        No branches match.
      </div>
    );
  }

  if (virtualize) {
    return (
      <VirtualBranchList
        branches={branches}
        currentBranch={currentBranch}
        manageMode={manageMode}
        pendingCheckout={pendingCheckout}
        onPick={onPick}
        onAskDelete={onAskDelete}
      />
    );
  }

  return (
    <ul
      data-testid="branch-picker-list"
      className="max-h-72 overflow-y-auto py-1"
    >
      {branches.map((b) => (
        <BranchRow
          key={b.name}
          entry={b}
          isCurrent={b.name === currentBranch}
          manageMode={manageMode}
          pending={pendingCheckout === b.name}
          onPick={onPick}
          onAskDelete={onAskDelete}
        />
      ))}
    </ul>
  );
}

function VirtualBranchList({
  branches,
  currentBranch,
  manageMode,
  pendingCheckout,
  onPick,
  onAskDelete,
}: Omit<BranchListProps, "virtualize">) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: branches.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 8,
  });

  return (
    <div
      ref={parentRef}
      data-testid="branch-picker-list"
      className="max-h-72 overflow-y-auto"
    >
      <div
        style={{
          height: rowVirtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((vrow) => {
          const entry = branches[vrow.index];
          if (!entry) return null;
          return (
            <div
              key={entry.name}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${vrow.start}px)`,
              }}
            >
              <BranchRow
                entry={entry}
                isCurrent={entry.name === currentBranch}
                manageMode={manageMode}
                pending={pendingCheckout === entry.name}
                onPick={onPick}
                onAskDelete={onAskDelete}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface BranchRowProps {
  entry: GitBranchEntry;
  isCurrent: boolean;
  manageMode: boolean;
  pending: boolean;
  onPick: (name: string) => void;
  onAskDelete: (name: string) => void;
}

function BranchRow({
  entry,
  isCurrent,
  manageMode,
  pending,
  onPick,
  onAskDelete,
}: BranchRowProps) {
  return (
    <li
      data-testid={`branch-picker-item-${entry.name}`}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent",
        isCurrent && "font-medium",
      )}
    >
      <button
        type="button"
        className="flex flex-1 items-center gap-2 text-left"
        onClick={() => onPick(entry.name)}
        disabled={pending}
        aria-current={isCurrent ? "true" : undefined}
      >
        {pending ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        ) : isCurrent ? (
          <span aria-hidden className="text-primary">
            ●
          </span>
        ) : (
          <span aria-hidden className="opacity-30">
            ○
          </span>
        )}
        <span className="truncate">{entry.name}</span>
        {entry.upstream && (
          <span className="ml-auto text-xs text-muted-foreground">
            {entry.upstream}
          </span>
        )}
      </button>
      {manageMode && (
        <button
          type="button"
          data-testid={`branch-picker-delete-${entry.name}`}
          aria-label={`Delete ${entry.name}`}
          className="rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            onAskDelete(entry.name);
          }}
        >
          Delete
        </button>
      )}
    </li>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function checkoutErrorCopy(
  result: { reason: string; message?: string; branch?: string },
): string {
  switch (result.reason) {
    case "dirty_working_tree":
      return (
        result.message ??
        "Working tree has uncommitted changes. Commit, stash, or discard them before switching branches."
      );
    case "branch_not_found":
      return `Branch '${result.branch ?? "?"}' does not exist.`;
    case "branch_already_exists":
      return `Branch '${result.branch ?? "?"}' already exists.`;
    case "invalid_branch_name":
      return result.message ?? "Invalid branch name.";
    case "not_a_repo":
      return "Not a git repository.";
    case "path_missing":
      return "Project path is missing on disk.";
    case "timeout":
      return "Checkout timed out.";
    default:
      return result.message ?? "Checkout failed.";
  }
}
