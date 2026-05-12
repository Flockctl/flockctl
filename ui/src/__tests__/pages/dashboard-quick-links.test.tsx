import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

import { QuickLinks } from "@/pages/dashboard-components/QuickLinks";

/**
 * Unit tests for the QuickLinks card (slice 23-01 T04).
 *
 * Coverage:
 *   - happy path renders the three rows in order with the correct
 *     labels and navigation targets;
 *   - the primary project row interpolates the project name + slug;
 *   - negative case: no primary project hides the Code-mode row (per
 *     slice negative_test);
 *   - each row exposes the hover styling tokens the spec calls for
 *     (`hover:bg-zinc-100`, `dark:hover:bg-zinc-800`) and renders a
 *     trailing chevron.
 */

function renderInRouter(ui: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={ui} />
        <Route path="*" element={<LocationSpy />} />
      </Routes>
    </MemoryRouter>,
  );
}

function LocationSpy() {
  const loc = useLocation();
  return <div data-testid="navigated-to">{loc.pathname + loc.search}</div>;
}

describe("QuickLinks / happy path", () => {
  it("renders all three rows when a primary project is provided", () => {
    renderInRouter(
      <QuickLinks
        primaryProject={{ slug: "my-app", name: "my-app" }}
        attentionCount={5}
      />,
    );

    expect(screen.getByTestId("quick-links-header")).toBeTruthy();
    expect(screen.getByTestId("quick-links-row-code").textContent).toBe(
      "Open my-app in Code mode",
    );
    expect(screen.getByTestId("quick-links-row-attention").textContent).toBe(
      "5 items need attention",
    );
    expect(screen.getByTestId("quick-links-row-analytics").textContent).toBe(
      "Spend by model",
    );
  });

  it("interpolates the project name into the Code-mode label", () => {
    renderInRouter(
      <QuickLinks
        primaryProject={{ slug: "flockctl", name: "Flockctl Daemon" }}
        attentionCount={0}
      />,
    );
    expect(screen.getByTestId("quick-links-row-code").textContent).toBe(
      "Open Flockctl Daemon in Code mode",
    );
  });

  it("renders attentionCount=0 verbatim ('0 items need attention')", () => {
    renderInRouter(
      <QuickLinks
        primaryProject={{ slug: "my-app", name: "my-app" }}
        attentionCount={0}
      />,
    );
    expect(screen.getByTestId("quick-links-row-attention").textContent).toBe(
      "0 items need attention",
    );
  });
});

describe("QuickLinks / navigation", () => {
  it("Code-mode row navigates to /projects/{slug}?tab=code", () => {
    renderInRouter(
      <QuickLinks
        primaryProject={{ slug: "my-app", name: "my-app" }}
        attentionCount={5}
      />,
    );
    fireEvent.click(screen.getByTestId("quick-links-row-code"));
    expect(screen.getByTestId("navigated-to").textContent).toBe(
      "/projects/my-app?tab=code",
    );
  });

  it("Attention row navigates to /attention", () => {
    renderInRouter(
      <QuickLinks
        primaryProject={{ slug: "my-app", name: "my-app" }}
        attentionCount={5}
      />,
    );
    fireEvent.click(screen.getByTestId("quick-links-row-attention"));
    expect(screen.getByTestId("navigated-to").textContent).toBe("/attention");
  });

  it("Analytics row navigates to /analytics?view=by-model", () => {
    renderInRouter(
      <QuickLinks
        primaryProject={{ slug: "my-app", name: "my-app" }}
        attentionCount={5}
      />,
    );
    fireEvent.click(screen.getByTestId("quick-links-row-analytics"));
    expect(screen.getByTestId("navigated-to").textContent).toBe(
      "/analytics?view=by-model",
    );
  });
});

describe("QuickLinks / negative case — no primary project", () => {
  it("hides the Code-mode row when primaryProject is omitted", () => {
    renderInRouter(<QuickLinks attentionCount={3} />);

    // The two static rows are still present.
    expect(screen.getByTestId("quick-links-row-attention")).toBeTruthy();
    expect(screen.getByTestId("quick-links-row-analytics")).toBeTruthy();

    // The Code-mode row is gone entirely.
    expect(screen.queryByTestId("quick-links-row-code")).toBeNull();
  });
});

describe("QuickLinks / row styling", () => {
  it("each row carries the spec'd hover background classes + chevron", () => {
    renderInRouter(
      <QuickLinks
        primaryProject={{ slug: "my-app", name: "my-app" }}
        attentionCount={1}
      />,
    );

    const ids = [
      "quick-links-row-code",
      "quick-links-row-attention",
      "quick-links-row-analytics",
    ];
    for (const id of ids) {
      const btn = screen.getByTestId(id);
      // Hover tokens from the spec.
      expect(btn.className).toContain("hover:bg-zinc-100");
      expect(btn.className).toContain("dark:hover:bg-zinc-800");
      // Full-width row, justify-between for the chevron tail.
      expect(btn.className).toContain("w-full");
      expect(btn.className).toContain("justify-between");
      // Chevron icon present (lucide renders an <svg>).
      expect(btn.querySelector("svg")).not.toBeNull();
    }
  });
});
