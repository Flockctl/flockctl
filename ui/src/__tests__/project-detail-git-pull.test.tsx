import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { GitPullResult } from "@/lib/types";

/**
 * UI tests for the project-header "Pull" button and its result dialog.
 *
 * The companion `project-detail.test.tsx` covers tab dispatch and the
 * page shell — this file focuses on the new git-pull surface so a
 * regression in either the button state machine (idle → pending →
 * settled) or the result-dialog copy is caught without a full E2E run.
 *
 * Both `useGitPullProject` and the page's other hooks are mocked at
 * module level so the suite does not need a QueryClientProvider, a
 * fetch mock, or a real backend — the boundary we exercise is the
 * page's interaction with the mutation's return value, not the
 * mutation's own implementation (which is covered by hooks-core).
 */

// State container that lets each test override what `useGitPullProject`
// returns and observe the mutate calls. Reset in beforeEach.
type MutationState = {
  isPending: boolean;
  // The page reads `mutate` (not `mutateAsync`); our stub captures the
  // projectId and the inline { onSuccess } callback so a test can drive
  // the dialog through any GitPullResult outcome.
  mutate: ReturnType<typeof vi.fn>;
};
let mutationState: MutationState;

vi.mock("@/pages/project-detail-components/MissionControlKpiBar", () => ({
  MissionControlKpiBar: () => <div data-testid="mission-control-kpi-bar" />,
}));
vi.mock("@/pages/project-detail-components/PlanTab", () => ({
  PlanTab: () => <div data-testid="plan-tab" />,
}));
vi.mock("@/pages/project-detail-components/RunsTab", () => ({
  RunsTab: () => <div data-testid="runs-tab" />,
}));
vi.mock("@/pages/project-detail-components/TemplatesSchedulesTab", () => ({
  TemplatesSchedulesTab: () => <div data-testid="templates-schedules-tab" />,
}));
vi.mock("@/pages/project-detail-components/ConfigTab", () => ({
  ConfigTab: () => <div data-testid="config-tab" />,
}));
vi.mock("@/components/todo-md-dialog", () => ({
  TodoMdDialog: () => null,
}));

// `useProject` returns one of two shapes depending on `withPath`. We use
// a module-scoped flag so each test can flip it before render.
let withPath = true;

vi.mock("@/lib/hooks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hooks")>(
    "@/lib/hooks",
  );
  return {
    ...actual,
    useProject: () => ({
      data: {
        id: "proj-123",
        name: "Proj 123",
        description: null,
        repo_url: null,
        path: withPath ? "/tmp/proj" : null,
        workspace_id: null,
        provider_fallback_chain: null,
        allowed_key_ids: null,
        gitignore_flockctl: false,
        gitignore_todo: false,
        gitignore_agents_md: false,
        use_project_claude_skills: false,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
      isLoading: false,
      error: null,
    }),
    useProjectConfig: () => ({ data: { baseBranch: "main" } }),
    useAttention: () => ({ items: [], total: 0 }),
    useCreateChat: () => ({ isPending: false, mutateAsync: vi.fn() }),
    useGitPullProject: () => mutationState,
  };
});

// Import AFTER the mocks so the page picks up the mocked modules.
import ProjectDetailPage from "@/pages/project-detail";

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/proj-123"]}>
      <Routes>
        <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  withPath = true;
  mutationState = {
    isPending: false,
    mutate: vi.fn(),
  };
});

// ─── Button rendering & interaction ────────────────────────────────────────

describe("Project header — Git Pull button", () => {
  it("renders a 'Pull' button alongside the existing header actions", () => {
    renderPage();
    const btn = screen.getByTestId("project-detail-page-git-pull");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent(/pull/i);
    expect(btn).not.toBeDisabled();
  });

  it("is disabled when the project has no on-disk path (nothing to pull into)", () => {
    withPath = false;
    renderPage();
    const btn = screen.getByTestId("project-detail-page-git-pull");
    expect(btn).toBeDisabled();
    // Tooltip should explain why instead of leaving the user guessing.
    expect(btn).toHaveAttribute(
      "title",
      expect.stringContaining("no local path"),
    );
  });

  it("invokes the pull mutation with the current projectId on click", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId("project-detail-page-git-pull"));
    expect(mutationState.mutate).toHaveBeenCalledTimes(1);
    expect(mutationState.mutate.mock.calls[0]![0]).toBe("proj-123");
  });

  it("shows a 'Pulling…' label and disables the button while the mutation is in flight", () => {
    mutationState = { isPending: true, mutate: vi.fn() };
    renderPage();
    const btn = screen.getByTestId("project-detail-page-git-pull");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/pulling/i);
  });
});

