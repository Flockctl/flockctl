import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  TasksBulkToolbar,
  summarize,
} from "@/pages/tasks-components/TasksBulkToolbar";

/**
 * Contract tests for {@link TasksBulkToolbar} (slice 24-00 T03).
 *
 * Negative tests pinned by the slice (03-bulk-toolbar.md):
 *   - "Delete button disabled with tooltip"
 *   - "Cancel queued only enabled when ≥1 queued task selected"
 *
 * Plus the positive coverage required by `expected_output`:
 *   - Sticky-top visibility gated on `selectedIds.length > 0`.
 *   - Buttons: Cancel queued / Mark watched / Copy IDs / Delete render.
 *   - Cancel queued forwards ONLY queued ids to the cancel mutation.
 *   - bulkMutate result split flows into onResult.
 *   - Copy IDs writes to clipboard and reports to parent.
 *   - summarize() returns the right tone for success / partial / total
 *     failure (drives the toast colour the slice describes).
 */

describe("TasksBulkToolbar / visibility", () => {
  it("renders nothing when nothing is selected", () => {
    const { container } = render(<TasksBulkToolbar selectedIds={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders sticky-top with the selection count when selectedIds > 0", () => {
    render(<TasksBulkToolbar selectedIds={["t-1", "t-2", "t-3"]} />);
    const bar = screen.getByTestId("tasks-bulk-toolbar");
    expect(bar.className).toContain("sticky");
    expect(bar.className).toContain("top-0");
    expect(screen.getByTestId("tasks-bulk-toolbar-count").textContent).toBe(
      "3 selected",
    );
  });
});

describe("TasksBulkToolbar / buttons render", () => {
  it("renders Cancel queued / Mark watched / Copy IDs / Delete", () => {
    render(<TasksBulkToolbar selectedIds={["t-1"]} />);
    expect(
      screen.getByTestId("tasks-bulk-toolbar-cancel-queued"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("tasks-bulk-toolbar-mark-watched"),
    ).toBeTruthy();
    expect(screen.getByTestId("tasks-bulk-toolbar-copy-ids")).toBeTruthy();
    expect(screen.getByTestId("tasks-bulk-toolbar-delete")).toBeTruthy();
  });
});

describe("TasksBulkToolbar / Cancel queued enablement", () => {
  it("is DISABLED when no selected task is queued", () => {
    render(
      <TasksBulkToolbar
        selectedIds={["t-1", "t-2"]}
        selectedStatuses={{ "t-1": "running", "t-2": "done" }}
        onCancelQueued={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const btn = screen.getByTestId(
      "tasks-bulk-toolbar-cancel-queued",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("title")).toMatch(/no queued tasks selected/i);
  });

  it("is ENABLED when at least one selected task is queued", () => {
    render(
      <TasksBulkToolbar
        selectedIds={["t-1", "t-2"]}
        selectedStatuses={{ "t-1": "queued", "t-2": "running" }}
        onCancelQueued={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const btn = screen.getByTestId(
      "tasks-bulk-toolbar-cancel-queued",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("is DISABLED when onCancelQueued is not wired up at all", () => {
    render(
      <TasksBulkToolbar
        selectedIds={["t-1"]}
        selectedStatuses={{ "t-1": "queued" }}
      />,
    );
    const btn = screen.getByTestId(
      "tasks-bulk-toolbar-cancel-queued",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("forwards ONLY the queued subset to onCancelQueued and emits the result", async () => {
    const onCancelQueued = vi.fn().mockResolvedValue(undefined);
    const onResult = vi.fn();
    const user = userEvent.setup();

    render(
      <TasksBulkToolbar
        selectedIds={["t-1", "t-2", "t-3"]}
        selectedStatuses={{
          "t-1": "queued",
          "t-2": "running",
          "t-3": "queued",
        }}
        onCancelQueued={onCancelQueued}
        onResult={onResult}
      />,
    );

    await user.click(screen.getByTestId("tasks-bulk-toolbar-cancel-queued"));

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledTimes(1);
    });
    // running task should NOT have been forwarded.
    expect(onCancelQueued).toHaveBeenCalledTimes(2);
    const calledIds = onCancelQueued.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(calledIds).toEqual(["t-1", "t-3"]);

    const firstCall = onResult.mock.calls[0]!;
    const [action, result] = firstCall as [string, { ok: string[]; failed: unknown[] }];
    expect(action).toBe("cancel_queued");
    expect(result.ok).toEqual(["t-1", "t-3"]);
    expect(result.failed).toEqual([]);
  });

  it("returns partial-success split when some per-task cancels reject", async () => {
    const onCancelQueued = vi
      .fn<(id: string) => Promise<unknown>>()
      .mockImplementation(async (id: string) => {
        if (id === "t-3") throw new Error("forbidden");
        return "ok";
      });
    const onResult = vi.fn();
    const user = userEvent.setup();

    render(
      <TasksBulkToolbar
        selectedIds={["t-1", "t-3"]}
        selectedStatuses={{ "t-1": "queued", "t-3": "queued" }}
        onCancelQueued={onCancelQueued}
        onResult={onResult}
      />,
    );

    await user.click(screen.getByTestId("tasks-bulk-toolbar-cancel-queued"));

    await waitFor(() => expect(onResult).toHaveBeenCalled());
    const partialCall = onResult.mock.calls[0]!;
    const [, result] = partialCall as [
      string,
      { ok: string[]; failed: { id: string; err: unknown }[] },
    ];
    expect(result.ok).toEqual(["t-1"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.id).toBe("t-3");
  });
});

describe("TasksBulkToolbar / Mark watched", () => {
  it("calls onMarkWatched for every selected id and emits result", async () => {
    const onMarkWatched = vi.fn().mockResolvedValue(undefined);
    const onResult = vi.fn();
    const user = userEvent.setup();

    render(
      <TasksBulkToolbar
        selectedIds={["t-1", "t-2"]}
        selectedStatuses={{ "t-1": "running", "t-2": "done" }}
        onMarkWatched={onMarkWatched}
        onResult={onResult}
      />,
    );

    await user.click(screen.getByTestId("tasks-bulk-toolbar-mark-watched"));

    await waitFor(() => expect(onResult).toHaveBeenCalled());
    expect(onMarkWatched).toHaveBeenCalledTimes(2);
    const watchedCall = onResult.mock.calls[0]!;
    const [action, result] = watchedCall as [
      string,
      { ok: string[]; failed: unknown[] },
    ];
    expect(action).toBe("mark_watched");
    expect(result.ok).toEqual(["t-1", "t-2"]);
  });

  it("button is disabled when onMarkWatched is not provided", () => {
    render(<TasksBulkToolbar selectedIds={["t-1"]} />);
    const btn = screen.getByTestId(
      "tasks-bulk-toolbar-mark-watched",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe("TasksBulkToolbar / Copy IDs", () => {
  let writeText: ReturnType<typeof vi.fn>;
  let originalClipboard: PropertyDescriptor | undefined;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    } else {
      delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    }
  });

  it("writes newline-joined full ids to the clipboard and notifies parent", async () => {
    const onCopyIds = vi.fn();
    // NOTE: `userEvent.setup()` installs its own clipboard shim that
    // intercepts `navigator.clipboard.writeText`, hiding our spy. Using
    // `fireEvent.click` keeps the real Object.defineProperty mock visible.
    render(
      <TasksBulkToolbar
        selectedIds={["t-1-full-uuid", "t-2-full-uuid"]}
        onCopyIds={onCopyIds}
      />,
    );

    fireEvent.click(screen.getByTestId("tasks-bulk-toolbar-copy-ids"));

    await waitFor(() => expect(onCopyIds).toHaveBeenCalled());
    expect(writeText).toHaveBeenCalledWith("t-1-full-uuid\nt-2-full-uuid");
    expect(onCopyIds).toHaveBeenCalledWith(["t-1-full-uuid", "t-2-full-uuid"]);
  });
});

describe("TasksBulkToolbar / Delete coming-soon", () => {
  it("Delete button is DISABLED with a 'Coming soon' tooltip", () => {
    render(<TasksBulkToolbar selectedIds={["t-1"]} />);
    const btn = screen.getByTestId(
      "tasks-bulk-toolbar-delete",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.getAttribute("title")).toBe("Coming soon");
  });
});

describe("TasksBulkToolbar / Clear selection", () => {
  it("calls onClearSelection when ✕ is clicked", async () => {
    const onClearSelection = vi.fn();
    const user = userEvent.setup();
    render(
      <TasksBulkToolbar
        selectedIds={["t-1"]}
        onClearSelection={onClearSelection}
      />,
    );

    await user.click(screen.getByTestId("tasks-bulk-toolbar-clear"));
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });
});

describe("summarize() — toast tone", () => {
  it("returns success tone when nothing failed", () => {
    const out = summarize("cancel_queued", {
      ok: ["a", "b", "c"],
      failed: [],
    });
    expect(out.tone).toBe("success");
    expect(out.message).toBe("Cancelled 3 tasks");
    expect(out.failedIds).toEqual([]);
  });

  it("returns warning tone with details for partial success", () => {
    const out = summarize("cancel_queued", {
      ok: ["a"],
      failed: [
        { id: "bcdefghij", err: new Error("denied") },
        { id: "klmnopqr", err: new Error("denied") },
      ],
    });
    expect(out.tone).toBe("warning");
    expect(out.message).toContain("Cancelled 1 of 3");
    expect(out.message).toContain("2 failed");
    expect(out.message).toContain("bcdefghi");
    expect(out.message).toContain("klmnopqr");
  });

  it("returns error tone when everything failed", () => {
    const out = summarize("cancel_queued", {
      ok: [],
      failed: [{ id: "aaaaaaaa", err: new Error("nope") }],
    });
    expect(out.tone).toBe("error");
    expect(out.message).toContain("Failed to cancel 1 task");
  });

  it("uses 'Marked watched' verb for mark_watched action", () => {
    const out = summarize("mark_watched", { ok: ["a", "b"], failed: [] });
    expect(out.message).toBe("Marked watched 2 tasks");
  });
});
