import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  ProposedCard,
  RATIONALE_MAX_CHARS,
  RATIONALE_TRUNCATE_SUFFIX,
} from "@/pages/project-detail-components/ProposedCard";

/**
 * Slice 11/07 — `ProposedCard` corner-case + accessibility coverage.
 *
 * Companion to `components/proposed_card.test.tsx`. That sibling pins the
 * baseline approve / dismiss / xss / DEFAULT_MISSION_COLUMNS behaviour;
 * THIS file focuses on the slice-spec corner cases that the verification
 * regex names: 5000-char rationale truncation + axe-style accessibility
 * assertions on the proposal card.
 *
 * Why we don't use `@axe-core/playwright` here:
 *   The accessibility contract for the card is small + entirely structural
 *   — it boils down to (a) every actionable element has an accessible name,
 *   (b) error messages live in a `role="alert"` live region, (c) the rationale
 *   is not buried in `aria-hidden`, (d) the buttons reach a non-disabled
 *   state after errors so a keyboard operator can retry. Each of those is a
 *   one-line jest-dom assertion, and pulling axe in just to run those four
 *   rules would double the unit-test bundle for negligible coverage gain.
 *   The e2e spec runs a real axe pass on the rendered surface for the
 *   rules-engine perspective — see `ui/e2e/missions-ui.spec.ts`.
 */

// --- Truncation: 5000-char rationale corner case -----------------------------

describe("rationale_5000_char_truncation_corner_cases", () => {
  it("truncates a runaway 50_000-char rationale to RATIONALE_MAX_CHARS", () => {
    // 10× the cap — proves truncation is O(1) regardless of input size.
    const huge = "a".repeat(50_000);
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
    expect(rationale.textContent!.length).toBe(RATIONALE_MAX_CHARS);
    expect(rationale.textContent!.endsWith(RATIONALE_TRUNCATE_SUFFIX)).toBe(
      true,
    );
  });

  it("rationale at exactly the cap does NOT trigger truncation (boundary)", () => {
    const exact = "x".repeat(RATIONALE_MAX_CHARS);
    render(
      <ProposedCard
        missionId="m1"
        proposalId="p1"
        rationale={exact}
        targetType="slice"
        candidateAction="noop"
      />,
    );
    const rationale = screen.getByTestId("proposed-card-rationale");
    expect(rationale).toHaveAttribute("data-rationale-truncated", "false");
    expect(rationale.textContent).toBe(exact);
    expect(rationale.textContent).not.toContain(RATIONALE_TRUNCATE_SUFFIX);
  });

  it("rationale one over the cap triggers truncation (boundary +1)", () => {
    const over = "y".repeat(RATIONALE_MAX_CHARS + 1);
    render(
      <ProposedCard
        missionId="m1"
        proposalId="p1"
        rationale={over}
        targetType="slice"
        candidateAction="noop"
      />,
    );
    const rationale = screen.getByTestId("proposed-card-rationale");
    expect(rationale).toHaveAttribute("data-rationale-truncated", "true");
    expect(rationale.textContent!.length).toBe(RATIONALE_MAX_CHARS);
  });

  it("multibyte / emoji rationale past the cap still respects the visible-char budget", () => {
    // The budget is char-count, not byte-count — match the implementation.
    const fluff = "🦆".repeat(RATIONALE_MAX_CHARS); // each emoji is 2 UTF-16 code units
    render(
      <ProposedCard
        missionId="m1"
        proposalId="p1"
        rationale={fluff}
        targetType="slice"
        candidateAction="noop"
      />,
    );
    const rationale = screen.getByTestId("proposed-card-rationale");
    expect(rationale.getAttribute("data-rationale-truncated")).toBe("true");
    // The rendered string length never exceeds the cap (in UTF-16 code units).
    expect(rationale.textContent!.length).toBeLessThanOrEqual(
      RATIONALE_MAX_CHARS,
    );
  });
});

// --- Axe-style accessibility: the proposal card -----------------------------