// ─── GitPullResultDialog — outcome-specific copy ───────────────────────────

/**
 * Drive the page through a click → mutation success cycle by capturing
 * the inline { onSuccess } passed to `mutate` and invoking it with the
 * supplied result. Returns nothing — the assertions read the rendered
 * dialog directly.
 */
async function clickPullAndResolve(result: GitPullResult) {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("project-detail-page-git-pull"));
  const opts = mutationState.mutate.mock.calls[0]![1] as {
    onSuccess: (r: GitPullResult) => void;
  };
  act(() => {
    opts.onSuccess(result);
  });
}

describe("GitPullResultDialog — success", () => {
  it("titles the dialog 'Already up to date' when no commits were pulled", async () => {
    renderPage();
    await clickPullAndResolve({
      ok: true,
      already_up_to_date: true,
      before_sha: "abc1234abc1234abc1234abc1234abc1234abc12",
      after_sha: "abc1234abc1234abc1234abc1234abc1234abc12",
      branch: "main",
      commits_pulled: 0,
      files_changed: 0,
      summary: "Already up to date.",
    });
    const dialog = await screen.findByTestId("git-pull-result-dialog");
    // The phrase appears twice (DialogTitle + summary line) so we
    // disambiguate by role — the title MUST be a heading.
    expect(
      within(dialog).getByRole("heading", { name: /already up to date/i }),
    ).toBeInTheDocument();
    // Suppress the SHA before/after line on no-op pulls — there's nothing
    // useful to show when the SHAs are equal.
    expect(within(dialog).queryByText(/→/)).not.toBeInTheDocument();
  });

  it("titles 'Pull complete' and shows summary + truncated SHAs when commits were pulled", async () => {
    const before = "abc1234abc1234abc1234abc1234abc1234abc12";
    const after = "def5678def5678def5678def5678def5678def56";
    renderPage();
    await clickPullAndResolve({
      ok: true,
      already_up_to_date: false,
      before_sha: before,
      after_sha: after,
      branch: "feature-x",
      commits_pulled: 3,
      files_changed: 7,
      summary: "Pulled 3 commits, 7 files changed.",
    });
    const dialog = await screen.findByTestId("git-pull-result-dialog");
    expect(within(dialog).getByText(/pull complete/i)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Pulled 3 commits, 7 files changed\./),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/feature-x/)).toBeInTheDocument();
    // SHAs truncated to the first 7 chars — full 40-char SHAs would
    // overflow the dialog and add no information.
    expect(within(dialog).getByText(before.slice(0, 7))).toBeInTheDocument();
    expect(within(dialog).getByText(after.slice(0, 7))).toBeInTheDocument();
    expect(within(dialog).queryByText(before)).not.toBeInTheDocument();
  });

  it("closes the dialog when the Close button is clicked", async () => {
    const user = userEvent.setup();
    renderPage();
    await clickPullAndResolve({
      ok: true,
      already_up_to_date: true,
      before_sha: "x",
      after_sha: "x",
      branch: "main",
      commits_pulled: 0,
      files_changed: 0,
      summary: "Already up to date.",
    });
    const dialog = await screen.findByTestId("git-pull-result-dialog");
    // Two "Close" controls live in a Radix Dialog: the explicit footer
    // <Button>, and the corner X with `<span class="sr-only">Close</span>`.
    // The footer button is the one we expose to the user, so target that
    // explicitly via its outline variant + visible text.
    const closeButtons = within(dialog).getAllByRole("button", { name: /close/i });
    const footerClose = closeButtons.find((b) => b.textContent?.trim() === "Close");
    expect(footerClose).toBeDefined();
    await user.click(footerClose!);
    expect(
      screen.queryByTestId("git-pull-result-dialog"),
    ).not.toBeInTheDocument();
  });
});

