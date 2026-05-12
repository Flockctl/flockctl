import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  ChatRow,
  type ChatRowChat,
} from "@/pages/chats-components/ChatRow";

/**
 * Contract tests for {@link ChatRow} (slice 24-02 T01).
 *
 * The row is presentational, so the tests cover the prop contract
 * surface directly:
 *   - happy path: project pill + title + last-message preview
 *     (line-clamp-2) + relative time
 *   - status indicator: live → LiveDot pulse + emerald 'live' label
 *   - status indicator: awaiting → amber StatusPill 'awaiting answer'
 *   - awaiting wins over live when both are set
 *   - idle (neither flag) → no status block, just the time
 *   - selected row paints the selected background + sets aria-current
 *   - click → onSelect(id)
 *   - edge cases: missing title falls back to "Untitled chat"; missing
 *     project_name + workspace_name → no leading pill; missing excerpt
 *     → no preview row; metric.last_message_at falls back to updated_at
 */

function makeChat(overrides: Partial<ChatRowChat> = {}): ChatRowChat {
  return {
    id: "chat-1",
    title: "Refactor the planner",
    project_name: "flockctl",
    workspace_name: null,
    updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    is_streaming: false,
    metrics: {
      message_count: 8,
      user_message_count: 4,
      assistant_message_count: 4,
      total_input_tokens: 1200,
      total_output_tokens: 400,
      total_cost_usd: 0.04,
      total_copilot_quota: 0,
      last_message_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      last_message_excerpt: "Let's split out the milestone view first.",
      todos_counts: null,
    },
    ...overrides,
  };
}

describe("ChatRow / happy path", () => {
  it("renders project pill, title, last-message preview and relative time", () => {
    render(<ChatRow chat={makeChat()} />);

    expect(screen.getByTestId("chat-row-project-pill")).toHaveTextContent(
      "flockctl",
    );
    expect(screen.getByTestId("chat-row-title")).toHaveTextContent(
      "Refactor the planner",
    );
    expect(screen.getByTestId("chat-row-excerpt")).toHaveTextContent(
      "Let's split out the milestone view first.",
    );
    // Excerpt uses Tailwind's line-clamp-2 utility per the slice spec.
    expect(screen.getByTestId("chat-row-excerpt").className).toContain(
      "line-clamp-2",
    );
    // Time uses the shared timeAgo helper — '2m ago' for a 2-minute-old metric.
    expect(screen.getByTestId("chat-row-time")).toHaveTextContent(/m ago/);
  });

  it("uses the slice prototype root classes (px-3 py-2, hover, divider)", () => {
    render(<ChatRow chat={makeChat()} />);
    const row = screen.getByTestId("chat-row");
    for (const cls of [
      "px-3",
      "py-2",
      "flex",
      "items-start",
      "gap-3",
      "cursor-pointer",
      "hover:bg-zinc-50",
      "dark:hover:bg-zinc-800/40",
      "border-b",
    ]) {
      expect(row.className).toContain(cls);
    }
  });
});

