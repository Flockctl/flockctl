import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

import {
  RangeFilter,
  useAnalyticsRange,
} from "@/pages/analytics-components/RangeFilter";

/**
 * Unit tests for {@link RangeFilter} (M25 analytics slice — T01).
 *
 * Contract (per slice 25-02 task 01):
 *   - Renders a `radiogroup` with the four required options
 *     (24h / 7d / 30d / all) and the literal labels from the prototype.
 *   - Default value is "7d" when ?range= is absent. (Distinct from the
 *     dashboard's TimeRangeSelect which defaults to "24h".)
 *   - URL precedence: a valid `?range=` value wins.
 *   - Invalid values fall back to the default and emit console.warn.
 *   - Clicking a segment writes `?range=` (replace, preserves siblings)
 *     and fires the `onChange` callback with the validated value.
 *   - The companion `useAnalyticsRange` hook resolves the same way.
 */

function LocationSpy() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderAt(initialEntries: string[], ui: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              {ui}
              <LocationSpy />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RangeFilter / rendering", () => {
  it("renders a radiogroup with the four required options in order", () => {
    renderAt(["/"], <RangeFilter />);
    const group = screen.getByTestId("analytics-range-filter");
    expect(group.getAttribute("role")).toBe("radiogroup");
    const options = Array.from(
      group.querySelectorAll<HTMLButtonElement>("button[role='radio']"),
    ).map((b) => ({
      value: b.getAttribute("data-value"),
      label: b.textContent,
    }));
    expect(options).toEqual([
      { value: "24h", label: "24h" },
      { value: "7d", label: "7d" },
      { value: "30d", label: "30d" },
      { value: "all", label: "All" },
    ]);
  });

  it("exposes an accessible name (defaults to 'Date range')", () => {
    renderAt(["/"], <RangeFilter />);
    expect(screen.getByLabelText("Date range")).toBeInTheDocument();
  });

  it("respects an aria-label override", () => {
    renderAt(["/"], <RangeFilter aria-label="Window" />);
    expect(screen.getByLabelText("Window")).toBeInTheDocument();
  });

  it("merges a caller-provided className onto the wrapper", () => {
    renderAt(["/"], <RangeFilter className="ml-2 custom-class" />);
    const group = screen.getByTestId("analytics-range-filter");
    expect(group.className).toContain("ml-2");
    expect(group.className).toContain("custom-class");
  });
});

describe("RangeFilter / value resolution", () => {
  it("defaults to 7d when ?range= is absent", () => {
    renderAt(["/"], <RangeFilter />);
    const checked = screen
      .getByTestId("analytics-range-filter")
      .querySelector<HTMLButtonElement>("button[aria-checked='true']");
    expect(checked?.getAttribute("data-value")).toBe("7d");
  });

  it("reads ?range=24h from the URL", () => {
    renderAt(["/?range=24h"], <RangeFilter />);
    const checked = screen
      .getByTestId("analytics-range-filter")
      .querySelector<HTMLButtonElement>("button[aria-checked='true']");
    expect(checked?.getAttribute("data-value")).toBe("24h");
  });

  it("reads ?range=30d from the URL", () => {
    renderAt(["/?range=30d"], <RangeFilter />);
    const checked = screen
      .getByTestId("analytics-range-filter")
      .querySelector<HTMLButtonElement>("button[aria-checked='true']");
    expect(checked?.getAttribute("data-value")).toBe("30d");
  });

  it("reads ?range=all from the URL", () => {
    renderAt(["/?range=all"], <RangeFilter />);
    const checked = screen
      .getByTestId("analytics-range-filter")
      .querySelector<HTMLButtonElement>("button[aria-checked='true']");
    expect(checked?.getAttribute("data-value")).toBe("all");
  });

  describe("invalid input", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("falls back to 7d on an unknown value", () => {
      renderAt(["/?range=1y"], <RangeFilter />);
      const checked = screen
        .getByTestId("analytics-range-filter")
        .querySelector<HTMLButtonElement>("button[aria-checked='true']");
      expect(checked?.getAttribute("data-value")).toBe("7d");
      expect(warnSpy).toHaveBeenCalledOnce();
    });

    it("falls back to 7d on an empty value", () => {
      renderAt(["/?range="], <RangeFilter />);
      const checked = screen
        .getByTestId("analytics-range-filter")
        .querySelector<HTMLButtonElement>("button[aria-checked='true']");
      expect(checked?.getAttribute("data-value")).toBe("7d");
      expect(warnSpy).toHaveBeenCalledOnce();
    });

    it("falls back on an XSS-shaped value", () => {
      renderAt(
        ["/?range=%3Cscript%3Ealert(1)%3C%2Fscript%3E"],
        <RangeFilter />,
      );
      const checked = screen
        .getByTestId("analytics-range-filter")
        .querySelector<HTMLButtonElement>("button[aria-checked='true']");
      expect(checked?.getAttribute("data-value")).toBe("7d");
      expect(warnSpy).toHaveBeenCalledOnce();
    });

    it("does NOT warn when the param is absent (default path)", () => {
      renderAt(["/"], <RangeFilter />);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

describe("RangeFilter / change", () => {
  it("writes ?range= when the operator picks a new value", () => {
    renderAt(["/"], <RangeFilter />);
    const button = screen
      .getByTestId("analytics-range-filter")
      .querySelector<HTMLButtonElement>("button[data-value='30d']");
    fireEvent.click(button!);
    expect(screen.getByTestId("location")).toHaveTextContent("range=30d");
  });

  it("preserves unrelated query params", () => {
    renderAt(["/?other=abc"], <RangeFilter />);
    const button = screen
      .getByTestId("analytics-range-filter")
      .querySelector<HTMLButtonElement>("button[data-value='all']");
    fireEvent.click(button!);
    const loc = screen.getByTestId("location").textContent ?? "";
    expect(loc).toContain("other=abc");
    expect(loc).toContain("range=all");
  });

  it("invokes the onChange callback with the validated next value", () => {
    const onChange = vi.fn();
    renderAt(["/"], <RangeFilter onChange={onChange} />);
    const button = screen
      .getByTestId("analytics-range-filter")
      .querySelector<HTMLButtonElement>("button[data-value='24h']");
    fireEvent.click(button!);
    expect(onChange).toHaveBeenCalledWith("24h");
  });

  it("does NOT fire onChange when re-clicking the active segment", () => {
    const onChange = vi.fn();
    renderAt(["/?range=7d"], <RangeFilter onChange={onChange} />);
    const button = screen
      .getByTestId("analytics-range-filter")
      .querySelector<HTMLButtonElement>("button[data-value='7d']");
    fireEvent.click(button!);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("useAnalyticsRange (companion hook)", () => {
  function Probe() {
    const range = useAnalyticsRange();
    return <div data-testid="probe">{range}</div>;
  }

  it("returns 7d by default", () => {
    renderAt(["/"], <Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("7d");
  });

  it("returns the URL value when valid", () => {
    renderAt(["/?range=30d"], <Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("30d");
  });

  it("returns 'all' when ?range=all", () => {
    renderAt(["/?range=all"], <Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("all");
  });

  it("falls back to 7d when invalid", () => {
    renderAt(["/?range=bogus"], <Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("7d");
  });
});
