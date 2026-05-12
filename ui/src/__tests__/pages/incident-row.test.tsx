import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  IncidentRow,
  type IncidentRowIncident,
  type IncidentSeverity,
  type IncidentSource,
} from "@/pages/incidents-components/IncidentRow";
import { IncidentsTable } from "@/pages/incidents-components/IncidentsTable";

/**
 * Unit tests for the M25 / 04 / T00 incident list row + table restyle.
 *
 * The component is presentational — `pages/incidents.tsx` wires the data
 * fetch, navigation, and the delete-confirm dialog. Tests cover:
 *
 *   - severity → StatusPill tone map (critical=danger, high=warning,
 *     medium=info, low=neutral) — codified in slice.md
 *   - the six-column contract (severity / title / source / opened-at /
 *     resolved-at / actions)
 *   - title truncation guard for long strings (200 chars)
 *   - row click / keyboard activation routes to `onSelect(id)` so the
 *     parent can `navigate(/incidents/:id)`
 *   - kebab → `onDelete(id)` and click on the kebab does NOT bubble up
 *     to the row's onSelect
 *   - resolved-at column shows `—` when the incident is still open
 */

function makeIncident(
  overrides: Partial<IncidentRowIncident> = {},
): IncidentRowIncident {
  return {
    id: "i-1",
    title: "Postgres OOM during nightly backup",
    severity: "critical",
    source: "chat",
    opened_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    resolved_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

interface RowHandlers {
  onSelect?: (id: string) => void;
  onDelete?: (id: string) => void;
}

function renderRow(i: IncidentRowIncident, handlers: RowHandlers = {}) {
  return render(
    <table>
      <tbody>
        <IncidentRow incident={i} {...handlers} />
      </tbody>
    </table>,
  );
}

describe("IncidentsTable / header", () => {
  it("renders an uppercase tracking-wider zinc-500 font-semibold header row", () => {
    render(<IncidentsTable rows={[makeIncident()]} />);
    const head = screen.getByTestId("incidents-table-head");
    const ths = within(head).getAllByRole("columnheader");
    // Severity + Title + Source + Opened + Resolved + (unlabelled actions)
    expect(ths.length).toBe(6);
    for (const th of ths) {
      expect(th.className).toContain("uppercase");
      expect(th.className).toContain("tracking-wider");
      expect(th.className).toContain("text-zinc-500");
      expect(th.className).toContain("font-semibold");
    }
    expect(within(head).getByText("Severity")).toBeTruthy();
    expect(within(head).getByText("Title")).toBeTruthy();
    expect(within(head).getByText("Source")).toBeTruthy();
    expect(within(head).getByText("Opened")).toBeTruthy();
    expect(within(head).getByText("Resolved")).toBeTruthy();
  });
});

describe("IncidentsTable / body row tokens", () => {
  it("uses divide-y on the body and applies the M22 hover surface on every row", () => {
    render(
      <IncidentsTable
        rows={[
          makeIncident(),
          makeIncident({ id: "i-2", title: "Second" }),
        ]}
      />,
    );
    const body = screen.getByTestId("incidents-table-body");
    expect(body.className).toContain("divide-y");
    expect(body.className).toMatch(/divide-zinc-(100|200)/);

    const rows = screen.getAllByTestId("incidents-table-row");
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.className).toContain("hover:bg-zinc-50");
      expect(row.className).toContain("dark:hover:bg-zinc-800/40");
    }
  });
});

describe("IncidentRow / severity StatusPill tone map", () => {
  // Codified in `.flockctl/plan/25-ui-redesign-library-surfaces/04-incidents/slice.md`.
  const cases: Array<{ severity: IncidentSeverity; tone: string }> = [
    { severity: "critical", tone: "danger" },
    { severity: "high", tone: "warning" },
    { severity: "medium", tone: "info" },
    { severity: "low", tone: "neutral" },
  ];

  for (const { severity, tone } of cases) {
    it(`maps severity=${severity} → tone=${tone}`, () => {
      renderRow(makeIncident({ severity }));
      const pill = screen.getByTestId("incidents-table-severity");
      expect(pill.getAttribute("data-tone")).toBe(tone);
      // Pill is uppercase + tracking-wider per the design tokens.
      expect(pill.className).toContain("uppercase");
      expect(pill.className).toContain("tracking-wider");
    });
  }

  it("annotates the row with `data-severity` for downstream styling hooks", () => {
    renderRow(makeIncident({ severity: "high" }));
    const row = screen.getByTestId("incidents-table-row");
    expect(row.getAttribute("data-severity")).toBe("high");
  });
});

