import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { GitLogCommit } from "@/lib/types";
import type { GitTarget } from "@/components/git/git-dropdown-button";

/**
 * Unit tests for {@link HistoryList}.
 *
 * The boundaries we exercise:
 *   - Default collapsed; expansion state persists in `localStorage`
 *     under a key scoped to `target.kind` + `target.id`. A second
 *     mount with the same target restores the saved flag.
 *   - First page is fetched on open; the hook is disabled while
 *     collapsed (we assert via the mocked hook's `enabled` arg).
 *   - Each row renders short-sha · subject · author · relative-time
 *     with a `title` tooltip carrying the full subject.
 *   - "Load more" surfaces while `next_cursor` is non-null and
 *     dispatches the hook's `fetchNextPage`. The button is replaced
 *     by a spinner while the fetch is in flight.
 *   - Clicking a row invokes `onSelectCommit` with the full SHA.
 *   - Empty repo renders the `scm-history-empty` notice.
 *   - A failed query surfaces `scm-history-error` with reason-keyed
 *     copy for `not_a_repo`.
 *   - The `scm-history-toggle` is the same test-id surfaced by the
 *     parent panel — clicking it fires the localStorage write.
 *
 * The data hook (`useGitLog`) is mocked at the module boundary so the
 * test does not need a `QueryClientProvider` or fetch mock.
 */

// ─── localStorage shim ────────────────────────────────────────────────────
// Same workaround the code-editor test ships: vitest 4 + jsdom 29 + Node 25
// hand back a `localStorage` global without methods on this codebase. The
// component reads `window.localStorage`, so we install a deterministic
// in-memory shim per-test to keep persistence assertions exact.
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

// ─── Hook mock ────────────────────────────────────────────────────────────
type HookState = {
  data?: { pages: Array<{ commits: GitLogCommit[]; next_cursor: string | null }> };
  isLoading: boolean;
  isError: boolean;
  error?: Error & { reason?: string };
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: ReturnType<typeof vi.fn>;
};

let hookState: HookState;
let lastUseGitLogArgs: {
  scope: string;
  entityId: string;
  options: { enabled?: boolean; limit?: number; branch?: string };
} | null;

vi.mock("@/lib/hooks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hooks")>(
    "@/lib/hooks",
  );
  return {
    ...actual,
    useGitLog: (
      scope: "projects" | "workspaces",
      entityId: string,
      options: { enabled?: boolean; limit?: number; branch?: string } = {},
    ) => {
      lastUseGitLogArgs = { scope, entityId, options };
      return hookState;
    },
  };
});

// ─── react-router shim ────────────────────────────────────────────────────
const navigateMock = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

import { HistoryList, historyStorageKey } from "@/components/git/HistoryList";

// ─── Fixtures ─────────────────────────────────────────────────────────────
const projectTarget: GitTarget = { kind: "project", id: "p1", path: "/tmp/p1" };

function makeCommit(sha: string, subject: string, secondsAgo: number): GitLogCommit {
  // Build a deterministic timestamp relative to "now" so the relative-time
  // assertion is stable. The ISO conversion in the row uses the same
  // arithmetic.
  const ts = Math.floor(Date.now() / 1000) - secondsAgo;
  return {
    sha,
    short_sha: sha.slice(0, 7),
    author: "Eduard",
    email: "ed@example.com",
    ts,
    subject,
    parents: [],
  };
}