describe("GitPullResultDialog — failure", () => {
  // For each `GitPullReason` we ship, assert the headline copy is the
  // operator-friendly phrasing the dialog promises. A regression where
  // a new reason ships without a matching headline shows up here as a
  // "git pull failed." fallback being rendered instead of the specific
  // copy below — caught immediately, before reaching the user.
  const REASON_HEADLINES: Array<{
    reason: Extract<GitPullResult, { ok: false }>["reason"];
    pattern: RegExp;
  }> = [
    { reason: "not_a_git_repo", pattern: /not a git repository/i },
    { reason: "no_upstream", pattern: /no upstream/i },
    { reason: "dirty_working_tree", pattern: /uncommitted changes/i },
    { reason: "non_fast_forward", pattern: /diverged|fast-forward/i },
    { reason: "auth_failed", pattern: /authentication/i },
    { reason: "network_error", pattern: /could not reach/i },
  ];

  for (const { reason, pattern } of REASON_HEADLINES) {
    it(`renders a reason-specific headline for reason='${reason}'`, async () => {
      renderPage();
      await clickPullAndResolve({
        ok: false,
        reason,
        message: "msg-for-" + reason,
        stderr: "stderr-for-" + reason,
      });
      const dialog = await screen.findByTestId("git-pull-result-dialog");
      expect(within(dialog).getByText(/pull failed/i)).toBeInTheDocument();
      expect(within(dialog).getByText(pattern)).toBeInTheDocument();
      // The structured `message` from the server always renders verbatim
      // — operators read it for the recovery hint (e.g. `git push -u …`).
      expect(within(dialog).getByText("msg-for-" + reason)).toBeInTheDocument();
    });
  }

  it("renders the raw stderr block when present (so operators can copy/paste)", async () => {
    renderPage();
    await clickPullAndResolve({
      ok: false,
      reason: "non_fast_forward",
      message: "fatal: Not possible to fast-forward, aborting.",
      stderr: "fatal: Not possible to fast-forward, aborting.\nhint: see git pull docs",
    });
    const dialog = await screen.findByTestId("git-pull-result-dialog");
    const stderrBlock = within(dialog).getByTestId("git-pull-stderr");
    expect(stderrBlock).toBeInTheDocument();
    expect(stderrBlock).toHaveTextContent(/Not possible to fast-forward/);
    expect(stderrBlock).toHaveTextContent(/see git pull docs/);
    // It must be a <pre>-style element so multi-line stderr survives.
    expect(stderrBlock.tagName).toBe("PRE");
  });

  it("omits the stderr block when the failure result has no stderr field", async () => {
    renderPage();
    await clickPullAndResolve({
      ok: false,
      reason: "dirty_working_tree",
      message: "Working tree has uncommitted changes (3 files).",
      // no `stderr` — the working-tree-clean check happens locally on the
      // server, so there's no upstream stderr to pass through.
    });
    const dialog = await screen.findByTestId("git-pull-result-dialog");
    expect(
      within(dialog).queryByTestId("git-pull-stderr"),
    ).not.toBeInTheDocument();
  });

  it("synthesises a graceful failure dialog when the mutation rejects (transport error)", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId("project-detail-page-git-pull"));
    // Simulate apiFetch throwing — the page's onError handler must turn
    // it into a `{ ok: false, reason: "unknown" }` result so the user
    // never sees a crashed page.
    const opts = mutationState.mutate.mock.calls[0]![1] as {
      onError: (e: Error) => void;
    };
    act(() => {
      opts.onError(new Error("ECONNREFUSED 127.0.0.1:52077"));
    });
    const dialog = await screen.findByTestId("git-pull-result-dialog");
    // For the `unknown` fallback, the headline copy is "git pull failed."
    // — same string that lives in the DialogTitle. Disambiguate by role.
    expect(
      within(dialog).getByRole("heading", { name: /pull failed/i }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/ECONNREFUSED 127\.0\.0\.1:52077/),
    ).toBeInTheDocument();
  });
});
