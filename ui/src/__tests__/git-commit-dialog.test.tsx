import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GitCommitResult, GitStatusResult } from "@/lib/types";

/**
 * UI tests for {@link GitCommitDialog}.
 *
 * The dialog is the real production surface mounted by the project-detail
 * "Git → Commit…" dropdown item. It owns three states (loading,
 * form-with-paths, success) and routes failure-reason copy through a
 * single inline error region. The boundary we exercise here is:
 *
 *   - the porcelain list renders one row per dirty path with the right
 *     status badge and the right pre-checked state;
 *   - submit is disabled until both message and selection are populated;
 *   - on success the dialog body collapses to the SHA + file-count line
 *     and the textarea / checklist are gone (no double-commit risk);
 *   - on each documented `GitCommitFailure.reason` the inline copy
 *     matches the operator-friendly phrasing the dialog promises;
 *   - empty working tree disables the submit button and shows the
 *     "nothing to commit" notice.
 *
 * The query + mutation hooks are mocked at the module boundary so the
 * test does not need a QueryClientProvider, fetch mock, or live backend.
 */

type StatusState = {
  data: GitStatusResult | undefined;
  isLoading: boolean;
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
    // The dialog calls both project and workspace hook trios
    // unconditionally (rules-of-hooks); only the active branch
    // dispatches `mutate`. We stub the workspace pair with inert
    // states so the cross-target call sites resolve without a
    // QueryClientProvider.
    useGitStatusWorkspace: () => ({
      data: undefined,
      isLoading: false,
      refetch: vi.fn(),
    }),
    useGitCommitWorkspace: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
  };
});

// Import AFTER the mocks so the component picks up the mocked module.
import { GitCommitDialog } from "@/components/git/git-commit-dialog";

function statusOk(
  entries: Array<{ path: string; index: string; worktree: string }>,
): GitStatusResult {
  return {
    ok: true,
    branch: "main",
    detached: false,
    entries,
    reason: "ok",
  };
}

beforeEach(() => {
  statusState = {
    data: statusOk([
      { path: "a.txt", index: " ", worktree: "M" },
      { path: "b.txt", index: " ", worktree: "M" },
    ]),
    isLoading: false,
    refetch: vi.fn(),
  };
  commitState = {
    isPending: false,
    mutate: vi.fn(),
  };
});

function renderDialog(props?: { open?: boolean }) {
  const onOpenChange = vi.fn();
  const utils = render(
    <GitCommitDialog
      open={props?.open ?? true}
      onOpenChange={onOpenChange}
      target={{ kind: "project", id: "proj-1", path: "/tmp/proj" }}
    />,
  );
  return { ...utils, onOpenChange };
}

// ─── Loading + empty states ─────────────────────────────────────────────────

