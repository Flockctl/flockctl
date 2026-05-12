import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Unit tests for the FileTree component + its `useFsTree` lazy-loading
 * bridge.
 *
 * The boundaries we exercise:
 *   - On mount, FileTree fetches the root listing and renders the
 *     entries in directory-first / alphabetical order (the order the
 *     server already guarantees — we just check we don't reshuffle it).
 *   - Expanding a directory triggers a *single* second fetch for that
 *     subpath; toggling it closed and re-opening it does NOT refetch.
 *   - Activating a file row calls `onSelect` with the relative path.
 *     Activating a directory does NOT.
 *   - When the server flags `truncated:true`, the synthetic "+ more
 *     entries (truncated)" marker appears at the end of that listing.
 *   - When the root listing comes back as `{ ok: false }`, the error
 *     placeholder renders with the structured `error_code` exposed via
 *     `data-error-code` so e2e + a11y assertions can switch on it.
 *
 * react-arborist is mocked at the module boundary with a deterministic
 * flat renderer: we walk the tree depth-first, render every visible
 * node (closed dirs hide their children), and call the user-supplied
 * children render prop for each one. This sidesteps react-window /
 * `clientHeight` measurement under jsdom — those concerns are covered
 * by the e2e suite.
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

let mockToggleCalls: string[] = [];
let mockActivateCalls: string[] = [];

vi.mock("react-arborist", () => {
  function MockTree(props: any) {
    const { data, children, onToggle, onActivate } = props;
    const NodeRenderer = children;

    // Track open state per id so the "expand → collapse → re-expand"
    // assertion is meaningful. Defaults to `openByDefault` (false).
    const [openIds, setOpenIds] = React.useState<Set<string>>(new Set());
    const [selectedId, setSelectedId] = React.useState<string | null>(null);

    const flatten = (
      nodes: any[],
      level: number,
      out: FakeNode[],
    ) => {
      for (const n of nodes) {
        const id: string = n.id;
        const isOpen = openIds.has(id);
        const isLeaf = n.children === undefined || n.children === null;
        const node: FakeNode = {
          data: n,
          level,
          isOpen,
          isSelected: selectedId === id,
          toggle: () => {
            mockToggleCalls.push(id);
            setOpenIds((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
            onToggle?.(id);
          },
          activate: () => {
            mockActivateCalls.push(id);
            setSelectedId(id);
            onActivate?.(node);
          },
        };
        out.push(node);
        if (isOpen && !isLeaf && Array.isArray(n.children)) {
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

// --- fetch mocks ------------------------------------------------------------

import * as fsApi from "@/lib/api/fs";

beforeEach(() => {
  mockToggleCalls = [];
  mockActivateCalls = [];
});

function makeFetchSpy(payloadByPath: Record<string, fsApi.FsListResponse>) {
  return vi.spyOn(fsApi, "fetchFsList").mockImplementation(
    (_projectId: string, path: string) => {
      const payload = payloadByPath[path];
      if (!payload) {
        return Promise.reject(new Error(`unexpected fetchFsList path: "${path}"`));
      }
      return Promise.resolve(payload);
    },
  );
}

import { FileTree } from "@/components/file-tree/FileTree";
import { buildChildren } from "@/components/file-tree/use-fs-tree";

function withQueryClient(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
    },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

// ---------------------------------------------------------------------------

describe("<FileTree />", () => {
  it("renders the root listing on mount", async () => {
    const fetchSpy = makeFetchSpy({
      "": {
        ok: true,
        path: ".",
        entries: [
          {
            name: "src",
            type: "dir",
            ignored: false,
            hasChildren: true,
            mtime: 1,
          },
          { name: "README.md", type: "file", ignored: false, size: 10, mtime: 2 },
        ],
        truncated: false,
      },
    });

    render(withQueryClient(<FileTree projectId="42" height={400} />));

    // Root listing arrives async — wait for both rows.
    await screen.findByTestId("file-tree-row-src");
    await screen.findByTestId("file-tree-row-README.md");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("42", "");
  });

  it("lazy-loads children when a directory is expanded and dedupes on re-expand", async () => {
    const fetchSpy = makeFetchSpy({
      "": {
        ok: true,
        path: ".",
        entries: [
          { name: "src", type: "dir", ignored: false, hasChildren: true },
        ],
        truncated: false,
      },
      src: {
        ok: true,
        path: "src",
        entries: [
          { name: "index.ts", type: "file", ignored: false, size: 5, mtime: 9 },
        ],
        truncated: false,
      },
    });

    const user = userEvent.setup();
    render(withQueryClient(<FileTree projectId="42" height={400} />));

    const srcRow = await screen.findByTestId("file-tree-row-src");

    // The child must NOT be visible before we expand.
    expect(screen.queryByTestId("file-tree-row-src/index.ts")).toBeNull();

    await user.click(srcRow);

    // Expand triggered onToggle("src") which fetched and populated.
    await screen.findByTestId("file-tree-row-src/index.ts");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenLastCalledWith("42", "src");

    // Collapse + re-expand → no third fetch.
    await user.click(srcRow); // collapse
    await user.click(srcRow); // re-expand
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // After re-expand the child row is visible again.
    await screen.findByTestId("file-tree-row-src/index.ts");
  });

  it("fires onSelect with the file's relative path when a leaf is activated", async () => {
    makeFetchSpy({
      "": {
        ok: true,
        path: ".",
        entries: [
          { name: "package.json", type: "file", ignored: false, size: 1, mtime: 1 },
          { name: "src", type: "dir", ignored: false, hasChildren: true },
        ],
        truncated: false,
      },
      // The folder click below toggles `src` which lazy-fetches its
      // contents — provide an empty listing so the promise doesn't
      // reject and surface as an unhandled rejection.
      src: {
        ok: true,
        path: "src",
        entries: [],
        truncated: false,
      },
    });

    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      withQueryClient(
        <FileTree projectId="42" height={400} onSelect={onSelect} />,
      ),
    );

    const fileRow = await screen.findByTestId("file-tree-row-package.json");
    const dirRow = await screen.findByTestId("file-tree-row-src");

    // Folder click toggles, NOT activate → should not call onSelect.
    await user.click(dirRow);
    expect(onSelect).not.toHaveBeenCalled();

    // File click activates.
    await user.click(fileRow);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("package.json");
  });

  it("renders a synthetic truncation marker when the server flags truncated:true", async () => {
    makeFetchSpy({
      "": {
        ok: true,
        path: ".",
        entries: [
          { name: "a.txt", type: "file", ignored: false, size: 1, mtime: 1 },
        ],
        truncated: true,
      },
    });

    render(withQueryClient(<FileTree projectId="42" height={400} />));

    await screen.findByTestId("file-tree-row-a.txt");
    // The truncation marker uses the parent path (empty string at root)
    // so the data-testid suffix is exactly "".
    const marker = await screen.findByTestId("file-tree-truncated-");
    expect(marker.textContent).toContain("truncated");
  });

  it("renders the error placeholder when the root listing fails", async () => {
    makeFetchSpy({
      "": {
        ok: false,
        error_code: "fs_permission_denied",
        message: "denied",
      },
    });

    render(withQueryClient(<FileTree projectId="42" height={400} />));

    const err = await screen.findByTestId("file-tree-error");
    expect(err.getAttribute("data-error-code")).toBe("fs_permission_denied");
  });
});

// --- buildChildren (pure helper) -------------------------------------------

describe("buildChildren", () => {
  it("appends a truncation marker when truncated is true", () => {
    const out = buildChildren(
      [{ name: "a", type: "file", ignored: false, size: 1, mtime: 1 }],
      "src",
      true,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: "file", path: "src/a" });
    expect(out[1]).toMatchObject({
      kind: "truncated",
      path: "src",
      id: "src/__truncated__",
    });
  });

  it("does not append a marker when truncated is false", () => {
    const out = buildChildren(
      [{ name: "a", type: "file", ignored: false }],
      "src",
      false,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("file");
  });

  it("uses the entry name as the id at the project root", () => {
    const out = buildChildren(
      [{ name: "README.md", type: "file", ignored: false }],
      "",
      false,
    );
    expect(out[0]?.id).toBe("README.md");
    expect(out[0]?.path).toBe("README.md");
  });
});

// Silence the unused-import warning while keeping `act` available if a
// future assertion needs to flush a microtask deliberately.
void act;
