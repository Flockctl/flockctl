import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Unit tests for the AgentsMdEditor save flow — dirty tracking, sha-conflict
 * detection, and the conflict-resolution banner.
 *
 * Hooks and the underlying fetch helpers are mocked at the module boundary so
 * the test owns:
 *   - what `useProjectFile` reports (sha + content),
 *   - what `fetchProjectFile` returns when the editor refetches at save time,
 *   - whether `usePutProjectAgentsMd().mutateAsync` resolves or rejects.
 *
 * Monaco is replaced with a passthrough <textarea> so we can drive `onChange`
 * synchronously from the tests via `fireEvent.change`. The real Cmd+S binding
 * runs through Monaco's `editor.addCommand`, which the passthrough cannot
 * exercise — that path is verified by the Playwright two-tab race spec; the
 * unit tests drive saves through the visible Save button instead.
 */

// --- Mock state (referenced by the hoisted vi.mock factories) ---------------

interface FileQueryState {
  data:
    | {
        ok: true;
        content: string;
        sha: string;
        size: number;
        mtime: number;
        encoding: "utf-8";
      }
    | { ok: false; error_code: string; message?: string }
    | undefined;
  error: unknown;
  isLoading: boolean;
}

let projectFileState: FileQueryState;

// `nextFetchResponse` is what the editor sees when it imperatively refetches
// the file at save time (sha-conflict detection) and again after a successful
// PUT (heldSha advance). Tests overwrite it to simulate "another writer beat
// us" or "we saved, our content is now on disk".
let nextFetchResponse:
  | { ok: true; content: string; sha: string; size: number; mtime: number; encoding: "utf-8" }
  | { ok: false; error_code: string; message?: string };

const fetchProjectFileMock = vi.fn(() => Promise.resolve(nextFetchResponse));
const fetchWorkspaceFileMock = vi.fn(() => Promise.resolve(nextFetchResponse));

const putProjectMutate = vi.fn();
const putWorkspaceMutate = vi.fn();

vi.mock("@/lib/hooks/fs", () => ({
  useProjectFile: () => projectFileState,
  useWorkspaceFile: () => ({ data: undefined, error: null, isLoading: false }),
  projectFileQueryKey: (projectId: string, path: string | null) =>
    ["project-file", projectId, path] as const,
  workspaceFileQueryKey: (workspaceId: string, path: string | null) =>
    ["workspace-file", workspaceId, path] as const,
}));

vi.mock("@/lib/api/fs", () => ({
  fetchProjectFile: (...args: unknown[]) => fetchProjectFileMock(...(args as [])),
  fetchWorkspaceFile: (...args: unknown[]) => fetchWorkspaceFileMock(...(args as [])),
}));

vi.mock("@/lib/hooks", () => ({
  useProjectEffective: () => ({ data: undefined, isLoading: false }),
  useWorkspaceEffective: () => ({ data: undefined, isLoading: false }),
  usePutProjectAgentsMd: () => ({
    mutateAsync: putProjectMutate,
    isPending: false,
  }),
  usePutWorkspaceAgentsMd: () => ({
    mutateAsync: putWorkspaceMutate,
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
  // `defineTheme` is added so the M23 / T06 Flockctl Monaco theme
  // registration on module load doesn't throw under this mock.
  editor: { setTheme: vi.fn(), defineTheme: vi.fn() },
}));

// localStorage + matchMedia shim — mirrors the workaround in the sibling
// `agents-md-editor.test.tsx` so the theme provider mounts cleanly under
// jsdom 29.
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

  fetchProjectFileMock.mockClear();
  fetchWorkspaceFileMock.mockClear();
  putProjectMutate.mockReset();
  putWorkspaceMutate.mockReset();
  // Default: PUT resolves with an empty success envelope. Individual tests
  // that care about the resolved value override this.
  putProjectMutate.mockResolvedValue({ layer: "project-public", present: true, bytes: 0 });
  putWorkspaceMutate.mockResolvedValue({
    layer: "workspace-public",
    present: true,
    bytes: 0,
  });
});

// --- Subject ----------------------------------------------------------------
import { AgentsMdEditor } from "@/components/AgentsMdEditor";
import { ThemeProvider } from "@/components/theme-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function renderEditor() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <AgentsMdEditor scope="project" id="42" />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

function loadedFileState(content: string, sha: string): FileQueryState {
  return {
    data: {
      ok: true,
      content,
      sha,
      size: content.length,
      mtime: 0,
      encoding: "utf-8",
    },
    error: null,
    isLoading: false,
  };
}

// --- Tests ------------------------------------------------------------------

