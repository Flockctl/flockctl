import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueuedMessagesList } from "@/components/QueuedMessagesList";
import type { QueuedChatMessage } from "@/lib/chat-queue-store";

/**
 * Tests for the M25 numbered, drag-and-drop reorderable queue list.
 *
 * The component is purely presentational — parent (chat-conversation.tsx)
 * owns the queue array and the three callbacks. Tests therefore focus on:
 *   1. Render contract: position numbers, head badge, "X queued · runs
 *      after current turn" header, Clear all + per-item ✕ wiring.
 *   2. Reorder behaviour: keyboard (Alt+↑/↓) covers the deterministic
 *      path; HTML5 DnD covers the mouse path. jsdom doesn't simulate
 *      a full DnD pipeline, so the DnD tests fire the events the React
 *      handlers actually listen to (`dragstart` → `dragover` → `drop`)
 *      against the rendered LIs and assert `onReorder` was called with
 *      the right indices.
 *   3. Disabled state: while a drain is in flight (`disabled={true}`),
 *      both reorder paths must be a no-op AND the rejection must be
 *      visible to assistive tech (aria-disabled on the ul).
 */

function makeItem(id: string, content: string): QueuedChatMessage {
  return {
    id,
    chatId: "c-1",
    data: { content },
  };
}

const SAMPLE_ITEMS: QueuedChatMessage[] = [
  makeItem("q-1", "first prompt"),
  makeItem("q-2", "second prompt"),
  makeItem("q-3", "third prompt"),
];

function renderList(
  partial: Partial<React.ComponentProps<typeof QueuedMessagesList>> = {},
) {
  const onRemove = vi.fn();
  const onClearAll = vi.fn();
  const onReorder = vi.fn(() => true);
  const utils = render(
    <QueuedMessagesList
      items={SAMPLE_ITEMS}
      onRemove={onRemove}
      onClearAll={onClearAll}
      onReorder={onReorder}
      {...partial}
    />,
  );
  return { ...utils, onRemove, onClearAll, onReorder };
}

