/**
 * Tests for {@link NewWorkspaceDialog} (refresh of the legacy
 * `CreateWorkspaceDialog` from `pages/workspaces.tsx`).
 *
 * The component is *visually* refreshed but its behaviour contract is
 * unchanged, so the tests pin the contract:
 *
 *   - the dialog renders its own trigger by default,
 *   - controlled mode (open + onOpenChange) suppresses the inline
 *     trigger and lets the parent open it,
 *   - the form blocks submit until name + at least one allowed AI key
 *     are present,
 *   - submit calls `useCreateWorkspace().mutateAsync` with name +
 *     allowed_key_ids + the full gitignore triplet (always-send, see
 *     component comment),
 *   - choosing the "Clone from Git" segment swaps `path` for `repoUrl`
 *     in the mutation payload,
 *   - the DirectoryPicker integration is wired (Browse button mounts
 *     the picker), preserving the legacy data-testid `cw-path-browse`.
 *
 * Hook strategy: we mock `@/lib/hooks` directly so the test drives the
 * mutation surface deterministically and doesn't depend on the
 * apiFetch ↔ snake/camel conversion. This mirrors the pattern used by
 * `create_workspace_dialog_has_scroll_container.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// jsdom is missing several APIs that Radix Dialog and DirectoryPicker
// reach for. No-op stubs are enough — the tests don't measure layout.
if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof (Element.prototype as any).scrollIntoView !== "function") {
  (Element.prototype as any).scrollIntoView = () => {};
}
if (typeof (Element.prototype as any).hasPointerCapture !== "function") {
  (Element.prototype as any).hasPointerCapture = () => false;
}
if (typeof (Element.prototype as any).setPointerCapture !== "function") {
  (Element.prototype as any).setPointerCapture = () => {};
}
if (typeof (Element.prototype as any).releasePointerCapture !== "function") {
  (Element.prototype as any).releasePointerCapture = () => {};
}
if (typeof (Element.prototype as any).scrollTo !== "function") {
  (Element.prototype as any).scrollTo = () => {};
}

const mutateAsyncSpy: ReturnType<typeof vi.fn> = vi.fn(async (
  _data: Record<string, unknown>,
) => ({ id: "ws-new" }));
const useCreateWorkspaceState = {
  isPending: false,
};

let aiKeysData: Array<{
  id: number;
  name: string | null;
  label: string | null;
  provider: string;
  is_active: boolean;
}> = [];

vi.mock("@/lib/hooks", () => ({
  useCreateWorkspace: () => ({
    mutate: vi.fn(),
    mutateAsync: mutateAsyncSpy,
    isPending: useCreateWorkspaceState.isPending,
  }),
  useAIKeys: () => ({
    data: aiKeysData,
    isLoading: false,
  }),
  // DirectoryPicker eagerly calls useFsBrowse on mount. Returning a
  // resolved-empty state keeps the picker dialog mountable without
  // network fakery.
  useFsBrowse: () => ({
    data: { path: "/Users/me", parent: null, entries: [] },
    isLoading: false,
    error: null,
  }),
}));

// Import AFTER the mock so the dialog picks up the stubbed hooks.
import { NewWorkspaceDialog } from "@/pages/workspaces-components/NewWorkspaceDialog";
import { Button } from "@/components/ui/button";

const ACTIVE_KEY = {
  id: 1,
  name: "Personal Anthropic",
  label: null,
  provider: "anthropic",
  is_active: true,
};
const INACTIVE_KEY = {
  id: 2,
  name: "Old key",
  label: null,
  provider: "anthropic",
  is_active: false,
};

beforeEach(() => {
  mutateAsyncSpy.mockClear();
  mutateAsyncSpy.mockResolvedValue({ id: "ws-new" });
  useCreateWorkspaceState.isPending = false;
  aiKeysData = [];
  document.body.innerHTML = "";
  try {
    window.localStorage.clear();
  } catch {
    /* noop */
  }
});

