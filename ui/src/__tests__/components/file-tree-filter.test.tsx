import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";

import { FileTreeFilter } from "@/components/file-tree/FileTreeFilter";

/**
 * Unit tests for {@link FileTreeFilter}.
 *
 * The filter input is the surface; the *contract* is the debounced
 * emission. We verify three things:
 *
 *   1. Renders an accessible input + clear button.
 *   2. Coalesces a multi-character keystroke burst into a single
 *      `onChange` call after the debounce window.
 *   3. The clear button resets the value and emits an empty string,
 *      which is the "filter off" sentinel the parent uses to restore
 *      the tree's normal shape.
 *
 * Fake timers + `userEvent`'s built-in advanceTimers integration would
 * be the cleanest pairing, but `userEvent.setup({ advanceTimers })`
 * adds a layer of indirection that obscures the assertions. We use
 * `fireEvent.change` instead — a direct event dispatch is enough for a
 * controlled input where we don't care about character-by-character
 * keystrokes.
 */

describe("<FileTreeFilter />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the filter input and accepts text", () => {
    render(<FileTreeFilter onChange={() => {}} debounceMs={50} />);
    const input = screen.getByTestId(
      "file-tree-filter-input",
    ) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.placeholder).toMatch(/filter/i);

    fireEvent.change(input, { target: { value: "src" } });
    expect(input.value).toBe("src");
  });

  it("debounces onChange so a typing burst collapses into one call", () => {
    const onChange = vi.fn();
    render(<FileTreeFilter onChange={onChange} debounceMs={150} />);
    const input = screen.getByTestId("file-tree-filter-input");

    // Mount fires one debounced emission with the initial empty
    // string. Flush it so the assertions below count only the typing
    // burst we care about.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    onChange.mockClear();

    // Three rapid keystrokes within the debounce window. The first two
    // each cancel the pending timer; only the third's timer survives.
    fireEvent.change(input, { target: { value: "s" } });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    fireEvent.change(input, { target: { value: "sr" } });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    fireEvent.change(input, { target: { value: "src" } });

    // Inside the window — no emission yet.
    expect(onChange).not.toHaveBeenCalled();

    // Clear the window — exactly one emission with the final value.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("src");
  });

  it("emits the empty string when the clear button resets the input", () => {
    const onChange = vi.fn();
    render(<FileTreeFilter onChange={onChange} debounceMs={50} />);
    const input = screen.getByTestId(
      "file-tree-filter-input",
    ) as HTMLInputElement;

    // Drop the initial empty-string emission.
    act(() => {
      vi.advanceTimersByTime(50);
    });
    onChange.mockClear();

    fireEvent.change(input, { target: { value: "node_modules" } });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(onChange).toHaveBeenLastCalledWith("node_modules");

    // Clear button only renders when there's a value.
    const clear = screen.getByTestId("file-tree-filter-clear");
    fireEvent.click(clear);
    expect(input.value).toBe("");

    act(() => {
      vi.advanceTimersByTime(50);
    });
    // Final emission carries the empty string — the parent's signal
    // to drop `searchTerm` and restore the normal tree.
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("hides the clear button when the input is empty", () => {
    render(<FileTreeFilter onChange={() => {}} debounceMs={50} />);
    expect(screen.queryByTestId("file-tree-filter-clear")).toBeNull();
  });
});