describe("QueuedMessagesList — render contract", () => {
  it("renders nothing when items is empty (avoids stray bar)", () => {
    const { container } = render(
      <QueuedMessagesList
        items={[]}
        onRemove={vi.fn()}
        onClearAll={vi.fn()}
        onReorder={vi.fn(() => true)}
      />,
    );
    // No queue → no bar at all. Avoids a 1-px border-top on chat surfaces
    // where the user has zero queued prompts (every chat, most of the time).
    expect(container.firstChild).toBeNull();
  });

  it("shows count + 'runs after current turn' header", () => {
    renderList();
    expect(screen.getByText(/3 queued/)).toBeInTheDocument();
    expect(screen.getByText(/runs after current turn/)).toBeInTheDocument();
  });

  it("renders one row per queue item with correct position labels", () => {
    renderList();
    const items = screen.getAllByTestId("chat-queued-item");
    expect(items).toHaveLength(3);
    // Positions are 1-indexed for the user (#1, #2, #3) — the data-index
    // is the underlying 0-indexed position the reorder handler operates on.
    expect(items[0]!.getAttribute("data-index")).toBe("0");
    expect(items[0]!.getAttribute("data-head")).toBe("true");
    expect(items[1]!.getAttribute("data-index")).toBe("1");
    expect(items[1]!.getAttribute("data-head")).toBeNull();
    // Position badges are visible on every row.
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("#2")).toBeInTheDocument();
    expect(screen.getByText("#3")).toBeInTheDocument();
  });

  it("renders each entry's content text", () => {
    renderList();
    expect(screen.getByText("first prompt")).toBeInTheDocument();
    expect(screen.getByText("second prompt")).toBeInTheDocument();
    expect(screen.getByText("third prompt")).toBeInTheDocument();
  });

  it("Clear all button fires onClearAll exactly once per click", async () => {
    const user = userEvent.setup();
    const { onClearAll } = renderList();
    await user.click(screen.getByTestId("chat-queued-clear"));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it("per-item ✕ fires onRemove with that entry's id (not its index)", async () => {
    const user = userEvent.setup();
    const { onRemove } = renderList();
    const removeButtons = screen.getAllByTestId("chat-queued-remove");
    await user.click(removeButtons[1]!);
    // Indexed by id, not position — so even after a reorder, the right
    // entry comes out.
    expect(onRemove).toHaveBeenCalledWith("q-2");
  });
});

describe("QueuedMessagesList — keyboard reorder (Alt+↑/↓)", () => {
  it("Alt+ArrowDown moves a row down by one", () => {
    const { onReorder } = renderList();
    const rows = screen.getAllByTestId("chat-queued-item");
    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown", altKey: true });
    expect(onReorder).toHaveBeenCalledWith(0, 1);
  });

  it("Alt+ArrowUp moves a row up by one", () => {
    const { onReorder } = renderList();
    const rows = screen.getAllByTestId("chat-queued-item");
    rows[2]!.focus();
    fireEvent.keyDown(rows[2]!, { key: "ArrowUp", altKey: true });
    expect(onReorder).toHaveBeenCalledWith(2, 1);
  });

  it("Alt+ArrowUp on the head is a no-op (would be index -1)", () => {
    const { onReorder } = renderList();
    const rows = screen.getAllByTestId("chat-queued-item");
    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: "ArrowUp", altKey: true });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("Alt+ArrowDown on the tail is a no-op (would be index N)", () => {
    const { onReorder } = renderList();
    const rows = screen.getAllByTestId("chat-queued-item");
    rows[2]!.focus();
    fireEvent.keyDown(rows[2]!, { key: "ArrowDown", altKey: true });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("plain ArrowUp / ArrowDown (no Alt) does NOT reorder — leaves screen reader nav alone", () => {
    const { onReorder } = renderList();
    const rows = screen.getAllByTestId("chat-queued-item");
    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    fireEvent.keyDown(rows[0]!, { key: "ArrowUp" });
    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe("QueuedMessagesList — drag-and-drop reorder", () => {
  // jsdom doesn't simulate the full HTML5 DnD pipeline, but the React
  // handlers (`onDragStart`, `onDragOver`, `onDrop`) just consume the
  // standard SyntheticEvent — we can fire each one against the LI and
  // observe `onReorder`. The rest of the pipeline (setData,
  // dropEffect, dragImage) is browser-side and isn't part of this
  // component's contract.

  function dataTransferStub(): DataTransfer {
    // The handler reads `effectAllowed`, `dropEffect`, and calls
    // `setData("text/plain", …)`. Anything else is irrelevant; a stub
    // with mutable string fields plus a no-op setData is enough.
    return {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn(),
      getData: vi.fn(() => ""),
    } as unknown as DataTransfer;
  }

  it("dragging the head onto position 2 fires onReorder(0, 2)", () => {
    const { onReorder } = renderList();
    const rows = screen.getAllByTestId("chat-queued-item");
    const dt = dataTransferStub();
    fireEvent.dragStart(rows[0]!, { dataTransfer: dt });
    fireEvent.dragOver(rows[2]!, { dataTransfer: dt });
    fireEvent.drop(rows[2]!, { dataTransfer: dt });
    expect(onReorder).toHaveBeenCalledWith(0, 2);
  });

  it("dropping on the same row (no movement) does NOT call onReorder", () => {
    const { onReorder } = renderList();
    const rows = screen.getAllByTestId("chat-queued-item");
    const dt = dataTransferStub();
    fireEvent.dragStart(rows[1]!, { dataTransfer: dt });
    fireEvent.dragOver(rows[1]!, { dataTransfer: dt });
    fireEvent.drop(rows[1]!, { dataTransfer: dt });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("dragEnd without a drop clears local state without calling onReorder", () => {
    const { onReorder } = renderList();
    const rows = screen.getAllByTestId("chat-queued-item");
    const dt = dataTransferStub();
    fireEvent.dragStart(rows[0]!, { dataTransfer: dt });
    // User releases outside any droppable target (e.g. drags off-screen).
    fireEvent.dragEnd(rows[0]!, { dataTransfer: dt });
    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe("QueuedMessagesList — disabled state", () => {
  it("ul carries aria-disabled when disabled=true (drain in flight)", () => {
    renderList({ disabled: true });
    const list = screen.getByRole("list");
    expect(list.getAttribute("aria-disabled")).toBe("true");
  });

  it("LI's draggable attribute is set to false when disabled=true", () => {
    renderList({ disabled: true });
    const rows = screen.getAllByTestId("chat-queued-item");
    // `draggable={false}` is what stops the browser from initiating the
    // DnD gesture in the first place — the React handlers also early-return
    // when `disabled`, but this is the first line of defence.
    for (const row of rows) {
      expect(row.getAttribute("draggable")).toBe("false");
    }
  });

  it("Alt+ArrowDown is a no-op when disabled=true", () => {
    const { onReorder } = renderList({ disabled: true });
    const rows = screen.getAllByTestId("chat-queued-item");
    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown", altKey: true });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("Clear all and ✕ remain functional when disabled=true (escape hatches)", async () => {
    // Drain-in-flight blocks reorders to dodge a head race, but leaving
    // the user with no way to drop a wrongly-queued prompt would be
    // worse than the race. Both removeFromQueue and clearQueue stay
    // wired up.
    const user = userEvent.setup();
    const { onRemove, onClearAll } = renderList({ disabled: true });
    await user.click(screen.getAllByTestId("chat-queued-remove")[0]!);
    expect(onRemove).toHaveBeenCalledWith("q-1");
    await user.click(screen.getByTestId("chat-queued-clear"));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });
});

describe("QueuedMessagesList — head highlight", () => {
  it("first row carries data-head='true', the rest don't", () => {
    renderList();
    const rows = screen.getAllByTestId("chat-queued-item");
    expect(rows[0]!.getAttribute("data-head")).toBe("true");
    expect(rows[1]!.getAttribute("data-head")).toBeNull();
    expect(rows[2]!.getAttribute("data-head")).toBeNull();
  });

  it("single-item queue still marks the lone entry as head", () => {
    render(
      <QueuedMessagesList
        items={[makeItem("solo", "only one")]}
        onRemove={vi.fn()}
        onClearAll={vi.fn()}
        onReorder={vi.fn(() => true)}
      />,
    );
    const rows = screen.getAllByTestId("chat-queued-item");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-head")).toBe("true");
  });
});
