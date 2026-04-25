/**
 * Guards the scrollable shape of the Create Workspace dialog.
 *
 * The CreateWorkspaceDialog must mirror the Create Project dialog in
 * `ui/src/pages/projects.tsx` (~line 397): a fixed-height DialogContent
 * with the title + footer pinned, and the form body in an inner
 * overflow-y-auto region. Without the inner scroller, the whole dialog
 * overflows the viewport on short screens and the Create button is
 * unreachable.
 *
 * This test opens the dialog from the Workspaces page and asserts:
 *   1. DialogContent (by role="dialog") carries the exact layout classes
 *      `max-w-lg`, `max-h-[85vh]`, `flex`, `flex-col`.
 *   2. There is at least one descendant element with `overflow-y-auto`
 *      that contains the form fields (the scroll container), so scroll
 *      is applied inside the form body rather than on the outer dialog.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

// jsdom doesn't ship with ResizeObserver — Radix's Dialog primitives
// reach for it in a layout effect. A no-op stub is enough here (we
// never measure the dialog). Mirrors the polyfill in
// DirectoryPicker.test.tsx.
if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Radix Dialog also calls pointer-capture APIs on the trigger that
// jsdom doesn't implement. Stub them so userEvent.click() doesn't
// explode opening the dialog.
if (typeof (Element.prototype as any).hasPointerCapture !== "function") {
  (Element.prototype as any).hasPointerCapture = () => false;
}
if (typeof (Element.prototype as any).setPointerCapture !== "function") {
  (Element.prototype as any).setPointerCapture = () => {};
}
if (typeof (Element.prototype as any).releasePointerCapture !== "function") {
  (Element.prototype as any).releasePointerCapture = () => {};
}
if (typeof (Element.prototype as any).scrollIntoView !== "function") {
  (Element.prototype as any).scrollIntoView = () => {};
}

vi.mock("@/lib/hooks", () => ({
  useWorkspaces: () => ({ data: [], isLoading: false, error: null }),
  useCreateWorkspace: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useDeleteWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
  useProjects: () => ({ data: [], isLoading: false, error: null }),
  useAttention: () => ({
    items: [],
    total: 0,
    isLoading: false,
    error: null,
    connectionState: "open",
  }),
  useAIKeys: () => ({
    data: [
      {
        id: 1,
        name: "Sample Key",
        label: null,
        provider: "anthropic",
        is_active: true,
      },
    ],
    isLoading: false,
  }),
  // The DirectoryPicker is rendered as a sibling of the Create dialog and
  // eagerly calls useFsBrowse on mount. Provide a no-op stub so the mock
  // module surface is complete.
  useFsBrowse: () => ({ data: undefined, isLoading: false, error: null }),
}));

// Import AFTER the mock so the page picks up the stubbed hooks.
import WorkspacesPage from "@/pages/workspaces";

beforeEach(() => {
  // WorkspacesPage renders a ConfirmDialog that calls portals; make sure
  // jsdom has a fresh body between tests.
  document.body.innerHTML = "";
});

describe("CreateWorkspaceDialog layout", () => {
  it("create_workspace_dialog_has_scroll_container renders a pinned header/footer with an inner overflow-y-auto region", async () => {
    render(
      <MemoryRouter>
        <WorkspacesPage />
      </MemoryRouter>,
    );

    const trigger = screen.getByRole("button", { name: /create workspace/i });
    await userEvent.click(trigger);

    // The Radix Dialog renders with role="dialog" once open.
    const dialog = await screen.findByRole("dialog");

    // Layout classes copied verbatim from projects.tsx line ~397. These
    // are the ones that actually control the sticky-header shape, so we
    // assert them explicitly rather than a single concatenated string
    // (class order is not stable across React renders).
    for (const cls of ["max-w-lg", "max-h-[85vh]", "flex", "flex-col"]) {
      expect(
        dialog.classList.contains(cls),
        `expected dialog to have class ${cls}; got: ${dialog.className}`,
      ).toBe(true);
    }

    // There must be an inner scrollable region — not the dialog itself.
    // We look for a descendant with overflow-y-auto that wraps the Name
    // input, which is inside the scroll container in projects.tsx.
    const nameInput = screen.getByLabelText(/name/i);
    const scroller = nameInput.closest(".overflow-y-auto");
    expect(
      scroller,
      "expected an ancestor with overflow-y-auto wrapping the form body",
    ).not.toBeNull();

    // The scroll container must be *inside* the dialog, not the dialog
    // itself (otherwise the header/footer scroll along with the body).
    expect(scroller).not.toBe(dialog);
    expect(dialog.contains(scroller!)).toBe(true);
  });
});
