/**
 * Code-mode tab state-machine tests — transition table.
 *
 * Per the `state-machine-driven-task` skill: the contract is the
 * transitions table below. The test loop iterates `[label, before,
 * event, after]` triples and asserts `reduce(before, event) ===
 * after` (deep-equal). Adding a new transition means adding a row;
 * the test loop generates the assertion automatically.
 *
 * Reference-equality short-circuit cases (the reducer is expected to
 * return the input `state` unchanged for no-ops) are tagged with
 * `expectSameRef: true` so we additionally assert `Object.is` to
 * guarantee Zustand selectors won't re-render.
 */

import { describe, it, expect } from "vitest";
import {
  reduce,
  initialState,
  type State,
  type Event,
  type Tab,
} from "@/components/code-mode/tab-state-machine";

// ----------------------------------------------------------------------------
// Builders — keep transition rows readable.
// ----------------------------------------------------------------------------

function tab(overrides: Partial<Tab> & Pick<Tab, "id" | "path">): Tab {
  return {
    buffer: "",
    heldSha: "",
    dirty: false,
    ...overrides,
  };
}

function withTabs(tabs: Tab[], activeId: string | null = null): State {
  return { tabs, activeId };
}

// ----------------------------------------------------------------------------
// Transition rows.
//
// Each row is `[label, before, event, after, opts?]`. `expectSameRef:
// true` adds an `Object.is(before, after)` assertion to lock down the
// "no-op returns same reference" contract.
// ----------------------------------------------------------------------------

type Row = [
  label: string,
  before: State,
  event: Event,
  after: State,
  opts?: { expectSameRef?: boolean },
];

const fileA = tab({ id: "1", path: "src/a.ts" });
const fileB = tab({ id: "2", path: "src/b.ts" });
const dirtyA = tab({ id: "1", path: "src/a.ts", dirty: true });
const dirtyAPending = tab({
  id: "1",
  path: "src/a.ts",
  dirty: true,
  pendingClose: true,
});

