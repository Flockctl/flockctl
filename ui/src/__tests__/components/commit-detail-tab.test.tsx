import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { GitShowFile, GitShowSuccess } from "@/lib/types";

/**
 * Unit tests for {@link CommitDetailTab}.
 *
 * The boundaries we exercise:
 *   - On mount, fires `useGitShow` and renders a loading state until
 *     it resolves; failure surfaces `commit-detail-error` with the
 *     reason in `data-reason`.
 *   - Once the show resolves, renders the header (subject + short-sha
 *     + author), the file list (one row per file, with status +
 *     added/removed), and auto-selects the first file.
 *   - Selecting a file fires a per-file `git-diff` query keyed on
 *     `(scope, entityId, sha, base, path)`. Re-selecting the same file
 *     hits the cache (same `useQuery` key).
 *   - For the initial commit (parents=[]), the diff `base` is the
 *     empty-tree SHA `4b825dc…`. For a normal commit it's `<sha>~1`.
 *   - The tab title is registered with `tabStore` once the commit
 *     resolves, with the format `<shortSha> <subject-truncated>`.
 *   - Empty file list renders the `commit-detail-file-empty` notice.
 *
 * The data hooks (`useGitShow` + `fetchGitDiff`) are mocked at the
 * module boundary so the test does not need a real `QueryClientProvider`
 * with network mocks; we still wrap in a minimal QueryClientProvider so
 * the per-file `useQuery` inside `DiffPane` resolves.
 */

// ─── Mock CodeEditor → trivial pre-tag ────────────────────────────────────
// Monaco is heavyweight and pulls a worker, which jsdom doesn't ship.
// Render a `<pre>` so the assertions can check the diff text directly
// without instantiating the real editor. The `data-path` survives so
// "selected path" assertions still work.
vi.mock("@/components/CodeEditor", () => ({
  CodeEditor: ({ value, path }: { value: string; path?: string }) => (
    <pre data-testid="mock-code-editor" data-path={path ?? ""}>
      {value}
    </pre>
  ),
}));

// ─── Mock useGitShow ──────────────────────────────────────────────────────
type ShowState = {
  data?: GitShowSuccess;
  isLoading: boolean;
  error?: Error & { reason?: string };
};

let showState: ShowState;

vi.mock("@/lib/hooks/git-show", () => ({
  useGitShow: (
    _scope: "projects" | "workspaces",
    _entityId: string,
    _sha: string,
  ) => {
    return {
      data: showState.data,
      isLoading: showState.isLoading,
      error: showState.error,
    };
  },
  gitShowQueryKey: () => [],
}));

// ─── Mock fetchGitDiff so we can assert on params ─────────────────────────
type FetchDiffFn = (
  scope: "projects" | "workspaces",
  entityId: string,
  params: { path: string; base: string; head: string },
) => Promise<unknown>;
let fetchDiffMock: FetchDiffFn & { mock: { calls: unknown[][] } };
vi.mock("@/lib/api/git-show", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/git-show")>(
    "@/lib/api/git-show",
  );
  return {
    ...actual,
    fetchGitDiff: (
      scope: "projects" | "workspaces",
      entityId: string,
      params: { path: string; base: string; head: string },
    ) => fetchDiffMock(scope, entityId, params),
  };
});

// ─── Imports under test (after the mocks) ─────────────────────────────────
import {
  CommitDetailTab,
  makeTabTitle,
} from "@/components/git/CommitDetailTab";
import { tabStore, commitTabId } from "@/components/code-mode/tab-store";
import { EMPTY_TREE_SHA } from "@/lib/api/git-show";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

const HEAD_SHA = "abcdef0123456789abcdef0123456789abcdef01";
const PARENT_SHA = "1111111111111111111111111111111111111111";

const FILE_M: GitShowFile = {
  path: "src/foo.ts",
  status: "M",
  added: 5,
  removed: 2,
};
const FILE_A: GitShowFile = {
  path: "src/bar.ts",
  status: "A",
  added: 12,
  removed: 0,
};
const FILE_R: GitShowFile = {
  path: "src/new.ts",
  status: "R",
  added: 0,
  removed: 0,
  old_path: "src/old.ts",
};

beforeEach(() => {
  showState = { isLoading: true };
  fetchDiffMock = vi.fn().mockResolvedValue({
    ok: true,
    patch: "@@ -1 +1 @@\n-old\n+new\n",
    base: `${HEAD_SHA}~1`,
    head: HEAD_SHA,
    status: "M",
    size: 30,
    reason: "ok",
  });
  tabStore.__resetForTests();
});

