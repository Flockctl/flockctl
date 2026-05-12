import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * Unit tests for {@link AgentsMdEditor}.
 *
 * The slice's contract — "AgentsMdEditor reads via <CodeEditor> + GET fs/file"
 * — is verified by mocking `useProjectFile` so we can hand the component a
 * deterministic `{ ok: true, content, sha, ... }` envelope and assert that
 *
 *   1. the Monaco-backed `<CodeEditor>` mounts with `value === content`,
 *   2. the editor is configured with `language="markdown"`,
 *   3. the read-status header strip reflects the `loaded` branch.
 *
 * Hooks are mocked at the module boundary so the test does not need a
 * QueryClientProvider, fetch shim, or live backend. The Monaco runtime is
 * heavy and irrelevant to this slice — `@monaco-editor/react` is mocked to
 * a passthrough <div> that mirrors the props we care about onto data-* so
 * the assertion stays cheap and synchronous.
 */

// --- Mocks (must precede the import-under-test) -----------------------------

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

vi.mock("@/lib/hooks/fs", () => ({
  useProjectFile: () => projectFileState,
  useWorkspaceFile: () => ({
    data: undefined,
    error: null,
    isLoading: false,
  }),
  // The editor imports the query key factories so it can imperatively
  // refresh the React Query cache after a save. Mirror them here so the
  // mocked module exposes the same surface.
  projectFileQueryKey: (projectId: string, path: string | null) =>
    ["project-file", projectId, path] as const,
  workspaceFileQueryKey: (workspaceId: string, path: string | null) =>
    ["workspace-file", workspaceId, path] as const,
}));

// `@/lib/api/fs` — the editor imports `fetchProjectFile` /
// `fetchWorkspaceFile` directly to do save-time conflict detection. The unit
// tests in this file never trigger save, so a no-op stub is enough.
vi.mock("@/lib/api/fs", () => ({
  fetchProjectFile: vi.fn(() => Promise.resolve({ ok: false, error_code: "fs_not_found" })),
  fetchWorkspaceFile: vi.fn(() => Promise.resolve({ ok: false, error_code: "fs_not_found" })),
}));

vi.mock("@/lib/hooks", () => ({
  useProjectEffective: () => ({ data: undefined, isLoading: false }),
  useWorkspaceEffective: () => ({ data: undefined, isLoading: false }),
  usePutProjectAgentsMd: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  usePutWorkspaceAgentsMd: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

// `@monaco-editor/react` ships a heavy runtime. The lazy boundary in
// `CodeEditor.tsx` keeps it out of the main bundle, but a unit test that
// renders the editor would still pay the (synchronous) Monaco worker import
// when the `React.lazy` chunk resolves. Stub the editor with a passthrough
// surface so we can assert the props the wrapper hands down without booting
// Monaco.
vi.mock("@monaco-editor/react", () => {
  const Editor = ({
    value,
    language,
    path,
  }: {
    value?: string;
    language?: string;
    path?: string;
  }) => (
    <div
      data-testid="mock-monaco"
      data-value={value ?? ""}
      data-language={language ?? ""}
      data-path={path ?? ""}
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

// `localStorage` + `matchMedia` shim — the theme provider that backs
// `<CodeEditor>` reads both on mount, and jsdom 29 doesn't ship them by
// default. Mirrors the workaround the existing `code-editor.test.tsx` uses.
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
});

// --- Subject ----------------------------------------------------------------
import { AgentsMdEditor } from "@/components/AgentsMdEditor";
import { ThemeProvider } from "@/components/theme-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function renderEditor(props: Partial<{ scope: "project" | "workspace"; id: string }> = {}) {
  // The editor reads the React Query client to imperatively refetch the
  // AGENTS.md file at save time (sha-conflict detection). Wrap with a
  // dedicated client so each test starts with an empty cache.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <AgentsMdEditor scope={props.scope ?? "project"} id={props.id ?? "1"} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("<AgentsMdEditor /> — read path via fs/file", () => {
  it("agents_md_editor_mounts_code_editor_with_loaded_content", async () => {
    projectFileState = {
      data: {
        ok: true,
        content: "# Hello",
        sha: "abc",
        size: 7,
        mtime: 0,
        encoding: "utf-8",
      },
      error: null,
      isLoading: false,
    };

    renderEditor();

    // Suspense resolves once the lazy CodeEditor chunk lands; the mocked
    // Monaco `<Editor>` is the proof that we routed through CodeEditor.
    const monaco = await screen.findByTestId("mock-monaco");
    expect(monaco.getAttribute("data-value")).toBe("# Hello");
    expect(monaco.getAttribute("data-language")).toBe("markdown");
    expect(monaco.getAttribute("data-path")).toBe("AGENTS.md");
  });

  it("agents_md_editor_renders_loaded_status_header", async () => {
    projectFileState = {
      data: {
        ok: true,
        content: "# Loaded",
        sha: "z",
        size: 8,
        mtime: 0,
        encoding: "utf-8",
      },
      error: null,
      isLoading: false,
    };

    renderEditor();

    const status = await screen.findByTestId(
      "agents-md-status-project-public",
    );
    expect(status.textContent).toBe("loaded");

    // Path label echoes the (relative) AGENTS.md path the hook fetched.
    expect(
      screen.getByTestId("agents-md-path-project-public").textContent,
    ).toBe("AGENTS.md");
  });

  it("agents_md_editor_renders_creating_new_when_file_missing", () => {
    // Server answers HTTP 200 with `{ ok: false, error_code: "fs_not_found" }`
    // for projects that have never had an AGENTS.md. The editor should
    // collapse that into the empty-state CTA, not a load error.
    projectFileState = {
      data: { ok: false, error_code: "fs_not_found" },
      error: null,
      isLoading: false,
    };

    renderEditor();

    expect(
      screen.getByTestId("agents-md-empty-project-public"),
    ).toBeInTheDocument();
    // Monaco does NOT mount in the empty state — the user has to click
    // Create first.
    expect(screen.queryByTestId("mock-monaco")).not.toBeInTheDocument();
  });
});
