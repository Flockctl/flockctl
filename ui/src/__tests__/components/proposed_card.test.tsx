import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SliceBoard } from "@/pages/project-detail-components/SliceBoard";
import {
  ProposedCard,
  RATIONALE_MAX_CHARS,
  RATIONALE_TRUNCATE_SUFFIX,
} from "@/pages/project-detail-components/ProposedCard";
import {
  DEFAULT_MISSION_COLUMNS,
  DEFAULT_SLICE_COLUMNS,
} from "@/pages/project-detail-components/slice-board-types";
import type { BoardProposal } from "@/pages/project-detail-components/SliceBoard";

/**
 * Verification suite for milestone 09 slice 06 task 02 — "Proposed column
 * in SliceBoard". Test names map 1:1 to the parent slice's corner cases:
 *
 *   - slice_board_with_mission_scope         (5-column variant in use)
 *   - rationale_text_is_html_escaped         (XSS via supervisor rationale)
 *   - approve_button                         (POST /approve, stale-toast guard)
 *   - dismiss_button                         (prompt for reason → POST /dismiss)
 *   - rationale_5000_char_truncation         (defense-in-depth visible cap)
 *   - extension_contract_proof               (DEFAULT_MISSION_COLUMNS == 5 cols)
 *
 * The verification regex in the slice spec
 *   `slice_board_with_mission_scope|approve_button|dismiss_button|rationale_text_is_html_escaped`
 * matches these `describe`/`it` names verbatim.
 */

function makeProposal(over: Partial<BoardProposal> = {}): BoardProposal {
  return {
    proposalId: "prop-1",
    missionId: "mission-1",
    rationale:
      "The auto-executor stalled on `slice-foo` for >30m; propose a verifying retry.",
    targetType: "slice",
    candidateAction: "Retry verifying slice-foo with fresh context",
    candidateSummary: "Re-run verifying step after pulling latest plan files.",
    candidateTargetId: "ms-onboarding",
    ...over,
  };
}

// --- DEFAULT_MISSION_COLUMNS contract -----------------------------------------

describe("extension_contract_proof — DEFAULT_MISSION_COLUMNS shape", () => {
  it("exports exactly five columns in Proposed → Pending → Active → Verifying → Completed order", () => {
    expect(DEFAULT_MISSION_COLUMNS).toHaveLength(5);
    expect(DEFAULT_MISSION_COLUMNS.map((c) => c.id)).toEqual([
      "proposed",
      "pending",
      "active",
      "verifying",
      "completed",
    ]);
  });

  it("Proposed column has empty matchStatuses (proposals route through `proposals` prop, not status grouping)", () => {
    const proposed = DEFAULT_MISSION_COLUMNS[0]!;
    expect(proposed.id).toBe("proposed");
    expect(proposed.matchStatuses).toEqual([]);
  });

  it("DEFAULT_SLICE_COLUMNS is unchanged (3 cols, no proposed)", () => {
    expect(DEFAULT_SLICE_COLUMNS.map((c) => c.id)).toEqual([
      "pending",
      "active",
      "completed",
    ]);
  });
});

// --- slice_board_with_mission_scope ------------------------------------------

describe("slice_board_with_mission_scope", () => {
  it("slice_board_with_mission_scope renders 5 columns when DEFAULT_MISSION_COLUMNS is in use", () => {
    render(
      <SliceBoard
        slices={[]}
        columns={DEFAULT_MISSION_COLUMNS}
        proposals={[]}
        milestoneTitleFor={() => "ms"}
        onSelectSlice={() => {}}
      />,
    );

    const cols = screen.getAllByTestId("slice-board-column");
    expect(cols).toHaveLength(5);
    expect(cols.map((c) => c.getAttribute("data-column-id"))).toEqual([
      "proposed",
      "pending",
      "active",
      "verifying",
      "completed",
    ]);

    // The board flags itself as mission-scoped so callers / tests can detect
    // the variant from the outside without re-reading the columns array.
    expect(screen.getByTestId("slice-board")).toHaveAttribute(
      "data-mission-scoped",
      "true",
    );
  });

  it("slice_board_with_mission_scope routes proposals into the Proposed column only", () => {
    render(
      <SliceBoard
        slices={[]}
        columns={DEFAULT_MISSION_COLUMNS}
        proposals={[makeProposal({ proposalId: "p1" }), makeProposal({ proposalId: "p2" })]}
        milestoneTitleFor={() => "ms"}
        onSelectSlice={() => {}}
      />,
    );

    const proposedCol = screen
      .getAllByTestId("slice-board-column")
      .find((el) => el.getAttribute("data-column-id") === "proposed")!;
    const cards = within(proposedCol).getAllByTestId("proposed-card");
    expect(cards.map((c) => c.getAttribute("data-proposal-id"))).toEqual([
      "p1",
      "p2",
    ]);

    // No proposed cards leaked into other columns.
    for (const id of ["pending", "active", "verifying", "completed"]) {
      const col = screen
        .getAllByTestId("slice-board-column")
        .find((el) => el.getAttribute("data-column-id") === id)!;
      expect(within(col).queryAllByTestId("proposed-card")).toHaveLength(0);
    }
  });

  it("slice_board_with_mission_scope falls back to slice columns when DEFAULT_SLICE_COLUMNS is used", () => {
    render(
      <SliceBoard
        slices={[]}
        columns={DEFAULT_SLICE_COLUMNS}
        proposals={[makeProposal()]} // proposals provided but no proposed column
        milestoneTitleFor={() => "ms"}
        onSelectSlice={() => {}}
      />,
    );

    expect(screen.getAllByTestId("slice-board-column")).toHaveLength(3);
    // Proposals are silently dropped when the column layout has no proposed
    // bucket — the board does not error on a mismatched proposals array.
    expect(screen.queryAllByTestId("proposed-card")).toHaveLength(0);
    expect(screen.getByTestId("slice-board")).toHaveAttribute(
      "data-mission-scoped",
      "false",
    );
  });
});

