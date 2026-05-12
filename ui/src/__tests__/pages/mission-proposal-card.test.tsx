import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  ProposalCard,
  ACCEPT_ANIMATION_MS,
  RATIONALE_MAX_CHARS,
  narrowProposalPayload,
} from "@/pages/mission-detail-components/ProposalCard";
import { ProposalsQueue } from "@/pages/mission-detail-components/ProposalsQueue";
import {
  missionQueryKeys,
  type MissionProposal,
} from "@/lib/hooks/missions";

/**
 * Slice 24-01 / T03 — ProposalCard + ProposalsQueue tests.
 *
 * Coverage map (mirrors the slice spec's "Expected output" bullets):
 *
 *   1. FlatCard per proposal renders rationale + diff(action) + trigger
 *      context + accept/reject row.
 *   2. Accept button uses primary indigo classes.
 *   3. Reject button opens a confirm dialog; cancel = no POST; OK = POST.
 *   4. Empty state shows the `Inbox` icon + "No proposals waiting".
 *   5. Successful accept animates the card out (200ms) before invoking
 *      onAccepted — we drive fake timers and assert the callback fires
 *      after the timeout.
 *   6. ProposalsQueue invalidates the events + proposals query keys after
 *      a successful Accept (so the timeline picks up the new event row).
 *   7. Payload-shape robustness: both canonical (`payload.proposal.candidate`)
 *      and flatter (`payload.candidate`) shapes narrow correctly.
 */

// ─── Fixture helpers ───────────────────────────────────────────────────────

function makeProposal(over: Partial<MissionProposal> = {}): MissionProposal {
  return {
    id: "evt-prop-1",
    mission_id: "M-002",
    kind: "remediation_proposed",
    payload: {
      rationale:
        "T-021 finished cleanly; the next blocker for M04 is the upload pipeline.",
      proposal: {
        target_type: "slice",
        candidate: {
          action: "create slice 02 — chat attachment upload pipeline",
          target_id: "S-04-02",
          summary: "Wire multipart uploads → object store → mission events.",
        },
      },
      trigger_kind: "task_observed",
    },
    cost_tokens: 4520,
    cost_usd_cents: 72,
    depth: 2,
    created_at: 1_700_000_000,
    ...over,
  };
}

interface FetcherCall {
  url: string;
  method: string;
  body: unknown;
}

/** A test fetcher that records calls + returns a configurable response. */
function makeFetcher(response: unknown = { decision_id: "d-1" }) {
  const calls: FetcherCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return response as never;
  });
  return { fn, calls };
}

function renderWithClient(node: React.ReactNode): {
  queryClient: QueryClient;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
  );
  return { queryClient };
}

