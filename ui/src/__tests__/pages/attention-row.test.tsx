import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AttentionRow } from "@/pages/attention-components/AttentionRow";
import { AttentionSection } from "@/pages/attention-components/AttentionSection";
import type { AttentionInboxItem } from "@/lib/hooks/use-attention-inbox";

/**
 * Slice 24-ui-redesign-working-surfaces/04-attention, T01 — pin the
 * presentational + interaction contract for `AttentionRow` and
 * `AttentionSection`.
 *
 * Pins (mirrors `expected_output` + `negative_tests` declared in the task
 * front-matter):
 *
 *   - Row: source-coloured icon avatar + title + 1-line context + relative
 *     time + Open / Dismiss actions.
 *   - Section: `SectionHeader size="section"` rendered for each priority
 *     bucket with a leading colour swatch + count subtitle.
 *   - Negative: when the parent's `onDismiss` rejects, the row stays
 *     mounted AND surfaces the rejection message inline (the "error toast"
 *     in the spec — kept on-row so it ships in the same DOM + ARIA region
 *     and never depends on a global toast provider that the unit test
 *     doesn't mount).
 *   - Negative: a 200-character title renders verbatim in the DOM but the
 *     title node carries the Tailwind `truncate` class so visual overflow
 *     is clipped by CSS.
 */

const FIXED_NOW = new Date("2026-05-07T12:00:00Z").getTime();