describe("GitCommitDialog — loading / empty", () => {
  it("renders a spinner while the porcelain status query is in flight", () => {
    statusState = {
      data: undefined,
      isLoading: true,
      refetch: vi.fn(),
    };
    renderDialog();
    expect(screen.getByTestId("git-commit-loading")).toBeInTheDocument();
    // The submit button is disabled too — no row to act on yet.
    expect(screen.getByTestId("git-commit-submit")).toBeDisabled();
  });

  it("renders the empty-tree notice and disables submit when there are no dirty paths", () => {
    statusState = {
      data: statusOk([]),
      isLoading: false,
      refetch: vi.fn(),
    };
    renderDialog();
    expect(screen.getByTestId("git-commit-empty")).toHaveTextContent(
      /Working tree is clean — nothing to commit\./i,
    );
    expect(
      screen.queryByTestId("git-commit-status-list"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("git-commit-submit")).toBeDisabled();
  });
});

// ─── Form / status list ─────────────────────────────────────────────────────

describe("GitCommitDialog — form", () => {
  it("renders one row per porcelain entry inside a scroll container", () => {
    renderDialog();
    const list = screen.getByTestId("git-commit-status-list");
    // Scroll container is capped at 240px to keep the dialog within the
    // viewport even on a 100-file working tree. We don't assert pixel
    // values (style ↔ class wiring) — the existence of the container plus
    // an overflow class is enough of a contract.
    expect(list).toHaveClass(/overflow/);
    expect(within(list).getByTestId("git-commit-row-a.txt")).toBeInTheDocument();
    expect(within(list).getByTestId("git-commit-row-b.txt")).toBeInTheDocument();
  });

  it("preserves the porcelain XY pair as the leading status badge", () => {
    statusState = {
      data: statusOk([
        { path: "untracked.txt", index: "?", worktree: "?" },
        { path: "added.txt", index: "A", worktree: " " },
        { path: "deleted.txt", index: " ", worktree: "D" },
        { path: "modified.txt", index: " ", worktree: "M" },
      ]),
      isLoading: false,
      refetch: vi.fn(),
    };
    renderDialog();
    expect(
      screen.getByTestId("git-commit-status-untracked.txt"),
    ).toHaveTextContent("??");
    expect(
      screen.getByTestId("git-commit-status-added.txt"),
    ).toHaveTextContent("A");
    expect(
      screen.getByTestId("git-commit-status-deleted.txt"),
    ).toHaveTextContent("D");
    expect(
      screen.getByTestId("git-commit-status-modified.txt"),
    ).toHaveTextContent("M");
  });

  it("pre-selects every dirty path on first arrival", () => {
    renderDialog();
    // Two pre-checked rows + a message → submit becomes enabled the
    // moment the user types.
    const a = screen.getByTestId("git-commit-row-a.txt");
    const b = screen.getByTestId("git-commit-row-b.txt");
    expect(within(a).getByRole("checkbox")).toBeChecked();
    expect(within(b).getByRole("checkbox")).toBeChecked();
  });

  it("disables Commit while message is empty even when paths are selected", () => {
    renderDialog();
    expect(screen.getByTestId("git-commit-submit")).toBeDisabled();
  });

  it("disables Commit when message is non-empty but every path is unchecked", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByTestId("git-commit-message"), "feat: x");
    // Uncheck both pre-selected rows.
    await user.click(
      within(screen.getByTestId("git-commit-row-a.txt")).getByRole("checkbox"),
    );
    await user.click(
      within(screen.getByTestId("git-commit-row-b.txt")).getByRole("checkbox"),
    );
    expect(screen.getByTestId("git-commit-submit")).toBeDisabled();
  });

  it("enables Commit once both message and selection are populated", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByTestId("git-commit-message"), "feat: x");
    expect(screen.getByTestId("git-commit-submit")).not.toBeDisabled();
  });

  it("treats whitespace-only messages as empty", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByTestId("git-commit-message"), "   ");
    expect(screen.getByTestId("git-commit-submit")).toBeDisabled();
  });

  it("invokes the commit mutation with the trimmed message and selected paths", async () => {
    const user = userEvent.setup();
    renderDialog();
    // Uncheck b.txt so we can prove the selection is the source of truth
    // (not the porcelain list).
    await user.click(
      within(screen.getByTestId("git-commit-row-b.txt")).getByRole("checkbox"),
    );
    await user.type(
      screen.getByTestId("git-commit-message"),
      "  feat: add foo  ",
    );
    await user.click(screen.getByTestId("git-commit-submit"));

    expect(commitState.mutate).toHaveBeenCalledTimes(1);
    const [vars] = commitState.mutate.mock.calls[0]!;
    expect(vars).toEqual({
      projectId: "proj-1",
      body: { message: "feat: add foo", paths: ["a.txt"] },
    });
  });

  it("calls onOpenChange(false) when Cancel is clicked", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.click(screen.getByTestId("git-commit-cancel"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ─── Success state ──────────────────────────────────────────────────────────

describe("GitCommitDialog — success", () => {
  it("collapses the body to the SHA + file-count line on ok:true", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByTestId("git-commit-message"), "feat: x");
    await user.click(screen.getByTestId("git-commit-submit"));

    const opts = commitState.mutate.mock.calls[0]![1] as {
      onSuccess: (r: GitCommitResult) => void;
    };
    act(() => {
      opts.onSuccess({
        ok: true,
        sha: "abcdef1234567890abcdef1234567890abcdef12",
        files_committed: 2,
        reason: "ok",
      });
    });

    const success = await screen.findByTestId("git-commit-success");
    expect(success).toBeInTheDocument();
    expect(screen.getByTestId("git-commit-success-sha")).toHaveTextContent(
      "abcdef1",
    );
    expect(success).toHaveTextContent(/2 files/);
    // Form surfaces are gone — no chance of a double commit.
    expect(
      screen.queryByTestId("git-commit-message"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("git-commit-submit"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("git-commit-status-list"),
    ).not.toBeInTheDocument();
  });

  it("renders 'file' (singular) when files_committed === 1", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByTestId("git-commit-message"), "feat: x");
    await user.click(screen.getByTestId("git-commit-submit"));

    const opts = commitState.mutate.mock.calls[0]![1] as {
      onSuccess: (r: GitCommitResult) => void;
    };
    act(() => {
      opts.onSuccess({
        ok: true,
        sha: "0123456abcdef",
        files_committed: 1,
        reason: "ok",
      });
    });
    const success = await screen.findByTestId("git-commit-success");
    expect(success).toHaveTextContent(/1 file\b/);
    expect(success).not.toHaveTextContent(/1 files/);
  });

  it("closes the dialog when Close is clicked on the success panel", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();
    await user.type(screen.getByTestId("git-commit-message"), "feat: x");
    await user.click(screen.getByTestId("git-commit-submit"));

    const opts = commitState.mutate.mock.calls[0]![1] as {
      onSuccess: (r: GitCommitResult) => void;
    };
    act(() => {
      opts.onSuccess({
        ok: true,
        sha: "deadbeef".repeat(5),
        files_committed: 3,
        reason: "ok",
      });
    });

    await user.click(await screen.findByTestId("git-commit-close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ─── Failure copy ───────────────────────────────────────────────────────────

describe("GitCommitDialog — failure copy", () => {
  it("surfaces empty_index with the refresh-and-retry copy", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByTestId("git-commit-message"), "feat: x");
    await user.click(screen.getByTestId("git-commit-submit"));

    const opts = commitState.mutate.mock.calls[0]![1] as {
      onSuccess: (r: GitCommitResult) => void;
    };
    act(() => {
      opts.onSuccess({
        ok: false,
        reason: "empty_index",
        message: "Nothing to commit.",
      });
    });
    const err = await screen.findByTestId("git-commit-error");
    expect(err).toHaveTextContent(/modified externally/i);
    expect(err).toHaveTextContent(/refresh and try again/i);
  });

  it("surfaces detached_head with the terminal-grade fix copy", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByTestId("git-commit-message"), "feat: x");
    await user.click(screen.getByTestId("git-commit-submit"));
    const opts = commitState.mutate.mock.calls[0]![1] as {
      onSuccess: (r: GitCommitResult) => void;
    };
    act(() => {
      opts.onSuccess({
        ok: false,
        reason: "detached_head",
        message: "HEAD is detached.",
      });
    });
    const err = await screen.findByTestId("git-commit-error");
    expect(err).toHaveTextContent(/HEAD is detached/i);
    expect(err).toHaveTextContent(/from the terminal/i);
  });

  it("surfaces unknown_path and triggers a status refetch", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByTestId("git-commit-message"), "feat: x");
    await user.click(screen.getByTestId("git-commit-submit"));

    const opts = commitState.mutate.mock.calls[0]![1] as {
      onSuccess: (r: GitCommitResult) => void;
    };
    act(() => {
      opts.onSuccess({
        ok: false,
        reason: "unknown_path",
        message: "Unknown path(s): a.txt",
      });
    });
    const err = await screen.findByTestId("git-commit-error");
    expect(err).toHaveTextContent(/no longer exist/i);
    expect(err).toHaveTextContent(/refreshing/i);
    // The "your view of the world is stale" failure mode forces a porcelain
    // refetch so the next click works against fresh data.
    await waitFor(() => expect(statusState.refetch).toHaveBeenCalled());
  });

  it("falls back to the raw server message on `unknown` reasons", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByTestId("git-commit-message"), "feat: x");
    await user.click(screen.getByTestId("git-commit-submit"));

    const opts = commitState.mutate.mock.calls[0]![1] as {
      onSuccess: (r: GitCommitResult) => void;
    };
    act(() => {
      opts.onSuccess({
        ok: false,
        reason: "unknown",
        message: "fatal: something the classifier didn't recognise",
      });
    });
    const err = await screen.findByTestId("git-commit-error");
    expect(err).toHaveTextContent(/something the classifier/i);
  });

  it("surfaces a transport rejection without crashing", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByTestId("git-commit-message"), "feat: x");
    await user.click(screen.getByTestId("git-commit-submit"));

    const opts = commitState.mutate.mock.calls[0]![1] as {
      onError: (e: Error) => void;
    };
    act(() => {
      opts.onError(new Error("ECONNREFUSED 127.0.0.1:52077"));
    });
    const err = await screen.findByTestId("git-commit-error");
    expect(err).toHaveTextContent(/ECONNREFUSED/);
  });
});

// ─── Open lifecycle ─────────────────────────────────────────────────────────

describe("GitCommitDialog — open lifecycle", () => {
  it("does not invoke the commit mutation merely by opening", () => {
    renderDialog();
    expect(commitState.mutate).not.toHaveBeenCalled();
  });
});
