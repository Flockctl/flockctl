import { describe, it, expect, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useViewMode, type ViewMode } from "@/lib/use-view-mode";

/**
 * Contract tests for `useViewMode`.
 *
 * The hook is the keystone of milestone 09's URL-backed view-mode state
 * machine — every slice (toggle UI, board view, swimlane stub, …) reads
 * through it, so its four-way contract is what we guard here:
 *
 *   1. default             — no URL, no storage → `'tree'`
 *   2. URL precedence      — `?view=board` → `'board'`
 *   3. localStorage fallback — empty URL + stored mode → stored mode
 *   4. invalid rejection   — XSS / unicode / wrong case → default
 *
 * A separate exhaustive suite lives next to the hook file and covers setMode
 * + persistence edge cases; this file is deliberately minimal so
 * `npm run test -- --run 'use-view-mode'` gives a fast contract smoke test.
 */

// Per-test localStorage mock. Other UI test files (e.g. server-store) swap
// `globalThis.localStorage` out without restoring it, so we reinstall our own
// mock in every `beforeEach` instead of relying on whatever leaked in before.
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

function installStorage() {
  store = {};
  Object.defineProperty(globalThis, "localStorage", {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
}

function makeWrapper(initial: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(MemoryRouter, { initialEntries: [initial] }, children);
  };
}

describe("use-view-mode contract", () => {
  beforeEach(() => {
    installStorage();
  });

  it("defaults to 'tree' when there is no URL param and no stored value", () => {
    const { result } = renderHook(() => useViewMode(), {
      wrapper: makeWrapper("/projects/p1"),
    });
    expect(result.current[0]).toBe<ViewMode>("tree");
  });

  it("returns the URL mode when '?view=' is in the allow-list", () => {
    const { result } = renderHook(() => useViewMode(), {
      wrapper: makeWrapper("/projects/p1?view=board"),
    });
    expect(result.current[0]).toBe<ViewMode>("board");
  });

  it("falls back to localStorage when the URL has no view param", () => {
    // Per-project scoping — use the same projectId the hook is given so the
    // key matches `${STORAGE_KEY_PREFIX}.${projectId}`.
    store["flockctl.viewMode.p1"] = "swimlane";
    const { result } = renderHook(() => useViewMode("p1"), {
      wrapper: makeWrapper("/projects/p1"),
    });
    expect(result.current[0]).toBe<ViewMode>("swimlane");
  });

  it("rejects invalid URL params (XSS, unicode, wrong case) and falls back to default", () => {
    // Classic script-injection shape — must not end up in the DOM or the
    // returned mode.
    const xss = renderHook(() => useViewMode(), {
      wrapper: makeWrapper("/projects/p1?view=%3Cscript%3Ealert(1)%3C%2Fscript%3E"),
    });
    expect(xss.result.current[0]).toBe<ViewMode>("tree");

    // Unicode smiley — also outside the allow-list.
    const unicode = renderHook(() => useViewMode(), {
      wrapper: makeWrapper("/projects/p1?view=%F0%9F%98%80"),
    });
    expect(unicode.result.current[0]).toBe<ViewMode>("tree");

    // Case matters — 'Board' is not 'board'.
    const wrongCase = renderHook(() => useViewMode(), {
      wrapper: makeWrapper("/projects/p1?view=Board"),
    });
    expect(wrongCase.result.current[0]).toBe<ViewMode>("tree");
  });
});
