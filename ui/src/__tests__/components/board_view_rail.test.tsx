import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import type { ReactNode } from "react";

/**
 * Slice 03 task: wire `SliceDetailTabs` into `ProjectDetailBoardView`'s
 * right slot. The rail is fed by `useSelection()` (URL-backed), so:
 *
 *  - ?slice=<id>   → rail renders the tabs with that sliceId
 *  - no ?slice=    → rail renders a friendly empty-state hint, NOT a spinner
 *  - ?slice=<id>   flipping to ?slice=<other> updates the rail reactively
 *                  without remounting the surrounding slot (unmount flicker
 *                  is the parent slice.md corner case we're closing).
 *
 * We stub the data hook used by the center slot's `BoardCenterDefault` so the
 * board renders without network. The left slot's `ProjectTreePanel` also
 * pulls from `useProjectTree` via the same mock. KPI bar is stubbed to cut
 * its react-query fan-out.
 */

const {
  useProjectTreeMock,
  useAutoExecStatusMock,
  useStartAutoExecuteMock,
  useCreateChatMock,
} = vi.hoisted(() => ({
  useProjectTreeMock: vi.fn(),
  useAutoExecStatusMock: vi.fn(),
  useStartAutoExecuteMock: vi.fn(),
  useCreateChatMock: vi.fn(),
}));

vi.mock("@/lib/hooks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hooks")>(
    "@/lib/hooks",
  );
  return {
    ...actual,
    useProjectTree: (...args: unknown[]) => useProjectTreeMock(...args),
    useAutoExecStatus: (...args: unknown[]) => useAutoExecStatusMock(...args),
    useStartAutoExecute: (...args: unknown[]) => useStartAutoExecuteMock(...args),
    useCreateChat: (...args: unknown[]) => useCreateChatMock(...args),
  };
});

vi.mock("@/pages/project-detail-components/MissionControlKpiBar", () => ({
  MissionControlKpiBar: ({ projectId }: { projectId: string }) => (
    <div data-testid="mission-control-kpi-bar">kpi:{projectId}</div>
  ),
}));

import { ProjectDetailBoardView } from "@/pages/project-detail-components/ProjectDetailBoardView";

function wrap(children: ReactNode, initialUrl = "/projects/proj-1") {
  return <MemoryRouter initialEntries={[initialUrl]}>{children}</MemoryRouter>;
}

function mockQuery<T>(
  data: T | undefined,
  opts: { isLoading?: boolean; error?: unknown } = {},
) {
  return {
    data,
    isLoading: opts.isLoading ?? false,
    error: opts.error ?? null,
    isSuccess: opts.error == null && !opts.isLoading,
    isError: !!opts.error,
  };
}

beforeEach(() => {
  useProjectTreeMock.mockReset();
  useProjectTreeMock.mockReturnValue(mockQuery({ milestones: [] }));

  // `SliceDetailPanel` pulls these three hooks; stub them with idle mocks so
  // the rail renders without booting real react-query / clipboard paths.
  useAutoExecStatusMock.mockReset();
  useAutoExecStatusMock.mockReturnValue(mockQuery(undefined));

  useStartAutoExecuteMock.mockReset();
  useStartAutoExecuteMock.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  });

  useCreateChatMock.mockReset();
  useCreateChatMock.mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  });
});

