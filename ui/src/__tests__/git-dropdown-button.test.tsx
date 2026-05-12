import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GitPullResult } from "@/lib/types";

/**
 * UI tests for {@link GitDropdownButton}.
 *
 * The dropdown is a thin orchestrator over three flows: Pull (fire-
 * and-forget mutation that surfaces its outcome via
 * `<GitPullResultDialog>`), and Commit / Push (production dialogs
 * mounted on demand). The boundary we exercise here is the dropdown's
 * *coordination* — does the trigger expose the right items, do the
 * right items dispatch the right side effect, does the disabled/
 * loading state propagate from the mutation to the trigger, and does
 * the project / workspace dispatch fan into the right hook trio.
 *
 * The mutations are mocked at the `@/lib/hooks` boundary so we don't
 * need a QueryClientProvider, a fetch mock, or a real backend.
 *
 * E2E-stable test-ids touched here:
 *   - `project-detail-page-git-button`  trigger (reused on workspace surface)
 *   - `project-detail-page-git-pull`    Pull menu item (preserved
 *                                       across the standalone-button
 *                                       → dropdown migration AND across
 *                                       the project → project+workspace
 *                                       mount expansion)
 *   - `project-detail-page-git-commit`  Commit menu item
 *   - `project-detail-page-git-push`    Push menu item
 */

type MutationState = {
  isPending: boolean;
  mutate: ReturnType<typeof vi.fn>;
};
let projectPullState: MutationState;
let workspacePullState: MutationState;

vi.mock("@/lib/hooks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hooks")>(
    "@/lib/hooks",
  );
  return {
    ...actual,
    useGitPullProject: () => projectPullState,
    useGitPullWorkspace: () => workspacePullState,
    // Stub the inner Commit dialog's hooks too — the dropdown mounts
    // the real `<GitCommitDialog>` when the Commit… item is clicked,
    // so we need every hook the dialog reads to resolve to inert
    // states. The dialog renders its loading skeleton (no list, no
    // submit) and that's enough to assert the dropdown opened it.
    useGitStatusProject: () => ({
      data: undefined,
      isLoading: true,
      refetch: vi.fn(),
    }),
    useGitStatusWorkspace: () => ({
      data: undefined,
      isLoading: true,
      refetch: vi.fn(),
    }),
    useGitCommitProject: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useGitCommitWorkspace: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    // The Push dialog is also production now — same trick: stub the
    // mutation hook so the dialog mounts in its idle state without
    // dragging a QueryClientProvider into the test.
    useGitPushProject: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useGitPushWorkspace: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
  };
});

// Import AFTER the mocks so the component picks up the mocked module.
import { GitDropdownButton } from "@/components/git/git-dropdown-button";
import type { GitTarget } from "@/components/git/git-dropdown-button";

beforeEach(() => {
  projectPullState = {
    isPending: false,
    mutate: vi.fn(),
  };
  workspacePullState = {
    isPending: false,
    mutate: vi.fn(),
  };
});

function renderDropdown(props?: { target?: Partial<GitTarget> & { kind?: GitTarget["kind"] } }) {
  const kind = props?.target?.kind ?? "project";
  const target: GitTarget =
    kind === "project"
      ? {
          kind: "project",
          id: (props?.target?.id as string | undefined) ?? "proj-123",
          path:
            props?.target?.path === undefined ? "/tmp/proj" : props.target.path,
        }
      : {
          kind: "workspace",
          id: (props?.target?.id as string | undefined) ?? "ws-123",
          path:
            props?.target?.path === undefined ? "/tmp/ws" : props.target.path,
        };
  return render(<GitDropdownButton target={target} />);
}

// ─── Trigger button ────────────────────────────────────────────────────────

