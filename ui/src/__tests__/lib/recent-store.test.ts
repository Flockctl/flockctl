import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { recentStore, RECENT_KEY, useTrackRecent } from "@/lib/recent-store";

// Some sibling tests (e.g. shell-switch) hijack `window.localStorage`
// via `Object.defineProperty` and don't restore it. We install our own
// fully-functional mock per test so the suite is robust against
// cross-file leakage of a partial mock.
type MockStore = Record<string, string>;
const installMockStorage = (initial: MockStore = {}) => {
  const data: MockStore = { ...initial };
  const mock = {
    getItem: (k: string) => (k in data ? data[k]! : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    removeItem: (k: string) => {
      delete data[k];
    },
    clear: () => {
      for (const k of Object.keys(data)) delete data[k];
    },
    key: (i: number) => Object.keys(data)[i] ?? null,
    get length() {
      return Object.keys(data).length;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: mock,
    configurable: true,
    writable: true,
  });
};

beforeEach(() => {
  installMockStorage();
  recentStore.__resetForTests();
});

describe("recentStore.track", () => {
  it("adds a new item with a monotonic `ts`", () => {
    const before = Date.now() * 1000;
    recentStore.track({ kind: "project", id: "p1", label: "alpha", href: "/projects/p1" });
    const list = recentStore.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("p1");
    expect(list[0]?.label).toBe("alpha");
    // `ts` is `Date.now() * 1000 + seq` so >= the pre-track `Date.now()` × 1000.
    expect(list[0]?.ts).toBeGreaterThanOrEqual(before);
  });

  it("dedupes by kind+id and refreshes label/href/ts", () => {
    recentStore.track({ kind: "project", id: "p1", label: "old-label", href: "/old" });
    const t0 = recentStore.list()[0]?.ts ?? 0;
    // The store's monotonic counter guarantees the second track lands
    // strictly after the first, no sleep required.
    recentStore.track({ kind: "project", id: "p1", label: "new-label", href: "/new" });
    const list = recentStore.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.label).toBe("new-label");
    expect(list[0]?.href).toBe("/new");
    expect(list[0]?.ts).toBeGreaterThan(t0);
  });

  it("treats same id with different kind as distinct entries", () => {
    recentStore.track({ kind: "project", id: "x", label: "Project X", href: "/projects/x" });
    recentStore.track({ kind: "workspace", id: "x", label: "Workspace X", href: "/workspaces/x" });
    expect(recentStore.list()).toHaveLength(2);
  });

  it("caps non-pinned items at 5; oldest evicted first", () => {
    for (let i = 0; i < 7; i++) {
      recentStore.track({
        kind: "project",
        id: `p${i}`,
        label: `Project ${i}`,
        href: `/projects/p${i}`,
      });
    }
    const ids = recentStore.list().map(i => i.id);
    // Only the 5 most-recent survive; oldest (`p0`, `p1`) evicted.
    expect(ids).toHaveLength(5);
    expect(ids).not.toContain("p0");
    expect(ids).not.toContain("p1");
    expect(ids).toContain("p6");
  });

  it("pinned items survive eviction beyond the cap", () => {
    recentStore.track({ kind: "project", id: "old-pinned", label: "OP", href: "/" });
    recentStore.pin("old-pinned");
    for (let i = 0; i < 7; i++) {
      recentStore.track({
        kind: "project",
        id: `p${i}`,
        label: `Project ${i}`,
        href: `/projects/p${i}`,
      });
    }
    const ids = recentStore.list().map(i => i.id);
    expect(ids).toContain("old-pinned");
    // Pinned + 5 recents = 6 items total.
    expect(ids).toHaveLength(6);
    // Pinned listed first.
    expect(ids[0]).toBe("old-pinned");
  });
});

describe("recentStore.pin / unpin", () => {
  it("pin sets the pinned flag and persists to storage", () => {
    recentStore.track({ kind: "task", id: "t1", label: "T1", href: "/tasks/t1" });
    recentStore.pin("t1");
    expect(recentStore.list()[0]?.pinned).toBe(true);
    const raw = window.localStorage.getItem(RECENT_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).items[0].pinned).toBe(true);
  });

  it("unpin clears the flag", () => {
    recentStore.track({ kind: "task", id: "t1", label: "T1", href: "/tasks/t1" });
    recentStore.pin("t1");
    recentStore.unpin("t1");
    expect(recentStore.list()[0]?.pinned).toBeUndefined();
  });
});

describe("recentStore persistence", () => {
  it("writes to flockctl.recent (namespaced key)", () => {
    recentStore.track({ kind: "project", id: "p1", label: "alpha", href: "/projects/p1" });
    expect(window.localStorage.getItem(RECENT_KEY)).not.toBeNull();
    // Guards against accidentally renaming the storage key out from
    // under existing users — bumping the key wipes their pinned list.
    expect(RECENT_KEY).toBe("flockctl.recent");
  });

  it("survives a corrupt storage payload (resets to empty)", () => {
    window.localStorage.setItem(RECENT_KEY, "{not valid json");
    recentStore.__resetForTests(); // re-hydrate
    // After reset, storage was cleared; track again to confirm the
    // store is writable and didn't get stuck on the corrupt blob.
    recentStore.track({ kind: "project", id: "fresh", label: "F", href: "/" });
    expect(recentStore.list()).toHaveLength(1);
  });

  it("survives a wrong-schema payload (drops items)", () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify({ v: 999, items: [] }));
    recentStore.__resetForTests();
    expect(recentStore.list()).toHaveLength(0);
  });
});

describe("useTrackRecent", () => {
  it("tracks the entity once mount + on every changed identity", () => {
    const { rerender } = renderHook(
      ({ id, label }: { id: string | undefined; label: string | null }) =>
        useTrackRecent({ kind: "project", id, label, href: `/projects/${id ?? ""}` }),
      { initialProps: { id: "p1", label: "alpha" } },
    );
    expect(recentStore.list()).toHaveLength(1);
    expect(recentStore.list()[0]?.label).toBe("alpha");

    // Same id+label → no new entry, no extra render-side effect.
    rerender({ id: "p1", label: "alpha" });
    expect(recentStore.list()).toHaveLength(1);

    // Label change → store gets the fresh value (via the dedupe-and-
    // refresh path inside `track`).
    rerender({ id: "p1", label: "alpha-renamed" });
    expect(recentStore.list()[0]?.label).toBe("alpha-renamed");

    // Switch to another id → second entry appears.
    rerender({ id: "p2", label: "beta" });
    expect(recentStore.list()).toHaveLength(2);
  });

  it("is a no-op while id or label is missing (params not yet resolved)", () => {
    type Props = { id: string | undefined; label: string | null };
    const { rerender } = renderHook<void, Props>(
      ({ id, label }) =>
        useTrackRecent({ kind: "project", id, label, href: "/projects/" }),
      { initialProps: { id: undefined, label: null } },
    );
    expect(recentStore.list()).toHaveLength(0);
    rerender({ id: "p1", label: null });
    expect(recentStore.list()).toHaveLength(0);
    rerender({ id: undefined, label: "alpha" });
    expect(recentStore.list()).toHaveLength(0);
    rerender({ id: "p1", label: "alpha" });
    expect(recentStore.list()).toHaveLength(1);
  });
});