// --- rationale_text_is_html_escaped ------------------------------------------

describe("rationale_text_is_html_escaped", () => {
  it("rationale_text_is_html_escaped: a <script> payload renders as text, not as a real script tag", () => {
    const xssPayload =
      "<script>window.__pwn=1</script><img src=x onerror=alert(1)>";
    render(
      <ProposedCard
        missionId="m1"
        proposalId="p1"
        rationale={xssPayload}
        targetType="slice"
        candidateAction="noop"
      />,
    );

    const rationale = screen.getByTestId("proposed-card-rationale");
    // React's default escaping turns the raw payload into a text node.
    expect(rationale.textContent).toBe(xssPayload);
    // No live <script> or <img> elements were created from the payload —
    // the only nodes inside the rationale paragraph are text.
    expect(rationale.querySelector("script")).toBeNull();
    expect(rationale.querySelector("img")).toBeNull();
    // And the global side-effect from `<script>` certainly did not fire.
    expect((window as unknown as { __pwn?: number }).__pwn).toBeUndefined();
  });

  it("rationale_text_is_html_escaped: `dangerouslySetInnerHTML` is NOT used anywhere on the card", () => {
    render(
      <ProposedCard
        missionId="m1"
        proposalId="p1"
        rationale="<b>bold</b>"
        targetType="slice"
        candidateAction="noop"
      />,
    );

    // If dangerouslySetInnerHTML had rendered the markup, we'd see a real
    // <b> element. Confirm we see only the literal text.
    const rationale = screen.getByTestId("proposed-card-rationale");
    expect(rationale.querySelector("b")).toBeNull();
    expect(rationale.textContent).toBe("<b>bold</b>");
  });
});

// --- rationale_5000_char_truncation ------------------------------------------

describe("rationale_5000_char_truncation", () => {
  it("rationale longer than 5000 chars is visibly truncated with an ellipsis", () => {
    const huge = "a".repeat(7500);
    render(
      <ProposedCard
        missionId="m1"
        proposalId="p1"
        rationale={huge}
        targetType="slice"
        candidateAction="noop"
      />,
    );

    const rationale = screen.getByTestId("proposed-card-rationale");
    expect(rationale).toHaveAttribute("data-rationale-truncated", "true");
    // Visible char budget is RATIONALE_MAX_CHARS, including the ellipsis.
    expect(rationale.textContent!.length).toBe(RATIONALE_MAX_CHARS);
    expect(rationale.textContent!.endsWith(RATIONALE_TRUNCATE_SUFFIX)).toBe(
      true,
    );
  });

  it("rationale at or below the cap renders verbatim (no ellipsis, no flag)", () => {
    const ok = "x".repeat(100);
    render(
      <ProposedCard
        missionId="m1"
        proposalId="p1"
        rationale={ok}
        targetType="slice"
        candidateAction="noop"
      />,
    );
    const rationale = screen.getByTestId("proposed-card-rationale");
    expect(rationale).toHaveAttribute("data-rationale-truncated", "false");
    expect(rationale.textContent).toBe(ok);
  });
});

// --- approve_button -----------------------------------------------------------