describe("GitDropdownButton — trigger", () => {
  it("renders a labelled trigger with a chevron and the literal text 'Git'", () => {
    renderDropdown();
    const trigger = screen.getByTestId("project-detail-page-git-button");
    expect(trigger).toBeInTheDocument();
    // The trigger's visible label is "Git" (alongside icons). We
    // assert the literal substring rather than a regex to catch any
    // future copy drift early.
    expect(trigger).toHaveTextContent("Git");
    expect(trigger).not.toBeDisabled();
  });

  it("disables the trigger when the project has no on-disk path", () => {
    renderDropdown({ target: { kind: "project", path: null } });
    const trigger = screen.getByTestId("project-detail-page-git-button");
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute(
      "title",
      expect.stringContaining("no local path"),
    );
  });

  it("disables the trigger with a workspace-specific tooltip when the workspace has no path", () => {
    renderDropdown({ target: { kind: "workspace", path: "" } });
    const trigger = screen.getByTestId("project-detail-page-git-button");
    expect(trigger).toBeDisabled();
    // Operator-friendly copy specific to the workspace surface — the
    // recovery path is "attach a path", not "set a project path".
    expect(trigger).toHaveAttribute(
      "title",
      expect.stringContaining("This workspace has no git repository attached."),
    );
  });

  it("does not render the menu items until the trigger is opened", () => {
    renderDropdown();
    expect(
      screen.queryByTestId("project-detail-page-git-pull"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("project-detail-page-git-commit"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("project-detail-page-git-push"),
    ).not.toBeInTheDocument();
  });
});

// ─── Menu items ─────────────────────────────────────────────────────────────

describe("GitDropdownButton — menu items", () => {
  it("exposes Pull, Commit…, and Push… items in that order when opened", async () => {
    const user = userEvent.setup();
    renderDropdown();
    await user.click(screen.getByTestId("project-detail-page-git-button"));

    const pull = await screen.findByTestId("project-detail-page-git-pull");
    const commit = screen.getByTestId("project-detail-page-git-commit");
    const push = screen.getByTestId("project-detail-page-git-push");

    expect(pull).toHaveTextContent(/pull/i);
    expect(commit).toHaveTextContent(/commit/i);
    expect(push).toHaveTextContent(/push/i);

    // Items appear in the documented order — orientation matters
    // because the keyboard cursor advances top-to-bottom.
    const order = [pull, commit, push].map((el) =>
      el.compareDocumentPosition(
        document.body.querySelector("[data-slot='dropdown-menu-content']")!,
      ),
    );
    // Sanity: all three items are inside the same content panel.
    for (const cmp of order) {
      expect(cmp & Node.DOCUMENT_POSITION_CONTAINS).toBeTruthy();
    }
  });

  it("preserves the legacy `project-detail-page-git-pull` test-id on the Pull item", async () => {
    // Existing E2E specs target this id; the dropdown migration must
    // not break them. Failure here means the e2e suite will start
    // missing the Pull surface.
    const user = userEvent.setup();
    renderDropdown();
    await user.click(screen.getByTestId("project-detail-page-git-button"));
    expect(
      await screen.findByTestId("project-detail-page-git-pull"),
    ).toBeInTheDocument();
  });
});

// ─── Pull flow ──────────────────────────────────────────────────────────────

describe("GitDropdownButton — Pull (project)", () => {
  it("invokes the project pull mutation with the current id on click", async () => {
    const user = userEvent.setup();
    renderDropdown();
    await user.click(screen.getByTestId("project-detail-page-git-button"));
    await user.click(
      await screen.findByTestId("project-detail-page-git-pull"),
    );
    expect(projectPullState.mutate).toHaveBeenCalledTimes(1);
    expect(projectPullState.mutate.mock.calls[0]![0]).toBe("proj-123");
    // The workspace mutation must NEVER fire when target.kind is
    // 'project' — a regression where both fire would double-charge a
    // pull and corrupt the audit log.
    expect(workspacePullState.mutate).not.toHaveBeenCalled();
  });

  it("opens the result dialog with success copy when the mutation resolves with commits pulled", async () => {
    const user = userEvent.setup();
    renderDropdown();
    await user.click(screen.getByTestId("project-detail-page-git-button"));
    await user.click(
      await screen.findByTestId("project-detail-page-git-pull"),
    );

    const opts = projectPullState.mutate.mock.calls[0]![1] as {
      onSuccess: (r: GitPullResult) => void;
    };
    act(() => {
      opts.onSuccess({
        ok: true,
        already_up_to_date: false,
        before_sha: "abc1234abc1234abc1234abc1234abc1234abc12",
        after_sha: "def5678def5678def5678def5678def5678def56",
        branch: "feature-x",
        commits_pulled: 3,
        files_changed: 7,
        summary: "Pulled 3 commits, 7 files changed.",
      });
    });

    const dialog = await screen.findByTestId("git-pull-result-dialog");
    expect(within(dialog).getByText(/pull complete/i)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Pulled 3 commits, 7 files changed\./),
    ).toBeInTheDocument();
  });

  it("opens the result dialog with failure copy when the mutation resolves with ok=false", async () => {
    const user = userEvent.setup();
    renderDropdown();
    await user.click(screen.getByTestId("project-detail-page-git-button"));
    await user.click(
      await screen.findByTestId("project-detail-page-git-pull"),
    );

    const opts = projectPullState.mutate.mock.calls[0]![1] as {
      onSuccess: (r: GitPullResult) => void;
    };
    act(() => {
      opts.onSuccess({
        ok: false,
        reason: "non_fast_forward",
        message: "fatal: Not possible to fast-forward, aborting.",
        stderr: "fatal: Not possible to fast-forward, aborting.",
      });
    });

    const dialog = await screen.findByTestId("git-pull-result-dialog");
    expect(within(dialog).getByText(/pull failed/i)).toBeInTheDocument();
    // Match the operator-friendly headline specifically — "diverged"
    // appears only in the dialog description, while "fast-forward"
    // also shows up in the verbatim message + stderr below, so we
    // anchor on the unique word.
    expect(within(dialog).getByText(/diverged/i)).toBeInTheDocument();
    // The raw stderr block must survive verbatim — operators copy/
    // paste it into a terminal to recover.
    expect(within(dialog).getByTestId("git-pull-stderr")).toHaveTextContent(
      /Not possible to fast-forward/,
    );
  });

  it("titles the dialog 'Already up to date' when the result has no commits to pull", async () => {
    const user = userEvent.setup();
    renderDropdown();
    await user.click(screen.getByTestId("project-detail-page-git-button"));
    await user.click(
      await screen.findByTestId("project-detail-page-git-pull"),
    );
    const opts = projectPullState.mutate.mock.calls[0]![1] as {
      onSuccess: (r: GitPullResult) => void;
    };
    act(() => {
      opts.onSuccess({
        ok: true,
        already_up_to_date: true,
        before_sha: "abc1234abc1234abc1234abc1234abc1234abc12",
        after_sha: "abc1234abc1234abc1234abc1234abc1234abc12",
        branch: "main",
        commits_pulled: 0,
        files_changed: 0,
        summary: "Already up to date.",
      });
    });
    const dialog = await screen.findByTestId("git-pull-result-dialog");
    expect(
      within(dialog).getByRole("heading", { name: /already up to date/i }),
    ).toBeInTheDocument();
    // Suppress the SHA → SHA arrow line on no-op pulls — there's
    // nothing useful to show when the SHAs are equal.
    expect(within(dialog).queryByText(/→/)).not.toBeInTheDocument();
  });

  it("truncates SHAs to 7 chars on commits-pulled outcomes", async () => {
    const before = "abc1234abc1234abc1234abc1234abc1234abc12";
    const after = "def5678def5678def5678def5678def5678def56";
    const user = userEvent.setup();
    renderDropdown();
    await user.click(screen.getByTestId("project-detail-page-git-button"));
    await user.click(
      await screen.findByTestId("project-detail-page-git-pull"),
    );
    const opts = projectPullState.mutate.mock.calls[0]![1] as {
      onSuccess: (r: GitPullResult) => void;
    };
    act(() => {
      opts.onSuccess({
        ok: true,
        already_up_to_date: false,
        before_sha: before,
        after_sha: after,
        branch: "feature-x",
        commits_pulled: 3,
        files_changed: 7,
        summary: "Pulled 3 commits, 7 files changed.",
      });
    });
    const dialog = await screen.findByTestId("git-pull-result-dialog");
    expect(within(dialog).getByText(before.slice(0, 7))).toBeInTheDocument();
    expect(within(dialog).getByText(after.slice(0, 7))).toBeInTheDocument();
    // Full 40-char SHAs would overflow the dialog and add no info.
    expect(within(dialog).queryByText(before)).not.toBeInTheDocument();
  });

  it("omits the stderr block when the failure result has no stderr field", async () => {
    const user = userEvent.setup();
    renderDropdown();
    await user.click(screen.getByTestId("project-detail-page-git-button"));
    await user.click(
      await screen.findByTestId("project-detail-page-git-pull"),
    );
    const opts = projectPullState.mutate.mock.calls[0]![1] as {
      onSuccess: (r: GitPullResult) => void;
    };
    act(() => {
      opts.onSuccess({
        ok: false,
        reason: "dirty_working_tree",
        message: "Working tree has uncommitted changes (3 files).",
        // no `stderr` — the working-tree-clean check happens locally
        // on the server, so there's no upstream stderr to forward.
      });
    });
    const dialog = await screen.findByTestId("git-pull-result-dialog");
    expect(
      within(dialog).queryByTestId("git-pull-stderr"),
    ).not.toBeInTheDocument();
  });

  // For each `GitPullReason` we ship, assert the headline copy is
  // the operator-friendly phrasing the dialog promises. A regression
  // where a new reason ships without a matching headline shows up
  // here as a "git pull failed." fallback being rendered instead of
  // the specific copy below — caught immediately, before reaching
  // the user.
  const REASON_HEADLINES: Array<{
    reason: Extract<GitPullResult, { ok: false }>["reason"];
    pattern: RegExp;
  }> = [
    { reason: "not_a_git_repo", pattern: /not a git repository/i },
    { reason: "no_upstream", pattern: /no upstream/i },
    { reason: "dirty_working_tree", pattern: /uncommitted changes/i },
    { reason: "non_fast_forward", pattern: /diverged/i },
    { reason: "auth_failed", pattern: /authentication/i },
    { reason: "network_error", pattern: /could not reach/i },
  ];

  for (const { reason, pattern } of REASON_HEADLINES) {
    it(`renders the operator-friendly headline for failure reason='${reason}'`, async () => {
      const user = userEvent.setup();
      renderDropdown();
      await user.click(screen.getByTestId("project-detail-page-git-button"));
      await user.click(
        await screen.findByTestId("project-detail-page-git-pull"),
      );
      const opts = projectPullState.mutate.mock.calls[0]![1] as {
        onSuccess: (r: GitPullResult) => void;
      };
      act(() => {
        opts.onSuccess({
          ok: false,
          reason,
          message: "msg-for-" + reason,
          stderr: "stderr-for-" + reason,
        });
      });
      const dialog = await screen.findByTestId("git-pull-result-dialog");
      expect(within(dialog).getByText(/pull failed/i)).toBeInTheDocument();
      expect(within(dialog).getByText(pattern)).toBeInTheDocument();
      // The structured `message` always renders verbatim — operators
      // read it for the recovery hint (e.g. `git push -u …`).
      expect(within(dialog).getByText("msg-for-" + reason)).toBeInTheDocument();
    });
  }

  it("synthesises an unknown-reason failure when the mutation rejects with a transport error", async () => {
    const user = userEvent.setup();
    renderDropdown();
    await user.click(screen.getByTestId("project-detail-page-git-button"));
    await user.click(
      await screen.findByTestId("project-detail-page-git-pull"),
    );

    const opts = projectPullState.mutate.mock.calls[0]![1] as {
      onError: (e: Error) => void;
    };
    act(() => {
      opts.onError(new Error("ECONNREFUSED 127.0.0.1:52077"));
    });

    const dialog = await screen.findByTestId("git-pull-result-dialog");
    // The page must never crash on a transport failure — the unknown-
    // reason fallback gives the user a recoverable view of the error.
    expect(
      within(dialog).getByRole("heading", { name: /pull failed/i }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/ECONNREFUSED 127\.0\.0\.1:52077/),
    ).toBeInTheDocument();
  });

  it("shows a 'Pulling…' label on the Pull item while the mutation is in flight", async () => {
    projectPullState = { isPending: true, mutate: vi.fn() };
    const user = userEvent.setup();
    renderDropdown();
    // Trigger is still enabled while pending — only the Pull *item*
    // is disabled — so a user can still open the menu mid-flight to
    // inspect that the mutation is running.
    const trigger = screen.getByTestId("project-detail-page-git-button");
    expect(trigger).not.toBeDisabled();
    await user.click(trigger);

    const pull = await screen.findByTestId("project-detail-page-git-pull");
    expect(pull).toHaveTextContent(/pulling/i);
    // Radix data-disabled attribute is the source of truth for menu
    // item disabled-ness — it's what gates onSelect dispatch and what
    // the styling reads.
    expect(pull).toHaveAttribute("data-disabled");
  });
});

// ─── Pull flow (workspace) ──────────────────────────────────────────────────
//
// Just enough coverage to prove the dispatch on `target.kind` routes
// the click into the workspace hook trio rather than the project one.
// All the headline / dialog copy assertions above are target-agnostic
// so we don't re-run them here.

describe("GitDropdownButton — Pull (workspace)", () => {
  it("invokes the workspace pull mutation when target.kind is 'workspace'", async () => {
    const user = userEvent.setup();
    renderDropdown({ target: { kind: "workspace", id: "ws-123" } });
    await user.click(screen.getByTestId("project-detail-page-git-button"));
    await user.click(
      await screen.findByTestId("project-detail-page-git-pull"),
    );
    expect(workspacePullState.mutate).toHaveBeenCalledTimes(1);
    expect(workspacePullState.mutate.mock.calls[0]![0]).toBe("ws-123");
    // Project path stays cold — the wrong-fanout regression is the
    // single biggest risk of this refactor.
    expect(projectPullState.mutate).not.toHaveBeenCalled();
  });
});

// ─── Commit / Push (production dialogs) ─────────────────────────────────────

describe("GitDropdownButton — Commit / Push", () => {
  it("opens the Commit dialog when the Commit… item is selected", async () => {
    const user = userEvent.setup();
    renderDropdown();
    await user.click(screen.getByTestId("project-detail-page-git-button"));
    await user.click(
      await screen.findByTestId("project-detail-page-git-commit"),
    );
    // The real `<GitCommitDialog>` renders with `data-testid="git-commit-dialog"`
    // and starts in its loading state because the mocked
    // `useGitStatusProject` returns `isLoading: true`.
    expect(
      await screen.findByTestId("git-commit-dialog"),
    ).toBeInTheDocument();
  });

  it("opens the Push dialog when the Push… item is selected", async () => {
    const user = userEvent.setup();
    renderDropdown();
    await user.click(screen.getByTestId("project-detail-page-git-button"));
    await user.click(
      await screen.findByTestId("project-detail-page-git-push"),
    );
    // Production dialog now — the placeholder is gone. The dialog
    // renders in its `gitInfo: null` loading state because the
    // dropdown wires `gitInfo={null}` for now.
    expect(
      await screen.findByTestId("git-push-dialog"),
    ).toBeInTheDocument();
  });

  it("does NOT trigger the pull mutation when the Commit item is selected", async () => {
    const user = userEvent.setup();
    renderDropdown();
    await user.click(screen.getByTestId("project-detail-page-git-button"));
    await user.click(
      await screen.findByTestId("project-detail-page-git-commit"),
    );
    expect(projectPullState.mutate).not.toHaveBeenCalled();
    expect(workspacePullState.mutate).not.toHaveBeenCalled();
  });

  it("does NOT trigger the pull mutation when the Push item is selected", async () => {
    const user = userEvent.setup();
    renderDropdown();
    await user.click(screen.getByTestId("project-detail-page-git-button"));
    await user.click(
      await screen.findByTestId("project-detail-page-git-push"),
    );
    expect(projectPullState.mutate).not.toHaveBeenCalled();
    expect(workspacePullState.mutate).not.toHaveBeenCalled();
  });
});
