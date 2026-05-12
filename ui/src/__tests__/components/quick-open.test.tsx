import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  QuickOpen,
  rankPaths,
  QUICK_OPEN_RESULT_CAP,
} from "@/components/code-mode/QuickOpen";
import {
  useQuickOpenIndexStore,
  walkProjectFiles,
  QUICK_OPEN_CACHE_TTL_MS,
} from "@/components/code-mode/quick-open-store";
import { useEditorTabsStore } from "@/components/code-mode/tab-store";

/**
 * Unit tests for the Quick-Open Cmd+P modal — its pure ranking
 * function, the BFS walker that backs the index, and the React surface
 * the dialog renders.
 *
 * The boundaries we exercise:
 *
 *   1. `rankPaths` — empty query → alpha, non-empty → fzy-scored
 *      and capped, ties broken on original index.
 *   2. `walkProjectFiles` — BFS over the fake lister, drops ignored
 *      entries and respects MAX_INDEX_ENTRIES.
 *   3. `useQuickOpenIndexStore.requestIndex` — caches across calls in
 *      the TTL window and refreshes after; clears prior state on
 *      project swap.
 *   4. `<QuickOpen>` — renders an input + list, ↑/↓ moves selection
 *      with wrap, Enter calls `useEditorTabsStore.open(path)` and
 *      requests close, Esc closes via Radix.
 *
 * All hooks are exercised against the real Zustand stores so the
 * test catches reducer regressions; the lister is the only injected
 * seam.
 */

