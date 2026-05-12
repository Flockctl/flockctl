import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GitCommitResult, GitStatusResult } from "@/lib/types";

/**
 * Unit tests for {@link SourceControlPanel}.
 *
 * The boundaries we exercise:
 *   - Header renders branch + ahead/behind from props.
 *   - Changes group renders one row per worktree-dirty entry; Staged
 *     group renders one row per index-dirty entry; an entry that is
 *     both lands in both groups (mirrors `git status --short`).
 *   - First arrival of the porcelain list pre-checks every dirty path;
 *     toggling a path stops auto-seeding so a refetch can't clobber
 *     the user's intent.
 *   - Submit is disabled until message + selection are populated, then
 *     fires the project-scoped commit mutation with the right body.
 *   - On success the message clears and the inline success banner
 *     replaces the (transient) error region.
 *   - Empty working tree shows the "clean" notice and disables Commit.
 *   - History is collapsed by default and the toggle expands it.
 *   - Refresh button calls `status.refetch()`.
 *
 * Hooks are mocked at the module boundary so the test does not need a
 * QueryClientProvider, fetch mock, or live backend.
 */

type StatusState = {
  data: GitStatusResult | undefined;
  isLoading: boolean;
  isFetching: boolean;
  refetch: ReturnType<typeof vi.fn>;
};
type CommitState = {
  isPending: boolean;
  mutate: ReturnType<typeof vi.fn>;
};

let statusState: StatusState;
let commitState: CommitState;

vi.mock("@/lib/hooks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hooks")>(
    "@/lib/hooks",
  );
  return {
    ...actual,
    useGitStatusProject: () => statusState,
    useGitCommitProject: () => commitState,
    useGitStatusWorkspace: () => ({
      data: undefined,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    }),
    useGitCommitWorkspace: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    // The HistoryList child reaches for `useGitLog`. Stub the disabled
    // shape — these tests don't exercise history; that lives in the
    // dedicated history-list spec.
    useGitLog: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    }),
    // Discard / Fetch were added in M01 slice 03 — the panel calls these
    // hooks unconditionally for stable hook-call ordering across the
    // project / workspace target dispatch. Stub the idle-mutation shape
    // so the test does not need a QueryClientProvider; the dedicated
    // discard / fetch e2e exercises the live cache invalidation path.
    useGitDiscardProject: () => ({ mutate: vi.fn(), isPending: false }),
    useGitDiscardWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
    useGitFetchProject: () => ({ mutate: vi.fn(), isPending: false }),
    useGitFetchWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
    // BranchPicker mounted in the header (slice 01) reaches for the
    // branch list + checkout / delete mutations. Stub the idle-query /
    // idle-mutation shapes so the panel-level tests do not need a
    // QueryClientProvider; the BranchPicker itself is exercised in
    // `branch-picker.test.tsx`.
    useGitBranchesProject: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
    }),
    useGitBranchesWorkspace: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
    }),
    useGitCheckoutProject: () => ({ mutate: vi.fn(), isPending: false }),
    useGitCheckoutWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
    useGitBranchDeleteProject: () => ({ mutate: vi.fn(), isPending: false }),
    useGitBranchDeleteWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
    // Stash hooks (slice 06) — same idle-stub treatment as discard / fetch.
    // The collapsed-by-default StashSection never actually fires its query
    // unless the user opens it, but the hook calls themselves run on every
    // mount; stub the shapes so the panel-level tests don't need a
    // QueryClientProvider.
    useGitStashListProject: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
      dataUpdatedAt: 0,
    }),
    useGitStashListWorkspace: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
      dataUpdatedAt: 0,
    }),
    useGitStashPushProject: () => ({ mutate: vi.fn(), isPending: false }),
    useGitStashPushWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
    useGitStashPopProject: () => ({ mutate: vi.fn(), isPending: false }),
    useGitStashPopWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
    useGitStashDropProject: () => ({ mutate: vi.fn(), isPending: false }),
    useGitStashDropWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

// HistoryList uses `useNavigate` from react-router-dom for row clicks.
// These panel-level tests don't mount a Router, so the bare hook call
// would throw. Stub it inline — the row-click navigation is covered by
// the dedicated history-list spec, which mocks the same module.
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

import { SourceControlPanel } from "@/components/git/SourceControlPanel";
import type { GitTarget } from "@/components/git/git-dropdown-button";