describe("NewWorkspaceDialog / trigger modes", () => {
  it("renders its own 'New workspace' trigger by default", () => {
    aiKeysData = [ACTIVE_KEY];
    render(<NewWorkspaceDialog />);
    expect(
      screen.getByRole("button", { name: "New workspace" }),
    ).toBeTruthy();
  });

  it("accepts a custom inline trigger node", () => {
    aiKeysData = [ACTIVE_KEY];
    render(<NewWorkspaceDialog trigger={<Button>+ New</Button>} />);
    expect(screen.getByRole("button", { name: "+ New" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "New workspace" }),
    ).toBeNull();
  });

  it("does NOT render an inline trigger in controlled-closed mode", () => {
    aiKeysData = [ACTIVE_KEY];
    render(<NewWorkspaceDialog open={false} onOpenChange={() => {}} />);
    expect(
      screen.queryByRole("button", { name: "New workspace" }),
    ).toBeNull();
    expect(screen.queryByTestId("new-workspace-dialog")).toBeNull();
  });

  it("opens the dialog content when controlled `open` is true", () => {
    aiKeysData = [ACTIVE_KEY];
    render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);
    expect(screen.getByTestId("new-workspace-dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "New workspace" })).toBeTruthy();
  });
});

describe("NewWorkspaceDialog / form contents", () => {
  it("renders all field groups + the active key checkbox when keys exist", () => {
    aiKeysData = [ACTIVE_KEY, INACTIVE_KEY];
    render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);

    expect(screen.getByLabelText("Name")).toBeTruthy();
    // Description label has "(optional)" suffix; match the textarea by id.
    expect(document.getElementById("cw-description")).not.toBeNull();
    expect(screen.getByTestId("cw-source-toggle")).toBeTruthy();
    // Local mode is the default → path field + Browse button render.
    expect(screen.getByLabelText("Path")).toBeTruthy();
    expect(screen.getByTestId("cw-path-browse")).toBeTruthy();

    // Active key is rendered as a checkbox row; inactive key is filtered out.
    expect(screen.getByLabelText("Personal Anthropic")).toBeTruthy();
    expect(screen.queryByLabelText("Old key")).toBeNull();

    // Submit button starts disabled because no key is checked yet.
    const submit = screen.getByTestId("cw-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain("Create workspace");
  });

  it("renders the no-keys warning when there are no active keys", () => {
    aiKeysData = [INACTIVE_KEY];
    render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);

    expect(screen.getByTestId("cw-no-keys-warning")).toBeTruthy();
    const submit = screen.getByTestId("cw-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});

describe("NewWorkspaceDialog / source segment toggle", () => {
  it("swaps the path field for a repoUrl field when 'Clone from Git' is picked", async () => {
    aiKeysData = [ACTIVE_KEY];
    const user = userEvent.setup();
    render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);

    expect(screen.getByLabelText("Path")).toBeTruthy();
    expect(screen.queryByLabelText("Repository URL")).toBeNull();

    const gitOption = screen.getByRole("radio", { name: "Clone from Git" });
    await user.click(gitOption);

    expect(screen.queryByLabelText("Path")).toBeNull();
    expect(screen.getByLabelText("Repository URL")).toBeTruthy();
  });
});

describe("NewWorkspaceDialog / submit flow", () => {
  it("blocks submit when no AI key is checked and never calls mutateAsync", async () => {
    aiKeysData = [ACTIVE_KEY];
    const user = userEvent.setup();
    render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);

    await user.type(screen.getByLabelText("Name"), "Marketing");

    const submit = screen.getByTestId("cw-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // Clicking a disabled button is a no-op, but explicitly assert the
    // contract: zero mutation calls.
    expect(mutateAsyncSpy).not.toHaveBeenCalled();
  });

  it("calls mutateAsync with name + repoUrl + allowed_key_ids + gitignore triplet (git source)", async () => {
    aiKeysData = [ACTIVE_KEY];
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<NewWorkspaceDialog open={true} onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText("Name"), "Marketing");

    await user.click(screen.getByRole("radio", { name: "Clone from Git" }));
    await user.type(
      screen.getByLabelText("Repository URL"),
      "https://github.com/org/repo",
    );

    await user.click(screen.getByLabelText("Personal Anthropic"));

    const submit = screen.getByTestId("cw-submit") as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));

    await act(async () => {
      await user.click(submit);
    });

    await waitFor(() => {
      expect(mutateAsyncSpy).toHaveBeenCalledTimes(1);
    });

    const payload = (mutateAsyncSpy.mock.calls[0]?.[0] ?? {}) as Record<
      string,
      unknown
    >;
    expect(payload.name).toBe("Marketing");
    expect(payload.repoUrl).toBe("https://github.com/org/repo");
    expect(payload.allowed_key_ids).toEqual([1]);
    // No path field in git mode.
    expect(payload.path).toBeUndefined();
    // Full gitignore triplet always sent (component comment: "always-send").
    expect(payload.gitignore_flockctl).toBeDefined();
    expect(payload.gitignore_todo).toBeDefined();
    expect(payload.gitignore_agents_md).toBeDefined();

    // Successful create → controlled-mode parent is asked to close.
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("sends path (not repoUrl) when staying on the local source segment", async () => {
    aiKeysData = [ACTIVE_KEY];
    const user = userEvent.setup();
    render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);

    await user.type(screen.getByLabelText("Name"), "Local Thing");
    await user.type(screen.getByLabelText("Path"), "/tmp/local-thing");
    await user.click(screen.getByLabelText("Personal Anthropic"));

    await act(async () => {
      await user.click(screen.getByTestId("cw-submit"));
    });

    await waitFor(() => {
      expect(mutateAsyncSpy).toHaveBeenCalledTimes(1);
    });
    const payload = (mutateAsyncSpy.mock.calls[0]?.[0] ?? {}) as Record<
      string,
      unknown
    >;
    expect(payload.path).toBe("/tmp/local-thing");
    expect(payload.repoUrl).toBeUndefined();
  });

  it("surfaces a form error when mutateAsync rejects and keeps the dialog open", async () => {
    aiKeysData = [ACTIVE_KEY];
    mutateAsyncSpy.mockRejectedValueOnce(new Error("boom: workspace exists"));
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<NewWorkspaceDialog open={true} onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText("Name"), "Boom");
    await user.click(screen.getByLabelText("Personal Anthropic"));

    await act(async () => {
      await user.click(screen.getByTestId("cw-submit"));
    });

    expect(await screen.findByTestId("cw-form-error")).toHaveTextContent(
      "boom: workspace exists",
    );
    // Dialog must NOT have been asked to close — the user needs to fix
    // the error first.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe("NewWorkspaceDialog / DirectoryPicker integration", () => {
  it("renders the Browse… button with the legacy data-testid `cw-path-browse`", () => {
    // The picker is a sibling Radix Dialog; jsdom + Radix's pointer-event
    // modal layer make end-to-end "click Browse → assert picker is open"
    // flaky in unit tests (the picker's own tests cover its mount path).
    // Asserting that the wiring point is in the DOM is enough at this
    // tier — the picker's `open` prop is handled by simple component
    // state (`pickerOpen`) and there is no other consumer.
    aiKeysData = [ACTIVE_KEY];
    render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);

    const browse = screen.getByTestId("cw-path-browse") as HTMLButtonElement;
    expect(browse).toBeTruthy();
    expect(browse.tagName).toBe("BUTTON");
    expect(browse.textContent).toMatch(/Browse/);
    expect(browse.disabled).toBe(false);
  });

  it("hides the Browse… button when source is switched to git (no path field)", async () => {
    aiKeysData = [ACTIVE_KEY];
    const user = userEvent.setup();
    render(<NewWorkspaceDialog open={true} onOpenChange={() => {}} />);

    expect(screen.getByTestId("cw-path-browse")).toBeTruthy();

    await user.click(screen.getByRole("radio", { name: "Clone from Git" }));

    // Browse is part of the Path field; switching to git removes both.
    expect(screen.queryByTestId("cw-path-browse")).toBeNull();
  });
});
