import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GitPushResult } from "@/lib/types";

/**
 * Unit tests for {@link GitPushDialog}.
 *
 * The dialog is presentational on `gitInfo` (passed as a prop) and on
 * the result of the `useGitPushProject` mutation (mocked here). What
 * we exercise is the dialog's *coordination*:
 *
 *   1. The summary row reflects the supplied branch/remote.
 *   2. The Advanced disclosure stays collapsed by default.
 *   3. The "Set upstream" toggle is enabled only when the branch has
 *      no upstream.
 *   4. The Force-push button is disabled until the literal "force" is
 *      typed, AND clearing the input after typing it disables the
 *      button again — and the click handler reads the LIVE input value
 *      via a ref BEFORE submitting (defence-in-depth against a stale
 *      React state snapshot).
 *   5. Each `GitPushReason` renders the operator-friendly inline error
 *      copy; `auth_failed` specifically renders the dedicated hint
 *      card with the docs link.
 *
 * The mutation is mocked at the `@/lib/hooks` boundary so we don't need
 * a `QueryClientProvider` or a fetch mock — the dialog only reads
 * `isPending` and calls `mutate(arg, opts)`, both of which we control
 * here.
 */

type MutationState = {
  isPending: boolean;
  mutate: ReturnType<typeof vi.fn>;
};
let mutationState: MutationState;

vi.mock("@/lib/hooks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hooks")>(
    "@/lib/hooks",
  );
  return {
    ...actual,
    useGitPushProject: () => mutationState,
    // Workspace hook is called unconditionally by the dialog
    // (rules-of-hooks). We stub it inert — only the active branch
    // (project, here) drives `mutate`.
    useGitPushWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

// Import AFTER the mock so the component picks up the mocked module.
import { GitPushDialog } from "@/components/git/git-push-dialog";
import type { GitInfo } from "@/components/git/git-push-dialog";

beforeEach(() => {
  mutationState = {
    isPending: false,
    mutate: vi.fn(),
  };
});

const DEFAULT_INFO: GitInfo = {
  branch: "feature-x",
  remote: "origin",
  hasUpstream: true,
};

function renderDialog(overrides?: {
  gitInfo?: GitInfo | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return render(
    <GitPushDialog
      target={{ kind: "project", id: "proj-1", path: "/tmp/proj" }}
      open={overrides?.open ?? true}
      onOpenChange={overrides?.onOpenChange ?? (() => {})}
      gitInfo={
        overrides?.gitInfo === undefined ? DEFAULT_INFO : overrides.gitInfo
      }
    />,
  );
}

// ─── Summary row ────────────────────────────────────────────────────────────

describe("GitPushDialog — summary row", () => {
  it("shows the branch and remote from gitInfo", () => {
    renderDialog();
    const dialog = screen.getByTestId("git-push-dialog");
    expect(within(dialog).getByTestId("git-push-dialog-branch")).toHaveTextContent(
      "feature-x",
    );
    expect(within(dialog).getByTestId("git-push-dialog-remote")).toHaveTextContent(
      "origin",
    );
  });

  it("shows a loading placeholder when gitInfo is null and disables submit", () => {
    renderDialog({ gitInfo: null });
    const dialog = screen.getByTestId("git-push-dialog");
    expect(within(dialog).getByText(/loading branch info/i)).toBeInTheDocument();
    expect(within(dialog).getByTestId("git-push-dialog-submit")).toBeDisabled();
  });
});

// ─── Advanced disclosure ────────────────────────────────────────────────────

describe("GitPushDialog — Advanced disclosure", () => {
  it("renders the Advanced section collapsed by default", () => {
    renderDialog();
    const adv = screen.getByTestId("git-push-dialog-advanced");
    expect(adv).not.toHaveAttribute("open");
  });

  it("expands when the summary is clicked, exposing the force-zone and set-upstream toggle", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("git-push-dialog-advanced-toggle"));
    expect(
      screen.getByTestId("git-push-dialog-force-zone"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("git-push-dialog-set-upstream"),
    ).toBeInTheDocument();
  });

  it("disables 'Set upstream' when the branch already has an upstream", () => {
    renderDialog({
      gitInfo: { ...DEFAULT_INFO, hasUpstream: true },
    });
    const checkbox = screen.getByTestId("git-push-dialog-set-upstream");
    expect(checkbox).toBeDisabled();
  });

  it("enables 'Set upstream' when the branch has no upstream", () => {
    renderDialog({
      gitInfo: { ...DEFAULT_INFO, hasUpstream: false },
    });
    const checkbox = screen.getByTestId("git-push-dialog-set-upstream");
    expect(checkbox).not.toBeDisabled();
  });
});

// ─── Push (non-force) flow ──────────────────────────────────────────────────

describe("GitPushDialog — Push (non-force)", () => {
  it("invokes the push mutation with force=false on Push click", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("git-push-dialog-submit"));
    expect(mutationState.mutate).toHaveBeenCalledTimes(1);
    const [arg] = mutationState.mutate.mock.calls[0]!;
    expect(arg).toEqual({
      projectId: "proj-1",
      body: { remote: "origin", set_upstream: false, force: false },
    });
  });

  it("includes set_upstream:true when the toggle is enabled and checked", async () => {
    const user = userEvent.setup();
    renderDialog({
      gitInfo: { ...DEFAULT_INFO, hasUpstream: false },
    });
    await user.click(screen.getByTestId("git-push-dialog-advanced-toggle"));
    // Toggle defaults to false even when enabled — flip it explicitly.
    await user.click(screen.getByTestId("git-push-dialog-set-upstream"));
    await user.click(screen.getByTestId("git-push-dialog-submit"));
    const [arg] = mutationState.mutate.mock.calls[0]!;
    expect(arg.body.set_upstream).toBe(true);
    expect(arg.body.force).toBe(false);
  });
});

