import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

import {
  TimeRangeSelect,
  useTimeRange,
} from "@/pages/dashboard-components/TimeRangeSelect";

/**
 * Unit tests for {@link TimeRangeSelect}.
 *
 * Contract:
 *   - Renders a native <select> with the three required options
 *     (24h / 7d / 30d) and the literal labels from the brief.
 *   - Default value is "24h" when ?range= is absent.
 *   - URL precedence: a valid `?range=` value wins.
 *   - Invalid values fall back to the default and emit console.warn.
 *   - Changing the select writes `?range=` (replace, preserves siblings)
 *     and fires the `onChange` callback with the validated value.
 *   - The companion `useTimeRange` hook resolves the same way.
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

describe("TimeRangeSelect / rendering", () => {
  it("renders a native <select> with the three required options in order", () => {
    renderAt(["/"], <TimeRangeSelect />);
    const select = screen.getByTestId("time-range-select");
    expect(select.tagName).toBe("SELECT");
    const options = Array.from(select.querySelectorAll("option")).map((o) => ({
      value: o.value,
      label: o.textContent,
    }));
    expect(options).toEqual([
      { value: "24h", label: "Last 24 hours" },
      { value: "7d", label: "Last 7 days" },
      { value: "30d", label: "Last 30 days" },
    ]);
  });

  it("applies the spec class list (border, padding, rounded, text size)", () => {
    renderAt(["/"], <TimeRangeSelect />);
    const select = screen.getByTestId("time-range-select");
    const cls = select.className;
    expect(cls).toContain("px-2.5");
    expect(cls).toContain("py-1.5");
    expect(cls).toContain("border");
    expect(cls).toContain("rounded");
    expect(cls).toContain("text-[12.5px]");
    expect(cls).toContain("outline-none");
  });

  it("merges a caller-provided className", () => {
    renderAt(["/"], <TimeRangeSelect className="ml-2 custom-class" />);
    const select = screen.getByTestId("time-range-select");
    expect(select.className).toContain("ml-2");
    expect(select.className).toContain("custom-class");
  });

  it("exposes an accessible name (defaults to 'Time range')", () => {
    renderAt(["/"], <TimeRangeSelect />);
    expect(screen.getByLabelText("Time range")).toBeInTheDocument();
  });

  it("respects an aria-label override", () => {
    renderAt(["/"], <TimeRangeSelect aria-label="Window" />);
    expect(screen.getByLabelText("Window")).toBeInTheDocument();
  });
});

describe("TimeRangeSelect / value resolution", () => {
  it("defaults to 24h when ?range= is absent", () => {
    renderAt(["/"], <TimeRangeSelect />);
    const select = screen.getByTestId("time-range-select") as HTMLSelectElement;
    expect(select.value).toBe("24h");
  });

  it("reads ?range=7d from the URL", () => {
    renderAt(["/?range=7d"], <TimeRangeSelect />);
    const select = screen.getByTestId("time-range-select") as HTMLSelectElement;
    expect(select.value).toBe("7d");
  });

  it("reads ?range=30d from the URL", () => {
    renderAt(["/?range=30d"], <TimeRangeSelect />);
    const select = screen.getByTestId("time-range-select") as HTMLSelectElement;
    expect(select.value).toBe("30d");
  });

  describe("invalid input", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("falls back to 24h on an unknown value", () => {
      renderAt(["/?range=1y"], <TimeRangeSelect />);
      const select = screen.getByTestId(
        "time-range-select",
      ) as HTMLSelectElement;
      expect(select.value).toBe("24h");
      expect(warnSpy).toHaveBeenCalledOnce();
    });

    it("falls back to 24h on an empty value", () => {
      renderAt(["/?range="], <TimeRangeSelect />);
      const select = screen.getByTestId(
        "time-range-select",
      ) as HTMLSelectElement;
      expect(select.value).toBe("24h");
      expect(warnSpy).toHaveBeenCalledOnce();
    });

    it("falls back on an XSS-shaped value without warning twice", () => {
      renderAt(
        ["/?range=%3Cscript%3Ealert(1)%3C%2Fscript%3E"],
        <TimeRangeSelect />,
      );
      const select = screen.getByTestId(
        "time-range-select",
      ) as HTMLSelectElement;
      expect(select.value).toBe("24h");
      expect(warnSpy).toHaveBeenCalledOnce();
    });

    it("does NOT warn when the param is absent (default path)", () => {
      renderAt(["/"], <TimeRangeSelect />);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

describe("TimeRangeSelect / change", () => {
  it("writes ?range= when the operator picks a new value", () => {
    renderAt(["/"], <TimeRangeSelect />);
    const select = screen.getByTestId("time-range-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "7d" } });
    expect(screen.getByTestId("location")).toHaveTextContent("range=7d");
  });

  it("preserves unrelated query params", () => {
    renderAt(["/?other=abc"], <TimeRangeSelect />);
    const select = screen.getByTestId("time-range-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "30d" } });
    const loc = screen.getByTestId("location").textContent ?? "";
    expect(loc).toContain("other=abc");
    expect(loc).toContain("range=30d");
  });

  it("invokes the onChange callback with the validated next value", () => {
    const onChange = vi.fn();
    renderAt(["/"], <TimeRangeSelect onChange={onChange} />);
    const select = screen.getByTestId("time-range-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "30d" } });
    expect(onChange).toHaveBeenCalledWith("30d");
  });
});

describe("useTimeRange (companion hook)", () => {
  function Probe() {
    const range = useTimeRange();
    return <div data-testid="probe">{range}</div>;
  }

  it("returns 24h by default", () => {
    renderAt(["/"], <Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("24h");
  });

  it("returns the URL value when valid", () => {
    renderAt(["/?range=7d"], <Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("7d");
  });

  it("falls back to 24h when invalid", () => {
    renderAt(["/?range=bogus"], <Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("24h");
  });
});
