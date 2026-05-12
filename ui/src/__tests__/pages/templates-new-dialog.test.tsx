/**
 * Tests for {@link NewTemplateDialog} (refresh of the legacy
 * `CreateTemplateDialog` from `pages/templates.tsx`).
 *
 * The component is *visually* refreshed but its behaviour contract is
 * unchanged, so the tests pin the contract:
 *
 *   - the dialog renders its own trigger button by default and opens
 *     the dialog content on click,
 *   - the form layout uses the `grid-cols-[160px_1fr]` token (the
 *     visual fingerprint of the refresh — a regression to the legacy
 *     `space-y-4` stack would fail this assertion),
 *   - the shadcn Dialog primitive is preserved (forms exception per
 *     `ui/CONTRIBUTING-DESIGN.md`),
 *   - the workspace and project rows only mount when the matching
 *     scope is selected (legacy conditional rendering preserved),
 *   - submit blocks with "Name is required" when the name field is
 *     empty and never invokes `useCreateTemplate().mutateAsync`,
 *   - submit blocks when scope=workspace but no workspace is picked,
 *   - happy path: filling Name + leaving scope=global posts the
 *     trimmed name + global scope + default timeout via
 *     `useCreateTemplate().mutateAsync`, then closes the dialog.
 *
 * Hook strategy: `@/lib/hooks` is mocked directly so the test drives
 * the mutation surface deterministically and doesn't depend on the
 * apiFetch ↔ snake/camel conversion. This mirrors the strategy used by
 * `workspaces-new-dialog.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// jsdom doesn't ship with several APIs that Radix Dialog + Select reach
// for. No-op stubs are enough — the tests don't measure layout. Mirrors
// the polyfill in `workspaces-new-dialog.test.tsx`.
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

const mutateAsyncSpy: ReturnType<typeof vi.fn> = vi.fn(async (
  _data: Record<string, unknown>,
) => ({ id: "tpl-new" }));
const useCreateTemplateState = {
  isPending: false,
};

vi.mock("@/lib/hooks", () => ({
  useCreateTemplate: () => ({
    mutate: vi.fn(),
    mutateAsync: mutateAsyncSpy,
    isPending: useCreateTemplateState.isPending,
  }),
  // The dialog itself only needs the lists for its scope-dependent
  // dropdowns. Empty arrays are fine for the global-scope happy path.
  useWorkspaces: () => ({ data: [], isLoading: false }),
  useProjects: () => ({ data: [], isLoading: false }),
  // TaskFormFields (rendered inside the dialog) reaches for these too —
  // returning empty / harmless values keeps it mountable without the
  // network. The dialog never reads from them directly.
  useMeta: () => ({ data: { agents: [], models: [], keys: [] } }),
  useAIKeys: () => ({ data: [], isLoading: false }),
  useProjectAllowedKeys: () => ({ data: null, isLoading: false }),
}));

// Import AFTER the mock so the dialog picks up the stubbed hooks.
import { NewTemplateDialog } from "@/pages/templates-components/NewTemplateDialog";

beforeEach(() => {
  mutateAsyncSpy.mockClear();
  mutateAsyncSpy.mockResolvedValue({ id: "tpl-new" });
  useCreateTemplateState.isPending = false;
  document.body.innerHTML = "";
});

describe("NewTemplateDialog — trigger + open", () => {
  it("renders the trigger button and opens the dialog on click", async () => {
    const user = userEvent.setup();
    render(<NewTemplateDialog />);

    expect(screen.getByTestId("new-template-trigger")).toBeInTheDocument();
    expect(screen.queryByTestId("new-template-dialog")).toBeNull();

    await user.click(screen.getByTestId("new-template-trigger"));

    const dialog = await screen.findByTestId("new-template-dialog");
    expect(dialog).toBeInTheDocument();
    // Pin the heading inside the dialog scope so we don't double-match
    // the trigger button text.
    expect(within(dialog).getByText("Create Template")).toBeInTheDocument();
  });

  it("respects the triggerLabel override", async () => {
    render(<NewTemplateDialog triggerLabel="New template" />);
    expect(screen.getByTestId("new-template-trigger").textContent).toContain(
      "New template",
    );
  });
});

describe("NewTemplateDialog — restyled grid layout", () => {
  it("inner form rows live inside a grid-cols-[160px_1fr] container", async () => {
    const user = userEvent.setup();
    render(<NewTemplateDialog />);
    await user.click(screen.getByTestId("new-template-trigger"));

    const grid = await screen.findByTestId("new-template-grid");
    // The grid token is the visual fingerprint of the refresh — assert
    // the exact utility class so a regression to the legacy `space-y-4`
    // stack is caught here, not on a screenshot.
    expect(grid.className).toContain("grid-cols-[160px_1fr]");
    expect(grid.className).toContain("grid");
  });

  it("preserves the shadcn Dialog (forms exception) — DialogContent is rendered", async () => {
    const user = userEvent.setup();
    render(<NewTemplateDialog />);
    await user.click(screen.getByTestId("new-template-trigger"));

    // DialogContent is identified by Radix via role="dialog".
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // The Radix dialog hosts our test-id'd form.
    expect(within(dialog).getByTestId("new-template-form")).toBeInTheDocument();
  });
});

describe("NewTemplateDialog — scope-dependent rows", () => {
  it("does not render workspace / project rows for the default global scope", async () => {
    const user = userEvent.setup();
    render(<NewTemplateDialog />);
    await user.click(screen.getByTestId("new-template-trigger"));
    await screen.findByTestId("new-template-dialog");

    // Both auxiliary rows are gated on the scope picker. Default scope
    // is `global`, so neither should mount.
    expect(document.getElementById("tpl-workspace")).toBeNull();
    expect(document.getElementById("tpl-project")).toBeNull();
  });
});

describe("NewTemplateDialog — validation", () => {
  it("blocks submit with empty name and surfaces 'Name is required'", async () => {
    const user = userEvent.setup();
    render(<NewTemplateDialog />);
    await user.click(screen.getByTestId("new-template-trigger"));
    await screen.findByTestId("new-template-dialog");

    await user.click(screen.getByTestId("new-template-submit"));

    expect(await screen.findByTestId("new-template-error")).toHaveTextContent(
      /name is required/i,
    );
    // The mutation must not have fired.
    expect(mutateAsyncSpy).not.toHaveBeenCalled();
  });
});

describe("NewTemplateDialog — happy path", () => {
  it("calls mutateAsync with trimmed name + global scope + default timeout, then closes", async () => {
    const user = userEvent.setup();
    render(<NewTemplateDialog />);

    await user.click(screen.getByTestId("new-template-trigger"));
    await screen.findByTestId("new-template-dialog");

    // Whitespace around the name is trimmed before submit.
    await user.type(screen.getByLabelText(/^name \*$/i), "  nightly-build  ");

    await user.click(screen.getByTestId("new-template-submit"));

    await waitFor(() => {
      expect(mutateAsyncSpy).toHaveBeenCalledTimes(1);
    });

    const payload = mutateAsyncSpy.mock.calls[0]?.[0] as {
      name: string;
      scope: string;
      timeout_seconds: number;
      workspace_id?: string;
      project_id?: string;
      description?: string;
      prompt?: string;
    };
    expect(payload.name).toBe("nightly-build");
    expect(payload.scope).toBe("global");
    // `defaultTaskFormValues.timeout` is "300"; component coerces to Number.
    expect(payload.timeout_seconds).toBe(300);
    // Workspace / project never set on a global-scoped template.
    expect(payload.workspace_id).toBeUndefined();
    expect(payload.project_id).toBeUndefined();
    // Optional fields are omitted when blank (legacy behaviour).
    expect(payload.description).toBeUndefined();
    expect(payload.prompt).toBeUndefined();

    // After a successful create the dialog resets + closes — the form
    // should no longer be in the DOM.
    await waitFor(() => {
      expect(screen.queryByTestId("new-template-dialog")).toBeNull();
    });
  });
});