// ─── Force-push gate ────────────────────────────────────────────────────────

describe("GitPushDialog — force-push literal gate", () => {
  it("disables the Force push button until the input value is exactly 'force'", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("git-push-dialog-advanced-toggle"));
    const submit = screen.getByTestId("git-push-dialog-force-submit");
    const input = screen.getByTestId(
      "git-push-dialog-force-input",
    ) as HTMLInputElement;

    expect(submit).toBeDisabled();
    await user.type(input, "forc");
    expect(submit).toBeDisabled();
    await user.type(input, "e");
    expect(submit).not.toBeDisabled();
  });

  it("re-disables the Force push button after the input is cleared", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("git-push-dialog-advanced-toggle"));
    const submit = screen.getByTestId("git-push-dialog-force-submit");
    const input = screen.getByTestId(
      "git-push-dialog-force-input",
    ) as HTMLInputElement;

    await user.type(input, "force");
    expect(submit).not.toBeDisabled();

    // Clearing the input must re-disable — guards against the
    // "armed once, armed forever" footgun.
    await user.clear(input);
    expect(submit).toBeDisabled();
  });

  it("invokes the mutation with force=true on Force push click", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("git-push-dialog-advanced-toggle"));
    const input = screen.getByTestId("git-push-dialog-force-input");
    await user.type(input, "force");
    await user.click(screen.getByTestId("git-push-dialog-force-submit"));
    expect(mutationState.mutate).toHaveBeenCalledTimes(1);
    const [arg] = mutationState.mutate.mock.calls[0]!;
    expect(arg.body.force).toBe(true);
  });

  it("reads the LIVE input value on click, not a stale state snapshot", async () => {
    // Defence-in-depth: even if React state still says 'force', a
    // direct DOM mutation of the input value (e.g. by an external
    // script or a test-time race) must NOT bypass the gate. The
    // click handler reads `inputRef.current.value` at click-time.
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("git-push-dialog-advanced-toggle"));
    const input = screen.getByTestId(
      "git-push-dialog-force-input",
    ) as HTMLInputElement;
    const submit = screen.getByTestId("git-push-dialog-force-submit");

    // Type the literal so React state + button enabled-ness agree it's armed.
    await user.type(input, "force");
    expect(submit).not.toBeDisabled();

    // Now mutate the DOM input value directly WITHOUT firing
    // change events — React state still says "force", but the
    // live DOM value no longer matches. The click handler must
    // refuse to submit.
    act(() => {
      // Direct DOM assignment models the race scenario: external
      // script / clipboard quirk mutates the input without firing
      // a React `change` event, so React state still says "force".
      input.value = "forc";
    });
    await user.click(submit);
    expect(mutationState.mutate).not.toHaveBeenCalled();
  });
});

