import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  SchedulesRow,
  SchedulesTable,
} from "@/pages/schedules-components/SchedulesTable";
import { ScheduleStatus, ScheduleType } from "@/lib/types";
import type { Schedule } from "@/lib/types";

/**
 * Unit tests for the M22 schedules table restyle.
 *
 * The component is presentational — `pages/schedules.tsx` wires data and
 * mutations, and the row only knows about a {@link Schedule} + four kebab
 * callbacks (run-now, pause, resume, delete). These tests cover:
 *
 *   - header tokens (uppercase tracking-wider zinc-500 font-semibold) +
 *     the seven-column contract
 *   - body tokens: `divide-y divide-zinc-{100|200}`, hover surface
 *   - column contract: name | cron (mono) | project (StatusPill scope-tinted)
 *     | template | next-run (mono rel time) | last-run (mono + status pill)
 *   - disabled-row contract: paused/expired schedules collapse the project
 *     pill to neutral and dim the row with `opacity-60`
 *   - kebab routes the right callback (Run now / Pause / Resume / Delete)
 */

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "s-1",
    template_scope: "project",
    template_name: "nightly-build",
    template_workspace_id: null,
    template_project_id: "p-1",
    assigned_key_id: null,
    schedule_type: ScheduleType.cron,
    cron_expression: "0 0 * * *",
    run_at: null,
    timezone: "UTC",
    status: ScheduleStatus.active,
    last_fire_time: new Date(Date.now() - 60_000).toISOString(),
    next_fire_time: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    misfire_grace_seconds: 60,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

interface RowHandlers {
  onRunNow?: (id: string) => void;
  onPause?: (id: string) => void;
  onResume?: (id: string) => void;
  onDelete?: (id: string) => void;
}

function renderRow(s: Schedule, handlers: RowHandlers = {}) {
  return render(
    <table>
      <tbody>
        <SchedulesRow schedule={s} {...handlers} />
      </tbody>
    </table>,
  );
}

describe("SchedulesTable / header", () => {
  it("renders an uppercase tracking-wider zinc-500 font-semibold header row", () => {
    render(<SchedulesTable rows={[makeSchedule()]} />);
    const head = screen.getByTestId("schedules-table-head");
    const ths = within(head).getAllByRole("columnheader");
    // Name + Cron + Project + Template + Next run + Last run + (unlabelled actions)
    expect(ths.length).toBe(7);
    for (const th of ths) {
      expect(th.className).toContain("uppercase");
      expect(th.className).toContain("tracking-wider");
      expect(th.className).toContain("text-zinc-500");
      expect(th.className).toContain("font-semibold");
    }
    expect(within(head).getByText("Name")).toBeTruthy();
    expect(within(head).getByText("Cron")).toBeTruthy();
    expect(within(head).getByText("Project")).toBeTruthy();
    expect(within(head).getByText("Template")).toBeTruthy();
    expect(within(head).getByText("Next run")).toBeTruthy();
    expect(within(head).getByText("Last run")).toBeTruthy();
  });
});

describe("SchedulesTable / body row tokens", () => {
  it("uses divide-y on the body and applies the M22 hover surface on every row", () => {
    render(
      <SchedulesTable
        rows={[
          makeSchedule(),
          makeSchedule({ id: "s-2", template_name: "hourly-sync" }),
        ]}
      />,
    );
    const body = screen.getByTestId("schedules-table-body");
    expect(body.className).toContain("divide-y");
    expect(body.className).toMatch(/divide-zinc-(100|200)/);

    const rows = screen.getAllByTestId("schedules-table-row");
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.className).toContain("hover:bg-zinc-50");
      expect(row.className).toContain("dark:hover:bg-zinc-800/40");
    }
  });
});