describe("board_view_rail", () => {
  it("renders the friendly empty-state hint when no slice is selected (no spinner)", () => {
    render(
      wrap(<ProjectDetailBoardView projectId="proj-1" mode="board" />),
    );

    const empty = screen.getByTestId("board-right-empty");
    expect(empty).toBeInTheDocument();
    // Copy changed from "No slice selected" to the more honest "Nothing
    // selected" once the rail grew a milestone-level detail panel — a
    // milestone click now populates the rail too, so the legacy "pick a
    // slice" wording is no longer accurate.
    expect(empty).toHaveTextContent(/nothing selected/i);

    // Must NOT be a spinner or skeleton — the rail is idle, not loading.
    expect(screen.queryByTestId("board-right-loading")).toBeNull();
    expect(empty.querySelector('[role="progressbar"]')).toBeNull();

    // Rail body (the tabs) is absent until selection lands.
    expect(screen.queryByTestId("board-right-rail")).toBeNull();
  });

  it("renders SliceDetailTabs in the right slot when ?slice=<id> is set", () => {
    // Seed the project-tree cache with a matching slice so the real
    // `SliceDetailPanel` renders its `slice-detail-panel` root (instead of
    // the not-found placeholder). The panel asserts identity through the
    // `data-slice-id` attribute it stamps on its root <aside>.
    useProjectTreeMock.mockReturnValue(
      mockQuery({
        milestones: [
          {
            id: "ms-1",
            project_id: "proj-1",
            title: "Milestone",
            description: null,
            status: "active",
            vision: null,
            success_criteria: null,
            depends_on: null,
            order_index: 0,
            created_at: "2026-04-23T12:00:00.000Z",
            updated_at: "2026-04-23T12:00:00.000Z",
            slices: [
              {
                id: "my-slice",
                milestone_id: "ms-1",
                title: "My slice",
                description: null,
                status: "active",
                risk: "low",
                depends: null,
                demo: null,
                goal: null,
                success_criteria: null,
                proof_level: null,
                threat_surface: null,
                order_index: 0,
                created_at: "2026-04-23T12:00:00.000Z",
                updated_at: "2026-04-23T12:00:00.000Z",
                tasks: [],
              },
            ],
          },
        ],
      }),
    );

    render(
      wrap(
        <ProjectDetailBoardView projectId="proj-1" mode="board" />,
        "/projects/proj-1?slice=my-slice",
      ),
    );

    expect(screen.queryByTestId("board-right-empty")).toBeNull();

    const rail = screen.getByTestId("board-right-rail");
    expect(rail).toBeInTheDocument();

    // SliceDetailTabs identifies itself via `data-slot="slice-detail-tabs"`.
    const tabsRoot = rail.querySelector('[data-slot="slice-detail-tabs"]');
    expect(tabsRoot).not.toBeNull();

    // Default tab registry — "Slice" trigger is present and the real
    // `SliceDetailPanel` is mounted with the selected slice id.
    expect(screen.getByRole("tab", { name: "Slice" })).toBeInTheDocument();
    const panel = screen.getByTestId("slice-detail-panel");
    expect(panel).toHaveAttribute("data-slice-id", "my-slice");
  });

  it("updates reactively when the URL slice selection changes, without unmounting the slot", async () => {
    // A tiny harness that lets a test click a button to flip ?slice=...
    // without involving the tree/board click handlers. Proves the rail is
    // *reactive* to useSelection(), not just mount-time snapshotted.
    function SliceToggler() {
      const [, setParams] = useSearchParams();
      return (
        <div>
          <button
            type="button"
            data-testid="set-slice-a"
            onClick={() => setParams({ slice: "slice-a" }, { replace: true })}
          >
            a
          </button>
          <button
            type="button"
            data-testid="set-slice-b"
            onClick={() => setParams({ slice: "slice-b" }, { replace: true })}
          >
            b
          </button>
          <button
            type="button"
            data-testid="clear-slice"
            onClick={() => setParams({}, { replace: true })}
          >
            clear
          </button>
        </div>
      );
    }

    // Seed both slice ids the toggler flips between so the real panel
    // renders under both selections (otherwise the panel would fall into
    // its `not-found` state and the rail stays mounted but the data-slice-id
    // signal disappears).
    const common = {
      milestone_id: "ms-1",
      description: null,
      status: "active" as const,
      risk: "low",
      depends: null,
      demo: null,
      goal: null,
      success_criteria: null,
      proof_level: null,
      threat_surface: null,
      order_index: 0,
      created_at: "2026-04-23T12:00:00.000Z",
      updated_at: "2026-04-23T12:00:00.000Z",
      tasks: [],
    };
    useProjectTreeMock.mockReturnValue(
      mockQuery({
        milestones: [
          {
            id: "ms-1",
            project_id: "proj-1",
            title: "Milestone",
            description: null,
            status: "active",
            vision: null,
            success_criteria: null,
            depends_on: null,
            order_index: 0,
            created_at: "2026-04-23T12:00:00.000Z",
            updated_at: "2026-04-23T12:00:00.000Z",
            slices: [
              { id: "slice-a", title: "A", ...common },
              { id: "slice-b", title: "B", ...common },
            ],
          },
        ],
      }),
    );

    const user = userEvent.setup();
    render(
      wrap(
        <>
          <SliceToggler />
          <ProjectDetailBoardView projectId="proj-1" mode="board" />
        </>,
      ),
    );

    // Start: no selection → empty hint.
    expect(screen.getByTestId("board-right-empty")).toBeInTheDocument();

    // Select slice-a → rail renders with slice-a.
    await user.click(screen.getByTestId("set-slice-a"));
    const railA = screen.getByTestId("board-right-rail");
    expect(railA).toBeInTheDocument();
    expect(screen.getByTestId("slice-detail-panel")).toHaveAttribute(
      "data-slice-id",
      "slice-a",
    );

    // Flip to slice-b. The rail wrapper stays mounted — same DOM node — so
    // there is no unmount flicker. Only the inner panel text changes.
    await user.click(screen.getByTestId("set-slice-b"));
    const railB = screen.getByTestId("board-right-rail");
    expect(railB).toBe(railA);
    expect(screen.getByTestId("slice-detail-panel")).toHaveAttribute(
      "data-slice-id",
      "slice-b",
    );

    // Clearing the param drops the rail and restores the empty hint.
    await user.click(screen.getByTestId("clear-slice"));
    expect(screen.queryByTestId("board-right-rail")).toBeNull();
    expect(screen.getByTestId("board-right-empty")).toBeInTheDocument();
  });

  it("honours a caller-supplied `right` prop — wiring is only the default", () => {
    render(
      wrap(
        <ProjectDetailBoardView
          projectId="proj-1"
          mode="board"
          right={<div data-testid="caller-rail">caller override</div>}
        />,
        "/projects/proj-1?slice=anything",
      ),
    );

    expect(screen.getByTestId("caller-rail")).toBeInTheDocument();
    expect(screen.queryByTestId("board-right-rail")).toBeNull();
    expect(screen.queryByTestId("board-right-empty")).toBeNull();
  });

  it("ignores malformed slice params (non-slug) and renders the empty hint", () => {
    // `useSelection` validates the slug format; a value with spaces must be
    // treated as "no selection" so the rail cannot be driven into rendering
    // tabs keyed on a garbage id.
    render(
      wrap(
        <ProjectDetailBoardView projectId="proj-1" mode="board" />,
        "/projects/proj-1?slice=not%20a%20slug",
      ),
    );

    expect(screen.getByTestId("board-right-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("board-right-rail")).toBeNull();
  });
});
