import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ChatsList } from "@/pages/chats-components/ChatsList";
import type { ChatRowChat } from "@/pages/chats-components/ChatRow";

/**
 * Contract tests for {@link ChatsList} (slice 24-02 T01).
 *
 * Covered promises:
 *   - empty input → returns null (parent owns the empty-state copy)
 *   - flat list mode sorts by last_message_at desc, falling back to
 *     updated_at when the metric is missing
 *   - sort is stable: same timestamp → tie-break on id
 *   - group="project" mode renders a SectionHeader per project (with
 *     count subtitle) and per-section sorting still applies
 *   - chats without a project_name go under a "No project" section,
 *     appended after the alphabetically-sorted named projects
 *   - selectedId highlights the matching row
 *   - pendingByChatId[id] > 0 → the matching row paints the
 *     'awaiting answer' StatusPill
 *   - is_streaming on a chat → the matching row paints the live label
 *   - clicking a row forwards onSelect(id) to the parent
 */

function makeChat(overrides: Partial<ChatRowChat> = {}): ChatRowChat {
  return {
    id: "chat-default",
    title: "Default chat",
    project_name: null,
    workspace_name: null,
    updated_at: "2026-05-07T10:00:00.000Z",
    is_streaming: false,
    metrics: {
      message_count: 1,
      user_message_count: 1,
      assistant_message_count: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_usd: 0,
      total_copilot_quota: 0,
      last_message_at: "2026-05-07T10:00:00.000Z",
      last_message_excerpt: "default excerpt",
      todos_counts: null,
    },
    ...overrides,
  };
}

function withLastMessage(at: string, overrides: Partial<ChatRowChat> = {}): ChatRowChat {
  const base = makeChat(overrides);
  return {
    ...base,
    updated_at: at,
    metrics: {
      ...base.metrics!,
      last_message_at: at,
    },
  };
}

