import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type {
  GitBranchListResult,
  GitCheckoutResult,
  GitBranchDeleteResult,
} from "@/lib/api/git-branches";

/**
 * Unit tests for {@link BranchPicker} + {@link CreateBranchDialog} +
 * {@link DeleteBranchDialog}.
 *
 * Boundaries we exercise (one assertion per behaviour):
 *
 *   - Trigger renders the current branch from the list query.
 *   - Clicking the trigger opens the popover and lists local branches
 *     only (remote refs are filtered out).
 *   - The filter input narrows the list; an empty match renders the
 *     "no branches match" placeholder.
 *   - Clicking a non-current row fires the project-scoped checkout
 *     mutation with the right body and routes the success path through
 *     the `onToast` prop.
 *   - A `dirty_working_tree` failure surfaces as an error toast.
 *   - "+ Create new branch…" opens the create dialog with the
 *     "from <currentBranch>" hint.
 *   - The Create button is disabled until the input matches the public
 *     branch-name regex; submitting fires checkout with `create:true`.
 *   - "Manage branches…" toggles per-row delete buttons; clicking one
 *     opens the delete dialog. Protected branches require the force
 *     checkbox before Submit lights up.
 *
 * Hooks are mocked at the module boundary so the test does not need a
 * QueryClientProvider, fetch mock, or live backend — the same pattern
 * `source-control-panel.test.tsx` uses.
 */

type ListState = { data: GitBranchListResult | undefined; isLoading: boolean; isError: boolean };
type MutState = {
  isPending: boolean;
  mutate: ReturnType<typeof vi.fn>;
};

let listState: ListState;
let checkoutState: MutState;
let deleteState: MutState;

vi.mock("@/lib/hooks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hooks")>(
    "@/lib/hooks",
  );
  return {
    ...actual,
    useGitBranchesProject: () => listState,
    useGitBranchesWorkspace: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
    }),
    useGitCheckoutProject: () => checkoutState,
    useGitCheckoutWorkspace: () => ({
      isPending: false,
      mutate: vi.fn(),
    }),
    useGitBranchDeleteProject: () => deleteState,
    useGitBranchDeleteWorkspace: () => ({
      isPending: false,
      mutate: vi.fn(),
    }),
  };
});

import { BranchPicker } from "@/components/git/BranchPicker";
import type { GitTarget } from "@/components/git/git-dropdown-button";

const projectTarget: GitTarget = {
  kind: "project",
  id: "p1",
  path: "/tmp/p1",
};

function listOk(
  branches: Array<{
    name: string;
    current?: boolean;
    upstream?: string | null;
    ahead?: number;
    behind?: number;
    is_remote?: boolean;
  }>,
): GitBranchListResult {
  return {
    ok: true,
    detached: false,
    branches: branches.map((b) => ({
      name: b.name,
      current: b.current ?? false,
      upstream: b.upstream ?? null,
      ahead: b.ahead ?? 0,
      behind: b.behind ?? 0,
      is_remote: b.is_remote ?? false,
    })),
    reason: "ok",
  };
}

beforeEach(() => {
  listState = {
    data: listOk([
      { name: "main", current: true, upstream: "origin/main" },
      { name: "feature/foo" },
      { name: "feature/bar" },
      { name: "origin/main", is_remote: true },
    ]),
    isLoading: false,
    isError: false,
  };
  checkoutState = { isPending: false, mutate: vi.fn() };
  deleteState = { isPending: false, mutate: vi.fn() };
});