describe("<AgentsMdEditor /> — save flow", () => {
  it("dirty_badge_appears_when_draft_diverges_from_source", async () => {
    projectFileState = loadedFileState("# Hello", "sha-loaded");
    renderEditor();

    const editor = await screen.findByTestId("mock-monaco");
    // No edits yet — no Unsaved badge.
    expect(screen.queryByText("Unsaved")).not.toBeInTheDocument();

    fireEvent.change(editor, { target: { value: "# Hello, world" } });

    expect(await screen.findByText("Unsaved")).toBeInTheDocument();
  });

  it("save_with_matching_sha_clears_dirty_and_advances_held_sha", async () => {
    projectFileState = loadedFileState("# Hello", "sha-old");
    // 1st fetch: conflict probe — same sha, no conflict.
    // 2nd fetch: post-PUT refresh — server now reports the new sha + content.
    nextFetchResponse = {
      ok: true,
      content: "# Hello",
      sha: "sha-old",
      size: 7,
      mtime: 0,
      encoding: "utf-8",
    };
    fetchProjectFileMock
      .mockResolvedValueOnce(nextFetchResponse)
      .mockResolvedValueOnce({
        ok: true,
        content: "# Hello, world",
        sha: "sha-new",
        size: 14,
        mtime: 0,
        encoding: "utf-8",
      });

    renderEditor();
    const editor = await screen.findByTestId("mock-monaco");
    fireEvent.change(editor, { target: { value: "# Hello, world" } });

    expect(await screen.findByText("Unsaved")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save agent guidance/i }));
    });

    // PUT was called with the in-flight draft.
    await waitFor(() => expect(putProjectMutate).toHaveBeenCalledTimes(1));
    expect(putProjectMutate).toHaveBeenCalledWith({
      projectId: "42",
      content: "# Hello, world",
    });

    // Conflict probe + post-save refresh = 2 fetch calls.
    await waitFor(() => expect(fetchProjectFileMock).toHaveBeenCalledTimes(2));

    // No conflict banner — the matching sha lets the save through.
    // (`Unsaved` clears via the React Query refetch path; the hook is
    // mocked here so we don't observe the badge transition — that is
    // covered by the Playwright two-tab spec which uses the live API.)
    expect(
      screen.queryByTestId("agents-md-conflict-banner"),
    ).not.toBeInTheDocument();

    // Confirmation toast surfaces.
    await screen.findByTestId("agents-md-toast-info");
  });

  it("save_with_diverged_sha_shows_conflict_banner_and_skips_put", async () => {
    projectFileState = loadedFileState("# Hello", "sha-mine");
    // Conflict probe sees a different sha than the one we hold.
    nextFetchResponse = {
      ok: true,
      content: "# Their version",
      sha: "sha-theirs",
      size: 16,
      mtime: 0,
      encoding: "utf-8",
    };
    fetchProjectFileMock.mockResolvedValue(nextFetchResponse);

    renderEditor();
    const editor = await screen.findByTestId("mock-monaco");
    fireEvent.change(editor, { target: { value: "# My edit" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save agent guidance/i }));
    });

    // The banner is mounted with both resolution buttons.
    const banner = await screen.findByTestId("agents-md-conflict-banner");
    expect(banner).toBeInTheDocument();
    expect(screen.getByTestId("agents-md-conflict-reload")).toBeInTheDocument();
    expect(screen.getByTestId("agents-md-conflict-keep")).toBeInTheDocument();

    // PUT must NOT have run — we refused to overwrite.
    expect(putProjectMutate).not.toHaveBeenCalled();
    // Draft is preserved (still dirty).
    expect(screen.queryByText("Unsaved")).toBeInTheDocument();
  });

  it("conflict_keep_my_edits_dismisses_banner_and_advances_held_sha", async () => {
    projectFileState = loadedFileState("# Hello", "sha-mine");

    // First save attempt: conflict.
    fetchProjectFileMock.mockResolvedValueOnce({
      ok: true,
      content: "# Their version",
      sha: "sha-theirs",
      size: 16,
      mtime: 0,
      encoding: "utf-8",
    });

    renderEditor();
    const editor = await screen.findByTestId("mock-monaco");
    fireEvent.change(editor, { target: { value: "# My edit" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save agent guidance/i }));
    });
    await screen.findByTestId("agents-md-conflict-banner");

    // Click "Keep my edits" — banner dismisses, heldSha advances to
    // sha-theirs so the next save sails past the conflict check.
    await act(async () => {
      fireEvent.click(screen.getByTestId("agents-md-conflict-keep"));
    });
    expect(
      screen.queryByTestId("agents-md-conflict-banner"),
    ).not.toBeInTheDocument();

    // Second save attempt: probe returns sha-theirs (matches heldSha now),
    // PUT runs, post-save refresh returns the freshly-written file.
    fetchProjectFileMock
      .mockResolvedValueOnce({
        ok: true,
        content: "# Their version",
        sha: "sha-theirs",
        size: 16,
        mtime: 0,
        encoding: "utf-8",
      })
      .mockResolvedValueOnce({
        ok: true,
        content: "# My edit",
        sha: "sha-mine-final",
        size: 9,
        mtime: 0,
        encoding: "utf-8",
      });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save agent guidance/i }));
    });

    await waitFor(() => expect(putProjectMutate).toHaveBeenCalledTimes(1));
    expect(putProjectMutate).toHaveBeenCalledWith({
      projectId: "42",
      content: "# My edit",
    });
  });

  it("conflict_reload_invalidates_query_and_dismisses_banner", async () => {
    projectFileState = loadedFileState("# Hello", "sha-mine");
    fetchProjectFileMock.mockResolvedValueOnce({
      ok: true,
      content: "# Their version",
      sha: "sha-theirs",
      size: 16,
      mtime: 0,
      encoding: "utf-8",
    });

    renderEditor();
    const editor = await screen.findByTestId("mock-monaco");
    fireEvent.change(editor, { target: { value: "# My edit" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save agent guidance/i }));
    });
    await screen.findByTestId("agents-md-conflict-banner");

    await act(async () => {
      fireEvent.click(screen.getByTestId("agents-md-conflict-reload"));
    });

    // Banner gone.
    await waitFor(() =>
      expect(
        screen.queryByTestId("agents-md-conflict-banner"),
      ).not.toBeInTheDocument(),
    );
    // PUT still has not run.
    expect(putProjectMutate).not.toHaveBeenCalled();
  });
});
