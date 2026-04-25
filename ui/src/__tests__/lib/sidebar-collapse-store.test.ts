import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  isGroupCollapsed,
  setGroupCollapsed,
  toggleGroupCollapsed,
  useGroupCollapsed,
  __resetSidebarCollapseStoreForTests,
} from "@/lib/sidebar-collapse-store";

const STORAGE_KEY = "flockctl_sidebar_collapsed";

// A previous test file (server-store) swaps out `globalThis.localStorage` with
// a custom object and never restores it. That's benign within its own suite,
// but file-order affects us: by the time this suite runs, `localStorage` may
// or may not be jsdom's native implementation. Installing our own mock per
// test gives us deterministic behaviour either way.
let store: Record<string, string>;
const mockStorage = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => {
    store[k] = v;
  },
  removeItem: (k: string) => {
    delete store[k];
  },
  clear: () => {
    store = {};
  },
  key: () => null,
  length: 0,
};

describe("sidebar-collapse-store", () => {
  beforeEach(() => {
    store = {};
    Object.defineProperty(globalThis, "localStorage", {
      value: mockStorage,
      configurable: true,
      writable: true,
    });
    __resetSidebarCollapseStoreForTests();
  });

  it("defaults to not-collapsed for any unseen group", () => {
    expect(isGroupCollapsed("never-seen")).toBe(false);
  });

  it("persists a collapse flip to localStorage", () => {
    setGroupCollapsed("work", true);
    expect(isGroupCollapsed("work")).toBe(true);
    const raw = store[STORAGE_KEY];
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual({ work: true });
  });

  it("toggles between collapsed and open", () => {
    toggleGroupCollapsed("automate");
    expect(isGroupCollapsed("automate")).toBe(true);
    toggleGroupCollapsed("automate");
    expect(isGroupCollapsed("automate")).toBe(false);
  });

  it("setGroupCollapsed is a no-op when the value is unchanged", () => {
    setGroupCollapsed("overview", false);
    // Still absent from storage — no write happened.
    expect(store[STORAGE_KEY]).toBeUndefined();

    setGroupCollapsed("overview", true);
    setGroupCollapsed("overview", true);
    expect(isGroupCollapsed("overview")).toBe(true);
  });

  it("useGroupCollapsed re-renders when its group toggles", () => {
    const { result } = renderHook(() => useGroupCollapsed("system"));
    expect(result.current).toBe(false);

    act(() => {
      setGroupCollapsed("system", true);
    });
    expect(result.current).toBe(true);

    act(() => {
      toggleGroupCollapsed("system");
    });
    expect(result.current).toBe(false);
  });

  it("useGroupCollapsed isolates groups from each other", () => {
    const work = renderHook(() => useGroupCollapsed("work"));
    const system = renderHook(() => useGroupCollapsed("system"));

    act(() => {
      setGroupCollapsed("work", true);
    });
    expect(work.result.current).toBe(true);
    expect(system.result.current).toBe(false);
  });

  it("swallows setItem errors (storage disabled / full) without throwing", () => {
    const original = mockStorage.setItem;
    mockStorage.setItem = () => {
      throw new Error("quota");
    };
    try {
      expect(() => setGroupCollapsed("x", true)).not.toThrow();
      // in-memory cache still reflects the write
      expect(isGroupCollapsed("x")).toBe(true);
    } finally {
      mockStorage.setItem = original;
    }
  });
});