// ─── Inline error states ────────────────────────────────────────────────────

describe("GitPushDialog — error rendering", () => {
  it("renders the dedicated auth hint card with a docs link on auth_failed", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("git-push-dialog-submit"));
    const opts = mutationState.mutate.mock.calls[0]![1] as {
      onSuccess: (r: GitPushResult) => void;
    };
    act(() => {
      opts.onSuccess({
        ok: false,
        reason: "auth_failed",
        message: "credentials rejected",
      });
    });
    const hint = await screen.findByTestId("git-push-dialog-auth-hint");
    expect(within(hint).getByText(/authentication failed/i)).toBeInTheDocument();
    expect(
      within(hint).getByText(/configure your git credentials and retry/i),
    ).toBeInTheDocument();
    const link = within(hint).getByTestId("git-push-dialog-auth-docs-link");
    expect(link).toHaveAttribute("href", "https://docs.flockctl.dev/git-auth");
    // Generic error card MUST NOT render alongside the auth-specific one.
    expect(
      screen.queryByTestId("git-push-dialog-error"),
    ).not.toBeInTheDocument();
  });

  const REASON_HEADLINES: Array<{
    reason: Extract<GitPushResult, { ok: false }>["reason"];
    pattern: RegExp;
  }> = [
    {
      reason: "protected_branch",
      pattern: /Refusing to force-push .*main.*master/i,
    },
    {
      reason: "rejected_non_fast_forward",
      pattern: /Remote has new commits/i,
    },
    {
      reason: "no_upstream",
      pattern: /Branch has no upstream/i,
    },
  ];

  for (const { reason, pattern } of REASON_HEADLINES) {
    it(`renders the operator-friendly headline for reason='${reason}'`, async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByTestId("git-push-dialog-submit"));
      const opts = mutationState.mutate.mock.calls[0]![1] as {
        onSuccess: (r: GitPushResult) => void;
      };
      act(() => {
        opts.onSuccess({
          ok: false,
          reason,
          message: "msg-for-" + reason,
        });
      });
      const card = await screen.findByTestId("git-push-dialog-error");
      expect(within(card).getByText(pattern)).toBeInTheDocument();
      expect(within(card).getByText("msg-for-" + reason)).toBeInTheDocument();
      // auth-hint card stays hidden for non-auth reasons.
      expect(
        screen.queryByTestId("git-push-dialog-auth-hint"),
      ).not.toBeInTheDocument();
    });
  }

  it("synthesises an unknown-reason failure on transport error", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("git-push-dialog-submit"));
    const opts = mutationState.mutate.mock.calls[0]![1] as {
      onError: (e: Error) => void;
    };
    act(() => {
      opts.onError(new Error("ECONNREFUSED 127.0.0.1:52077"));
    });
    const card = await screen.findByTestId("git-push-dialog-error");
    expect(within(card).getByText(/git push failed/i)).toBeInTheDocument();
    expect(
      within(card).getByText(/ECONNREFUSED 127\.0\.0\.1:52077/),
    ).toBeInTheDocument();
  });
});

// ─── Loading state ──────────────────────────────────────────────────────────

describe("GitPushDialog — loading state", () => {
  it("disables both submit buttons and Cancel while the mutation is pending", async () => {
    mutationState = { isPending: true, mutate: vi.fn() };
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("git-push-dialog-advanced-toggle"));
    expect(screen.getByTestId("git-push-dialog-submit")).toBeDisabled();
    expect(screen.getByTestId("git-push-dialog-cancel")).toBeDisabled();
    // Force button still disabled because input is empty — but
    // typing 'force' should NOT enable it while a push is in flight.
    const input = screen.getByTestId("git-push-dialog-force-input");
    await user.type(input, "force");
    expect(screen.getByTestId("git-push-dialog-force-submit")).toBeDisabled();
  });
});
