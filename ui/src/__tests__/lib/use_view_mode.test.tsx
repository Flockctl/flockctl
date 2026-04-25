import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useViewMode, type ViewMode } from "@/lib/use-view-mode";

// --- localStorage mock --------------------------------------------------------
// Other test files (server-store) swap `globalThis.localStorage` with custom
// objects and don't restore them, so file order matters. Install our own mock
// per test for deterministic behaviour either way.
let store: Record<string, string>;
let throwOnSet = false;
let throwOnGet = false;
const mockStorage = {
  getItem: (k: string) => {
    if (throwOnGet) throw new Error("SecurityError");
    return k in store ? store[k] : null;
  },
  setItem: (k: string, v: string) => {
    if (throwOnSet) throw new Error("quota");
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

function installStorage() {
  store = {};
  throwOnSet = false;
  throwOnGet = false;
  Object.defineProperty(globalThis, "localStorage", {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
}

// --- Router wrapper -----------------------------------------------------------

function makeWrapper(initial: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>;
  };
}

// Tiny compound hook for assertions that care about URL side effects.
function useViewModeAndLocation(projectId?: string) {
  const [mode, setMode] = useViewMode(projectId);
  const location = useLocation();
  return { mode, setMode, search: location.search, pathname: location.pathname };
}

describe("use_view_mode", () => {
  beforeEach(() => {
    installStorage();
  });

  describe("precedence: URL > localStorage > default", () => {
    it("defaults to 'tree' with no URL and no storage", () => {
      const { result } = renderHook(() => useViewMode(), {
        wrapper: makeWrapper("/projects/abc"),
      });
      expect(result.current[0]).toBe<ViewMode>("tree");
    });

    it("returns the URL mode when it is in the allow-list", () => {
      const { result } = renderHook(() => useViewMode(), {
        wrapper: makeWrapper("/projects/abc?view=board"),
      });
      expect(result.current[0]).toBe<ViewMode>("board");
    });

    it("falls back to localStorage when URL is absent", () => {
      store["flockctl.viewMode.p1"] = "swimlane";
      const { result } = renderHook(() => useViewMode("p1"), {
        wrapper: makeWrapper("/projects/p1"),
      });
      expect(result.current[0]).toBe<ViewMode>("swimlane");
    });

    it("URL beats localStorage when both are valid", () => {
      store["flockctl.viewMode.p1"] = "swimlane";
      const { result } = renderHook(() => useViewMode("p1"), {
        wrapper: makeWrapper("/projects/p1?view=board"),
      });
      expect(result.current[0]).toBe<ViewMode>("board");
    });

    it("uses a per-project storage key", () => {
      store["flockctl.viewMode.alpha"] = "board";
      store["flockctl.viewMode.beta"] = "swimlane";
      const alpha = renderHook(() => useViewMode("alpha"), {
        wrapper: makeWrapper("/projects/alpha"),
      });
      const beta = renderHook(() => useViewMode("beta"), {
        wrapper: makeWrapper("/projects/beta"),
      });
      expect(alpha.result.current[0]).toBe("board");
      expect(beta.result.current[0]).toBe("swimlane");
    });

    it("uses a global storage key when no projectId is given", () => {
      store["flockctl.viewMode"] = "board";
      const { result } = renderHook(() => useViewMode(), {
        wrapper: makeWrapper("/projects/abc"),
      });
      expect(result.current[0]).toBe("board");
    });
  });

  describe("allow-list rejection", () => {
    it("rejects an XSS-ish view param and falls back to default", () => {
      const { result } = renderHook(() => useViewMode(), {
        wrapper: makeWrapper("/projects/abc?view=alert(1)"),
      });
      expect(result.current[0]).toBe<ViewMode>("tree");
    });

    it("treats an empty string view param as absent", () => {
      store["flockctl.viewMode"] = "swimlane";
      const { result } = renderHook(() => useViewMode(), {
        wrapper: makeWrapper("/projects/abc?view="),
      });
      // empty string is invalid → fall through to localStorage
      expect(result.current[0]).toBe<ViewMode>("swimlane");
    });

    it("rejects unicode / garbage view param", () => {
      const { result } = renderHook(() => useViewMode(), {
        wrapper: makeWrapper("/projects/abc?view=%F0%9F%98%80"),
      });
      expect(result.current[0]).toBe<ViewMode>("tree");
    });

    it("rejects a value that only differs by case ('Board' != 'board')", () => {
      const { result } = renderHook(() => useViewMode(), {
        wrapper: makeWrapper("/projects/abc?view=Board"),
      });
      expect(result.current[0]).toBe<ViewMode>("tree");
    });

    it("rejects an invalid value stored in localStorage", () => {
      store["flockctl.viewMode"] = "grid-view";
      const { result } = renderHook(() => useViewMode(), {
        wrapper: makeWrapper("/projects/abc"),
      });
      expect(result.current[0]).toBe<ViewMode>("tree");
    });
  });

  describe("setMode", () => {
    it("updates URL and localStorage in the same tick", () => {
      const { result } = renderHook(() => useViewModeAndLocation("p1"), {
        wrapper: makeWrapper("/projects/p1"),
      });
      expect(result.current.mode).toBe("tree");

      act(() => {
        result.current.setMode("board");
      });

      expect(result.current.mode).toBe("board");
      expect(result.current.search).toContain("view=board");
      expect(store["flockctl.viewMode.p1"]).toBe("board");
    });

    it("preserves unrelated query params when switching", () => {
      const { result } = renderHook(() => useViewModeAndLocation(), {
        wrapper: makeWrapper("/projects/abc?milestone=42&view=tree"),
      });

      act(() => {
        result.current.setMode("board");
      });

      expect(result.current.search).toContain("milestone=42");
      expect(result.current.search).toContain("view=board");
    });

    it("does not change the pathname (no reload / no navigation)", () => {
      const { result } = renderHook(() => useViewModeAndLocation(), {
        wrapper: makeWrapper("/projects/abc"),
      });
      const before = result.current.pathname;

      act(() => {
        result.current.setMode("swimlane");
      });

      expect(result.current.pathname).toBe(before);
    });

    it("ignores attempts to set a mode outside the allow-list", () => {
      const { result } = renderHook(() => useViewModeAndLocation(), {
        wrapper: makeWrapper("/projects/abc"),
      });

      act(() => {
        // @ts-expect-error — runtime guard test
        result.current.setMode("garbage");
      });

      expect(result.current.mode).toBe("tree");
      expect(result.current.search).not.toContain("view=garbage");
      expect(store["flockctl.viewMode"]).toBeUndefined();
    });

    it("is referentially stable across renders so consumers can dep-array it", () => {
      const { result, rerender } = renderHook(() => useViewMode("p1"), {
        wrapper: makeWrapper("/projects/p1"),
      });
      const first = result.current[1];
      rerender();
      const second = result.current[1];
      expect(first).toBe(second);
    });

    it("survives localStorage.setItem throwing (private mode / quota)", () => {
      const { result } = renderHook(() => useViewModeAndLocation(), {
        wrapper: makeWrapper("/projects/abc"),
      });

      throwOnSet = true;
      expect(() => {
        act(() => {
          result.current.setMode("board");
        });
      }).not.toThrow();

      // URL still reflects the change
      expect(result.current.search).toContain("view=board");
      expect(result.current.mode).toBe("board");
    });

    it("survives localStorage.getItem throwing when resolving initial mode", () => {
      throwOnGet = true;
      expect(() => {
        renderHook(() => useViewMode("p1"), {
          wrapper: makeWrapper("/projects/p1"),
        });
      }).not.toThrow();
    });
  });
});