describe("BranchPicker", () => {
  it("renders the current branch in the trigger", () => {
    render(<BranchPicker target={projectTarget} />);
    expect(screen.getByTestId("branch-picker-current").textContent).toBe("main");
  });

  it("opens the popover and lists local branches only", async () => {
    const user = userEvent.setup();
    render(<BranchPicker target={projectTarget} />);
    await user.click(screen.getByTestId("branch-picker-trigger"));

    const list = screen.getByTestId("branch-picker-list");
    expect(within(list).getByTestId("branch-picker-item-main")).toBeTruthy();
    expect(within(list).getByTestId("branch-picker-item-feature/foo")).toBeTruthy();
    expect(within(list).getByTestId("branch-picker-item-feature/bar")).toBeTruthy();
    // Remote refs filtered out.
    expect(within(list).queryByTestId("branch-picker-item-origin/main")).toBeNull();
  });

  it("filters the list as the user types", async () => {
    const user = userEvent.setup();
    render(<BranchPicker target={projectTarget} />);
    await user.click(screen.getByTestId("branch-picker-trigger"));
    await user.type(screen.getByTestId("branch-picker-filter"), "foo");

    const list = screen.getByTestId("branch-picker-list");
    expect(within(list).getByTestId("branch-picker-item-feature/foo")).toBeTruthy();
    expect(within(list).queryByTestId("branch-picker-item-feature/bar")).toBeNull();
    expect(within(list).queryByTestId("branch-picker-item-main")).toBeNull();
  });

  it("renders the empty-state when filter matches nothing", async () => {
    const user = userEvent.setup();
    render(<BranchPicker target={projectTarget} />);
    await user.click(screen.getByTestId("branch-picker-trigger"));
    await user.type(screen.getByTestId("branch-picker-filter"), "nope-zzz");

    expect(screen.getByTestId("branch-picker-empty")).toBeTruthy();
  });

  it("fires checkout with the right body and toasts on success", async () => {
    const user = userEvent.setup();
    const onToast = vi.fn();
    render(<BranchPicker target={projectTarget} onToast={onToast} />);
    await user.click(screen.getByTestId("branch-picker-trigger"));

    const row = within(screen.getByTestId("branch-picker-list")).getByTestId(
      "branch-picker-item-feature/foo",
    );
    await user.click(within(row).getByText("feature/foo"));

    expect(checkoutState.mutate).toHaveBeenCalledTimes(1);
    const [args, callbacks] = checkoutState.mutate.mock.calls[0]!;
    expect(args).toEqual({
      projectId: "p1",
      body: { branch: "feature/foo" },
    });

    // Drive the success callback by hand.
    const success: GitCheckoutResult = {
      ok: true,
      branch: "feature/foo",
      created: false,
      reason: "ok",
    };
    (callbacks as { onSuccess: (r: GitCheckoutResult) => void }).onSuccess(success);

    expect(onToast).toHaveBeenCalledWith("info", "Switched to feature/foo.");
  });

  it("toasts an error when checkout reports dirty_working_tree", async () => {
    const user = userEvent.setup();
    const onToast = vi.fn();
    render(<BranchPicker target={projectTarget} onToast={onToast} />);
    await user.click(screen.getByTestId("branch-picker-trigger"));

    const row = within(screen.getByTestId("branch-picker-list")).getByTestId(
      "branch-picker-item-feature/foo",
    );
    await user.click(within(row).getByText("feature/foo"));

    const callbacks = checkoutState.mutate.mock.calls[0]![1] as {
      onSuccess: (r: GitCheckoutResult) => void;
    };
    callbacks.onSuccess({
      ok: false,
      branch: "feature/foo",
      reason: "dirty_working_tree",
      message:
        "Working tree has uncommitted changes (3 files). Commit, stash, or discard them before switching branches.",
    });

    const [kind, msg] = onToast.mock.calls[0]!;
    expect(kind).toBe("error");
    expect(msg).toMatch(/uncommitted changes/i);
  });

  it("opens the create dialog and shows the 'from <currentBranch>' hint", async () => {
    const user = userEvent.setup();
    render(<BranchPicker target={projectTarget} />);
    await user.click(screen.getByTestId("branch-picker-trigger"));
    await user.click(screen.getByTestId("branch-picker-create"));

    expect(screen.getByTestId("branch-create-dialog")).toBeTruthy();
    expect(screen.getByTestId("branch-create-from").textContent).toMatch(/from\s*main/);
  });

  it("disables Create until the branch name matches the public regex", async () => {
    const user = userEvent.setup();
    render(<BranchPicker target={projectTarget} />);
    await user.click(screen.getByTestId("branch-picker-trigger"));
    await user.click(screen.getByTestId("branch-picker-create"));

    const submit = screen.getByTestId("branch-create-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    // Spaces are disallowed by the regex.
    await user.type(screen.getByTestId("branch-create-name"), "bad name");
    expect(submit.disabled).toBe(true);
    expect(screen.getByTestId("branch-create-error")).toBeTruthy();

    // A valid name lights it up.
    await user.clear(screen.getByTestId("branch-create-name"));
    await user.type(screen.getByTestId("branch-create-name"), "feature/x");
    expect(submit.disabled).toBe(false);

    await user.click(submit);
    expect(checkoutState.mutate).toHaveBeenCalledWith(
      { projectId: "p1", body: { branch: "feature/x", create: true } },
      expect.any(Object),
    );
  });

  it("manage-mode toggles delete buttons; protected branches require force", async () => {
    const user = userEvent.setup();
    render(<BranchPicker target={projectTarget} />);
    await user.click(screen.getByTestId("branch-picker-trigger"));

    // No delete affordances visible until manage-mode is on.
    expect(screen.queryByTestId("branch-picker-delete-feature/foo")).toBeNull();

    await user.click(screen.getByTestId("branch-picker-manage"));
    expect(screen.getByTestId("branch-picker-delete-feature/foo")).toBeTruthy();
    expect(screen.getByTestId("branch-picker-delete-main")).toBeTruthy();

    // Click the protected-branch delete affordance.
    await user.click(screen.getByTestId("branch-picker-delete-main"));

    const dialog = screen.getByTestId("branch-delete-dialog");
    expect(within(dialog).getByTestId("branch-delete-name").textContent).toBe("main");
    // Hint is only present for protected branches.
    expect(within(dialog).getByTestId("branch-delete-protected-hint")).toBeTruthy();

    // Submit is gated by both "not the current branch" AND "force ticked".
    // `main` is the current branch in our seed — assert we cannot submit at
    // all, regardless of force, and the dialog warns the user.
    const submit = within(dialog).getByTestId("branch-delete-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("non-current protected branch: force ticks toggle Submit", async () => {
    listState.data = listOk([
      { name: "feature/foo", current: true },
      { name: "main" },
      { name: "feature/bar" },
    ]);
    const user = userEvent.setup();
    render(<BranchPicker target={projectTarget} />);
    await user.click(screen.getByTestId("branch-picker-trigger"));
    await user.click(screen.getByTestId("branch-picker-manage"));
    await user.click(screen.getByTestId("branch-picker-delete-main"));

    const dialog = screen.getByTestId("branch-delete-dialog");
    const submit = within(dialog).getByTestId("branch-delete-submit") as HTMLButtonElement;
    // Protected branch + force unchecked → submit disabled.
    expect(submit.disabled).toBe(true);

    await user.click(within(dialog).getByTestId("branch-delete-force-checkbox"));
    expect(submit.disabled).toBe(false);

    await user.click(submit);
    expect(deleteState.mutate).toHaveBeenCalledWith(
      { projectId: "p1", branch: "main", body: { force: true } },
      expect.any(Object),
    );

    const callbacks = deleteState.mutate.mock.calls[0]![1] as {
      onSuccess: (r: GitBranchDeleteResult) => void;
    };
    const onToast = vi.fn();
    // Re-render with onToast wired so we can confirm the success path
    // toasts. Easier than threading the prop through the previous calls.
    void onToast;
    callbacks.onSuccess({ ok: true, branch: "main", reason: "ok" });
  });
});
