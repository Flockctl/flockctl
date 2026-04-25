import { describe, it, expect } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import {
  useWorkspaceTab,
  type WorkspaceTab,
} from "@/lib/use-workspace-tab";

/**
 * Contract tests for `useWorkspaceTab`.
 *
 * The hook is a URL-backed tab selector for the workspace detail page.
 * Source of truth is `?tab=` on the URL; anything outside the allow-list
 * silently resolves to `'plan'`.
 *
 *   1. default          — no URL param → `'plan'`
 *   2. URL precedence   — `?tab=runs` → `'runs'` (and every other allowed
 *                         value round-trips)
 *   3. invalid fallback — XSS / unicode / wrong case / empty → `'plan'`
 *   4. setTab           — writes the param, preserves other query params,
 *                         stable reference across renders
 */

function makeWrapper(initial: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(MemoryRouter, { initialEntries: [initial] }, children);
  };
}

describe("use-workspace-tab contract", () => {
  it("defaults to 'plan' when there is no ?tab= param", () => {
    const { result } = renderHook(() => useWorkspaceTab(), {
      wrapper: makeWrapper("/workspaces/w1"),
    });
    expect(result.current[0]).toBe<WorkspaceTab>("plan");
  });

  it("returns each allowed tab when present in the URL", () => {
    const cases: WorkspaceTab[] = ["plan", "runs", "templates", "config"];
    for (const value of cases) {
      const { result } = renderHook(() => useWorkspaceTab(), {
        wrapper: makeWrapper(`/workspaces/w1?tab=${value}`),
      });
      expect(result.current[0]).toBe<WorkspaceTab>(value);
    }
  });

  it("rejects invalid ?tab= values (XSS, unicode, wrong case, empty) and falls back to 'plan'", () => {
    // Empty string: `?tab=` — explicitly set but empty.
    const empty = renderHook(() => useWorkspaceTab(), {
      wrapper: makeWrapper("/workspaces/w1?tab="),
    });
    expect(empty.result.current[0]).toBe<WorkspaceTab>("plan");

    // Classic script-injection shape.
    const xss = renderHook(() => useWorkspaceTab(), {
      wrapper: makeWrapper(
        "/workspaces/w1?tab=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
      ),
    });
    expect(xss.result.current[0]).toBe<WorkspaceTab>("plan");

    // Unicode smiley — outside the allow-list.
    const unicode = renderHook(() => useWorkspaceTab(), {
      wrapper: makeWrapper("/workspaces/w1?tab=%F0%9F%98%80"),
    });
    expect(unicode.result.current[0]).toBe<WorkspaceTab>("plan");

    // Case matters — 'Plan' is not 'plan'.
    const wrongCase = renderHook(() => useWorkspaceTab(), {
      wrapper: makeWrapper("/workspaces/w1?tab=Plan"),
    });
    expect(wrongCase.result.current[0]).toBe<WorkspaceTab>("plan");

    // Adjacent-but-unknown value.
    const unknown = renderHook(() => useWorkspaceTab(), {
      wrapper: makeWrapper("/workspaces/w1?tab=settings"),
    });
    expect(unknown.result.current[0]).toBe<WorkspaceTab>("plan");
  });

  it("setTab writes the ?tab= param and preserves other query params", () => {
    // Spy hook: renders alongside the hook under test so we can inspect
    // the router's search-param state after the setter fires.
    function useBoth() {
      const [tab, setTab] = useWorkspaceTab();
      const [params] = useSearchParams();
      return { tab, setTab, params };
    }

    const { result } = renderHook(() => useBoth(), {
      wrapper: makeWrapper("/workspaces/w1?focus=slice-42&tab=plan"),
    });

    expect(result.current.tab).toBe<WorkspaceTab>("plan");
    expect(result.current.params.get("focus")).toBe("slice-42");

    act(() => {
      result.current.setTab("runs");
    });

    expect(result.current.tab).toBe<WorkspaceTab>("runs");
    expect(result.current.params.get("tab")).toBe("runs");
    // Merge — not replace — so `focus` must still be on the URL.
    expect(result.current.params.get("focus")).toBe("slice-42");
  });

  it("setTab keeps a stable reference across renders", () => {
    const { result, rerender } = renderHook(() => useWorkspaceTab(), {
      wrapper: makeWrapper("/workspaces/w1"),
    });
    const first = result.current[1];
    rerender();
    expect(result.current[1]).toBe(first);
  });

  it("setTab ignores invalid values at runtime", () => {
    const { result } = renderHook(() => useWorkspaceTab(), {
      wrapper: makeWrapper("/workspaces/w1"),
    });
    act(() => {
      // Cast around the type guard to simulate a caller passing junk.
      (result.current[1] as (t: string) => void)("not-a-tab");
    });
    expect(result.current[0]).toBe<WorkspaceTab>("plan");
  });
});
