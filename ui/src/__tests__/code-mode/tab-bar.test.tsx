/**
 * TabBar contract tests.
 *
 * The TabBar is a pure projection of `useEditorTabsStore` — every test
 * sets up store state via the public store methods (`open`, `setDirty`,
 * `focus`, …) and asserts the rendered DOM. The store's own transition
 * behaviour is covered by `tab-state-machine.test.ts`; this file owns
 * the *visual* contract:
 *
 *   - all open tabs render
 *   - the active tab is highlighted
 *   - icon + label + dirty dot + close button per tab
 *   - long labels carry the full path on a `title` attribute
 *   - same-basename tabs disambiguate via parent directories
 *   - clicking a tab focuses it; clicking × closes it
 *
 * The disambiguation algorithm is exported as a pure function and
 * exercised independently so we can lock down the tricky multi-group
 * cases without mounting any component.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TabBar, disambiguateLabels } from "@/components/code-mode/TabBar";
import { useEditorTabsStore } from "@/components/code-mode/tab-store";

// ---------------------------------------------------------------------------
// Store helpers — keep tests focused on the rendered contract instead of
// fiddling with reducer events directly. `seed` opens N paths and returns
// their generated ids in stable order so assertions can target the row
// for a specific path.
// ---------------------------------------------------------------------------

function seed(paths: string[]): string[] {
  const ids: string[] = [];
  for (const p of paths) {
    ids.push(useEditorTabsStore.getState().open(p));
  }
  return ids;
}

beforeEach(() => {
  // Each test starts from an empty store so tab ids and order are
  // independent of run order.
  useEditorTabsStore.getState().__resetForTests();
});

// ---------------------------------------------------------------------------
// disambiguateLabels — pure unit coverage of the labelling rule.
// ---------------------------------------------------------------------------

describe("disambiguateLabels", () => {
  it("returns the basename when paths are unique", () => {
    expect(
      disambiguateLabels(["src/a.ts", "src/b.ts", "lib/c.ts"]),
    ).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("prepends the closest distinguishing parent for two-way collisions", () => {
    // From the SKILL spec example.
    expect(
      disambiguateLabels(["src/api/auth.ts", "src/middleware/auth.ts"]),
    ).toEqual(["api/auth.ts", "middleware/auth.ts"]);
  });

  it("walks further up the tree when one parent is not enough", () => {
    // Two paths share both basename AND immediate parent. The labels
    // need a grandparent to be distinct.
    expect(
      disambiguateLabels(["a/x/auth.ts", "b/x/auth.ts"]),
    ).toEqual(["a/x/auth.ts", "b/x/auth.ts"]);
  });

  it("only expands the colliding tabs — non-colliding tabs keep the basename", () => {
    const labels = disambiguateLabels([
      "src/api/auth.ts",
      "src/middleware/auth.ts",
      "src/util.ts",
    ]);
    expect(labels[0]).toBe("api/auth.ts");
    expect(labels[1]).toBe("middleware/auth.ts");
    expect(labels[2]).toBe("util.ts");
  });

  it("handles a three-way collision with mixed expansion depths", () => {
    // a/x/auth.ts, a/y/auth.ts, b/x/auth.ts
    //   depth 1: x/auth.ts, y/auth.ts, x/auth.ts  (0 and 2 still collide)
    //   depth 2: a/x/auth.ts,         (untouched), b/x/auth.ts
    // The middle tab should NOT have been expanded past depth 1 — it
    // never collided once the parent was added.
    const labels = disambiguateLabels([
      "a/x/auth.ts",
      "a/y/auth.ts",
      "b/x/auth.ts",
    ]);
    expect(labels).toEqual(["a/x/auth.ts", "y/auth.ts", "b/x/auth.ts"]);
  });

  it("handles a leading slash by ignoring empty segments", () => {
    expect(disambiguateLabels(["/foo/a.ts", "/bar/a.ts"])).toEqual([
      "foo/a.ts",
      "bar/a.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Render contract.
// ---------------------------------------------------------------------------

describe("<TabBar />", () => {
  it("renders nothing when no tabs are open", () => {
    const { container } = render(<TabBar />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("tab-bar")).toBeNull();
  });

  it("renders one row per open tab", () => {
    const ids = seed(["src/a.ts", "src/b.ts", "src/c.ts"]);
    render(<TabBar />);

    expect(screen.getByTestId("tab-bar")).toBeInTheDocument();
    for (const id of ids) {
      expect(screen.getByTestId(`tab-${id}`)).toBeInTheDocument();
    }
  });

  it("highlights the active tab and only the active tab", () => {
    const [, idB, idC] = seed(["a.ts", "b.ts", "c.ts"]);
    // `seed` leaves the LAST-opened tab as active (open() focuses).
    render(<TabBar />);

    expect(screen.getByTestId(`tab-${idC}`)).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByTestId(`tab-${idB}`)).toHaveAttribute(
      "data-active",
      "false",
    );
  });

  it("each tab renders an icon, basename label, and a close button", () => {
    const [id] = seed(["src/index.ts"]);
    render(<TabBar />);

    // Label = basename when no collisions.
    const label = screen.getByTestId(`tab-label-${id}`);
    expect(label).toHaveTextContent("index.ts");

    // Close button is keyboard-discoverable via its accessible name.
    expect(
      screen.getByRole("button", { name: /close index\.ts/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId(`tab-close-${id}`)).toBeInTheDocument();

    // The icon is rendered as an SVG sibling of the label inside the row.
    const row = screen.getByTestId(`tab-${id}`);
    expect(row.querySelector("svg")).not.toBeNull();
  });

  it("renders a dirty dot only on dirty tabs", () => {
    const [idA, idB] = seed(["a.ts", "b.ts"]);
    useEditorTabsStore.getState().setDirty(idA!, true);
    render(<TabBar />);

    expect(screen.getByTestId(`tab-dirty-${idA}`)).toBeInTheDocument();
    expect(screen.getByTestId(`tab-dirty-${idA}`)).toHaveTextContent("•");
    expect(screen.queryByTestId(`tab-dirty-${idB}`)).toBeNull();

    // Toggle clean → the dot disappears without a remount. The store
    // mutation is wrapped in `act` so React's commit phase finishes
    // before we read the DOM back.
    act(() => {
      useEditorTabsStore.getState().setDirty(idA!, false);
    });
    expect(screen.queryByTestId(`tab-dirty-${idA}`)).toBeNull();

    // The reflective `data-dirty` attribute on the row mirrors the flag
    // so e2e selectors and CSS can target it.
    expect(screen.getByTestId(`tab-${idA}`)).toHaveAttribute(
      "data-dirty",
      "false",
    );
  });

  it("long labels expose the full path on a title attribute", () => {
    const [id] = seed([
      "deeply/nested/folder/structure/with/a/very-long-filename.ts",
    ]);
    render(<TabBar />);

    const row = screen.getByTestId(`tab-${id}`);
    const label = screen.getByTestId(`tab-label-${id}`);

    // Both row and label carry the title so a hover anywhere on the
    // tab reveals the full path.
    expect(row).toHaveAttribute(
      "title",
      "deeply/nested/folder/structure/with/a/very-long-filename.ts",
    );
    expect(label).toHaveAttribute(
      "title",
      "deeply/nested/folder/structure/with/a/very-long-filename.ts",
    );
    // CSS `truncate` class is applied so the visible text gets clipped
    // before it overflows the row.
    expect(label.className).toMatch(/truncate/);
  });

  it("disambiguates same-basename tabs with the parent directory", () => {
    const [idApi, idMid] = seed([
      "src/api/auth.ts",
      "src/middleware/auth.ts",
    ]);
    render(<TabBar />);

    expect(screen.getByTestId(`tab-label-${idApi}`)).toHaveTextContent(
      "api/auth.ts",
    );
    expect(screen.getByTestId(`tab-label-${idMid}`)).toHaveTextContent(
      "middleware/auth.ts",
    );
  });

  it("non-colliding tabs keep the basename even when others are disambiguated", () => {
    const [idApi, idMid, idUtil] = seed([
      "src/api/auth.ts",
      "src/middleware/auth.ts",
      "src/util.ts",
    ]);
    render(<TabBar />);

    expect(screen.getByTestId(`tab-label-${idApi}`)).toHaveTextContent(
      "api/auth.ts",
    );
    expect(screen.getByTestId(`tab-label-${idMid}`)).toHaveTextContent(
      "middleware/auth.ts",
    );
    expect(screen.getByTestId(`tab-label-${idUtil}`)).toHaveTextContent(
      "util.ts",
    );
  });

  it("clicking a tab focuses it in the store", async () => {
    const user = userEvent.setup();
    const [idA, idB] = seed(["a.ts", "b.ts"]);
    // After seed, tab B is active. Click tab A → focus shifts.
    render(<TabBar />);
    expect(useEditorTabsStore.getState().activeId).toBe(idB);

    await user.click(screen.getByTestId(`tab-${idA}`));
    expect(useEditorTabsStore.getState().activeId).toBe(idA);

    // Re-rendering picks up the active swap.
    expect(screen.getByTestId(`tab-${idA}`)).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByTestId(`tab-${idB}`)).toHaveAttribute(
      "data-active",
      "false",
    );
  });

  it("clicking the × closes the tab and does not also focus it", async () => {
    const user = userEvent.setup();
    const [idA, idB] = seed(["a.ts", "b.ts"]);
    // B is active; close the inactive A → activeId stays B, A is gone.
    render(<TabBar />);

    await user.click(screen.getByTestId(`tab-close-${idA}`));

    expect(useEditorTabsStore.getState().tabs.map((t) => t.id)).toEqual([
      idB,
    ]);
    expect(useEditorTabsStore.getState().activeId).toBe(idB);
    expect(screen.queryByTestId(`tab-${idA}`)).toBeNull();
  });

  it("closing a dirty tab flips pendingClose without removing it (confirm dialog is slice 02)", async () => {
    const user = userEvent.setup();
    const [idA] = seed(["dirty.ts"]);
    useEditorTabsStore.getState().setDirty(idA!, true);
    render(<TabBar />);

    await user.click(screen.getByTestId(`tab-close-${idA}`));

    // The reducer keeps the tab open and flips pendingClose; the UI
    // wiring for a confirm dialog lands in the next slice.
    const tab = useEditorTabsStore
      .getState()
      .tabs.find((t) => t.id === idA);
    expect(tab?.pendingClose).toBe(true);
    expect(screen.getByTestId(`tab-${idA}`)).toBeInTheDocument();
  });
});
