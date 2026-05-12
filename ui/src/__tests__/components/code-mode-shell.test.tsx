import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Unit tests for the project-detail "Code" tab wrapper —
 * {@link ProjectCodeMode}. The wrapper composes:
 *
 *   - `<CodeModeShell>` (already covered by its own tests)
 *   - `<FileTree>`      (already covered by its own tests)
 *   - `<CodeEditor>`    (already covered by its own tests)
 *
 * So this suite focuses purely on the wiring contract:
 *
 *   1. The Files panel renders by default (default activity from the
 *      shell), with the project tree visible.
 *   2. Activating a leaf in the tree promotes the empty-state placeholder
 *      to a Monaco-backed editor pane and fires a single
 *      `GET /projects/:id/fs/file?path=…`.
 *   3. Activating a different leaf swaps the buffer in-place
 *      (replacement, not tabs — that's slice 01's job).
 *   4. Switching projects via prop change resets the open path so a
 *      stale buffer from the previous project does not leak into the
 *      new view.
 *   5. The error envelope from `useProjectFile` surfaces in the editor
 *      slot rather than crashing the page.
 *
 * Mocking strategy:
 *   - react-arborist is replaced by a deterministic flat renderer (same
 *     shape as `file-tree.test.tsx` so the contract stays consistent).
 *   - The Monaco wrapper is stubbed at the module boundary — we only
 *     care that the wrapper got the right `value` + `path`, not that
 *     Monaco itself rendered. The real wrapper is exercised in
 *     `code-editor.test.tsx`.
 *   - `fetchProjectFile` and `fetchFsList` are spied on directly.
 */

// --- localStorage / matchMedia shims (theme provider needs both) ---
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

// --- react-arborist mock: flatten the tree, render every visible row ---

vi.mock("react-arborist", () => {
  function MockTree(props: any) {
    const { data, children, onActivate } = props;
    const NodeRenderer = children;
    const [openIds] = React.useState<Set<string>>(new Set());

    const flatten = (nodes: any[], level: number, out: any[]) => {
      for (const n of nodes) {
        const id: string = n.id;
        const isLeaf = n.children === undefined || n.children === null;
        const node = {
          data: n,
          level,
          isOpen: openIds.has(id),
          isSelected: false,
          toggle: () => {},
          activate: () => {
            onActivate?.(node);
          },
        };
        out.push(node);
        if (node.isOpen && !isLeaf && Array.isArray(n.children)) {
          flatten(n.children, level + 1, out);
        }
      }
      return out;
    };

    const flat = flatten(data ?? [], 0, []);
    return (
      <div data-testid="mock-arborist-tree">
        {flat.map((node) => (
          <NodeRenderer
            key={node.data.id}
            node={node}
            tree={{}}
            style={{}}
            dragHandle={() => {}}
          />
        ))}
      </div>
    );
  }
  return { Tree: MockTree };
});

// --- Monaco wrapper stub: render value+path so we can assert the wiring ---

vi.mock("@/components/CodeEditor", () => {
  return {
    CodeEditor: (props: { value: string; path?: string }) => (
      <div
        data-testid="mock-code-editor"
        data-path={props.path ?? ""}
        data-value={props.value}
      />
    ),
  };
});

// react-router's `useNavigate` is harmless here, but the SourceControlPanel
// (lazily reached via the SCM activity tab) imports query hooks we don't
// want to set up. Stub it — the Files activity is the default and the
// only one this suite exercises.
vi.mock("@/components/git/SourceControlPanel", () => ({
  SourceControlPanel: () => <div data-testid="mock-scm-panel" />,
}));

import * as fsApi from "@/lib/api/fs";

import { ProjectCodeMode } from "@/pages/project-detail-components/CodeMode";

function withQueryClient(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
    },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const ROOT_LISTING: fsApi.FsListResponse = {
  ok: true,
  path: ".",
  entries: [
    { name: "README.md", type: "file", ignored: false, size: 12, mtime: 1 },
    { name: "package.json", type: "file", ignored: false, size: 5, mtime: 2 },
  ],
  truncated: false,
};

function stubFs() {
  vi.spyOn(fsApi, "fetchFsList").mockImplementation(
    (_projectId: string, path: string) => {
      if (path === "") return Promise.resolve(ROOT_LISTING);
      return Promise.reject(new Error(`unexpected fetchFsList path: "${path}"`));
    },
  );
}

function stubFileRead(byPath: Record<string, fsApi.FsReadResponse | Error>) {
  return vi.spyOn(fsApi, "fetchProjectFile").mockImplementation(
    (_projectId: string, path: string) => {
      const entry = byPath[path];
      if (!entry) {
        return Promise.reject(new Error(`unexpected fetchProjectFile: "${path}"`));
      }
      if (entry instanceof Error) return Promise.reject(entry);
      return Promise.resolve(entry);
    },
  );
}

const TARGET = {
  kind: "project" as const,
  id: "p-1",
  path: "/tmp/p-1",
};