const projectTarget: GitTarget = {
  kind: "project",
  id: "p1",
  path: "/tmp/p1",
};

function statusOk(
  entries: Array<{ path: string; index: string; worktree: string }>,
  branch = "main",
): GitStatusResult {
  return {
    ok: true,
    branch,
    detached: false,
    entries,
    reason: "ok",
  };
}

beforeEach(() => {
  statusState = {
    data: statusOk([
      { path: "src/auth.ts", index: " ", worktree: "M" },
      { path: "src/api/users.ts", index: " ", worktree: "M" },
      { path: "src/notes.md", index: "?", worktree: "?" },
      { path: "src/new-feature.ts", index: "A", worktree: " " },
    ]),
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  };
  commitState = {
    isPending: false,
    mutate: vi.fn(),
  };
});

describe("SourceControlPanel", () => {
  it("renders branch + ahead/behind in the header", () => {
    render(
      <SourceControlPanel
        target={projectTarget}
        aheadBehind={{ ahead: 3, behind: 2 }}
      />,
    );
    expect(screen.getByTestId("scm-branch").textContent).toBe("main");
    expect(screen.getByTestId("scm-ahead").textContent).toBe("↑3");
    expect(screen.getByTestId("scm-behind").textContent).toBe("↓2");
  });

  it("falls back to ↑0 ↓0 when aheadBehind is omitted (header shape stable)", () => {
    render(<SourceControlPanel target={projectTarget} />);
    expect(screen.getByTestId("scm-ahead").textContent).toBe("↑0");
    expect(screen.getByTestId("scm-behind").textContent).toBe("↓0");
  });

  it("splits entries into Changes (worktree-dirty) and Staged (index-dirty) groups", () => {
    render(<SourceControlPanel target={projectTarget} />);

    // Changes: src/auth.ts, src/api/users.ts, src/notes.md (worktree non-blank)
    const changes = screen.getByTestId("scm-changes-list");
    expect(within(changes).getByTestId("scm-row-src/auth.ts")).toBeTruthy();
    expect(within(changes).getByTestId("scm-row-src/api/users.ts")).toBeTruthy();
    expect(within(changes).getByTestId("scm-row-src/notes.md")).toBeTruthy();
    expect(within(changes).queryByTestId("scm-row-src/new-feature.ts")).toBeNull();

    // Staged: src/new-feature.ts (index non-blank)
    const staged = screen.getByTestId("scm-staged-list");
    expect(within(staged).getByTestId("scm-row-src/new-feature.ts")).toBeTruthy();
    expect(within(staged).queryByTestId("scm-row-src/auth.ts")).toBeNull();
  });

  it("pre-checks every dirty path on first arrival", () => {
    render(<SourceControlPanel target={projectTarget} />);
    const cb = screen.getByTestId(
      "scm-row-checkbox-src/auth.ts",
    ) as HTMLInputElement;
    // Radix Checkbox sets `data-state="checked"` on its root.
    expect(cb.getAttribute("data-state")).toBe("checked");
  });

  it("renders the empty-state when the working tree is clean", () => {
    statusState.data = statusOk([]);
    render(<SourceControlPanel target={projectTarget} />);
    expect(screen.getByTestId("scm-empty")).toBeTruthy();
    const submit = screen.getByTestId("scm-commit-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("disables Commit until message is populated", async () => {
    const user = userEvent.setup();
    render(<SourceControlPanel target={projectTarget} />);
    const submit = screen.getByTestId("scm-commit-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    await user.type(screen.getByTestId("scm-message"), "feat: ship slice");
    expect(submit.disabled).toBe(false);
  });

  it("fires the project commit mutation with the selected paths and trimmed message", async () => {
    const user = userEvent.setup();
    render(<SourceControlPanel target={projectTarget} />);

    await user.type(screen.getByTestId("scm-message"), "  feat: x  ");
    await user.click(screen.getByTestId("scm-commit-submit"));

    expect(commitState.mutate).toHaveBeenCalledTimes(1);
    const call = commitState.mutate.mock.calls[0]!;
    const args = call[0] as { projectId: string; body: { message: string; paths: string[] } };
    expect(args.projectId).toBe("p1");
    expect(args.body.message).toBe("feat: x");
    // All four entries are pre-selected on first arrival.
    expect(args.body.paths.sort()).toEqual(
      [
        "src/api/users.ts",
        "src/auth.ts",
        "src/new-feature.ts",
        "src/notes.md",
      ].sort(),
    );
  });

  it("clears the message and shows the success banner on commit success", async () => {
    const user = userEvent.setup();
    render(<SourceControlPanel target={projectTarget} />);

    await user.type(screen.getByTestId("scm-message"), "msg");
    await user.click(screen.getByTestId("scm-commit-submit"));

    // Drive the success callback by hand — the mutate stub captures it.
    const call = commitState.mutate.mock.calls[0]!;
    const callbacks = call[1] as {
      onSuccess: (r: GitCommitResult) => void;
      onError: (e: Error) => void;
    };
    const result: GitCommitResult = {
      ok: true,
      sha: "deadbeef1234",
      files_committed: 4,
      reason: "ok",
    };
    act(() => {
      callbacks.onSuccess(result);
    });

    const success = await screen.findByTestId("scm-commit-success");
    // sha7 truncation, so "deadbeef1234" → "deadbee".
    expect(success.textContent).toContain("deadbee");
    expect(success.textContent).toContain("4 files");
    expect((screen.getByTestId("scm-message") as HTMLTextAreaElement).value).toBe("");
  });

  it("shows the inline error banner with the right copy on a failure result", async () => {
    const user = userEvent.setup();
    render(<SourceControlPanel target={projectTarget} />);

    await user.type(screen.getByTestId("scm-message"), "msg");
    await user.click(screen.getByTestId("scm-commit-submit"));

    const call = commitState.mutate.mock.calls[0]!;
    const callbacks = call[1] as {
      onSuccess: (r: GitCommitResult) => void;
      onError: (e: Error) => void;
    };
    act(() => {
      callbacks.onSuccess({
        ok: false,
        reason: "empty_index",
      } as unknown as GitCommitResult);
    });

    const err = await screen.findByTestId("scm-commit-error");
    expect(err.textContent).toMatch(/Nothing staged/);
  });

  it("toggling a path stops auto-seeding (user intent wins)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<SourceControlPanel target={projectTarget} />);

    // Uncheck one path.
    await user.click(screen.getByTestId("scm-row-checkbox-src/auth.ts"));

    // Simulate a fresh porcelain peek arriving (e.g. refetch). The dirty
    // set is identical — reseeding would re-check src/auth.ts, which we
    // explicitly want to NOT happen.
    statusState.data = statusOk([
      { path: "src/auth.ts", index: " ", worktree: "M" },
      { path: "src/api/users.ts", index: " ", worktree: "M" },
      { path: "src/notes.md", index: "?", worktree: "?" },
      { path: "src/new-feature.ts", index: "A", worktree: " " },
    ]);
    rerender(<SourceControlPanel target={projectTarget} />);

    const cb = screen.getByTestId(
      "scm-row-checkbox-src/auth.ts",
    ) as HTMLInputElement;
    expect(cb.getAttribute("data-state")).toBe("unchecked");
  });

  it("history disclosure is collapsed by default and toggles open on click", async () => {
    const user = userEvent.setup();
    render(<SourceControlPanel target={projectTarget} />);

    expect(screen.queryByTestId("scm-history")).toBeNull();
    await user.click(screen.getByTestId("scm-history-toggle"));
    expect(screen.getByTestId("scm-history")).toBeTruthy();
  });

  it("Refresh calls status.refetch()", async () => {
    const user = userEvent.setup();
    render(<SourceControlPanel target={projectTarget} />);
    await user.click(screen.getByTestId("scm-refresh"));
    expect(statusState.refetch).toHaveBeenCalledTimes(1);
  });

  it("renders the not-a-repo copy when the porcelain query fails", () => {
    statusState.data = {
      ok: false,
      reason: "not_a_repo",
      message: "no .git",
    } as GitStatusResult;
    render(<SourceControlPanel target={projectTarget} />);
    expect(screen.getByTestId("scm-not-a-repo").textContent).toMatch(
      /Not a git repository/,
    );
  });

  it("flips to the virtualised renderer when entry count exceeds the threshold", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      index: " ",
      worktree: "M",
    }));
    statusState.data = statusOk(many);
    render(
      <SourceControlPanel target={projectTarget} virtualizeThreshold={20} />,
    );
    // The virtualised wrapper testid is only emitted on the virtual path.
    expect(screen.getByTestId("scm-virtualised")).toBeTruthy();
  });
});
