import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Regression test for the `flockctl.ui.next` localStorage cleanup
 * migration in `src/main.tsx`.
 *
 * Background: `flockctl.ui.next` was the M21 feature flag that gated
 * the new-shell rollout. After the flag was retired (the new shell is
 * now the unconditional chrome), the residual localStorage entry is
 * dead state on machines that flipped it during the rollout. The
 * migration in `main.tsx` removes it on first boot.
 *
 * Why this test does not import `main.tsx` directly: that module
 * imports the entire app graph (router, every page module, theme
 * provider, query client, etc.) and calls `createRoot` at module load.
 * The codebase precedent for testing `main.tsx` behaviour is to
 * duplicate the small bit of logic under test rather than load the
 * full graph — see `workspace_settings_redirect.test.tsx` for the
 * same pattern. The duplicated snippet below MUST stay byte-equivalent
 * to the migration block in `main.tsx`; if the production code
 * changes, mirror the change here.
 */

const STORAGE_KEY = "flockctl.ui.next";

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

/**
 * Mirrors the migration block in `src/main.tsx`. Keep these in sync.
 */
function runMigration() {
  if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
    try {
      if (localStorage.getItem("flockctl.ui.next") !== null) {
        localStorage.removeItem("flockctl.ui.next");
      }
    } catch {
      // Storage disabled / quota errors are non-fatal — the flag will
      // simply linger until the storage backend recovers.
    }
  }
}

describe("main.tsx — flockctl.ui.next localStorage cleanup migration", () => {
  beforeEach(() => {
    store = {};
    Object.defineProperty(globalThis, "localStorage", {
      value: mockStorage,
      configurable: true,
      writable: true,
    });
  });

  it("removes a pre-existing flockctl.ui.next entry on first boot", () => {
    store[STORAGE_KEY] = "1";
    expect(mockStorage.getItem(STORAGE_KEY)).toBe("1");

    runMigration();

    expect(mockStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(STORAGE_KEY in store).toBe(false);
  });

  it("removes the entry regardless of stored value (truthy and falsy)", () => {
    for (const value of ["true", "false", "", "0", "{}"]) {
      store = { [STORAGE_KEY]: value };
      runMigration();
      expect(mockStorage.getItem(STORAGE_KEY)).toBeNull();
    }
  });

  it("is a no-op when the entry is absent", () => {
    expect(mockStorage.getItem(STORAGE_KEY)).toBeNull();
    const removeSpy = vi.spyOn(mockStorage, "removeItem");

    runMigration();

    expect(removeSpy).not.toHaveBeenCalled();
    expect(mockStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("is idempotent — running twice still leaves the entry removed", () => {
    store[STORAGE_KEY] = "stale";

    runMigration();
    runMigration();
    runMigration();

    expect(mockStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("does not touch unrelated localStorage entries", () => {
    store[STORAGE_KEY] = "stale";
    store["flockctl_sidebar_collapsed"] = '{"work":true}';
    store["flockctl.theme"] = "dark";
    store["other.app.flag"] = "keep";

    runMigration();

    expect(mockStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(mockStorage.getItem("flockctl_sidebar_collapsed")).toBe(
      '{"work":true}',
    );
    expect(mockStorage.getItem("flockctl.theme")).toBe("dark");
    expect(mockStorage.getItem("other.app.flag")).toBe("keep");
  });

  it("swallows storage exceptions (Safari private mode / quota) without throwing", () => {
    store[STORAGE_KEY] = "stale";
    const original = mockStorage.removeItem;
    mockStorage.removeItem = () => {
      throw new Error("SecurityError: storage disabled");
    };
    try {
      expect(() => runMigration()).not.toThrow();
    } finally {
      mockStorage.removeItem = original;
    }
  });

  it("survives a getItem that throws", () => {
    const original = mockStorage.getItem;
    mockStorage.getItem = () => {
      throw new Error("SecurityError");
    };
    try {
      expect(() => runMigration()).not.toThrow();
    } finally {
      mockStorage.getItem = original;
    }
  });
});