beforeEach(() => {
  // Pin Date.now without `vi.useFakeTimers()` — fake timers serialize
  // setTimeout-based microtasks (which `waitFor` depends on) and would
  // make the async dismiss tests hang indefinitely. Stubbing Date.now
  // directly gives deterministic relative-time output without touching
  // the timer queue.
  vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderWithRouter(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function makeItem(overrides: Partial<AttentionInboxItem> = {}): AttentionInboxItem {
  return {
    key: "agent_question:100:req-1",
    source: "agent_question",
    priority: "normal",
    title: "Which file should I edit?",
    context: "Task #100",
    href: "/tasks/100",
    created_at: FIXED_NOW - 2 * 60 * 1000, // 2m ago
    ...overrides,
  };
}

// ─── Row: visual contract ─────────────────────────────────────────────────

describe("AttentionRow / visual contract", () => {
  it("renders title, context, relative time, and an icon avatar", () => {
    const item = makeItem();
    renderWithRouter(<AttentionRow item={item} onDismiss={vi.fn()} />);

    expect(
      screen.getByTestId(`attention-title-${item.key}`).textContent,
    ).toBe("Which file should I edit?");
    expect(
      screen.getByTestId(`attention-context-${item.key}`).textContent,
    ).toBe("Task #100");
    expect(
      screen.getByTestId(`attention-time-${item.key}`).textContent,
    ).toBe("2m");
    expect(screen.getByTestId(`attention-icon-${item.key}`)).toBeTruthy();
  });

  it("omits the context line when item.context is null", () => {
    const item = makeItem({ context: null, key: "k-no-ctx" });
    renderWithRouter(<AttentionRow item={item} onDismiss={vi.fn()} />);
    expect(screen.queryByTestId("attention-context-k-no-ctx")).toBeNull();
  });

  it.each([
    ["agent_question", "question", "bg-emerald-500/15"],
    ["mission_proposal", "proposal", "bg-amber-500/15"],
    ["failed_task", "failed", "bg-rose-500/15"],
  ] as const)(
    "%s → %s avatar with %s tint",
    (source, expectedLabel, expectedBg) => {
      const item = makeItem({
        source,
        priority: source === "failed_task" ? "critical" : "normal",
        key: `k-${source}`,
      });
      renderWithRouter(<AttentionRow item={item} onDismiss={vi.fn()} />);

      const avatar = screen.getByTestId(`attention-icon-k-${source}`);
      expect(avatar.getAttribute("data-icon")).toBe(expectedLabel);
      expect(avatar.className).toContain(expectedBg);
    },
  );

  it("Open is a Link to item.href; Dismiss is a button", () => {
    const item = makeItem({ href: "/chats/200", key: "k-link" });
    renderWithRouter(<AttentionRow item={item} onDismiss={vi.fn()} />);

    const open = screen.getByTestId("attention-open-k-link");
    expect(open.tagName).toBe("A");
    expect(open.getAttribute("href")).toBe("/chats/200");
    expect(open.textContent).toContain("Open");

    const dismiss = screen.getByTestId("attention-dismiss-k-link");
    expect(dismiss.tagName).toBe("BUTTON");
    expect(dismiss.textContent).toBe("Dismiss");
  });

  it("title node carries the Tailwind 'truncate' class", () => {
    const item = makeItem();
    renderWithRouter(<AttentionRow item={item} onDismiss={vi.fn()} />);
    const title = screen.getByTestId(`attention-title-${item.key}`);
    expect(title.className).toContain("truncate");
  });
});

// ─── Row: relative-time buckets ───────────────────────────────────────────

describe("AttentionRow / relative-time buckets", () => {
  it.each([
    [30 * 1000, "30s"],
    [5 * 60 * 1000, "5m"],
    [3 * 60 * 60 * 1000, "3h"],
    [2 * 24 * 60 * 60 * 1000, "2d"],
  ] as const)("%dms ago → %s", (delta, expected) => {
    const item = makeItem({
      created_at: FIXED_NOW - delta,
      key: `k-${delta}`,
    });
    renderWithRouter(<AttentionRow item={item} onDismiss={vi.fn()} />);
    expect(screen.getByTestId(`attention-time-k-${delta}`).textContent).toBe(
      expected,
    );
  });
});

// ─── Row: dismiss interaction ─────────────────────────────────────────────

describe("AttentionRow / dismiss happy path", () => {
  it("calls onDismiss with the item, then hides the row", async () => {
    const onDismiss = vi.fn().mockResolvedValue(undefined);
    const item = makeItem({ key: "k-happy" });

    renderWithRouter(<AttentionRow item={item} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByTestId("attention-dismiss-k-happy"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(item);

    // Pending state: button shows "Dismissing…" and is disabled while the
    // promise is in flight.
    expect(screen.getByTestId("attention-dismiss-k-happy").textContent).toBe(
      "Dismissing…",
    );

    await waitFor(() => {
      expect(screen.queryByTestId("attention-row-k-happy")).toBeNull();
    });
  });
});

describe("AttentionRow / dismiss mutation failure", () => {
  it("row stays mounted and renders an inline error toast", async () => {
    const onDismiss = vi
      .fn()
      .mockRejectedValue(new Error("dismiss endpoint blew up"));
    const item = makeItem({ key: "k-fail" });

    renderWithRouter(<AttentionRow item={item} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByTestId("attention-dismiss-k-fail"));

    // The row should NOT optimistically disappear.
    await waitFor(() => {
      expect(screen.getByTestId(`attention-error-${item.key}`)).toBeTruthy();
    });

    // Row still mounted.
    expect(screen.getByTestId(`attention-row-${item.key}`)).toBeTruthy();
    // Error message comes through verbatim.
    expect(
      screen.getByTestId(`attention-error-${item.key}`).textContent,
    ).toContain("dismiss endpoint blew up");
    // role="alert" so screen readers announce it (accessibility pin).
    expect(
      screen.getByTestId(`attention-error-${item.key}`).getAttribute("role"),
    ).toBe("alert");
    // Button is re-enabled so the user can retry.
    expect(
      (
        screen.getByTestId("attention-dismiss-k-fail") as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("handles a non-Error rejection (string thrown) with a default message", async () => {
    const onDismiss = vi.fn().mockRejectedValue("network blip"); // intentionally not Error
    const item = makeItem({ key: "k-string-fail" });

    renderWithRouter(<AttentionRow item={item} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId("attention-dismiss-k-string-fail"));

    await waitFor(() => {
      expect(
        screen.getByTestId(`attention-error-${item.key}`).textContent,
      ).toContain("Failed to dismiss item");
    });
  });
});

// ─── Negative: long titles truncate ───────────────────────────────────────

describe("AttentionRow / long title 200 chars truncates", () => {
  it("renders the full text but clips visually via Tailwind 'truncate'", () => {
    const longTitle = "x".repeat(200);
    const item = makeItem({ title: longTitle, key: "k-long" });

    renderWithRouter(<AttentionRow item={item} onDismiss={vi.fn()} />);

    const title = screen.getByTestId("attention-title-k-long");
    // Full string preserved in the DOM (no JS truncation — accessibility:
    // a screen reader gets the full title; CSS handles visual clipping).
    expect(title.textContent).toBe(longTitle);
    expect(title.textContent?.length).toBe(200);
    // `truncate` is the Tailwind utility that paints
    // overflow-hidden + whitespace-nowrap + text-ellipsis.
    expect(title.className).toContain("truncate");
  });

  it("context line also carries 'truncate' for long context strings", () => {
    const longCtx = "Mission ".concat("y".repeat(200));
    const item = makeItem({ context: longCtx, key: "k-long-ctx" });
    renderWithRouter(<AttentionRow item={item} onDismiss={vi.fn()} />);
    const ctx = screen.getByTestId("attention-context-k-long-ctx");
    expect(ctx.textContent).toBe(longCtx);
    expect(ctx.className).toContain("truncate");
  });
});

// ─── Section: SectionHeader + bucket layout ───────────────────────────────

describe("AttentionSection", () => {
  it("renders a 'Critical' SectionHeader with rose swatch + count subtitle", () => {
    const items: AttentionInboxItem[] = [
      makeItem({
        key: "k-c1",
        source: "failed_task",
        priority: "critical",
        title: "Run e2e against local daemon",
        href: "/tasks/300",
      }),
      makeItem({
        key: "k-c2",
        source: "failed_task",
        priority: "critical",
        title: "Lint the UI",
        href: "/tasks/301",
      }),
    ];

    renderWithRouter(
      <AttentionSection
        priority="critical"
        items={items}
        onDismiss={vi.fn()}
      />,
    );

    const header = screen.getByTestId("attention-section-header-critical");
    expect(header).toBeTruthy();
    // SectionHeader renders the size attribute on its outer div.
    expect(header.getAttribute("data-size")).toBe("section");
    expect(header.textContent).toContain("Critical");
    expect(header.textContent).toContain("2 items");

    const swatch = screen.getByTestId("section-header-swatch");
    expect(swatch.className).toContain("bg-rose-500");

    // Both rows render inside the section.
    expect(screen.getByTestId("attention-row-k-c1")).toBeTruthy();
    expect(screen.getByTestId("attention-row-k-c2")).toBeTruthy();
  });

  it("renders a 'Normal' SectionHeader with indigo swatch", () => {
    const items: AttentionInboxItem[] = [
      makeItem({ key: "k-n1", priority: "normal" }),
    ];
    renderWithRouter(
      <AttentionSection
        priority="normal"
        items={items}
        onDismiss={vi.fn()}
      />,
    );

    const header = screen.getByTestId("attention-section-header-normal");
    expect(header.textContent).toContain("Normal");
    // Singular subtitle.
    expect(header.textContent).toContain("1 item");
    expect(header.textContent).not.toContain("1 items");
    expect(screen.getByTestId("section-header-swatch").className).toContain(
      "bg-indigo-500",
    );
  });

  it("renders nothing when items is empty", () => {
    const { container } = renderWithRouter(
      <AttentionSection
        priority="critical"
        items={[]}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("forwards onDismiss to each row (the row's button uses it)", async () => {
    const onDismiss = vi.fn().mockResolvedValue(undefined);
    const items: AttentionInboxItem[] = [makeItem({ key: "k-fwd" })];

    renderWithRouter(
      <AttentionSection
        priority="normal"
        items={items}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByTestId("attention-dismiss-k-fwd"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(items[0]);
  });
});
