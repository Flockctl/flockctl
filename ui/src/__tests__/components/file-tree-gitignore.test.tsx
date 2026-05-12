import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Unit tests for the gitignore dimming + show/hide pipeline.
 *
 * Two contracts are validated here, both at the boundary the slice
 * task pinned:
 *
 *   1. **Dim-only-when-shown.** When an entry comes back from the
 *      server with `ignored:true` AND the operator has `showIgnored`
 *      enabled, the row's wrapper carries the `opacity-50` class. This
 *      is the visual contract <TreeNode> exposes — testing the class
 *      directly (rather than computed style) sidesteps jsdom's
 *      no-css-engine limitation while still pinning the specific Tailwind
 *      utility the design relies on.
 *
 *   2. **Filter-out-when-hidden.** With `showIgnored=false`, the same
 *      ignored entries are filtered OUT of the data array passed to
 *      react-arborist before any row renders — so the row's
 *      `data-testid` is absent from the DOM entirely. This is the
 *      "pure data transformation before react-arborist sees the nodes"
 *      promise from the task spec; if it ever regresses to a CSS-only
 *      hide, the assertion below fails.
 *
 * react-arborist is mocked the same way as `file-tree.test.tsx`: a
 * deterministic flat renderer that walks visible nodes and forwards
 * each one to the user's `children` render prop. That keeps the test
 * focused on the data path through `useFsTree` + `<TreeNode>` rather
 * than react-window virtualisation.
 */

// --- react-arborist mock ----------------------------------------------------

type FakeNode = {
  data: any;
  level: number;
  isOpen: boolean;
  isSelected: boolean;
  toggle: () => void;
  activate: () => void;
};

vi.mock("react-arborist", () => {
  function MockTree(props: any) {
    const { data, children } = props;
    const NodeRenderer = children;
    const [openIds] = React.useState<Set<string>>(new Set());

    const flatten = (nodes: any[], level: number, out: FakeNode[]) => {
      for (const n of nodes) {
        const id: string = n.id;
        const isLeaf = n.children === undefined || n.children === null;
        const node: FakeNode = {
          data: n,
          level,
          isOpen: openIds.has(id),
          isSelected: false,
          toggle: () => {},
          activate: () => {},
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

// --- fetch mock -------------------------------------------------------------

import * as fsApi from "@/lib/api/fs";

beforeEach(() => {
  vi.restoreAllMocks();
});

function stubRoot(payload: fsApi.FsListResponse) {
  return vi.spyOn(fsApi, "fetchFsList").mockImplementation(
    (_projectId: string, path: string) => {
      if (path === "") return Promise.resolve(payload);
      return Promise.reject(
        new Error(`unexpected fetchFsList path: "${path}"`),
      );
    },
  );
}

import { FileTree } from "@/components/file-tree/FileTree";

function withQueryClient(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
    },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const ROOT_WITH_IGNORED: fsApi.FsListResponse = {
  ok: true,
  path: ".",
  entries: [
    { name: "src", type: "dir", ignored: false, hasChildren: true, mtime: 1 },
    { name: "node_modules", type: "dir", ignored: true, hasChildren: true, mtime: 2 },
    { name: "README.md", type: "file", ignored: false, size: 10, mtime: 3 },
    { name: ".env", type: "file", ignored: true, size: 5, mtime: 4 },
  ],
  truncated: false,
};

// ---------------------------------------------------------------------------

describe("<FileTree /> gitignore dimming + filter", () => {
  it("dims ignored rows with opacity-50 when showIgnored=true", async () => {
    stubRoot(ROOT_WITH_IGNORED);

    render(
      withQueryClient(
        <FileTree projectId="42" height={400} showIgnored={true} />,
      ),
    );

    // Both ignored and non-ignored rows are present in the DOM.
    const ignoredRow = await screen.findByTestId("file-tree-row-node_modules");
    const ignoredFile = await screen.findByTestId("file-tree-row-.env");
    const cleanRow = await screen.findByTestId("file-tree-row-src");
    const cleanFile = await screen.findByTestId("file-tree-row-README.md");

    // Ignored rows wear `opacity-50`; non-ignored rows do not.
    expect(ignoredRow.className).toContain("opacity-50");
    expect(ignoredFile.className).toContain("opacity-50");
    expect(cleanRow.className).not.toContain("opacity-50");
    expect(cleanFile.className).not.toContain("opacity-50");

    // The data-ignored attribute mirrors the underlying flag — useful
    // for e2e + a11y assertions that don't want to grep classNames.
    expect(ignoredRow.getAttribute("data-ignored")).toBe("true");
    expect(cleanRow.getAttribute("data-ignored")).toBe("false");
  });

  it("filters ignored entries OUT of the tree data when showIgnored=false", async () => {
    stubRoot(ROOT_WITH_IGNORED);

    render(
      withQueryClient(
        <FileTree projectId="42" height={400} showIgnored={false} />,
      ),
    );

    // Non-ignored entries still mount.
    await screen.findByTestId("file-tree-row-src");
    await screen.findByTestId("file-tree-row-README.md");

    // Ignored entries must NOT be in the DOM at all — this is the
    // "pure data transformation before react-arborist sees the nodes"
    // contract. A CSS-only hide would still surface the testid.
    expect(screen.queryByTestId("file-tree-row-node_modules")).toBeNull();
    expect(screen.queryByTestId("file-tree-row-.env")).toBeNull();
  });

  it("toggling showIgnored at runtime restores hidden rows without a refetch", async () => {
    const fetchSpy = stubRoot(ROOT_WITH_IGNORED);

    function Harness() {
      const [show, setShow] = React.useState(true);
      return (
        <div>
          <button
            data-testid="harness-toggle"
            onClick={() => setShow((p) => !p)}
          >
            toggle
          </button>
          <FileTree projectId="42" height={400} showIgnored={show} />
        </div>
      );
    }

    render(withQueryClient(<Harness />));

    // Initial render: show=true → ignored entries present.
    await screen.findByTestId("file-tree-row-node_modules");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Flip to hidden. The ignored rows disappear but no refetch is
    // triggered — the assemble step alone re-runs the filter.
    screen.getByTestId("harness-toggle").click();
    await waitFor(() => {
      expect(screen.queryByTestId("file-tree-row-node_modules")).toBeNull();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Flip back. The previously-hidden rows reappear, still without a
    // refetch — the cached payload alone satisfies the new view.
    screen.getByTestId("harness-toggle").click();
    await screen.findByTestId("file-tree-row-node_modules");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("defaults to showing ignored entries when the prop is omitted", async () => {
    stubRoot(ROOT_WITH_IGNORED);

    render(withQueryClient(<FileTree projectId="42" height={400} />));

    // Default surface includes the ignored rows — matches the
    // localStorage default the page wrapper applies.
    await screen.findByTestId("file-tree-row-node_modules");
    await screen.findByTestId("file-tree-row-.env");
  });
});