describe("CommitDetailTab", () => {
  describe("makeTabTitle", () => {
    it("formats as <shortSha> <subject>", () => {
      const title = makeTabTitle(HEAD_SHA, "feat: add CommitDetailTab");
      expect(title).toBe("abcdef0 feat: add CommitDetailTab");
    });

    it("truncates long subjects to 60 chars (including ellipsis)", () => {
      const long = "x".repeat(80);
      const title = makeTabTitle(HEAD_SHA, long);
      // 7 (sha) + 1 (space) + 57 (subject head) + 1 (…) = 66 chars
      expect(title.length).toBe(66);
      expect(title.endsWith("…")).toBe(true);
      expect(title.startsWith("abcdef0 ")).toBe(true);
    });
  });

  it("renders a loading state while git-show is in flight", () => {
    showState = { isLoading: true };
    renderWithClient(
      <CommitDetailTab scope="projects" entityId="1" sha={HEAD_SHA} />,
    );
    expect(screen.getByTestId("commit-detail-loading")).toBeInTheDocument();
  });

  it("renders an error state with the reason on git-show failure", () => {
    const err = new Error("git-show failed: bad_revision") as Error & {
      reason?: string;
    };
    err.reason = "bad_revision";
    showState = { isLoading: false, error: err };

    renderWithClient(
      <CommitDetailTab scope="projects" entityId="1" sha={HEAD_SHA} />,
    );

    const node = screen.getByTestId("commit-detail-error");
    expect(node).toBeInTheDocument();
    expect(node.getAttribute("data-reason")).toBe("bad_revision");
  });

  it("renders the header + file list once git-show resolves", async () => {
    showState = {
      isLoading: false,
      data: {
        ok: true,
        commit: {
          sha: HEAD_SHA,
          parents: [PARENT_SHA],
          author: "Eduard",
          email: "ed@example.com",
          ts: 1700000000,
          message: "feat: add commit-detail tab",
        },
        files: [FILE_M, FILE_A, FILE_R],
        reason: "ok",
      },
    };

    renderWithClient(
      <CommitDetailTab scope="projects" entityId="1" sha={HEAD_SHA} />,
    );

    expect(screen.getByTestId("commit-detail-tab")).toHaveAttribute(
      "data-sha",
      HEAD_SHA,
    );
    expect(screen.getByTestId("commit-detail-header")).toHaveTextContent(
      "feat: add commit-detail tab",
    );
    expect(screen.getByTestId("commit-detail-sha")).toHaveTextContent(
      HEAD_SHA.slice(0, 7),
    );

    expect(screen.getByTestId("commit-detail-file-0")).toHaveAttribute(
      "data-path",
      FILE_M.path,
    );
    expect(screen.getByTestId("commit-detail-file-0")).toHaveAttribute(
      "data-status",
      "M",
    );
    expect(screen.getByTestId("commit-detail-file-1")).toHaveAttribute(
      "data-path",
      FILE_A.path,
    );
    expect(screen.getByTestId("commit-detail-file-2")).toHaveAttribute(
      "data-status",
      "R",
    );

    // Auto-selects the first file.
    expect(screen.getByTestId("commit-detail-file-0")).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("fetches git-diff for the auto-selected first file with base=<sha>~1", async () => {
    showState = {
      isLoading: false,
      data: {
        ok: true,
        commit: {
          sha: HEAD_SHA,
          parents: [PARENT_SHA],
          author: "Eduard",
          email: "ed@example.com",
          ts: 1700000000,
          message: "regular commit",
        },
        files: [FILE_M, FILE_A],
        reason: "ok",
      },
    };

    renderWithClient(
      <CommitDetailTab scope="projects" entityId="1" sha={HEAD_SHA} />,
    );

    await waitFor(() => {
      expect(fetchDiffMock).toHaveBeenCalledWith("projects", "1", {
        path: FILE_M.path,
        base: `${HEAD_SHA}~1`,
        head: HEAD_SHA,
      });
    });

    // Diff text lands in the mocked CodeEditor.
    await waitFor(() => {
      const editor = screen.getByTestId("mock-code-editor");
      expect(editor).toHaveTextContent("-old");
      expect(editor).toHaveTextContent("+new");
    });

    // The diff wrapper carries the selected path for e2e assertions.
    expect(screen.getByTestId("commit-detail-diff")).toHaveAttribute(
      "data-path",
      FILE_M.path,
    );
  });

  it("uses EMPTY_TREE_SHA as the diff base for the initial commit (parents=[])", async () => {
    showState = {
      isLoading: false,
      data: {
        ok: true,
        commit: {
          sha: HEAD_SHA,
          parents: [],
          author: "Eduard",
          email: "ed@example.com",
          ts: 1700000000,
          message: "initial commit",
        },
        files: [FILE_A],
        reason: "ok",
      },
    };

    renderWithClient(
      <CommitDetailTab scope="projects" entityId="1" sha={HEAD_SHA} />,
    );

    await waitFor(() => {
      expect(fetchDiffMock).toHaveBeenCalledWith("projects", "1", {
        path: FILE_A.path,
        base: EMPTY_TREE_SHA,
        head: HEAD_SHA,
      });
    });
  });

  it("clicking a different file fires a new git-diff with the new path", async () => {
    showState = {
      isLoading: false,
      data: {
        ok: true,
        commit: {
          sha: HEAD_SHA,
          parents: [PARENT_SHA],
          author: "Eduard",
          email: "ed@example.com",
          ts: 1700000000,
          message: "two files",
        },
        files: [FILE_M, FILE_A],
        reason: "ok",
      },
    };

    const user = userEvent.setup();
    renderWithClient(
      <CommitDetailTab scope="projects" entityId="1" sha={HEAD_SHA} />,
    );

    // First fetch is for FILE_M (auto-selected).
    await waitFor(() => {
      expect(fetchDiffMock).toHaveBeenCalledTimes(1);
    });

    // Click FILE_A → second fetch with path = FILE_A.path.
    await user.click(screen.getByTestId("commit-detail-file-1"));

    await waitFor(() => {
      expect(fetchDiffMock).toHaveBeenLastCalledWith("projects", "1", {
        path: FILE_A.path,
        base: `${HEAD_SHA}~1`,
        head: HEAD_SHA,
      });
    });

    // Active row state moves to FILE_A.
    expect(screen.getByTestId("commit-detail-file-1")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByTestId("commit-detail-file-0")).toHaveAttribute(
      "data-active",
      "false",
    );
  });

  it("registers the tab title with the tabStore once git-show resolves", () => {
    showState = {
      isLoading: false,
      data: {
        ok: true,
        commit: {
          sha: HEAD_SHA,
          parents: [PARENT_SHA],
          author: "Eduard",
          email: "ed@example.com",
          ts: 1700000000,
          message: "register tab title",
        },
        files: [FILE_M],
        reason: "ok",
      },
    };

    renderWithClient(
      <CommitDetailTab scope="projects" entityId="42" sha={HEAD_SHA} />,
    );

    const id = commitTabId("projects", "42", HEAD_SHA);
    const tab = tabStore
      .getState()
      .tabs.find((t) => t.id === id);
    expect(tab).toBeDefined();
    expect(tab!.kind).toBe("commit");
    if (tab!.kind === "commit") {
      expect(tab!.title).toBe("abcdef0 register tab title");
    }
    expect(tabStore.getState().activeId).toBe(id);
  });

  it("renders the empty-files notice when files=[]", () => {
    showState = {
      isLoading: false,
      data: {
        ok: true,
        commit: {
          sha: HEAD_SHA,
          parents: [PARENT_SHA],
          author: "Eduard",
          email: "ed@example.com",
          ts: 1700000000,
          message: "no-op commit",
        },
        files: [],
        reason: "ok",
      },
    };

    renderWithClient(
      <CommitDetailTab scope="projects" entityId="1" sha={HEAD_SHA} />,
    );

    expect(screen.getByTestId("commit-detail-file-empty")).toBeInTheDocument();
    expect(screen.getByTestId("commit-detail-empty")).toBeInTheDocument();
    // No diff fetches happen when there is nothing to diff.
    expect(fetchDiffMock).not.toHaveBeenCalled();
  });

  it("surfaces a per-file diff failure with reason in data-reason", async () => {
    fetchDiffMock = vi.fn().mockResolvedValue({
      ok: false,
      reason: "bad_revision",
      message: "unknown ref",
    });

    showState = {
      isLoading: false,
      data: {
        ok: true,
        commit: {
          sha: HEAD_SHA,
          parents: [PARENT_SHA],
          author: "Eduard",
          email: "ed@example.com",
          ts: 1700000000,
          message: "diff fail",
        },
        files: [FILE_M],
        reason: "ok",
      },
    };

    renderWithClient(
      <CommitDetailTab scope="projects" entityId="1" sha={HEAD_SHA} />,
    );

    await waitFor(() => {
      const node = screen.getByTestId("commit-detail-diff-error");
      expect(node).toBeInTheDocument();
      expect(node.getAttribute("data-reason")).toBe("bad_revision");
    });
  });
});