describe("approve_button", () => {
  it("approve_button fires POST /missions/:id/proposals/:pid/approve and reports decision id", async () => {
    const fetcher = vi.fn().mockResolvedValue({ decision_id: "dec-1" });
    const onApproved = vi.fn();
    const user = userEvent.setup();

    render(
      <ProposedCard
        missionId="mission-42"
        proposalId="prop-99"
        rationale="why"
        targetType="task"
        candidateAction="Add tests for X"
        fetcher={fetcher as never}
        onApproved={onApproved}
      />,
    );

    await user.click(screen.getByTestId("proposed-card-approve"));

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe("/missions/mission-42/proposals/prop-99/approve");
    expect((init as RequestInit).method).toBe("POST");
    expect(onApproved).toHaveBeenCalledWith("dec-1");
  });

  it("approve_button stale-toast guard: a double-click only fires ONE POST", async () => {
    let resolve: ((v: { decision_id: string }) => void) | null = null;
    const fetcher = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<{ decision_id: string }>((res) => {
            resolve = res;
          }),
      );
    const onApproved = vi.fn();
    const user = userEvent.setup();

    render(
      <ProposedCard
        missionId="m1"
        proposalId="p1"
        rationale="why"
        targetType="slice"
        candidateAction="noop"
        fetcher={fetcher as never}
        onApproved={onApproved}
      />,
    );

    const btn = screen.getByTestId("proposed-card-approve");
    await user.click(btn);
    // Second click while in flight — must be ignored (button is disabled
    // and the handler short-circuits on `isSubmitting`).
    await user.click(btn);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(btn).toBeDisabled();

    // Resolve the in-flight request and assert the success callback fires once.
    resolve!({ decision_id: "dec-stale" });
    await vi.waitFor(() =>
      expect(onApproved).toHaveBeenCalledWith("dec-stale"),
    );
    expect(onApproved).toHaveBeenCalledTimes(1);
  });

  it("approve_button surfaces a server error inline without crashing", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("boom from server"));
    const user = userEvent.setup();
    render(
      <ProposedCard
        missionId="m1"
        proposalId="p1"
        rationale="why"
        targetType="slice"
        candidateAction="noop"
        fetcher={fetcher as never}
      />,
    );

    await user.click(screen.getByTestId("proposed-card-approve"));
    const err = await screen.findByTestId("proposed-card-error");
    expect(err).toHaveTextContent(/boom from server/);
    // Button is re-enabled so the operator can retry.
    expect(screen.getByTestId("proposed-card-approve")).not.toBeDisabled();
  });
});

// --- dismiss_button -----------------------------------------------------------

describe("dismiss_button", () => {
  it("dismiss_button: prompts for a reason and POSTs it to /dismiss", async () => {
    const fetcher = vi.fn().mockResolvedValue({ decision_id: "dec-d" });
    const onDismissed = vi.fn();
    const user = userEvent.setup();
    const promptReason = vi.fn().mockReturnValue("looks like a duplicate");

    render(
      <ProposedCard
        missionId="m1"
        proposalId="p1"
        rationale="why"
        targetType="slice"
        candidateAction="noop"
        fetcher={fetcher as never}
        promptReason={promptReason}
        onDismissed={onDismissed}
      />,
    );

    await user.click(screen.getByTestId("proposed-card-dismiss"));

    expect(promptReason).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe("/missions/m1/proposals/p1/dismiss");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ reason: "looks like a duplicate" });

    expect(onDismissed).toHaveBeenCalledWith("dec-d", "looks like a duplicate");
  });

  it("dismiss_button: cancelling the prompt is a no-op (no POST, no callback)", async () => {
    const fetcher = vi.fn();
    const onDismissed = vi.fn();
    const user = userEvent.setup();
    const promptReason = vi.fn().mockReturnValue(null); // user hit Cancel

    render(
      <ProposedCard
        missionId="m1"
        proposalId="p1"
        rationale="why"
        targetType="slice"
        candidateAction="noop"
        fetcher={fetcher as never}
        promptReason={promptReason}
        onDismissed={onDismissed}
      />,
    );

    await user.click(screen.getByTestId("proposed-card-dismiss"));
    expect(promptReason).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(onDismissed).not.toHaveBeenCalled();
  });

  it("dismiss_button: empty / whitespace reason is sent as no-reason body `{}`", async () => {
    const fetcher = vi.fn().mockResolvedValue({ decision_id: "dec-d2" });
    const user = userEvent.setup();
    render(
      <ProposedCard
        missionId="m1"
        proposalId="p1"
        rationale="why"
        targetType="slice"
        candidateAction="noop"
        fetcher={fetcher as never}
        promptReason={() => "   "}
      />,
    );

    await user.click(screen.getByTestId("proposed-card-dismiss"));
    const [, init] = fetcher.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({});
  });
});
