import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Unit tests for the {@link PlanFileEditor} save flow — dirty tracking and
 * the save button wiring against the legacy plan-store endpoints.
 *
 * Mirrors `agents-md-editor-save.test.tsx`: hooks are mocked at the module
 * boundary so the test owns:
 *   - what `usePlanFile` reports (content + path),
 *   - whether `useUpdatePlanFile().mutateAsync` resolves or rejects.
 *
 * Monaco is replaced with a passthrough <textarea> so we can drive
 * `onChange` synchronously via `fireEvent.change`. The real Cmd+S binding
 * runs through Monaco's `editor.addCommand`, which the passthrough cannot
 * exercise — that path is verified by the Playwright spec; the unit tests
 * drive saves through the visible Save button instead.
 *
 * NOTE: the plan-file API does NOT track sha; the conflict-banner contract
 * only applies to AgentsMdEditor (which reads the FS API). This file
 * therefore covers the dirty/save loop only.
 */

// --- Mock state (referenced by the hoisted vi.mock factories) ---------------

interface PlanFileQueryState {
  data: { content: string; path: string } | undefined;
  error: unknown;
  isLoading: boolean;
}

let planFileState: PlanFileQueryState;
const updateFileMutate = vi.fn();

vi.mock("@/lib/hooks", () => ({
  usePlanFile: () => planFileState,
  useUpdatePlanFile: () => ({
    mutateAsync: updateFileMutate,
    isPending: false,
  }),
}));

// `@monaco-editor/react` — passthrough <textarea>. We need a real DOM
// `onChange` so the test can drive draft mutations; otherwise dirty
// transitions are unobservable from outside the component.
vi.mock("@monaco-editor/react", () => {
  const Editor = ({
    value,
    onChange,
    language,
    path,
  }: {
    value?: string;
    onChange?: (next: string | undefined) => void;
    language?: string;
    path?: string;
  }) => (
    <textarea
      data-testid="mock-monaco"
      data-language={language ?? ""}
      data-path={path ?? ""}
      value={value ?? ""}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
  const DiffEditor = () => <div data-testid="mock-monaco-diff" />;
  return {
    Editor,
    DiffEditor,
    loader: { config: vi.fn() },
  };
});

vi.mock("monaco-editor", () => ({
  // M23 / T06 — `defineTheme` is needed for the Flockctl Monaco theme
  // registration that runs at module load.
  editor: { setTheme: vi.fn(), defineTheme: vi.fn() },
}));

// localStorage + matchMedia shim — mirrors the workaround in
// `agents-md-editor-save.test.tsx` so the theme provider mounts cleanly
// under jsdom.
let storageBacking: Record<string, string>;
const mockStorage = {
  getItem: (k: string) => (k in storageBacking ? storageBacking[k] : null),
  setItem: (k: string, v: string) => {
    storageBacking[k] = v;
  },
  removeItem: (k: string) => {
    delete storageBacking[k];
  },
  clear: () => {
    storageBacking = {};
  },
  key: () => null,
  length: 0,
};

beforeEach(() => {
  storageBacking = {};
  Object.defineProperty(globalThis, "localStorage", {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }

  updateFileMutate.mockReset();
  updateFileMutate.mockResolvedValue({ ok: true });
});

// --- Subject ----------------------------------------------------------------
import { PlanFileEditor } from "@/pages/project-detail-components/PlanFileEditor";
import type { ChatContext } from "@/pages/project-detail-components/types";
import { ThemeProvider } from "@/components/theme-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const milestoneContext: ChatContext = {
  entity_type: "milestone",
  entity_id: "00-foo",
  title: "Foo milestone",
};

function renderEditor(context: ChatContext = milestoneContext) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <PlanFileEditor projectId="42" context={context} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

function loadedPlanFile(content: string, path: string): PlanFileQueryState {
  return {
    data: { content, path },
    error: null,
    isLoading: false,
  };
}

// --- Tests ------------------------------------------------------------------

describe("<PlanFileEditor /> — save flow", () => {
  it("monaco_mounts_with_markdown_language_and_seeded_content", async () => {
    planFileState = loadedPlanFile("# Hello", "plan/00-foo/milestone.md");
    renderEditor();

    const editor = await screen.findByTestId("mock-monaco");
    expect(editor).toHaveAttribute("data-language", "markdown");
    expect(editor).toHaveValue("# Hello");
    // Path label trims to last 3 segments.
    expect(screen.getByTestId("plan-file-editor-path")).toHaveTextContent(
      "plan/00-foo/milestone.md",
    );
  });

  it("dirty_badge_appears_when_draft_diverges_from_source", async () => {
    planFileState = loadedPlanFile("# Hello", "plan/00-foo/milestone.md");
    renderEditor();

    const editor = await screen.findByTestId("mock-monaco");
    // No edits yet — no Unsaved badge.
    expect(screen.queryByTestId("plan-file-editor-dirty")).not.toBeInTheDocument();

    fireEvent.change(editor, { target: { value: "# Hello, world" } });

    expect(
      await screen.findByTestId("plan-file-editor-dirty"),
    ).toBeInTheDocument();
  });

  it("save_button_invokes_update_mutation_and_clears_dirty", async () => {
    planFileState = loadedPlanFile("# Hello", "plan/00-foo/milestone.md");
    renderEditor();
    const editor = await screen.findByTestId("mock-monaco");
    fireEvent.change(editor, { target: { value: "# Hello, world" } });
    expect(
      await screen.findByTestId("plan-file-editor-dirty"),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save plan file/i }));
    });

    await waitFor(() => expect(updateFileMutate).toHaveBeenCalledTimes(1));
    expect(updateFileMutate).toHaveBeenCalledWith({
      type: "milestone",
      milestone: "00-foo",
      slice: undefined,
      task: undefined,
      content: "# Hello, world",
    });

    // After a successful save: source advances to the just-written draft, so
    // the Unsaved badge clears.
    await waitFor(() =>
      expect(
        screen.queryByTestId("plan-file-editor-dirty"),
      ).not.toBeInTheDocument(),
    );
    // And the transient Saved badge surfaces.
    expect(
      await screen.findByTestId("plan-file-editor-saved"),
    ).toBeInTheDocument();
  });

  it("save_button_disabled_when_buffer_is_clean", async () => {
    planFileState = loadedPlanFile("# Hello", "plan/00-foo/milestone.md");
    renderEditor();

    await screen.findByTestId("mock-monaco");
    const button = screen.getByRole("button", { name: /save disabled/i });
    expect(button).toBeDisabled();
  });

  it("slice_context_routes_save_with_slice_id", async () => {
    planFileState = loadedPlanFile("# Slice body", "plan/01-bar/slice.md");
    renderEditor({
      entity_type: "slice",
      entity_id: "01-bar",
      milestone_id: "00-foo",
      title: "Bar slice",
    });

    const editor = await screen.findByTestId("mock-monaco");
    fireEvent.change(editor, { target: { value: "# Slice body edited" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save plan file/i }));
    });

    await waitFor(() => expect(updateFileMutate).toHaveBeenCalledTimes(1));
    expect(updateFileMutate).toHaveBeenCalledWith({
      type: "slice",
      milestone: "00-foo",
      slice: "01-bar",
      task: undefined,
      content: "# Slice body edited",
    });
  });
});