describe("ChatsList / empty state", () => {
  it("returns null when chats is empty (parent owns the empty-state)", () => {
    const { container } = render(<ChatsList chats={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("ChatsList / flat list mode", () => {
  it("sorts by last_message_at desc", () => {
    const oldest = withLastMessage("2026-05-01T00:00:00.000Z", {
      id: "c-old",
      title: "Oldest",
    });
    const newest = withLastMessage("2026-05-07T00:00:00.000Z", {
      id: "c-new",
      title: "Newest",
    });
    const middle = withLastMessage("2026-05-04T00:00:00.000Z", {
      id: "c-mid",
      title: "Middle",
    });

    render(<ChatsList chats={[oldest, newest, middle]} />);

    const rows = screen.getAllByTestId("chat-row");
    expect(rows.map((r) => r.getAttribute("data-chat-id"))).toEqual([
      "c-new",
      "c-mid",
      "c-old",
    ]);
  });

  it("falls back to updated_at when last_message_at is missing", () => {
    const a = makeChat({
      id: "c-a",
      title: "A",
      updated_at: "2026-05-07T01:00:00.000Z",
      metrics: { ...makeChat().metrics!, last_message_at: null },
    });
    const b = makeChat({
      id: "c-b",
      title: "B",
      updated_at: "2026-05-07T03:00:00.000Z",
      metrics: { ...makeChat().metrics!, last_message_at: null },
    });
    render(<ChatsList chats={[a, b]} />);
    const rows = screen.getAllByTestId("chat-row");
    expect(rows.map((r) => r.getAttribute("data-chat-id"))).toEqual([
      "c-b",
      "c-a",
    ]);
  });

  it("ties on timestamp break by chat id (stable order)", () => {
    const at = "2026-05-07T00:00:00.000Z";
    const z = withLastMessage(at, { id: "c-z" });
    const a = withLastMessage(at, { id: "c-a" });
    const m = withLastMessage(at, { id: "c-m" });
    render(<ChatsList chats={[z, a, m]} />);
    const rows = screen.getAllByTestId("chat-row");
    expect(rows.map((r) => r.getAttribute("data-chat-id"))).toEqual([
      "c-a",
      "c-m",
      "c-z",
    ]);
  });

  it("default group mode renders the flat `data-group=list` shell", () => {
    render(<ChatsList chats={[makeChat()]} />);
    expect(screen.getByTestId("chats-list")).toHaveAttribute(
      "data-group",
      "list",
    );
    expect(screen.queryByTestId("chats-list-section")).toBeNull();
  });
});

describe("ChatsList / group-by-project mode", () => {
  it("renders a SectionHeader per project with a count subtitle", () => {
    const flockctlA = withLastMessage("2026-05-07T05:00:00.000Z", {
      id: "c-fa",
      project_name: "flockctl",
    });
    const flockctlB = withLastMessage("2026-05-07T01:00:00.000Z", {
      id: "c-fb",
      project_name: "flockctl",
    });
    const marketing = withLastMessage("2026-05-07T03:00:00.000Z", {
      id: "c-m",
      project_name: "marketing-site",
    });

    render(
      <ChatsList
        chats={[flockctlA, marketing, flockctlB]}
        group="project"
      />,
    );

    expect(screen.getByTestId("chats-list")).toHaveAttribute(
      "data-group",
      "project",
    );

    const sections = screen.getAllByTestId("chats-list-section");
    // Alphabetical: flockctl, marketing-site
    expect(sections.map((s) => s.getAttribute("data-section-key"))).toEqual([
      "flockctl",
      "marketing-site",
    ]);

    // Each section header carries the project name + chat count.
    const flockSection = sections[0]!;
    const flockHeader = within(flockSection).getByTestId("section-header");
    expect(within(flockHeader).getByText("flockctl")).toBeInTheDocument();
    expect(within(flockHeader).getByText("2 chats")).toBeInTheDocument();

    const marketingSection = sections[1]!;
    const marketingHeader = within(marketingSection).getByTestId(
      "section-header",
    );
    expect(within(marketingHeader).getByText("1 chat")).toBeInTheDocument();
  });

  it("sorts chats within each section by last_message_at desc", () => {
    const newer = withLastMessage("2026-05-07T05:00:00.000Z", {
      id: "c-newer",
      project_name: "flockctl",
    });
    const older = withLastMessage("2026-05-07T01:00:00.000Z", {
      id: "c-older",
      project_name: "flockctl",
    });
    render(
      <ChatsList chats={[older, newer]} group="project" />,
    );

    const section = screen.getByTestId("chats-list-section");
    const rows = within(section).getAllByTestId("chat-row");
    expect(rows.map((r) => r.getAttribute("data-chat-id"))).toEqual([
      "c-newer",
      "c-older",
    ]);
  });

  it("chats without a project group under 'No project', appended last", () => {
    const named = withLastMessage("2026-05-07T05:00:00.000Z", {
      id: "c-named",
      project_name: "flockctl",
    });
    const unscoped = withLastMessage("2026-05-07T03:00:00.000Z", {
      id: "c-unscoped",
      project_name: null,
    });
    const otherNamed = withLastMessage("2026-05-07T04:00:00.000Z", {
      id: "c-other",
      project_name: "marketing-site",
    });

    render(
      <ChatsList
        chats={[unscoped, named, otherNamed]}
        group="project"
      />,
    );

    const sections = screen.getAllByTestId("chats-list-section");
    expect(sections.map((s) => s.getAttribute("data-section-key"))).toEqual([
      "flockctl",
      "marketing-site",
      "__none__",
    ]);
    const noProject = sections[2]!;
    expect(within(noProject).getByText("No project")).toBeInTheDocument();
    expect(
      within(noProject).getByText("1 chat"),
    ).toBeInTheDocument();
  });
});

describe("ChatsList / forwarded props", () => {
  it("highlights the row matching selectedId", () => {
    const a = makeChat({ id: "c-a" });
    const b = makeChat({ id: "c-b" });
    render(<ChatsList chats={[a, b]} selectedId="c-b" />);
    const rows = screen.getAllByTestId("chat-row");
    const aRow = rows.find((r) => r.getAttribute("data-chat-id") === "c-a")!;
    const bRow = rows.find((r) => r.getAttribute("data-chat-id") === "c-b")!;
    expect(aRow.getAttribute("data-selected")).toBe("false");
    expect(bRow.getAttribute("data-selected")).toBe("true");
    expect(bRow).toHaveAttribute("aria-current", "true");
  });

  it("pendingByChatId[id] > 0 paints the awaiting StatusPill on that row", () => {
    const a = makeChat({ id: "c-a" });
    const b = makeChat({ id: "c-b" });
    render(
      <ChatsList chats={[a, b]} pendingByChatId={{ "c-b": 1 }} />,
    );
    const bRow = screen
      .getAllByTestId("chat-row")
      .find((r) => r.getAttribute("data-chat-id") === "c-b")!;
    expect(within(bRow).getByTestId("chat-row-awaiting")).toBeInTheDocument();
    const aRow = screen
      .getAllByTestId("chat-row")
      .find((r) => r.getAttribute("data-chat-id") === "c-a")!;
    expect(within(aRow).queryByTestId("chat-row-awaiting")).toBeNull();
  });

  it("is_streaming → row paints the live label", () => {
    const a = makeChat({ id: "c-a", is_streaming: true });
    const b = makeChat({ id: "c-b" });
    render(<ChatsList chats={[a, b]} />);
    const aRow = screen
      .getAllByTestId("chat-row")
      .find((r) => r.getAttribute("data-chat-id") === "c-a")!;
    expect(within(aRow).getByTestId("chat-row-live")).toBeInTheDocument();
  });

  it("clicking a row forwards onSelect(chatId) to the parent", async () => {
    const onSelect = vi.fn();
    const a = makeChat({ id: "c-a" });
    const b = makeChat({ id: "c-b" });
    render(<ChatsList chats={[a, b]} onSelect={onSelect} />);

    const user = userEvent.setup();
    const bRow = screen
      .getAllByTestId("chat-row")
      .find((r) => r.getAttribute("data-chat-id") === "c-b")!;
    await user.click(bRow);
    expect(onSelect).toHaveBeenCalledWith("c-b");
  });

  it("runningByChatId paints the live label on the matching row", () => {
    const a = makeChat({ id: "c-a", is_streaming: false });
    const b = makeChat({ id: "c-b", is_streaming: false });
    render(<ChatsList chats={[a, b]} runningByChatId={{ "c-a": true }} />);
    const aRow = screen
      .getAllByTestId("chat-row")
      .find((r) => r.getAttribute("data-chat-id") === "c-a")!;
    const bRow = screen
      .getAllByTestId("chat-row")
      .find((r) => r.getAttribute("data-chat-id") === "c-b")!;
    expect(within(aRow).getByTestId("chat-row-live")).toBeInTheDocument();
    expect(within(bRow).queryByTestId("chat-row-live")).toBeNull();
  });

  it("lastReadByChatId marks rows older than their updated_at as unread", () => {
    // c-a: read at 09:00, updated 10:00 → unread (blue dot).
    // c-b: read at 11:00, updated 10:00 → read (no dot).
    // c-c: never read       , updated 10:00 → unread (no entry in map).
    const a = makeChat({ id: "c-a", updated_at: "2026-05-07T10:00:00.000Z" });
    const b = makeChat({ id: "c-b", updated_at: "2026-05-07T10:00:00.000Z" });
    const c = makeChat({ id: "c-c", updated_at: "2026-05-07T10:00:00.000Z" });
    render(
      <ChatsList
        chats={[a, b, c]}
        lastReadByChatId={{
          "c-a": "2026-05-07T09:00:00.000Z",
          "c-b": "2026-05-07T11:00:00.000Z",
        }}
      />,
    );
    const aRow = screen
      .getAllByTestId("chat-row")
      .find((r) => r.getAttribute("data-chat-id") === "c-a")!;
    const bRow = screen
      .getAllByTestId("chat-row")
      .find((r) => r.getAttribute("data-chat-id") === "c-b")!;
    const cRow = screen
      .getAllByTestId("chat-row")
      .find((r) => r.getAttribute("data-chat-id") === "c-c")!;
    expect(within(aRow).getByTestId("chat-row-unread")).toBeInTheDocument();
    expect(within(bRow).queryByTestId("chat-row-unread")).toBeNull();
    expect(within(cRow).getByTestId("chat-row-unread")).toBeInTheDocument();
  });

  it("selectedId suppresses the unread dot on the matching row", () => {
    // The user is currently looking at this chat — painting it as
    // "unread" would be a lie. The selected row is implicitly read.
    const a = makeChat({ id: "c-a", updated_at: "2026-05-07T10:00:00.000Z" });
    render(
      <ChatsList
        chats={[a]}
        selectedId="c-a"
        lastReadByChatId={{ "c-a": "2026-05-07T09:00:00.000Z" }}
      />,
    );
    const aRow = screen.getByTestId("chat-row");
    expect(within(aRow).queryByTestId("chat-row-unread")).toBeNull();
  });

  it("missing lastReadByChatId map → no unread markers anywhere", () => {
    const a = makeChat({ id: "c-a", updated_at: "2026-05-07T10:00:00.000Z" });
    render(<ChatsList chats={[a]} />);
    expect(screen.queryByTestId("chat-row-unread")).toBeNull();
  });

  it("forwards onTogglePin / onDelete to rows in flat-list mode", async () => {
    // Regression: the flat list previously dropped these props on the
    // floor, so the pin / delete action cluster was silently invisible
    // in the default `/chats` view. Both callbacks must reach the row.
    const onTogglePin = vi.fn();
    const onDelete = vi.fn();
    const a = makeChat({ id: "c-a" });
    render(
      <ChatsList
        chats={[a]}
        onTogglePin={onTogglePin}
        onDelete={onDelete}
      />,
    );
    const row = screen.getByTestId("chat-row");
    const pinBtn = within(row).getByTestId("chat-row-pin");
    const delBtn = within(row).getByTestId("chat-row-delete");

    const user = userEvent.setup();
    await user.click(pinBtn);
    expect(onTogglePin).toHaveBeenCalledWith("c-a", true);
    await user.click(delBtn);
    expect(onDelete).toHaveBeenCalledWith("c-a");
  });

  it("forwards onTogglePin / onDelete to rows in group-by-project mode", async () => {
    const onTogglePin = vi.fn();
    const onDelete = vi.fn();
    const a = makeChat({ id: "c-a", project_name: "flockctl" });
    render(
      <ChatsList
        chats={[a]}
        group="project"
        onTogglePin={onTogglePin}
        onDelete={onDelete}
      />,
    );
    const row = screen.getByTestId("chat-row");
    const pinBtn = within(row).getByTestId("chat-row-pin");
    const delBtn = within(row).getByTestId("chat-row-delete");

    const user = userEvent.setup();
    await user.click(pinBtn);
    expect(onTogglePin).toHaveBeenCalledWith("c-a", true);
    await user.click(delBtn);
    expect(onDelete).toHaveBeenCalledWith("c-a");
  });

  it("pinned chats float to the top of the flat list regardless of recency", () => {
    // Backend sorts (pinned DESC, last_message_at DESC); the client's
    // re-sort must preserve that, otherwise pinning has no visible
    // effect after a re-render.
    const olderPinned = withLastMessage("2026-05-01T00:00:00.000Z", {
      id: "c-pin",
      title: "Pinned old",
      pinned: true,
    });
    const newerUnpinned = withLastMessage("2026-05-07T00:00:00.000Z", {
      id: "c-new",
      title: "Newer",
    });
    render(<ChatsList chats={[newerUnpinned, olderPinned]} />);
    const rows = screen.getAllByTestId("chat-row");
    expect(rows.map((r) => r.getAttribute("data-chat-id"))).toEqual([
      "c-pin",
      "c-new",
    ]);
  });
});