beforeEach(() => {
  storageBacking = {};
  Object.defineProperty(globalThis, "localStorage", {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
  // Same property exists on `window` in jsdom — keep them in sync so the
  // SSR-guard inside HistoryList doesn't swing on which one the test
  // happens to read.
  Object.defineProperty(window, "localStorage", {
    value: mockStorage,
    configurable: true,
    writable: true,
  });

  hookState = {
    data: {
      pages: [
        {
          commits: [
            makeCommit("a".repeat(40), "feat: ship slice", 30),
            makeCommit("b".repeat(40), "fix: typo in README", 3600),
          ],
          next_cursor: null,
        },
      ],
    },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  };
  lastUseGitLogArgs = null;
  navigateMock.mockReset();
});

describe("HistoryList", () => {
  it("is collapsed by default and the body is not in the DOM", () => {
    render(<HistoryList target={projectTarget} />);
    expect(screen.getByTestId("scm-history-toggle")).toBeTruthy();
    expect(screen.queryByTestId("scm-history")).toBeNull();
    // The hook is wired in disabled mode while collapsed so we don't
    // pay for a round-trip the user hasn't asked for.
    expect(lastUseGitLogArgs?.options.enabled).toBe(false);
  });

  it("clicking the toggle expands the section and enables the query", async () => {
    const user = userEvent.setup();
    render(<HistoryList target={projectTarget} />);

    await user.click(screen.getByTestId("scm-history-toggle"));

    expect(screen.getByTestId("scm-history")).toBeTruthy();
    expect(lastUseGitLogArgs?.options.enabled).toBe(true);
  });

  it("persists the open flag in localStorage under a target-scoped key", async () => {
    const user = userEvent.setup();
    render(<HistoryList target={projectTarget} />);
    const key = historyStorageKey(projectTarget);

    await user.click(screen.getByTestId("scm-history-toggle"));
    expect(window.localStorage.getItem(key)).toBe("1");

    await user.click(screen.getByTestId("scm-history-toggle"));
    expect(window.localStorage.getItem(key)).toBe("0");
  });

  it("restores the open flag from localStorage on mount", () => {
    window.localStorage.setItem(historyStorageKey(projectTarget), "1");
    render(<HistoryList target={projectTarget} />);

    // Expanded right out of the gate — no click needed.
    expect(screen.getByTestId("scm-history")).toBeTruthy();
  });

  it("renders one row per commit with short-sha, subject, author, relative time", async () => {
    const user = userEvent.setup();
    render(<HistoryList target={projectTarget} />);
    await user.click(screen.getByTestId("scm-history-toggle"));

    const list = screen.getByTestId("scm-history-list");
    const row = within(list).getByTestId(`scm-history-row-${"a".repeat(40)}`);
    expect(within(row).getByTestId(`scm-history-sha-${"a".repeat(40)}`).textContent).toBe(
      "aaaaaaa",
    );
    expect(
      within(row).getByTestId(`scm-history-subject-${"a".repeat(40)}`).textContent,
    ).toBe("feat: ship slice");
    expect(
      within(row).getByTestId(`scm-history-author-${"a".repeat(40)}`).textContent,
    ).toBe("Eduard");
    // Relative time is one of "30s ago", "29s ago", or "31s ago" depending
    // on render-time drift — match the shape, not the exact integer.
    expect(
      within(row).getByTestId(`scm-history-time-${"a".repeat(40)}`).textContent,
    ).toMatch(/\d+s ago/);
  });

  it("subject row carries a `title` tooltip with the full subject text", async () => {
    const user = userEvent.setup();
    const longSubject =
      "feat: this is a very long subject line that should be truncated visually but appear in full inside the tooltip";
    hookState.data = {
      pages: [
        {
          commits: [makeCommit("c".repeat(40), longSubject, 60)],
          next_cursor: null,
        },
      ],
    };
    render(<HistoryList target={projectTarget} />);
    await user.click(screen.getByTestId("scm-history-toggle"));

    const subject = screen.getByTestId(`scm-history-subject-${"c".repeat(40)}`);
    expect(subject.getAttribute("title")).toBe(longSubject);
    // The truncate class is what hides the overflowed text.
    expect(subject.className).toContain("truncate");
  });

  it("clicking a row invokes onSelectCommit with the full SHA", async () => {
    const onSelectCommit = vi.fn();
    const user = userEvent.setup();
    render(
      <HistoryList target={projectTarget} onSelectCommit={onSelectCommit} />,
    );
    await user.click(screen.getByTestId("scm-history-toggle"));
    await user.click(screen.getByTestId(`scm-history-row-${"a".repeat(40)}`));

    expect(onSelectCommit).toHaveBeenCalledTimes(1);
    expect(onSelectCommit).toHaveBeenCalledWith("a".repeat(40));
  });

  it("with no `onSelectCommit` override, navigates via react-router", async () => {
    const user = userEvent.setup();
    render(<HistoryList target={projectTarget} />);
    await user.click(screen.getByTestId("scm-history-toggle"));
    await user.click(screen.getByTestId(`scm-history-row-${"a".repeat(40)}`));

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(
      `/projects/p1/git/commit/${"a".repeat(40)}`,
    );
  });

  it("renders the empty notice when the repo has no commits", async () => {
    const user = userEvent.setup();
    hookState.data = { pages: [{ commits: [], next_cursor: null }] };
    render(<HistoryList target={projectTarget} />);
    await user.click(screen.getByTestId("scm-history-toggle"));

    expect(screen.getByTestId("scm-history-empty")).toBeTruthy();
    expect(screen.queryByTestId("scm-history-list")).toBeNull();
  });

  it("renders the loading spinner while the first page is in flight", async () => {
    const user = userEvent.setup();
    hookState.isLoading = true;
    hookState.data = undefined;
    render(<HistoryList target={projectTarget} />);
    await user.click(screen.getByTestId("scm-history-toggle"));

    expect(screen.getByTestId("scm-history-loading")).toBeTruthy();
    expect(screen.queryByTestId("scm-history-list")).toBeNull();
  });

  it("renders the error banner with reason-keyed copy on a failed query", async () => {
    const user = userEvent.setup();
    hookState.isLoading = false;
    hookState.isError = true;
    hookState.data = undefined;
    const err = new Error("git-log failed: not_a_repo") as Error & {
      reason?: string;
    };
    err.reason = "not_a_repo";
    hookState.error = err;
    render(<HistoryList target={projectTarget} />);
    await user.click(screen.getByTestId("scm-history-toggle"));

    const banner = screen.getByTestId("scm-history-error");
    expect(banner.textContent).toMatch(/Not a git repository/);
  });

  it("shows the Load-more button while next_cursor is non-null and fires fetchNextPage", async () => {
    const user = userEvent.setup();
    hookState.data = {
      pages: [
        {
          commits: [makeCommit("a".repeat(40), "first page", 60)],
          next_cursor: "deadbeefdeadbeef",
        },
      ],
    };
    hookState.hasNextPage = true;
    render(<HistoryList target={projectTarget} />);
    await user.click(screen.getByTestId("scm-history-toggle"));

    const loadMore = screen.getByTestId("scm-history-load-more");
    expect(loadMore).toBeTruthy();

    await user.click(loadMore);
    expect(hookState.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("hides Load-more once next_cursor is null (last page reached)", async () => {
    const user = userEvent.setup();
    hookState.hasNextPage = false;
    render(<HistoryList target={projectTarget} />);
    await user.click(screen.getByTestId("scm-history-toggle"));

    expect(screen.queryByTestId("scm-history-load-more")).toBeNull();
  });

  it("replaces Load-more with a spinner while the next page is fetching", async () => {
    const user = userEvent.setup();
    hookState.hasNextPage = true;
    hookState.isFetchingNextPage = true;
    render(<HistoryList target={projectTarget} />);
    await user.click(screen.getByTestId("scm-history-toggle"));

    expect(screen.queryByTestId("scm-history-load-more")).toBeNull();
    expect(screen.getByTestId("scm-history-loading-more")).toBeTruthy();
  });

  it("flattens multiple pages into a single list", async () => {
    const user = userEvent.setup();
    hookState.data = {
      pages: [
        {
          commits: [makeCommit("a".repeat(40), "page 1 row", 60)],
          next_cursor: "ffff",
        },
        {
          commits: [makeCommit("b".repeat(40), "page 2 row", 120)],
          next_cursor: null,
        },
      ],
    };
    render(<HistoryList target={projectTarget} />);
    await user.click(screen.getByTestId("scm-history-toggle"));

    const list = screen.getByTestId("scm-history-list");
    expect(within(list).getByTestId(`scm-history-row-${"a".repeat(40)}`)).toBeTruthy();
    expect(within(list).getByTestId(`scm-history-row-${"b".repeat(40)}`)).toBeTruthy();
  });

  it("scopes the localStorage key to target.kind + target.id", () => {
    const wsTarget: GitTarget = { kind: "workspace", id: "w42", path: "/tmp/w42" };
    expect(historyStorageKey(projectTarget)).toBe(
      "flockctl.scm.history.open.project.p1",
    );
    expect(historyStorageKey(wsTarget)).toBe(
      "flockctl.scm.history.open.workspace.w42",
    );
  });

  it("uses `workspaces` as the API scope for a workspace target", () => {
    const wsTarget: GitTarget = { kind: "workspace", id: "w42", path: "/tmp/w42" };
    render(<HistoryList target={wsTarget} />);
    act(() => {
      // Force a re-render after the lazy state init reads localStorage.
    });
    expect(lastUseGitLogArgs?.scope).toBe("workspaces");
    expect(lastUseGitLogArgs?.entityId).toBe("w42");
  });
});