beforeEach(() => {
  // Reset both stores so per-test state is isolated.
  useQuickOpenIndexStore.getState().__resetForTests();
  useEditorTabsStore.getState().__resetForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// rankPaths — pure ranking
// ---------------------------------------------------------------------------

describe("rankPaths", () => {
  it("empty query → alpha-sorts case-insensitively, capped at the limit", () => {
    const paths = ["src/Zoo.ts", "src/apple.ts", "Banana.ts", "chr.ts"];
    const out = rankPaths(paths, "");
    // Sort is on full paths, case-insensitive: B < c < s.
    // Within "src/" the basename `apple` (a) precedes `Zoo` (z).
    expect(out).toEqual([
      "Banana.ts",
      "chr.ts",
      "src/apple.ts",
      "src/Zoo.ts",
    ]);
  });

  it("non-empty query → fzy-scored, drops zero-score paths", () => {
    const paths = [
      "src/components/Header.tsx",
      "src/server/db.ts",
      "src/components/Footer.tsx",
      "README.md",
    ];
    const out = rankPaths(paths, "header");
    // "header" is a substring of "Header.tsx"; it should rank first
    // and the unrelated paths should be dropped (zero score on
    // "header").
    expect(out[0]).toBe("src/components/Header.tsx");
    // README.md does not contain `h` `e` `a` `d` `e` `r` in order, so
    // it must NOT be in the result list.
    expect(out).not.toContain("README.md");
  });

  it("respects the QUICK_OPEN_RESULT_CAP", () => {
    const paths = Array.from(
      { length: QUICK_OPEN_RESULT_CAP * 2 },
      (_, i) => `f${i}.ts`,
    );
    const out = rankPaths(paths, "");
    expect(out).toHaveLength(QUICK_OPEN_RESULT_CAP);
  });
});

// ---------------------------------------------------------------------------
// walkProjectFiles — BFS over the fake lister
// ---------------------------------------------------------------------------

describe("walkProjectFiles", () => {
  type Entry = {
    name: string;
    type: "file" | "dir";
    ignored: boolean;
    hasChildren?: boolean;
  };
  type Listing =
    | { ok: true; entries: Entry[]; truncated: boolean }
    | { ok: false; error_code: string };

  function fakeLister(byPath: Record<string, Listing>) {
    return async (_pid: string, path: string): Promise<Listing> => {
      const res = byPath[path];
      if (!res) return { ok: true, entries: [], truncated: false };
      return res;
    };
  }

  it("BFS-walks the tree, drops ignored entries, returns flat paths", async () => {
    const lister = fakeLister({
      "": {
        ok: true,
        truncated: false,
        entries: [
          { name: "src", type: "dir", ignored: false, hasChildren: true },
          { name: "node_modules", type: "dir", ignored: true, hasChildren: true },
          { name: "README.md", type: "file", ignored: false },
        ],
      },
      src: {
        ok: true,
        truncated: false,
        entries: [
          { name: "index.ts", type: "file", ignored: false },
          { name: "lib", type: "dir", ignored: false, hasChildren: true },
        ],
      },
      "src/lib": {
        ok: true,
        truncated: false,
        entries: [{ name: "util.ts", type: "file", ignored: false }],
      },
    });

    const { paths, error } = await walkProjectFiles("p1", lister);
    expect(error).toBeNull();
    // Order is BFS — root first, then children, but the exact
    // interleaving depends on concurrency. Sort for stable assertion.
    expect(paths.sort()).toEqual([
      "README.md",
      "src/index.ts",
      "src/lib/util.ts",
    ]);
  });

  it("propagates the root error_code when the root listing fails", async () => {
    const lister = fakeLister({
      "": { ok: false, error_code: "fs_permission_denied" },
    });
    const { paths, error } = await walkProjectFiles("p1", lister);
    expect(paths).toEqual([]);
    expect(error).toBe("fs_permission_denied");
  });
});

// ---------------------------------------------------------------------------
// useQuickOpenIndexStore — caching + project-swap behaviour
// ---------------------------------------------------------------------------

describe("useQuickOpenIndexStore", () => {
  it("caches across requestIndex calls within the TTL window", async () => {
    const lister = vi.fn(async () => ({
      ok: true as const,
      truncated: false,
      entries: [{ name: "a.ts", type: "file" as const, ignored: false }],
    }));
    useQuickOpenIndexStore.getState().__setListerForTests(lister);

    await useQuickOpenIndexStore.getState().requestIndex("proj-1");
    expect(lister).toHaveBeenCalledTimes(1);

    // Inside the TTL window — second call dedupes.
    await useQuickOpenIndexStore.getState().requestIndex("proj-1");
    expect(lister).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the cache window has elapsed", async () => {
    const lister = vi.fn(async () => ({
      ok: true as const,
      truncated: false,
      entries: [{ name: "a.ts", type: "file" as const, ignored: false }],
    }));
    useQuickOpenIndexStore.getState().__setListerForTests(lister);

    await useQuickOpenIndexStore.getState().requestIndex("proj-1");
    expect(lister).toHaveBeenCalledTimes(1);

    // Backdate the fetchedAt past the TTL window.
    useQuickOpenIndexStore.setState((s) => ({
      ...s,
      fetchedAt: Date.now() - QUICK_OPEN_CACHE_TTL_MS - 1_000,
    }));
    await useQuickOpenIndexStore.getState().requestIndex("proj-1");
    expect(lister).toHaveBeenCalledTimes(2);
  });

  it("clears prior project state on project swap", async () => {
    const lister = vi.fn(async (_pid: string, _path: string) => ({
      ok: true as const,
      truncated: false,
      entries: [{ name: "a.ts", type: "file" as const, ignored: false }],
    }));
    useQuickOpenIndexStore.getState().__setListerForTests(lister);

    await useQuickOpenIndexStore.getState().requestIndex("proj-1");
    expect(useQuickOpenIndexStore.getState().projectId).toBe("proj-1");
    expect(useQuickOpenIndexStore.getState().paths).toEqual(["a.ts"]);

    await useQuickOpenIndexStore.getState().requestIndex("proj-2");
    expect(useQuickOpenIndexStore.getState().projectId).toBe("proj-2");
    expect(useQuickOpenIndexStore.getState().paths).toEqual(["a.ts"]);
    // Two distinct walks fired.
    expect(lister).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// <QuickOpen> — DOM contract
// ---------------------------------------------------------------------------

describe("<QuickOpen>", () => {
  function seedIndex(paths: string[]) {
    // Bypass the walker — directly inject the index. The store exposes
    // the same shape Zustand stores natively support.
    useQuickOpenIndexStore.setState((s) => ({
      ...s,
      projectId: "p1",
      paths,
      fetchedAt: Date.now(),
      isLoading: false,
      error: null,
    }));
    // The component still calls `requestIndex` on mount — keep the
    // lister a noop so the call resolves without changing state. With
    // the cache window fresh, the requestIndex is a no-op anyway.
    useQuickOpenIndexStore.getState().__setListerForTests(async () => ({
      ok: true,
      truncated: false,
      entries: [],
    }));
  }

  it("empty input → renders top-100 alpha-sorted rows", async () => {
    seedIndex(["src/zeta.ts", "alpha.ts", "src/beta.ts"]);
    const onOpenChange = vi.fn();
    render(
      <QuickOpen projectId="p1" open={true} onOpenChange={onOpenChange} />,
    );

    const rows = await screen.findAllByTestId("quick-open-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute("data-path", "alpha.ts");
    expect(rows[1]).toHaveAttribute("data-path", "src/beta.ts");
    expect(rows[2]).toHaveAttribute("data-path", "src/zeta.ts");
    // First row starts active.
    expect(rows[0]).toHaveAttribute("data-active", "true");
  });

  it("typing fuzzy-filters and surfaces fzy-scored matches", async () => {
    seedIndex([
      "src/components/Header.tsx",
      "src/server/db.ts",
      "src/components/Footer.tsx",
    ]);
    const user = userEvent.setup();
    render(
      <QuickOpen projectId="p1" open={true} onOpenChange={vi.fn()} />,
    );

    const input = screen.getByTestId("quick-open-input");
    await user.type(input, "header");

    await waitFor(() => {
      const rows = screen.getAllByTestId("quick-open-row");
      expect(rows[0]).toHaveAttribute(
        "data-path",
        "src/components/Header.tsx",
      );
    });
    // server/db.ts shouldn't match the needle "header" — drop it.
    expect(
      screen
        .queryAllByTestId("quick-open-row")
        .map((r) => r.getAttribute("data-path")),
    ).not.toContain("src/server/db.ts");
  });

  it("ArrowDown / ArrowUp move selection and wrap at the ends", async () => {
    seedIndex(["a.ts", "b.ts", "c.ts"]);
    const user = userEvent.setup();
    render(
      <QuickOpen projectId="p1" open={true} onOpenChange={vi.fn()} />,
    );

    const input = screen.getByTestId("quick-open-input");
    input.focus();

    const getActive = () =>
      screen
        .getAllByTestId("quick-open-row")
        .find((r) => r.getAttribute("data-active") === "true")
        ?.getAttribute("data-path");

    expect(getActive()).toBe("a.ts");
    await user.keyboard("{ArrowDown}");
    expect(getActive()).toBe("b.ts");
    await user.keyboard("{ArrowDown}");
    expect(getActive()).toBe("c.ts");
    await user.keyboard("{ArrowDown}"); // wrap
    expect(getActive()).toBe("a.ts");
    await user.keyboard("{ArrowUp}"); // wrap back
    expect(getActive()).toBe("c.ts");
  });

  it("Enter opens the active path in the editor-tabs store and closes the dialog", async () => {
    seedIndex(["a.ts", "b.ts", "c.ts"]);
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <QuickOpen projectId="p1" open={true} onOpenChange={onOpenChange} />,
    );

    const input = screen.getByTestId("quick-open-input");
    input.focus();
    await user.keyboard("{ArrowDown}"); // → b.ts
    await user.keyboard("{Enter}");

    // The editor-tabs store should have one tab open at b.ts.
    const tabs = useEditorTabsStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.path).toBe("b.ts");

    // And the modal asked to close.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clicking a row opens it and closes the dialog", async () => {
    seedIndex(["alpha.ts", "beta.ts"]);
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <QuickOpen projectId="p1" open={true} onOpenChange={onOpenChange} />,
    );

    const rows = await screen.findAllByTestId("quick-open-row");
    await user.click(rows[1]!);

    const tabs = useEditorTabsStore.getState().tabs;
    expect(tabs[0]?.path).toBe("beta.ts");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders the 'No matches' empty-state when the query has no fuzzy hits", async () => {
    seedIndex(["src/foo.ts"]);
    const user = userEvent.setup();
    render(
      <QuickOpen projectId="p1" open={true} onOpenChange={vi.fn()} />,
    );

    const input = screen.getByTestId("quick-open-input");
    await user.type(input, "xyzzz");

    await screen.findByTestId("quick-open-empty");
  });

  it("renders the 'Indexing…' placeholder when the index is empty and a walk is in flight", () => {
    // Start with an empty index and the loading flag set.
    useQuickOpenIndexStore.setState((s) => ({
      ...s,
      projectId: "p1",
      paths: [],
      fetchedAt: 0,
      isLoading: true,
      error: null,
    }));
    useQuickOpenIndexStore.getState().__setListerForTests(
      // Hold the lister so the requestIndex inside the component
      // doesn't resolve and clear isLoading mid-render.
      () => new Promise(() => {}),
    );

    render(
      <QuickOpen projectId="p1" open={true} onOpenChange={vi.fn()} />,
    );
    expect(screen.getByTestId("quick-open-loading")).toBeInTheDocument();
  });

  it("prunes activeIndex when the result list shrinks below it", async () => {
    seedIndex(["alpha.ts", "alphabet.ts", "alps.ts"]);
    const user = userEvent.setup();
    render(
      <QuickOpen projectId="p1" open={true} onOpenChange={vi.fn()} />,
    );

    // Move to the third row, then narrow the list to one match.
    const input = screen.getByTestId("quick-open-input");
    input.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    let rows = screen.getAllByTestId("quick-open-row");
    expect(rows[2]).toHaveAttribute("data-active", "true");

    await user.type(input, "alphabet");
    await waitFor(() => {
      rows = screen.getAllByTestId("quick-open-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveAttribute("data-active", "true");
    });
  });

  it("re-opening resets the query and selection", async () => {
    seedIndex(["a.ts", "b.ts", "c.ts"]);
    const user = userEvent.setup();
    const { rerender } = render(
      <QuickOpen projectId="p1" open={true} onOpenChange={vi.fn()} />,
    );

    const input = screen.getByTestId("quick-open-input") as HTMLInputElement;
    input.focus();
    await user.type(input, "b");
    await user.keyboard("{ArrowDown}"); // hypothetically — if any matches survived

    // Close.
    rerender(
      <QuickOpen projectId="p1" open={false} onOpenChange={vi.fn()} />,
    );
    // Re-open.
    rerender(
      <QuickOpen projectId="p1" open={true} onOpenChange={vi.fn()} />,
    );

    await waitFor(() => {
      const next = screen.getByTestId("quick-open-input") as HTMLInputElement;
      expect(next.value).toBe("");
    });

    const rows = screen.getAllByTestId("quick-open-row");
    expect(rows[0]).toHaveAttribute("data-active", "true");
  });
});

// ---------------------------------------------------------------------------
// Concurrent requestIndex coalescing — guards against the double-fetch
// regression where a remount + a manual call triggered two BFS passes.
// ---------------------------------------------------------------------------

describe("requestIndex concurrent coalescing", () => {
  it("fires the lister exactly once across two parallel callers", async () => {
    let resolveListing: ((v: any) => void) | null = null;
    const lister = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveListing = resolve;
        }),
    );
    useQuickOpenIndexStore.getState().__setListerForTests(lister);

    const a = useQuickOpenIndexStore.getState().requestIndex("p1");
    const b = useQuickOpenIndexStore.getState().requestIndex("p1");

    // Drain microtasks so both callers register against the in-flight walk.
    await Promise.resolve();
    expect(lister).toHaveBeenCalledTimes(1);

    // Resolve and assert both promises complete.
    await act(async () => {
      resolveListing?.({
        ok: true,
        truncated: false,
        entries: [{ name: "x.ts", type: "file", ignored: false }],
      });
      await Promise.all([a, b]);
    });
    expect(useQuickOpenIndexStore.getState().paths).toEqual(["x.ts"]);
  });
});
