import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useSelection } from "@/lib/use-selection";

/**
 * Contract tests for `useSelection`.
 *
 * The slug regex `/^[a-z0-9][a-z0-9-]{0,63}$/` is the ONLY validation layer
 * between query-string input and the values consumers render. The threat-model
 * gate test is `selection_url_params_reject_non_slug_format` — touch with care.
 */

function makeWrapper(initial: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>;
  };
}

function useSelectionAndLocation() {
  const sel = useSelection();
  const location = useLocation();
  return { ...sel, search: location.search, pathname: location.pathname };
}

describe("use_selection", () => {
  describe("URL → state precedence", () => {
    it("returns null for both ids when no params are present", () => {
      const { result } = renderHook(() => useSelection(), {
        wrapper: makeWrapper("/projects/p1"),
      });
      expect(result.current.milestoneId).toBeNull();
      expect(result.current.sliceId).toBeNull();
    });

    it("parses a valid milestone slug from the URL", () => {
      const { result } = renderHook(() => useSelection(), {
        wrapper: makeWrapper("/projects/p1?milestone=ms-01"),
      });
      expect(result.current.milestoneId).toBe("ms-01");
      expect(result.current.sliceId).toBeNull();
    });

    it("parses a valid slice slug from the URL", () => {
      const { result } = renderHook(() => useSelection(), {
        wrapper: makeWrapper("/projects/p1?slice=slice-00"),
      });
      expect(result.current.sliceId).toBe("slice-00");
      expect(result.current.milestoneId).toBeNull();
    });

    it("parses both params independently", () => {
      const { result } = renderHook(() => useSelection(), {
        wrapper: makeWrapper("/projects/p1?milestone=ms-01&slice=slice-00"),
      });
      expect(result.current.milestoneId).toBe("ms-01");
      expect(result.current.sliceId).toBe("slice-00");
    });

    it("accepts boundary-length slugs (1 char and 64 chars)", () => {
      const long = "a" + "b".repeat(63); // 64 chars total
      expect(long).toHaveLength(64);
      const { result } = renderHook(() => useSelection(), {
        wrapper: makeWrapper(`/projects/p1?milestone=a&slice=${long}`),
      });
      expect(result.current.milestoneId).toBe("a");
      expect(result.current.sliceId).toBe(long);
    });
  });

  // THIS IS THE THREAT-MODEL GATE — do not weaken without re-doing the
  // security review of every consumer that renders milestoneId / sliceId.
  describe("selection_url_params_reject_non_slug_format", () => {
    const cases: Array<[string, string]> = [
      ["empty string", ""],
      ["leading hyphen", "-leading"],
      ["uppercase", "Milestone-1"],
      ["unicode emoji", "%F0%9F%98%80"],
      ["angle-bracket injection", "%3Cscript%3Ealert(1)%3C%2Fscript%3E"],
      ["double-quote injection", "a%22onerror%3Dalert(1)"],
      ["space inside", "ms%201"],
      ["underscore (not allowed)", "ms_01"],
      ["dot (not allowed)", "ms.01"],
      ["slash (path traversal)", "ms%2F..%2Fetc"],
      ["null byte", "ms%00"],
      ["65 chars (too long)", "a" + "b".repeat(64)],
      ["very long string", "a".repeat(500)],
      ["whitespace only", "%20%20"],
    ];

    for (const [label, raw] of cases) {
      it(`rejects ${label} — milestone`, () => {
        const { result } = renderHook(() => useSelection(), {
          wrapper: makeWrapper(`/projects/p1?milestone=${raw}`),
        });
        expect(result.current.milestoneId).toBeNull();
      });
      it(`rejects ${label} — slice`, () => {
        const { result } = renderHook(() => useSelection(), {
          wrapper: makeWrapper(`/projects/p1?slice=${raw}`),
        });
        expect(result.current.sliceId).toBeNull();
      });
    }
  });

  describe("setMilestone / setSlice", () => {
    it("setMilestone writes a valid slug to the URL", () => {
      const { result } = renderHook(() => useSelectionAndLocation(), {
        wrapper: makeWrapper("/projects/p1"),
      });

      act(() => {
        result.current.setMilestone("ms-01");
      });

      expect(result.current.milestoneId).toBe("ms-01");
      expect(result.current.search).toContain("milestone=ms-01");
    });

    it("setSlice writes a valid slug to the URL", () => {
      const { result } = renderHook(() => useSelectionAndLocation(), {
        wrapper: makeWrapper("/projects/p1"),
      });

      act(() => {
        result.current.setSlice("slice-00");
      });

      expect(result.current.sliceId).toBe("slice-00");
      expect(result.current.search).toContain("slice=slice-00");
    });

    it("setMilestone(null) removes the param", () => {
      const { result } = renderHook(() => useSelectionAndLocation(), {
        wrapper: makeWrapper("/projects/p1?milestone=ms-01&slice=slice-00"),
      });

      act(() => {
        result.current.setMilestone(null);
      });

      expect(result.current.milestoneId).toBeNull();
      expect(result.current.search).not.toContain("milestone=");
      // Sibling slice param survives.
      expect(result.current.sliceId).toBe("slice-00");
      expect(result.current.search).toContain("slice=slice-00");
    });

    it("setSlice(null) removes only the slice param", () => {
      const { result } = renderHook(() => useSelectionAndLocation(), {
        wrapper: makeWrapper("/projects/p1?milestone=ms-01&slice=slice-00"),
      });

      act(() => {
        result.current.setSlice(null);
      });

      expect(result.current.sliceId).toBeNull();
      expect(result.current.search).not.toContain("slice=");
      expect(result.current.milestoneId).toBe("ms-01");
    });

    it("strips an invalid param on the next setter call", () => {
      const { result } = renderHook(() => useSelectionAndLocation(), {
        wrapper: makeWrapper("/projects/p1?milestone=%3Cscript%3E"),
      });
      // Read path: garbage → null.
      expect(result.current.milestoneId).toBeNull();

      // Setter overwrites the garbage, leaving the URL clean.
      act(() => {
        result.current.setMilestone("ms-01");
      });
      expect(result.current.milestoneId).toBe("ms-01");
      expect(result.current.search).toContain("milestone=ms-01");
      expect(result.current.search).not.toContain("script");

      // Setting null after that fully removes the param.
      act(() => {
        result.current.setMilestone(null);
      });
      expect(result.current.milestoneId).toBeNull();
      expect(result.current.search).not.toContain("milestone=");
    });

    it("ignores attempts to set an invalid slug via the setter", () => {
      const { result } = renderHook(() => useSelectionAndLocation(), {
        wrapper: makeWrapper("/projects/p1?milestone=ms-01"),
      });

      act(() => {
        result.current.setMilestone("<script>");
      });

      // Garbage rejected → behaves like setMilestone(null).
      expect(result.current.milestoneId).toBeNull();
      expect(result.current.search).not.toContain("script");
      expect(result.current.search).not.toContain("milestone=");
    });

    it("preserves unrelated query params when toggling selection", () => {
      const { result } = renderHook(() => useSelectionAndLocation(), {
        wrapper: makeWrapper("/projects/p1?view=board&milestone=ms-01"),
      });

      act(() => {
        result.current.setSlice("slice-00");
      });

      expect(result.current.search).toContain("view=board");
      expect(result.current.search).toContain("milestone=ms-01");
      expect(result.current.search).toContain("slice=slice-00");
    });

    it("does not change the pathname (no reload / no navigation)", () => {
      const { result } = renderHook(() => useSelectionAndLocation(), {
        wrapper: makeWrapper("/projects/p1"),
      });
      const before = result.current.pathname;

      act(() => {
        result.current.setMilestone("ms-01");
      });
      act(() => {
        result.current.setSlice("slice-00");
      });

      expect(result.current.pathname).toBe(before);
    });

    it("setMilestone and setSlice are referentially stable across renders", () => {
      const { result, rerender } = renderHook(() => useSelection(), {
        wrapper: makeWrapper("/projects/p1"),
      });
      const m1 = result.current.setMilestone;
      const s1 = result.current.setSlice;
      rerender();
      expect(result.current.setMilestone).toBe(m1);
      expect(result.current.setSlice).toBe(s1);
    });
  });
});