describe("ChatRow / status indicator", () => {
  it("live → renders LiveDot + emerald 'live' label", () => {
    render(
      <ChatRow chat={makeChat({ is_streaming: true })} />,
    );
    const live = screen.getByTestId("chat-row-live");
    expect(live).toHaveTextContent(/^\s*live\s*$/);
    // Emerald tone: emerald-600 in light, emerald-400 in dark.
    expect(live.className).toContain("text-emerald-600");
    expect(live.className).toContain("dark:text-emerald-400");
    // LiveDot pulse: the live dot's halo (animate-ping) is rendered for
    // a state="live" dot. We only assert the wrapper data-state here —
    // LiveDot has its own dedicated test for halo classes.
    const dot = live.querySelector('[data-state="live"]');
    expect(dot).not.toBeNull();
    // No awaiting pill when only live.
    expect(screen.queryByTestId("chat-row-awaiting")).toBeNull();
    // Row's data-state mirrors the active indicator.
    expect(screen.getByTestId("chat-row")).toHaveAttribute(
      "data-state",
      "live",
    );
  });

  it("awaitingAnswer → amber StatusPill 'awaiting answer'", () => {
    render(<ChatRow chat={makeChat()} awaitingAnswer />);
    const pill = screen.getByTestId("chat-row-awaiting");
    expect(pill).toHaveTextContent(/awaiting answer/i);
    // Warning tone is amber per StatusPill's tone map.
    expect(pill.getAttribute("data-tone")).toBe("warning");
    expect(screen.queryByTestId("chat-row-live")).toBeNull();
    expect(screen.getByTestId("chat-row")).toHaveAttribute(
      "data-state",
      "awaiting",
    );
  });

  it("awaiting wins over live when both flags are set", () => {
    render(
      <ChatRow
        chat={makeChat({ is_streaming: true })}
        awaitingAnswer
      />,
    );
    expect(screen.getByTestId("chat-row-awaiting")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-row-live")).toBeNull();
  });

  it("idle (neither flag) → no status block, only the time", () => {
    render(<ChatRow chat={makeChat()} />);
    expect(screen.queryByTestId("chat-row-live")).toBeNull();
    expect(screen.queryByTestId("chat-row-awaiting")).toBeNull();
    expect(screen.getByTestId("chat-row-time")).toBeInTheDocument();
    expect(screen.getByTestId("chat-row")).toHaveAttribute(
      "data-state",
      "idle",
    );
  });

  it("running prop alone (no is_streaming) renders the live label", () => {
    // The chat row's `is_streaming` field is server-fresh but only
    // updates on a list refetch — `running` from the WS-driven live
    // map is the more current signal. Either should mark the row as
    // alive on its own.
    render(<ChatRow chat={makeChat({ is_streaming: false })} running />);
    expect(screen.getByTestId("chat-row-live")).toBeInTheDocument();
  });

  it("awaiting still wins over running", () => {
    render(
      <ChatRow chat={makeChat()} awaitingAnswer running />,
    );
    expect(screen.getByTestId("chat-row-awaiting")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-row-live")).toBeNull();
  });
});

describe("ChatRow / unread indicator", () => {
  it("unread=true renders a blue dot before the title", () => {
    render(<ChatRow chat={makeChat()} unread />);
    expect(screen.getByTestId("chat-row-unread")).toBeInTheDocument();
  });

  it("unread is suppressed when awaitingAnswer is set", () => {
    // Two attention markers on one row would just be noise — the
    // amber awaiting pill is louder, so the blue dot stands down.
    render(<ChatRow chat={makeChat()} unread awaitingAnswer />);
    expect(screen.queryByTestId("chat-row-unread")).toBeNull();
    expect(screen.getByTestId("chat-row-awaiting")).toBeInTheDocument();
  });

  it("unread coexists with the live label", () => {
    // Live is a status (something is happening), unread is a personal
    // marker (you haven't seen it). Both can coexist — the blue dot
    // sits in the title row, the live label in the right column.
    render(<ChatRow chat={makeChat({ is_streaming: true })} unread />);
    expect(screen.getByTestId("chat-row-unread")).toBeInTheDocument();
    expect(screen.getByTestId("chat-row-live")).toBeInTheDocument();
  });

  it("unread defaults to false", () => {
    render(<ChatRow chat={makeChat()} />);
    expect(screen.queryByTestId("chat-row-unread")).toBeNull();
  });
});

describe("ChatRow / selection", () => {
  it("selected=true paints the selected background and sets aria-current", () => {
    render(<ChatRow chat={makeChat()} selected />);
    const row = screen.getByTestId("chat-row");
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row).toHaveAttribute("data-selected", "true");
    expect(row.className).toContain("bg-zinc-100");
  });

  it("selected=false omits aria-current", () => {
    render(<ChatRow chat={makeChat()} />);
    const row = screen.getByTestId("chat-row");
    expect(row).not.toHaveAttribute("aria-current");
    expect(row).toHaveAttribute("data-selected", "false");
  });
});

describe("ChatRow / interaction", () => {
  it("clicking the row fires onSelect with the chat id", async () => {
    const onSelect = vi.fn();
    render(<ChatRow chat={makeChat({ id: "chat-42" })} onSelect={onSelect} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("chat-row"));
    expect(onSelect).toHaveBeenCalledWith("chat-42");
  });

  it("renders as a focusable role=button so keyboard activation works", async () => {
    // The row itself is a `<div role="button">` rather than a real
    // `<button>` because the trailing pin/delete affordances are
    // <button>s and nesting buttons is invalid HTML. We re-implement
    // keyboard activation (Enter/Space) on the div so screen readers
    // and keyboard users still get the same select behaviour.
    const onSelect = vi.fn();
    render(<ChatRow chat={makeChat({ id: "chat-42" })} onSelect={onSelect} />);
    const row = screen.getByTestId("chat-row");
    expect(row).toHaveAttribute("role", "button");
    expect(row).toHaveAttribute("tabindex", "0");
    row.focus();
    const user = userEvent.setup();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("clicking the trailing pin button fires onTogglePin and does NOT select", async () => {
    const onSelect = vi.fn();
    const onTogglePin = vi.fn();
    render(
      <ChatRow
        chat={makeChat({ id: "chat-42", pinned: false })}
        onSelect={onSelect}
        onTogglePin={onTogglePin}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("chat-row-pin"));
    expect(onTogglePin).toHaveBeenCalledWith("chat-42", true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clicking the trailing delete button fires onDelete and does NOT select", async () => {
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    render(
      <ChatRow
        chat={makeChat({ id: "chat-42" })}
        onSelect={onSelect}
        onDelete={onDelete}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("chat-row-delete"));
    expect(onDelete).toHaveBeenCalledWith("chat-42");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("omitting both action callbacks hides the trailing cluster", () => {
    // Picker / read-only surfaces shouldn't accidentally surface
    // destructive actions just because they reused ChatRow.
    render(<ChatRow chat={makeChat()} />);
    expect(screen.queryByTestId("chat-row-actions")).toBeNull();
    expect(screen.queryByTestId("chat-row-pin")).toBeNull();
    expect(screen.queryByTestId("chat-row-delete")).toBeNull();
  });

  it("pinned=true paints the pin button in the always-visible amber state", () => {
    render(
      <ChatRow
        chat={makeChat({ pinned: true })}
        onTogglePin={vi.fn()}
      />,
    );
    const pin = screen.getByTestId("chat-row-pin");
    // No `opacity-0` class — pinned rows show the affordance without
    // hover so the user can unpin without hunting for it.
    expect(pin.className).not.toContain("opacity-0");
    expect(pin.className).toContain("text-amber-600");
  });
});

describe("ChatRow / multi-select", () => {
  it("omitting onToggleMultiSelect hides the leading checkbox entirely", () => {
    // Read-only surfaces and the legacy two-pane sidebar must not
    // accidentally surface batch-mode UI just because they reused
    // ChatRow. Same gating principle as the trailing actions cluster.
    render(<ChatRow chat={makeChat()} />);
    expect(screen.queryByTestId("chat-row-multiselect")).toBeNull();
    expect(screen.queryByTestId("chat-row-multiselect-input")).toBeNull();
  });

  it("renders a leading checkbox when onToggleMultiSelect is wired", () => {
    render(
      <ChatRow
        chat={makeChat()}
        onToggleMultiSelect={vi.fn()}
      />,
    );
    const checkbox = screen.getByTestId("chat-row-multiselect-input");
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toHaveProperty("checked", false);
  });

  it("multiSelected=true checks the box and pins it visible", () => {
    // Persistent visibility (not just hover-revealed) is the affordance
    // that lets the user see at-a-glance which rows are part of the
    // current selection set.
    render(
      <ChatRow
        chat={makeChat()}
        multiSelected
        onToggleMultiSelect={vi.fn()}
      />,
    );
    const wrapper = screen.getByTestId("chat-row-multiselect");
    const input = screen.getByTestId("chat-row-multiselect-input");
    expect(input).toHaveProperty("checked", true);
    expect(wrapper.className).toContain("opacity-100");
    expect(wrapper.className).not.toContain("opacity-0");
  });

  it("toggling the checkbox fires onToggleMultiSelect and does NOT navigate", async () => {
    const onSelect = vi.fn();
    const onToggleMultiSelect = vi.fn();
    render(
      <ChatRow
        chat={makeChat({ id: "chat-42" })}
        onSelect={onSelect}
        onToggleMultiSelect={onToggleMultiSelect}
      />,
    );
    const user = userEvent.setup();
    // Click the input directly — same path the user takes.
    await user.click(screen.getByTestId("chat-row-multiselect-input"));
    expect(onToggleMultiSelect).toHaveBeenCalledWith("chat-42", true);
    // Critical: the row's outer onClick must not fire — otherwise the
    // user would be navigated into a chat they were trying to add to a
    // batch operation.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("unchecking a previously-selected row fires the deselect call", async () => {
    const onToggleMultiSelect = vi.fn();
    render(
      <ChatRow
        chat={makeChat({ id: "chat-42" })}
        multiSelected
        onToggleMultiSelect={onToggleMultiSelect}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("chat-row-multiselect-input"));
    expect(onToggleMultiSelect).toHaveBeenCalledWith("chat-42", false);
  });
});

describe("ChatRow / edge cases", () => {
  it("missing title falls back to 'Untitled chat'", () => {
    render(<ChatRow chat={makeChat({ title: null })} />);
    expect(screen.getByTestId("chat-row-title")).toHaveTextContent(
      "Untitled chat",
    );
  });

  it("whitespace-only title falls back to 'Untitled chat'", () => {
    render(<ChatRow chat={makeChat({ title: "   " })} />);
    expect(screen.getByTestId("chat-row-title")).toHaveTextContent(
      "Untitled chat",
    );
  });

  it("missing project_name uses workspace_name in the leading pill", () => {
    render(
      <ChatRow
        chat={makeChat({ project_name: null, workspace_name: "personal" })}
      />,
    );
    expect(screen.getByTestId("chat-row-project-pill")).toHaveTextContent(
      "personal",
    );
  });

  it("missing project_name + workspace_name → no leading pill", () => {
    render(
      <ChatRow
        chat={makeChat({ project_name: null, workspace_name: null })}
      />,
    );
    expect(screen.queryByTestId("chat-row-project-pill")).toBeNull();
  });

  it("missing excerpt → no preview row", () => {
    render(
      <ChatRow
        chat={makeChat({
          metrics: {
            ...makeChat().metrics!,
            last_message_excerpt: null,
          },
        })}
      />,
    );
    expect(screen.queryByTestId("chat-row-excerpt")).toBeNull();
  });

  it("falls back to updated_at when metrics.last_message_at is missing", () => {
    const old = new Date(Date.now() - 90 * 60 * 1000).toISOString(); // 90m ago
    render(
      <ChatRow
        chat={makeChat({
          updated_at: old,
          metrics: {
            ...makeChat().metrics!,
            last_message_at: null,
          },
        })}
      />,
    );
    // 90 minutes ago → "1h ago" via timeAgo helper.
    expect(screen.getByTestId("chat-row-time")).toHaveTextContent(/h ago/);
  });
});