const transitions: Row[] = [
  // ── open ───────────────────────────────────────────────────────────────
  [
    "open: empty store → adds new tab and focuses it",
    initialState,
    { type: "open", path: "src/a.ts", newId: "1" },
    withTabs([fileA], "1"),
  ],
  [
    "open: existing path → focuses existing tab, no new tab",
    withTabs([fileA, fileB], "2"),
    { type: "open", path: "src/a.ts", newId: "ignored" },
    withTabs([fileA, fileB], "1"),
  ],
  [
    "open: already-active existing path → no-op (same ref)",
    withTabs([fileA], "1"),
    { type: "open", path: "src/a.ts", newId: "ignored" },
    withTabs([fileA], "1"),
    { expectSameRef: true },
  ],
  [
    "open: new path appends right of existing tabs and focuses",
    withTabs([fileA], "1"),
    { type: "open", path: "src/b.ts", newId: "2" },
    withTabs([fileA, fileB], "2"),
  ],

  // ── focus ──────────────────────────────────────────────────────────────
  [
    "focus: switches activeId to a different open tab",
    withTabs([fileA, fileB], "1"),
    { type: "focus", id: "2" },
    withTabs([fileA, fileB], "2"),
  ],
  [
    "focus: already-active id → no-op (same ref)",
    withTabs([fileA, fileB], "1"),
    { type: "focus", id: "1" },
    withTabs([fileA, fileB], "1"),
    { expectSameRef: true },
  ],
  [
    "focus: unknown id → no-op (same ref)",
    withTabs([fileA], "1"),
    { type: "focus", id: "ghost" },
    withTabs([fileA], "1"),
    { expectSameRef: true },
  ],

  // ── close (clean) ──────────────────────────────────────────────────────
  [
    "close: clean active tab → remove, activeId = null when last",
    withTabs([fileA], "1"),
    { type: "close", id: "1" },
    withTabs([], null),
  ],
  [
    "close: clean active tab with right neighbour → focus right",
    withTabs([fileA, fileB], "1"),
    { type: "close", id: "1" },
    withTabs([fileB], "2"),
  ],
  [
    "close: clean active rightmost tab → focus left neighbour",
    withTabs([fileA, fileB], "2"),
    { type: "close", id: "2" },
    withTabs([fileA], "1"),
  ],
  [
    "close: clean inactive tab → remove without changing activeId",
    withTabs([fileA, fileB], "2"),
    { type: "close", id: "1" },
    withTabs([fileB], "2"),
  ],
  [
    "close: unknown id → no-op (same ref)",
    withTabs([fileA], "1"),
    { type: "close", id: "ghost" },
    withTabs([fileA], "1"),
    { expectSameRef: true },
  ],

  // ── close (dirty handshake) ────────────────────────────────────────────
  [
    "close: dirty tab → flips pendingClose=true (tab stays open)",
    withTabs([dirtyA], "1"),
    { type: "close", id: "1" },
    withTabs([dirtyAPending], "1"),
  ],
  [
    "close: dirty tab with pendingClose already true → no-op (same ref)",
    withTabs([dirtyAPending], "1"),
    { type: "close", id: "1" },
    withTabs([dirtyAPending], "1"),
    { expectSameRef: true },
  ],

  // ── confirmClose ───────────────────────────────────────────────────────
  [
    "confirmClose(cancel): clears pendingClose, leaves dirty intact",
    withTabs([dirtyAPending], "1"),
    { type: "confirmClose", id: "1", choice: "cancel" },
    withTabs(
      [tab({ id: "1", path: "src/a.ts", dirty: true, pendingClose: false })],
      "1",
    ),
  ],
  [
    "confirmClose(cancel) on tab without pendingClose → no-op (same ref)",
    withTabs([dirtyA], "1"),
    { type: "confirmClose", id: "1", choice: "cancel" },
    withTabs([dirtyA], "1"),
    { expectSameRef: true },
  ],
  [
    "confirmClose(save): removes tab (save I/O is caller's job)",
    withTabs([dirtyAPending, fileB], "1"),
    { type: "confirmClose", id: "1", choice: "save" },
    withTabs([fileB], "2"),
  ],
  [
    "confirmClose(dont): removes tab",
    withTabs([dirtyAPending, fileB], "1"),
    { type: "confirmClose", id: "1", choice: "dont" },
    withTabs([fileB], "2"),
  ],
  [
    "confirmClose: unknown id → no-op (same ref)",
    withTabs([fileA], "1"),
    { type: "confirmClose", id: "ghost", choice: "save" },
    withTabs([fileA], "1"),
    { expectSameRef: true },
  ],

  // ── setDirty ───────────────────────────────────────────────────────────
  [
    "setDirty(true): clean → dirty",
    withTabs([fileA], "1"),
    { type: "setDirty", id: "1", dirty: true },
    withTabs([dirtyA], "1"),
  ],
  [
    "setDirty(false): dirty → clean",
    withTabs([dirtyA], "1"),
    { type: "setDirty", id: "1", dirty: false },
    withTabs([fileA], "1"),
  ],
  [
    "setDirty: same value → no-op (same ref)",
    withTabs([fileA], "1"),
    { type: "setDirty", id: "1", dirty: false },
    withTabs([fileA], "1"),
    { expectSameRef: true },
  ],
  [
    "setDirty: unknown id → no-op (same ref)",
    withTabs([fileA], "1"),
    { type: "setDirty", id: "ghost", dirty: true },
    withTabs([fileA], "1"),
    { expectSameRef: true },
  ],

  // ── setBuffer ──────────────────────────────────────────────────────────
  [
    "setBuffer: writes content + sha and clears dirty (post-save)",
    withTabs([dirtyA], "1"),
    { type: "setBuffer", id: "1", content: "hello", sha: "abc123" },
    withTabs(
      [tab({ id: "1", path: "src/a.ts", buffer: "hello", heldSha: "abc123" })],
      "1",
    ),
  ],
  [
    "setBuffer: on clean tab still clears dirty and overwrites bytes (post-load)",
    withTabs([fileA], "1"),
    { type: "setBuffer", id: "1", content: "v1", sha: "sha-v1" },
    withTabs(
      [tab({ id: "1", path: "src/a.ts", buffer: "v1", heldSha: "sha-v1" })],
      "1",
    ),
  ],
  [
    "setBuffer: unknown id → no-op (same ref)",
    withTabs([fileA], "1"),
    { type: "setBuffer", id: "ghost", content: "x", sha: "y" },
    withTabs([fileA], "1"),
    { expectSameRef: true },
  ],

  // ── rename ─────────────────────────────────────────────────────────────
  [
    "rename: matching tab path is patched, all other state survives",
    withTabs(
      [
        tab({
          id: "1",
          path: "src/a.ts",
          buffer: "hello",
          heldSha: "abc",
          dirty: true,
        }),
      ],
      "1",
    ),
    { type: "rename", from: "src/a.ts", to: "src/b.ts" },
    withTabs(
      [
        tab({
          id: "1",
          path: "src/b.ts",
          buffer: "hello",
          heldSha: "abc",
          dirty: true,
        }),
      ],
      "1",
    ),
  ],
  [
    "rename: no matching tab → no-op (same ref)",
    withTabs([fileA], "1"),
    { type: "rename", from: "ghost.ts", to: "found.ts" },
    withTabs([fileA], "1"),
    { expectSameRef: true },
  ],
];