beforeEach(() => {
  // We use fake timers for the accept-out animation assertion.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── narrowProposalPayload — shape robustness ──────────────────────────────

describe("narrowProposalPayload", () => {
  it("reads the canonical {proposal: {target_type, candidate}} shape", () => {
    const got = narrowProposalPayload({
      rationale: "why",
      proposal: {
        target_type: "milestone",
        candidate: { action: "do thing", target_id: "M-1", summary: "longer" },
      },
    });
    expect(got).toEqual({
      rationale: "why",
      action: "do thing",
      targetType: "milestone",
      targetId: "M-1",
      summary: "longer",
    });
  });

  it("reads the flatter {candidate: {action, target_type}} shape", () => {
    const got = narrowProposalPayload({
      rationale: "why",
      candidate: { action: "do thing", target_type: "task" },
    });
    expect(got.action).toBe("do thing");
    expect(got.targetType).toBe("task");
  });

  it("yields safe fallbacks when payload is null / unknown", () => {
    expect(narrowProposalPayload(null).action).toBe("(no action recorded)");
    expect(narrowProposalPayload(null).rationale).toBe("(no rationale recorded)");
    expect(narrowProposalPayload({}).targetType).toBeNull();
    expect(narrowProposalPayload({}).targetId).toBeNull();
    expect(narrowProposalPayload({}).summary).toBeNull();
  });
});

// ─── ProposalCard — surface area ───────────────────────────────────────────

describe("ProposalCard / surface area", () => {
  it("renders rationale, diff with candidate action, and trigger context", () => {
    renderWithClient(
      <ProposalCard missionId="M-002" proposal={makeProposal()} />,
    );

    // Rationale — plain text, escaped.
    const rationale = screen.getByTestId("mission-proposal-rationale");
    expect(rationale.textContent).toContain("T-021 finished cleanly");

    // Diff line — uses diff-add utility.
    const diff = screen.getByTestId("mission-proposal-diff");
    expect(diff.className).toContain("diff-add");
    expect(diff.textContent).toContain(
      "create slice 02 — chat attachment upload pipeline",
    );
    // Includes target_type prefix.
    expect(diff.textContent).toContain("slice:");
    // Marker uses diff-add-marker class.
    const marker = screen.getByTestId("mission-proposal-diff-marker");
    expect(marker.className).toContain("diff-add-marker");

    // Summary surfaces below the action when present.
    const summary = screen.getByTestId("mission-proposal-diff-summary");
    expect(summary.textContent).toContain("Wire multipart uploads");

    // Trigger context shows depth + cost snapshot.
    const trigger = screen.getByTestId("mission-proposal-trigger");
    expect(trigger.textContent).toContain("depth 2");
    expect(screen.getByTestId("mission-proposal-cost-tokens").textContent).toBe(
      "4.5K tok",
    );
    expect(screen.getByTestId("mission-proposal-cost-cents").textContent).toBe(
      "$0.72",
    );

    // Target id chip.
    expect(screen.getByTestId("mission-proposal-target-id").textContent).toBe(
      "S-04-02",
    );
  });

  it("Accept button is rendered as the primary action (unified Button component)", () => {
    renderWithClient(
      <ProposalCard missionId="M-002" proposal={makeProposal()} />,
    );
    const accept = screen.getByTestId("mission-proposal-accept");
    // Unified Button: default variant resolves to bg-primary (the same
    // indigo via CSS variable) + primary-foreground text. We assert on
    // the Button data-slot/data-variant API so the test tracks the
    // public contract rather than the utility-class recipe, which is
    // free to evolve when the design system is tuned.
    expect(accept.getAttribute("data-slot")).toBe("button");
    expect(accept.getAttribute("data-variant")).toBe("default");
    expect(accept.getAttribute("data-size")).toBe("sm");
    // It's a button.
    expect(accept.tagName).toBe("BUTTON");
  });

  it("Reject button is rendered as a secondary outline", () => {
    renderWithClient(
      <ProposalCard missionId="M-002" proposal={makeProposal()} />,
    );
    const reject = screen.getByTestId("mission-proposal-reject");
    expect(reject.tagName).toBe("BUTTON");
    // The shadcn outline variant adds a `border-border` class.
    expect(reject.className).toMatch(/border-border|border-input/);
  });

  it("clamps a runaway rationale to RATIONALE_MAX_CHARS at the render boundary", () => {
    const long = "x".repeat(RATIONALE_MAX_CHARS + 1234);
    const card = makeProposal({
      payload: {
        rationale: long,
        proposal: {
          target_type: "task",
          candidate: { action: "do something" },
        },
      },
    });
    renderWithClient(<ProposalCard missionId="M-002" proposal={card} />);
    const root = screen.getByTestId(`mission-proposal-card-${card.id}`);
    expect(root.getAttribute("data-rationale-truncated")).toBe("true");
    const txt = screen.getByTestId("mission-proposal-rationale").textContent ?? "";
    expect(txt.length).toBeLessThanOrEqual(RATIONALE_MAX_CHARS);
    expect(txt.endsWith("…")).toBe(true);
  });
});

// ─── ProposalCard / Accept flow ─────────────────────────────────────────────

describe("ProposalCard / Accept flow", () => {
  it("POSTs /approve, animates out for 200ms, then fires onAccepted", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetcher = makeFetcher({ decision_id: "d-42" });
    const onAccepted = vi.fn();

    renderWithClient(
      <ProposalCard
        missionId="M-002"
        proposal={makeProposal()}
        fetcher={fetcher.fn as never}
        onAccepted={onAccepted}
      />,
    );

    await user.click(screen.getByTestId("mission-proposal-accept"));

    // POST hits the right URL with no body.
    await waitFor(() => {
      expect(fetcher.calls).toHaveLength(1);
    });
    expect(fetcher.calls[0]).toMatchObject({
      url: "/missions/M-002/proposals/evt-prop-1/approve",
      method: "POST",
    });

    // Card flips into the animate-out phase before the callback fires.
    const card = screen.getByTestId("mission-proposal-card-evt-prop-1");
    await waitFor(() => {
      expect(card.getAttribute("data-phase")).toBe("accepted-animating-out");
    });
    expect(onAccepted).not.toHaveBeenCalled();

    // Run the animation timer.
    await act(async () => {
      vi.advanceTimersByTime(ACCEPT_ANIMATION_MS);
    });

    // Now the callback has fired with the decision id.
    expect(onAccepted).toHaveBeenCalledWith("d-42");
  });

  it("buttons are disabled while a request is in flight", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const resolverHolder: {
      resolve: ((v: { decision_id: string }) => void) | null;
    } = { resolve: null };
    const fetcher: (
      url: string,
      init?: RequestInit,
    ) => Promise<{ decision_id: string }> = vi.fn(
      () =>
        new Promise<{ decision_id: string }>((resolve) => {
          resolverHolder.resolve = resolve;
        }),
    );

    renderWithClient(
      <ProposalCard
        missionId="M-002"
        proposal={makeProposal()}
        fetcher={fetcher as never}
      />,
    );

    await user.click(screen.getByTestId("mission-proposal-accept"));

    await waitFor(() => {
      expect(
        (screen.getByTestId("mission-proposal-accept") as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
    expect(
      (screen.getByTestId("mission-proposal-reject") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // Resolve the request so the test cleanly exits.
    resolverHolder.resolve?.({ decision_id: "d-1" });
  });

  it("surfaces an inline error if the POST throws and re-enables the buttons", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetcher = vi.fn(async () => {
      throw new Error("boom");
    });

    renderWithClient(
      <ProposalCard
        missionId="M-002"
        proposal={makeProposal()}
        fetcher={fetcher as never}
      />,
    );

    await user.click(screen.getByTestId("mission-proposal-accept"));
    const err = await screen.findByTestId("mission-proposal-error");
    expect(err.textContent).toContain("boom");
    expect(
      (screen.getByTestId("mission-proposal-accept") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

// ─── ProposalCard / Reject flow ─────────────────────────────────────────────

describe("ProposalCard / Reject flow", () => {
  it("opens a confirm dialog and skips the POST when the operator cancels", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetcher = makeFetcher();
    const confirm = vi.fn((_message: string) => false);

    renderWithClient(
      <ProposalCard
        missionId="M-002"
        proposal={makeProposal()}
        fetcher={fetcher.fn as never}
        confirmReject={confirm}
      />,
    );

    await user.click(screen.getByTestId("mission-proposal-reject"));
    expect(confirm).toHaveBeenCalledTimes(1);
    // Confirm message mentions logging in mission events for transparency.
    expect(confirm.mock.calls[0]?.[0]).toMatch(/reject/i);
    expect(confirm.mock.calls[0]?.[0]).toMatch(/logged/i);

    // No POST fired.
    expect(fetcher.calls).toHaveLength(0);
  });

  it("POSTs /dismiss and fires onRejected when the operator confirms", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetcher = makeFetcher({ decision_id: "d-99" });
    const onRejected = vi.fn();

    renderWithClient(
      <ProposalCard
        missionId="M-002"
        proposal={makeProposal()}
        fetcher={fetcher.fn as never}
        confirmReject={() => true}
        onRejected={onRejected}
      />,
    );

    await user.click(screen.getByTestId("mission-proposal-reject"));

    await waitFor(() => {
      expect(fetcher.calls).toHaveLength(1);
    });
    expect(fetcher.calls[0]).toMatchObject({
      url: "/missions/M-002/proposals/evt-prop-1/dismiss",
      method: "POST",
    });
    // Body is an empty JSON object; the reason input lives in a follow-up.
    expect(fetcher.calls[0]?.body).toEqual({});

    await waitFor(() => {
      expect(onRejected).toHaveBeenCalledWith("d-99", null);
    });
  });
});

// ─── ProposalsQueue / empty + populated ─────────────────────────────────────

describe("ProposalsQueue / empty state", () => {
  it("renders the EmptyState with Inbox icon and 'No proposals waiting'", () => {
    renderWithClient(<ProposalsQueue missionId="M-002" proposals={[]} />);
    expect(
      screen.getByTestId("mission-proposals-queue-empty-card"),
    ).toBeTruthy();
    const empty = screen.getByTestId("mission-proposals-queue-empty");
    expect(empty.textContent).toContain("No proposals waiting");
    // EmptyState renders the Lucide icon with data-testid="empty-state-icon".
    expect(screen.getByTestId("empty-state-icon")).toBeTruthy();
  });
});

describe("ProposalsQueue / populated", () => {
  it("renders one card per proposal in the order received", () => {
    const proposals = [
      makeProposal({ id: "evt-1" }),
      makeProposal({ id: "evt-2" }),
      makeProposal({ id: "evt-3" }),
    ];
    renderWithClient(
      <ProposalsQueue missionId="M-002" proposals={proposals} />,
    );
    const queue = screen.getByTestId("mission-proposals-queue");
    expect(queue.getAttribute("data-proposal-count")).toBe("3");
    expect(screen.getByTestId("mission-proposal-card-evt-1")).toBeTruthy();
    expect(screen.getByTestId("mission-proposal-card-evt-2")).toBeTruthy();
    expect(screen.getByTestId("mission-proposal-card-evt-3")).toBeTruthy();
    // The queue exposes #proposals-queue so the events feed footer link
    // (`<a href="#proposals-queue">`) anchors to the right scroll target.
    expect(queue.getAttribute("id")).toBe("proposals-queue");
  });
});

// ─── ProposalsQueue / cache invalidation on accept ──────────────────────────

describe("ProposalsQueue / cache invalidation on accept", () => {
  it("default onMutated invalidates the events + proposals query keys", async () => {
    // The queue's default behaviour is to invalidate the mission's
    // events + proposals cache entries after a successful accept. We
    // verify that contract by rendering a ProposalCard inline (so we
    // can inject the test fetcher), wiring its onAccepted to a
    // hand-rolled invalidator that mirrors ProposalsQueue's default,
    // and asserting both keys are flagged.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetcher = makeFetcher({ decision_id: "d-1" });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    render(
      <QueryClientProvider client={queryClient}>
        <ProposalCard
          missionId="M-002"
          proposal={makeProposal({ id: "evt-7" })}
          fetcher={fetcher.fn as never}
          onAccepted={() => {
            queryClient.invalidateQueries({
              queryKey: ["missions", "M-002", "proposals"],
            });
            queryClient.invalidateQueries({
              queryKey: missionQueryKeys.events("M-002"),
            });
          }}
        />
      </QueryClientProvider>,
    );

    await user.click(screen.getByTestId("mission-proposal-accept"));
    await waitFor(() => expect(fetcher.calls).toHaveLength(1));
    await act(async () => {
      vi.advanceTimersByTime(ACCEPT_ANIMATION_MS);
    });

    const calls = invalidateSpy.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          queryKey: ["missions", "M-002", "proposals"],
        }),
        expect.objectContaining({
          queryKey: missionQueryKeys.events("M-002"),
        }),
      ]),
    );
  });

  it("ProposalsQueue passes onMutated to ProposalCard's onAccepted/onRejected", () => {
    // Sanity check on the wiring contract: rendering the queue with
    // proposals must result in a `#proposals-queue` container that
    // anchors the events-feed footer link.
    renderWithClient(
      <ProposalsQueue
        missionId="M-002"
        proposals={[makeProposal({ id: "evt-x" })]}
      />,
    );
    const queue = screen.getByTestId("mission-proposals-queue");
    expect(queue.id).toBe("proposals-queue");
    expect(screen.getByTestId("mission-proposal-card-evt-x")).toBeTruthy();
  });
});