describe("IncidentRow / column contract", () => {
  it("renders the title text", () => {
    renderRow(makeIncident({ title: "Disk space alert" }));
    expect(screen.getByTestId("incidents-table-title").textContent).toBe(
      "Disk space alert",
    );
  });

  it("truncates very long titles via the `truncate` class (no overflow into siblings)", () => {
    const longTitle = "a".repeat(200);
    renderRow(makeIncident({ title: longTitle }));
    const title = screen.getByTestId("incidents-table-title");
    // textContent stays full — truncation is purely visual via Tailwind's
    // `truncate` utility (overflow:hidden + text-overflow:ellipsis).
    expect(title.textContent).toBe(longTitle);
    expect(title.className).toContain("truncate");
    // Hover/screen-reader fallback: the full title is preserved as title attr.
    expect(title.getAttribute("title")).toBe(longTitle);
  });

  for (const source of ["chat", "task", "mission"] as IncidentSource[]) {
    it(`renders the source label "${source}"`, () => {
      renderRow(makeIncident({ source }));
      expect(screen.getByTestId("incidents-table-source").textContent).toBe(
        source,
      );
    });
  }

  it("renders an em-dash when source is null", () => {
    renderRow(makeIncident({ source: null }));
    expect(screen.getByTestId("incidents-table-source").textContent).toBe("—");
  });

  it("renders opened-at as a relative-time mono cell", () => {
    renderRow(
      makeIncident({
        opened_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      }),
    );
    const opened = screen.getByTestId("incidents-table-opened-at");
    expect(opened.textContent).toBe("2h ago");
    const cell = opened.closest("td")!;
    expect(cell.className).toContain("font-mono");
  });

  it("renders resolved-at as a relative-time mono cell when set", () => {
    renderRow(
      makeIncident({
        resolved_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const resolved = screen.getByTestId("incidents-table-resolved-at");
    expect(resolved.textContent).toBe("1m ago");
    const cell = resolved.closest("td")!;
    expect(cell.className).toContain("font-mono");
  });

  it("renders an em-dash for resolved-at when the incident is still open", () => {
    renderRow(makeIncident({ resolved_at: null }));
    const resolved = screen.getByTestId("incidents-table-resolved-at");
    expect(resolved.textContent).toBe("—");
    const row = screen.getByTestId("incidents-table-row");
    expect(row.getAttribute("data-resolved")).toBe("false");
  });

  it("flags the row as resolved when `resolved_at` is set", () => {
    renderRow(
      makeIncident({
        resolved_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const row = screen.getByTestId("incidents-table-row");
    expect(row.getAttribute("data-resolved")).toBe("true");
  });
});

describe("IncidentRow / activation → onSelect (used to navigate /incidents/:id)", () => {
  it("invokes onSelect with the incident id when the row is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderRow(makeIncident({ id: "i-42" }), { onSelect });
    await user.click(screen.getByTestId("incidents-table-row"));
    expect(onSelect).toHaveBeenCalledWith("i-42");
  });

  it("invokes onSelect when the row is activated by Enter", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderRow(makeIncident({ id: "i-42" }), { onSelect });
    const row = screen.getByTestId("incidents-table-row");
    row.focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("i-42");
  });

  it("invokes onSelect when the row is activated by Space", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderRow(makeIncident({ id: "i-42" }), { onSelect });
    const row = screen.getByTestId("incidents-table-row");
    row.focus();
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledWith("i-42");
  });

  it("exposes role=link + tabIndex=0 so the row is keyboard-reachable", () => {
    renderRow(makeIncident());
    const row = screen.getByTestId("incidents-table-row");
    expect(row.getAttribute("role")).toBe("link");
    expect(row.getAttribute("tabindex")).toBe("0");
  });
});

describe("IncidentRow / kebab menu", () => {
  it("does not render the kebab when no onDelete is passed", () => {
    renderRow(makeIncident());
    expect(screen.queryByTestId("incidents-table-kebab")).toBeNull();
  });

  it("invokes onDelete with the incident id", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    renderRow(makeIncident({ id: "i-7" }), { onDelete });

    await user.click(screen.getByTestId("incidents-table-kebab"));
    await user.click(await screen.findByText("Delete"));
    expect(onDelete).toHaveBeenCalledWith("i-7");
  });

  it("clicking the kebab does not bubble up to the row's onSelect", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    renderRow(makeIncident({ id: "i-7" }), { onSelect, onDelete });

    await user.click(screen.getByTestId("incidents-table-kebab"));
    // Kebab opens but we never reach the row click handler.
    expect(onSelect).not.toHaveBeenCalled();
  });
});