// ----------------------------------------------------------------------------
// Generated test loop.
// ----------------------------------------------------------------------------

describe("tab state machine — transition table", () => {
  for (const [label, before, event, after, opts] of transitions) {
    it(label, () => {
      const result = reduce(before, event);
      expect(result).toEqual(after);
      if (opts?.expectSameRef) {
        // No-op contract: returning the input ref lets Zustand selectors
        // skip re-rendering.
        expect(Object.is(result, before)).toBe(true);
      }
    });
  }
});

// ----------------------------------------------------------------------------
// A small handful of multi-step trajectories, to lock down sequences
// the table can't cleanly express (each row is independent).
// ----------------------------------------------------------------------------

describe("tab state machine — trajectories", () => {
  it("dirty close → cancel → re-close → save: ends with tab removed", () => {
    let s: State = withTabs([dirtyA, fileB], "1");
    s = reduce(s, { type: "close", id: "1" });
    expect(s.tabs[0]!.pendingClose).toBe(true);

    s = reduce(s, { type: "confirmClose", id: "1", choice: "cancel" });
    expect(s.tabs[0]!.pendingClose).toBeFalsy();
    expect(s.tabs[0]!.dirty).toBe(true);

    s = reduce(s, { type: "close", id: "1" });
    expect(s.tabs[0]!.pendingClose).toBe(true);

    s = reduce(s, { type: "confirmClose", id: "1", choice: "save" });
    expect(s.tabs.map((t) => t.id)).toEqual(["2"]);
    expect(s.activeId).toBe("2");
  });

  it("open(a) → setDirty(true) → setBuffer clears dirty (save round-trip)", () => {
    let s: State = initialState;
    s = reduce(s, { type: "open", path: "src/a.ts", newId: "1" });
    s = reduce(s, { type: "setDirty", id: "1", dirty: true });
    expect(s.tabs[0]!.dirty).toBe(true);

    s = reduce(s, {
      type: "setBuffer",
      id: "1",
      content: "saved",
      sha: "new-sha",
    });
    expect(s.tabs[0]!.dirty).toBe(false);
    expect(s.tabs[0]!.buffer).toBe("saved");
    expect(s.tabs[0]!.heldSha).toBe("new-sha");
  });

  it("opening the same path twice returns the same tab id", () => {
    let s: State = initialState;
    s = reduce(s, { type: "open", path: "src/a.ts", newId: "1" });
    const firstId = s.tabs[0]!.id;
    s = reduce(s, { type: "focus", id: "1" }); // (no-op — already active)
    s = reduce(s, { type: "open", path: "src/a.ts", newId: "should-be-ignored" });
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]!.id).toBe(firstId);
    expect(s.activeId).toBe(firstId);
  });
});

// ----------------------------------------------------------------------------
// Coverage check — every Event variant must appear in the transition
// table. If a new variant is added to the discriminated union without
// a corresponding row, this test fails — forcing test coverage.
// ----------------------------------------------------------------------------

describe("tab state machine — event coverage", () => {
  it("every Event variant has at least one row in the transition table", () => {
    const expected: Event["type"][] = [
      "open",
      "close",
      "confirmClose",
      "focus",
      "setDirty",
      "setBuffer",
      "rename",
    ];
    const seen = new Set(transitions.map(([, , event]) => event.type));
    for (const t of expected) {
      expect(seen.has(t)).toBe(true);
    }
  });
});