describe("SchedulesRow / column contract", () => {
  it("renders the name column with the cron preset label when one matches", () => {
    renderRow(makeSchedule({ cron_expression: "0 0 * * *" }));
    expect(screen.getByTestId("schedules-table-name").textContent).toBe(
      "Daily at midnight",
    );
  });

  it("falls back to the template_name as the schedule's display name", () => {
    renderRow(
      makeSchedule({
        cron_expression: "*/7 * * * *", // not a known preset
        template_name: "ad-hoc-cron",
      }),
    );
    expect(screen.getByTestId("schedules-table-name").textContent).toBe(
      "ad-hoc-cron",
    );
  });

  it("renders the cron column in a monospace cell", () => {
    renderRow(makeSchedule({ cron_expression: "*/5 * * * *" }));
    const cron = screen.getByTestId("schedules-table-cron");
    expect(cron.textContent).toBe("*/5 * * * *");
    const cell = cron.closest("td")!;
    expect(cell.className).toContain("font-mono");
  });

  it("renders the project column as a StatusPill tinted by scope", () => {
    renderRow(makeSchedule({ template_scope: "workspace" }));
    const pill = screen.getByTestId("schedules-table-project-pill");
    expect(pill.textContent).toBe("Workspace");
    expect(pill.getAttribute("data-tone")).toBe("info");
    expect(pill.className).toContain("uppercase");
    expect(pill.className).toContain("tracking-wider");
  });

  it("scope-tints the project pill with success for project-scoped schedules", () => {
    renderRow(makeSchedule({ template_scope: "project" }));
    const pill = screen.getByTestId("schedules-table-project-pill");
    expect(pill.textContent).toBe("Project");
    expect(pill.getAttribute("data-tone")).toBe("success");
  });

  it("renders the template column with the schedule's template name", () => {
    renderRow(makeSchedule({ template_name: "nightly-build" }));
    expect(screen.getByTestId("schedules-table-template").textContent).toBe(
      "nightly-build",
    );
  });

  it("renders next-run as a relative-time mono cell", () => {
    renderRow(
      makeSchedule({
        next_fire_time: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      }),
    );
    const next = screen.getByTestId("schedules-table-next-run");
    expect(next.textContent).toBe("3h ago");
    const cell = next.closest("td")!;
    expect(cell.className).toContain("font-mono");
  });

  it("renders last-run with a mono timestamp paired with a status StatusPill", () => {
    renderRow(
      makeSchedule({
        last_fire_time: new Date(Date.now() - 60_000).toISOString(),
        status: ScheduleStatus.active,
      }),
    );
    const last = screen.getByTestId("schedules-table-last-run");
    expect(last.className).toContain("font-mono");

    const status = screen.getByTestId("schedules-table-status-pill");
    expect(status.textContent).toBe("active");
    expect(status.getAttribute("data-tone")).toBe("success");
  });
});

describe("SchedulesRow / disabled state", () => {
  it("renders a paused schedule with a neutral project pill and a dimmed row", () => {
    renderRow(
      makeSchedule({
        template_scope: "project",
        status: ScheduleStatus.paused,
      }),
    );
    const row = screen.getByTestId("schedules-table-row");
    expect(row.getAttribute("data-disabled")).toBe("true");
    expect(row.className).toContain("opacity-60");

    const pill = screen.getByTestId("schedules-table-project-pill");
    expect(pill.getAttribute("data-tone")).toBe("neutral");
  });

  it("renders an expired schedule with a neutral project pill and a dimmed row", () => {
    renderRow(
      makeSchedule({
        template_scope: "workspace",
        status: ScheduleStatus.expired,
      }),
    );
    const row = screen.getByTestId("schedules-table-row");
    expect(row.className).toContain("opacity-60");

    const pill = screen.getByTestId("schedules-table-project-pill");
    expect(pill.getAttribute("data-tone")).toBe("neutral");
  });

  it("active schedule keeps the scope-tinted pill and is not dimmed", () => {
    renderRow(
      makeSchedule({
        template_scope: "workspace",
        status: ScheduleStatus.active,
      }),
    );
    const row = screen.getByTestId("schedules-table-row");
    expect(row.className).not.toContain("opacity-60");
    expect(row.getAttribute("data-disabled")).toBeNull();

    const pill = screen.getByTestId("schedules-table-project-pill");
    expect(pill.getAttribute("data-tone")).toBe("info");
  });
});

describe("SchedulesRow / kebab menu", () => {
  it("does not render the kebab when no callbacks are passed", () => {
    renderRow(makeSchedule());
    expect(screen.queryByTestId("schedules-table-kebab")).toBeNull();
  });

  it("invokes the run-now handler with the schedule id", async () => {
    const user = userEvent.setup();
    const onRunNow = vi.fn();
    renderRow(makeSchedule({ id: "s-42" }), { onRunNow });

    await user.click(screen.getByTestId("schedules-table-kebab"));
    await user.click(await screen.findByText("Run now"));
    expect(onRunNow).toHaveBeenCalledWith("s-42");
  });

  it("shows Pause for an active schedule and routes to onPause", async () => {
    const user = userEvent.setup();
    const onPause = vi.fn();
    const onResume = vi.fn();
    renderRow(
      makeSchedule({ id: "s-1", status: ScheduleStatus.active }),
      { onPause, onResume },
    );

    await user.click(screen.getByTestId("schedules-table-kebab"));
    await user.click(await screen.findByText("Pause"));
    expect(onPause).toHaveBeenCalledWith("s-1");
    expect(onResume).not.toHaveBeenCalled();
  });

  it("shows Resume for a paused schedule and routes to onResume", async () => {
    const user = userEvent.setup();
    const onPause = vi.fn();
    const onResume = vi.fn();
    renderRow(
      makeSchedule({ id: "s-1", status: ScheduleStatus.paused }),
      { onPause, onResume },
    );

    await user.click(screen.getByTestId("schedules-table-kebab"));
    await user.click(await screen.findByText("Resume"));
    expect(onResume).toHaveBeenCalledWith("s-1");
    expect(onPause).not.toHaveBeenCalled();
  });

  it("invokes onDelete with the schedule id", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    renderRow(makeSchedule({ id: "s-7" }), { onDelete });

    await user.click(screen.getByTestId("schedules-table-kebab"));
    await user.click(await screen.findByText("Delete"));
    expect(onDelete).toHaveBeenCalledWith("s-7");
  });
});