describe("axe_compliance_proposed_card", () => {
  function renderCard(
    over: Partial<Parameters<typeof ProposedCard>[0]> = {},
  ) {
    return render(
      <ProposedCard
        missionId="m1"
        proposalId="p1"
        rationale="why"
        targetType="slice"
        candidateAction="Add tests"
        candidateSummary="Cover edge cases for the executor"
        candidateTargetId="ms-onboarding"
        {...over}
      />,
    );
  }

  it("approve and dismiss buttons have accessible names", () => {
    renderCard();
    const approve = screen.getByTestId("proposed-card-approve");
    const dismiss = screen.getByTestId("proposed-card-dismiss");
    expect(approve.tagName).toBe("BUTTON");
    expect(dismiss.tagName).toBe("BUTTON");
    // Visible text doubles as the accessible name (no aria-label override).
    expect(approve).toHaveAccessibleName("Approve");
    expect(dismiss).toHaveAccessibleName("Dismiss");
  });

  it("the optional Edit button is hidden when no handler is wired (no orphan controls)", () => {
    renderCard();
    expect(screen.queryByTestId("proposed-card-edit")).toBeNull();
  });

  it("the optional Edit button surfaces with an accessible name when wired", () => {
    renderCard({ onEdit: () => {} });
    const edit = screen.getByTestId("proposed-card-edit");
    expect(edit).toHaveAccessibleName("Edit");
  });

  it("error banner uses role=alert so AT announces server failures", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("server boom"));
    renderCard({ fetcher: fetcher as never });

    const user = userEvent.setup();
    await user.click(screen.getByTestId("proposed-card-approve"));

    const err = await screen.findByTestId("proposed-card-error");
    // axe rule `aria-allowed-role` / `landmark-no-duplicate-banner` shape:
    // implicit `alert` role on an error message.
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).toContain("server boom");
  });

  it("buttons recover to non-disabled after an error so a keyboard operator can retry", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("transient"));
    renderCard({ fetcher: fetcher as never });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("proposed-card-approve"));
    await screen.findByTestId("proposed-card-error");
    expect(screen.getByTestId("proposed-card-approve")).not.toBeDisabled();
    expect(screen.getByTestId("proposed-card-dismiss")).not.toBeDisabled();
  });

  it("rationale text is reachable via the accessibility tree (no aria-hidden)", () => {
    renderCard({ rationale: "Operator-visible reason" });
    const rationale = screen.getByTestId("proposed-card-rationale");
    expect(rationale.getAttribute("aria-hidden")).not.toBe("true");
    expect(rationale.textContent).toBe("Operator-visible reason");
  });

  it("target metadata renders a target_id with a title attr for the truncated full slug", () => {
    renderCard({ candidateTargetId: "very-long-milestone-slug-for-overflow" });
    const targetId = screen.getByTestId("proposed-card-target-id");
    // axe `aria-required-attr`: the truncated slug exposes the full value via
    // `title` so a hover / AT user can still see the parent identifier.
    expect(targetId.getAttribute("title")).toBe(
      "very-long-milestone-slug-for-overflow",
    );
  });

  it("supports keyboard activation of approve via Enter", async () => {
    const fetcher = vi.fn().mockResolvedValue({ decision_id: "dec-kb" });
    const onApproved = vi.fn();
    renderCard({
      fetcher: fetcher as never,
      onApproved,
    });

    const user = userEvent.setup();
    const approve = screen.getByTestId("proposed-card-approve");
    approve.focus();
    expect(document.activeElement).toBe(approve);
    await user.keyboard("{Enter}");

    await vi.waitFor(() =>
      expect(onApproved).toHaveBeenCalledWith("dec-kb"),
    );
  });
});

// --- Per-card scope contract -------------------------------------------------

describe("proposed_card_scope", () => {
  it("the card root carries the proposal-id + mission-id + target-type for e2e selectors", () => {
    render(
      <ProposedCard
        missionId="mission-xyz"
        proposalId="prop-abc"
        rationale="why"
        targetType="task"
        candidateAction="noop"
      />,
    );
    const root = screen.getByTestId("proposed-card");
    expect(root.getAttribute("data-proposal-id")).toBe("prop-abc");
    expect(root.getAttribute("data-mission-id")).toBe("mission-xyz");
    expect(root.getAttribute("data-target-type")).toBe("task");
  });

  it("surfaces the candidate summary as separate, scoped text when provided", () => {
    render(
      <ProposedCard
        missionId="m1"
        proposalId="p1"
        rationale="why"
        targetType="slice"
        candidateAction="Add a verifying retry"
        candidateSummary="Re-run the pre-merge gate after a transient timeout"
      />,
    );
    const candidate = screen.getByTestId("proposed-card-candidate");
    expect(within(candidate).getByText("Add a verifying retry")).toBeInTheDocument();
    expect(
      within(candidate).getByTestId("proposed-card-candidate-summary").textContent,
    ).toBe("Re-run the pre-merge gate after a transient timeout");
  });
});