describe("<ProjectCodeMode />", () => {
  it("renders the empty editor placeholder before any file is selected", async () => {
    stubFs();
    render(
      withQueryClient(
        <ProjectCodeMode projectId="p-1" target={TARGET} />,
      ),
    );

    // Default activity is the Files panel — the file tree must mount.
    await screen.findByTestId("code-mode-files-panel");
    await screen.findByTestId("file-tree-row-README.md");

    // Editor area shows the empty state, NOT the editor.
    expect(screen.getByTestId("code-mode-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("code-mode-editor")).toBeNull();
    expect(screen.queryByTestId("mock-code-editor")).toBeNull();
  });

  it("opens the activated file in the single Monaco pane", async () => {
    stubFs();
    const readSpy = stubFileRead({
      "README.md": {
        ok: true,
        content: "# hello\n",
        sha: "sha-1",
        size: 8,
        mtime: 1,
        encoding: "utf-8",
      },
    });

    const user = userEvent.setup();
    render(
      withQueryClient(
        <ProjectCodeMode projectId="p-1" target={TARGET} />,
      ),
    );

    const row = await screen.findByTestId("file-tree-row-README.md");
    await user.click(row);

    // The empty state gives way to the editor pane carrying the contents.
    const editor = await screen.findByTestId("code-mode-editor");
    expect(editor).toHaveAttribute("data-open-path", "README.md");

    const monaco = screen.getByTestId("mock-code-editor");
    expect(monaco).toHaveAttribute("data-path", "README.md");
    expect(monaco).toHaveAttribute("data-value", "# hello\n");

    expect(readSpy).toHaveBeenCalledTimes(1);
    // The third positional arg is the optional `range` — undefined for
    // a default whole-file read; the partial-open flow lives in the
    // dedicated `large-file.test.tsx`.
    expect(readSpy).toHaveBeenCalledWith("p-1", "README.md", undefined);
  });

  it("replaces the buffer in-place when the user activates a different file", async () => {
    stubFs();
    const readSpy = stubFileRead({
      "README.md": {
        ok: true,
        content: "first\n",
        sha: "sha-1",
        size: 6,
        mtime: 1,
        encoding: "utf-8",
      },
      "package.json": {
        ok: true,
        content: "{ }\n",
        sha: "sha-2",
        size: 4,
        mtime: 2,
        encoding: "utf-8",
      },
    });

    const user = userEvent.setup();
    render(
      withQueryClient(
        <ProjectCodeMode projectId="p-1" target={TARGET} />,
      ),
    );

    await user.click(await screen.findByTestId("file-tree-row-README.md"));

    await waitFor(() => {
      const m = screen.getByTestId("mock-code-editor");
      expect(m).toHaveAttribute("data-value", "first\n");
    });

    // Switching files swaps the buffer — there is no second editor mount,
    // the existing pane re-renders with the new value/path.
    await user.click(await screen.findByTestId("file-tree-row-package.json"));

    await waitFor(() => {
      const m = screen.getByTestId("mock-code-editor");
      expect(m).toHaveAttribute("data-path", "package.json");
      expect(m).toHaveAttribute("data-value", "{ }\n");
    });

    // Single editor mount, two reads — one per opened file.
    expect(screen.getAllByTestId("mock-code-editor")).toHaveLength(1);
    expect(readSpy).toHaveBeenCalledTimes(2);
  });

  it("falls back to the empty state when the projectId-keyed subtree remounts", async () => {
    stubFs();
    stubFileRead({
      "README.md": {
        ok: true,
        content: "first\n",
        sha: "sha-1",
        size: 6,
        mtime: 1,
        encoding: "utf-8",
      },
    });

    const user = userEvent.setup();
    // Mirror the wrapper's call site — project-detail.tsx passes
    // `key={projectId}` so a project swap remounts this subtree and
    // resets the selection. We assert that contract here by changing
    // the React key on rerender; the previous project's selected path
    // must not leak into the new mount.
    const { rerender } = render(
      withQueryClient(
        <ProjectCodeMode key="p-1" projectId="p-1" target={TARGET} />,
      ),
    );

    await user.click(await screen.findByTestId("file-tree-row-README.md"));
    await screen.findByTestId("code-mode-editor");

    rerender(
      withQueryClient(
        <ProjectCodeMode
          key="p-2"
          projectId="p-2"
          target={{ ...TARGET, id: "p-2" }}
        />,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId("code-mode-empty")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("code-mode-editor")).toBeNull();
  });

  it("renders the error placeholder when the file read fails", async () => {
    stubFs();
    stubFileRead({
      "README.md": new Error("boom"),
    });

    const user = userEvent.setup();
    render(
      withQueryClient(
        <ProjectCodeMode projectId="p-1" target={TARGET} />,
      ),
    );

    await user.click(await screen.findByTestId("file-tree-row-README.md"));

    const err = await screen.findByTestId("code-mode-error");
    expect(err.textContent).toContain("README.md");
    expect(err.textContent).toContain("boom");

    // Editor is NOT mounted on the error path.
    expect(screen.queryByTestId("mock-code-editor")).toBeNull();
  });
});
