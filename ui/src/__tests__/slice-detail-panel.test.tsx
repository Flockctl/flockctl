import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { ReactNode } from "react";

import type {
  MilestoneTree,
  PlanSliceTree,
  PlanTask,
  AutoExecuteStatusResponse,
} from "@/lib/types";

/**
 * Unit contract for `SliceDetailPanel` (milestone 09 / slice 02 right-rail).
 *
 * The panel is a "zero new fetch" consumer of the shared project-tree cache:
 * - It reads the slice out of `useProjectTree(projectId)`.
 * - It gates the Re-run button on `useAutoExecStatus(projectId, milestoneId)`.
 * - It creates a chat via `useCreateChat()` then navigates to `/chats/:id`.
 *
 * We therefore stub the entire `@/lib/hooks` barrel — keeping the test free
 * of QueryClient + fetch wiring and letting us assert directly on the
 * mutation calls. That mirrors the pattern used by `task_card.test.tsx`.
 *
 * Verification gate from the brief:
 *   npm run test -- --run 'slice-detail-panel'
 * so every `describe` in this file starts with `slice-detail-panel`.
 */

// --- Mocks --------------------------------------------------------------

const {
  projectTreeMock,
  autoExecStatusMock,
  startAutoExecuteMock,
  createChatMock,
  planEditorOpenMock,
} = vi.hoisted(() => ({
  projectTreeMock: vi.fn(),
  autoExecStatusMock: vi.fn(),
  startAutoExecuteMock: vi.fn(),
  createChatMock: vi.fn(),
  planEditorOpenMock: vi.fn(),
}));

vi.mock("@/lib/hooks", () => ({
  useProjectTree: (...args: unknown[]) => projectTreeMock(...args),
  useAutoExecStatus: (...args: unknown[]) => autoExecStatusMock(...args),
  useStartAutoExecute: (...args: unknown[]) => startAutoExecuteMock(...args),
  useCreateChat: (...args: unknown[]) => createChatMock(...args),
}));

// Stub the Plan-editor context so we can assert the new per-task
// "Open plan" icon button calls `planEditor.open(...)` with the correct
// task-scoped payload. Returning a non-null controller also exercises
// the production code path that renders the button — `null` would hide
// it (storybook contract), which is a different branch.
vi.mock("@/pages/project-detail-components/plan-editor-context", () => ({
  usePlanEditor: () => ({
    context: null,
    open: planEditorOpenMock,
    close: vi.fn(),
  }),
}));

import { SliceDetailPanel } from "@/pages/project-detail-components/SliceDetailPanel";

// --- Fixtures -----------------------------------------------------------

function makeTask(
  id: string,
  overrides: Partial<PlanTask> = {},
): PlanTask {
  return {
    id,
    slice_id: "slice-1",
    title: `Task ${id}`,
    description: null,
    model: null,
    status: "completed",
    estimate: null,
    files: null,
    verify: null,
    inputs: null,
    expected_output: null,
    task_id: `t-${id}`,
    order_index: 0,
    output: null,
    summary: null,
    verification_passed: null,
    verification_output: null,
    created_at: "2026-04-23T12:00:00.000Z",
    updated_at: "2026-04-23T12:00:30.000Z",
    ...overrides,
  };
}

function makeSlice(
  overrides: Partial<PlanSliceTree> = {},
): PlanSliceTree {
  return {
    id: "slice-1",
    milestone_id: "ms-1",
    title: "Wire right rail",
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
    updated_at: "2026-04-23T12:00:30.000Z",
    tasks: [],
    ...overrides,
  };
}

function makeMilestone(
  overrides: Partial<MilestoneTree> = {},
): MilestoneTree {
  return {
    id: "ms-1",
    project_id: "proj-1",
    title: "Mission control",
    description: null,
    status: "active",
    vision: null,
    success_criteria: null,
    depends_on: null,
    order_index: 0,
    created_at: "2026-04-23T12:00:00.000Z",
    updated_at: "2026-04-23T12:00:30.000Z",
    slices: [],
    ...overrides,
  };
}

interface TreeOptions {
  milestones?: MilestoneTree[];
  isLoading?: boolean;
}

function mockTree({ milestones = [], isLoading = false }: TreeOptions = {}) {
  projectTreeMock.mockReturnValue({
    data: isLoading ? undefined : { milestones },
    isLoading,
    error: null,
    isSuccess: !isLoading,
    isError: false,
  });
}

function mockAutoExec(
  data: AutoExecuteStatusResponse | undefined = undefined,
) {
  autoExecStatusMock.mockReturnValue({
    data,
    isLoading: false,
    error: null,
    isSuccess: true,
    isError: false,
  });
}

let lastStartAutoExecuteMutate: ReturnType<typeof vi.fn>;
let lastCreateChatMutateAsync: ReturnType<typeof vi.fn>;

function wrap(children: ReactNode, initialPath = "/projects/proj-1") {
  // A MemoryRouter with a catch-all so the "Chat" button's navigation to
  // `/chats/:id` resolves to a testable sentinel rather than a blank page.
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/projects/:id" element={children} />
        <Route
          path="/chats/:id"
          element={<div data-testid="navigated-chat" />}
        />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  projectTreeMock.mockReset();
  autoExecStatusMock.mockReset();
  startAutoExecuteMock.mockReset();
  createChatMock.mockReset();
  planEditorOpenMock.mockReset();

  lastStartAutoExecuteMutate = vi.fn();
  startAutoExecuteMock.mockReturnValue({
    mutate: lastStartAutoExecuteMutate,
    isPending: false,
  });

  lastCreateChatMutateAsync = vi.fn(async (args: { entityId: string }) => ({
    id: `chat-for-${args.entityId}`,
  }));
  createChatMock.mockReturnValue({
    mutateAsync: lastCreateChatMutateAsync,
    isPending: false,
  });

  mockAutoExec({
    status: "idle",
    milestone_id: "ms-1",
    current_slice_ids: [],
    started_at: null,
    completed_slices: 0,
    total_slices: 0,
  });
});

// --- Tests --------------------------------------------------------------

describe("slice-detail-panel empty state", () => {
  it("renders the 'select a slice' hint when sliceId is undefined", () => {
    mockTree({ milestones: [] });
    render(wrap(<SliceDetailPanel projectId="proj-1" sliceId={undefined} />));

    const empty = screen.getByTestId("slice-detail-panel-empty");
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveTextContent(/select a slice/i);
    // Action buttons MUST NOT render in the empty state — they would be
    // clickable affordances over a nothing selection.
    expect(screen.queryByTestId("slice-detail-panel-rerun")).toBeNull();
    expect(screen.queryByTestId("slice-detail-panel-chat")).toBeNull();
    expect(screen.queryByTestId("slice-detail-panel-copy-id")).toBeNull();
  });
});

describe("slice-detail-panel loading state", () => {
  it("renders skeletons while the project tree is loading with no cached data", () => {
    mockTree({ isLoading: true });
    render(wrap(<SliceDetailPanel projectId="proj-1" sliceId="slice-1" />));

    expect(
      screen.getByTestId("slice-detail-panel-loading"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("slice-detail-panel")).toBeNull();
    expect(screen.queryByTestId("slice-detail-panel-not-found")).toBeNull();
  });
});

describe("slice-detail-panel not-found state", () => {
  it("renders the not-found hint when the tree resolved but the slice is missing", () => {
    mockTree({
      milestones: [makeMilestone({ slices: [makeSlice({ id: "other" })] })],
    });

    render(
      wrap(<SliceDetailPanel projectId="proj-1" sliceId="ghost-slice" />),
    );

    const notFound = screen.getByTestId("slice-detail-panel-not-found");
    expect(notFound).toBeInTheDocument();
    expect(notFound).toHaveTextContent(/slice not found/i);
    // Body of the panel is suppressed — no tasks, no stats, no actions.
    expect(screen.queryByTestId("slice-detail-panel-tasks")).toBeNull();
    expect(screen.queryByTestId("slice-detail-panel-rerun")).toBeNull();
  });
});

describe("slice-detail-panel header + title wrap", () => {
  it("renders the milestone breadcrumb and slice title, applying line-clamp-3", () => {
    const slice = makeSlice({
      title: "A".repeat(150),
    });
    mockTree({
      milestones: [makeMilestone({ slices: [slice] })],
    });

    render(wrap(<SliceDetailPanel projectId="proj-1" sliceId="slice-1" />));

    const title = screen.getByTestId("slice-detail-panel-title");
    expect(title).toHaveTextContent("A".repeat(150));
    // Long-title wrap corner case — the title carries `line-clamp-3` so the
    // rail can't be pushed arbitrarily tall by a verbose slice title.
    expect(title.className).toMatch(/line-clamp-3/);
    // title attribute mirrors the full string so a hover tooltip restores it.
    expect(title).toHaveAttribute("title", "A".repeat(150));

    expect(
      screen.getByTestId("slice-detail-panel-milestone"),
    ).toHaveTextContent("Mission control");
  });
});

describe("slice-detail-panel rerun mutation", () => {
  it("fires startAutoExecute with the owning milestone id when Re-run is clicked", async () => {
    const user = userEvent.setup();
    mockTree({
      milestones: [
        makeMilestone({ slices: [makeSlice({ id: "slice-1" })] }),
      ],
    });
    render(wrap(<SliceDetailPanel projectId="proj-1" sliceId="slice-1" />));

    const rerun = screen.getByTestId("slice-detail-panel-rerun");
    expect(rerun).toBeEnabled();

    await user.click(rerun);

    expect(lastStartAutoExecuteMutate).toHaveBeenCalledTimes(1);
    expect(lastStartAutoExecuteMutate).toHaveBeenCalledWith({
      milestoneId: "ms-1",
    });
  });

  it("disables Re-run with a tooltip when auto-execution is already running for that milestone", () => {
    mockTree({
      milestones: [
        makeMilestone({ slices: [makeSlice({ id: "slice-1" })] }),
      ],
    });
    mockAutoExec({
      status: "running",
      milestone_id: "ms-1",
      current_slice_ids: ["slice-1"],
      started_at: "2026-04-23T12:00:00.000Z",
      completed_slices: 0,
      total_slices: 1,
    });

    render(wrap(<SliceDetailPanel projectId="proj-1" sliceId="slice-1" />));

    const rerun = screen.getByTestId("slice-detail-panel-rerun");
    expect(rerun).toBeDisabled();
    // Tooltip explains the disabled state — covers the
    // rerun-already-running disabled corner case in the brief.
    expect(rerun).toHaveAttribute(
      "title",
      "Auto-execution is already running for this milestone",
    );
  });

  it("shows a 'Starting…' label while the rerun mutation is pending", () => {
    startAutoExecuteMock.mockReturnValue({
      mutate: vi.fn(),
      isPending: true,
    });
    mockTree({
      milestones: [
        makeMilestone({ slices: [makeSlice({ id: "slice-1" })] }),
      ],
    });

    render(wrap(<SliceDetailPanel projectId="proj-1" sliceId="slice-1" />));

    const rerun = screen.getByTestId("slice-detail-panel-rerun");
    expect(rerun).toBeDisabled();
    expect(rerun).toHaveTextContent(/starting/i);
  });
});

describe("slice-detail-panel chat dialog", () => {
  it("creates a slice-scoped chat then navigates to /chats/:id", async () => {
    const user = userEvent.setup();
    mockTree({
      milestones: [
        makeMilestone({
          slices: [
            makeSlice({ id: "slice-1", title: "Compose rail actions" }),
          ],
        }),
      ],
    });

    render(wrap(<SliceDetailPanel projectId="proj-1" sliceId="slice-1" />));

    await user.click(screen.getByTestId("slice-detail-panel-chat"));

    expect(lastCreateChatMutateAsync).toHaveBeenCalledTimes(1);
    expect(lastCreateChatMutateAsync).toHaveBeenCalledWith({
      project_id: "proj-1",
      entityType: "slice",
      entityId: "slice-1",
      title: "Compose rail actions",
    });

    // The mock resolves to `{ id: "chat-for-slice-1" }` — the panel wires that
    // into `navigate("/chats/chat-for-slice-1")`, which lands on the sentinel
    // route from `wrap()`.
    expect(await screen.findByTestId("navigated-chat")).toBeInTheDocument();
  });

  it("disables the Chat button while the create-chat mutation is pending", () => {
    createChatMock.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: true,
    });
    mockTree({
      milestones: [
        makeMilestone({ slices: [makeSlice({ id: "slice-1" })] }),
      ],
    });

    render(wrap(<SliceDetailPanel projectId="proj-1" sliceId="slice-1" />));

    const chat = screen.getByTestId("slice-detail-panel-chat");
    expect(chat).toBeDisabled();
    expect(chat).toHaveTextContent(/opening/i);
  });
});

describe("slice-detail-panel copy id", () => {
  it("writes the slice id to the clipboard and flips the label to 'Copied' for ~1.5s", async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
      });

      mockTree({
        milestones: [
          makeMilestone({ slices: [makeSlice({ id: "slice-1" })] }),
        ],
      });

      render(wrap(<SliceDetailPanel projectId="proj-1" sliceId="slice-1" />));

      const copy = screen.getByTestId("slice-detail-panel-copy-id");
      expect(copy).toHaveTextContent(/copy id/i);

      // `userEvent` is driven by real timers; use fireEvent.click here so we
      // can keep fake timers for the setTimeout assertion below.
      fireEvent.click(copy);

      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith("slice-1");
      expect(copy).toHaveTextContent(/copied/i);

      // After the 1500ms timeout the label resets. React 19 queues the state
      // update on the setTimeout callback — flush it inside act() so the
      // subsequent text assertion sees the idle label, not the transient one.
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(copy).toHaveTextContent(/copy id/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("degrades gracefully when navigator.clipboard is unavailable (no throw)", () => {
    // Remove the clipboard object entirely — mirrors insecure contexts. The
    // panel uses `navigator.clipboard?.writeText(...)` so the optional chain
    // short-circuits without throwing; the UX still flips to "Copied" so the
    // user gets feedback even if the physical copy silently failed.
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });

    mockTree({
      milestones: [
        makeMilestone({ slices: [makeSlice({ id: "slice-1" })] }),
      ],
    });
    render(wrap(<SliceDetailPanel projectId="proj-1" sliceId="slice-1" />));

    const copy = screen.getByTestId("slice-detail-panel-copy-id");
    // The click MUST NOT throw even though the clipboard API is absent.
    expect(() => fireEvent.click(copy)).not.toThrow();
    // The "Copied" flash still appears — the panel intentionally optimistically
    // flips regardless so users in insecure contexts still see an
    // acknowledgement.
    expect(copy).toHaveTextContent(/copied/i);
  });
});

describe("slice-detail-panel stats grid", () => {
  it("renders em dashes when no tasks contribute duration or cost", () => {
    mockTree({
      milestones: [
        makeMilestone({
          slices: [makeSlice({ id: "slice-1", tasks: [] })],
        }),
      ],
    });
    render(wrap(<SliceDetailPanel projectId="proj-1" sliceId="slice-1" />));

    const duration = screen.getByTestId("slice-detail-panel-stat-duration");
    const cost = screen.getByTestId("slice-detail-panel-stat-cost");
    expect(within(duration).getByText("—")).toBeInTheDocument();
    expect(within(cost).getByText("—")).toBeInTheDocument();
  });

  it("sums duration_ms and total_cost_usd across tasks", () => {
    mockTree({
      milestones: [
        makeMilestone({
          slices: [
            makeSlice({
              id: "slice-1",
              tasks: [
                makeTask("a", {
                  summary: { duration_ms: 1_500, total_cost_usd: 0.02 },
                }),
                makeTask("b", {
                  summary: { duration_ms: 500, total_cost_usd: 0.01 },
                }),
                // A task with no summary must degrade gracefully — no NaN.
                makeTask("c", { summary: null }),
              ],
            }),
          ],
        }),
      ],
    });
    render(wrap(<SliceDetailPanel projectId="proj-1" sliceId="slice-1" />));

    // 2000ms → "2.0s"
    expect(
      within(
        screen.getByTestId("slice-detail-panel-stat-duration"),
      ).getByText("2.0s"),
    ).toBeInTheDocument();
    // $0.03 → "$0.03"
    expect(
      within(
        screen.getByTestId("slice-detail-panel-stat-cost"),
      ).getByText("$0.03"),
    ).toBeInTheDocument();
  });
});

describe("slice-detail-panel tasks list", () => {
  it("renders a '0-task placeholder' when the slice has no tasks", () => {
    mockTree({
      milestones: [
        makeMilestone({
          slices: [makeSlice({ id: "slice-1", tasks: [] })],
        }),
      ],
    });
    render(wrap(<SliceDetailPanel projectId="proj-1" sliceId="slice-1" />));

    const section = screen.getByTestId("slice-detail-panel-tasks");
    expect(section).toHaveTextContent(/no tasks on this slice yet/i);
    expect(
      screen.queryByTestId("slice-detail-panel-task-list"),
    ).toBeNull();
  });

  it("sorts tasks by order_index and links materialized runs to /tasks/:task_id", () => {
    const tasks: PlanTask[] = [
      makeTask("b", { order_index: 1, task_id: "run-b" }),
      makeTask("a", { order_index: 0, task_id: "run-a" }),
      makeTask("c", { order_index: 2, task_id: null }), // unmaterialized
    ];
    mockTree({
      milestones: [
        makeMilestone({
          slices: [makeSlice({ id: "slice-1", tasks })],
        }),
      ],
    });
    render(wrap(<SliceDetailPanel projectId="proj-1" sliceId="slice-1" />));

    // `slice-detail-panel-task-<id>` matches individual row elements.
    // The regex explicitly excludes `-task-list` (the ul wrapper) and
    // `-task-title-*` (the inner title span) so we land on row roots only.
    const rows = screen
      .getAllByTestId(
        /^slice-detail-panel-task-(?!list$|title-)[a-z0-9-]+$/i,
      );
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "slice-detail-panel-task-a",
      "slice-detail-panel-task-b",
      "slice-detail-panel-task-c",
    ]);

    // Materialized rows are <a> Links pointing at /tasks/:run.
    expect(rows[0]!.tagName).toBe("A");
    expect(rows[0]!.getAttribute("href")).toBe("/tasks/run-a");
    expect(rows[1]!.getAttribute("href")).toBe("/tasks/run-b");

    // Unmaterialized row is a <div> with aria-disabled, NOT a link.
    expect(rows[2]!.tagName).toBe("DIV");
    expect(rows[2]!.getAttribute("aria-disabled")).toBe("true");
  });

  it("renders an 'Open plan' icon button on each task row that opens the Plan editor scoped to the task", async () => {
    // Per-task icon affordance parallel to the slice-level "Edit files"
    // button — but icon-only, no label, because task rows are tight.
    // Clicking it must invoke `planEditor.open` with `entity_type: "task"`
    // plus the owning `milestone_id` / `slice_id`, so the Plan file editor
    // can resolve the correct task plan file.
    const user = userEvent.setup();
    const tasks: PlanTask[] = [
      makeTask("a", { order_index: 0, task_id: "run-a", title: "Task A" }),
      makeTask("b", { order_index: 1, task_id: null, title: "Task B" }),
    ];
    mockTree({
      milestones: [
        makeMilestone({
          id: "ms-42",
          slices: [makeSlice({ id: "slice-1", tasks })],
        }),
      ],
    });
    render(wrap(<SliceDetailPanel projectId="proj-1" sliceId="slice-1" />));

    const aBtn = screen.getByTestId("slice-detail-panel-open-plan-a");
    const bBtn = screen.getByTestId("slice-detail-panel-open-plan-b");
    // Icon-only affordance — no user-visible text content, just an
    // accessible label for screen readers.
    expect(aBtn).toHaveAccessibleName(/open plan for task a/i);
    expect(bBtn).toHaveAccessibleName(/open plan for task b/i);
    expect(aBtn.textContent?.trim()).toBe("");

    await user.click(aBtn);
    expect(planEditorOpenMock).toHaveBeenCalledTimes(1);
    expect(planEditorOpenMock).toHaveBeenLastCalledWith({
      entity_type: "task",
      entity_id: "a",
      milestone_id: "ms-42",
      slice_id: "slice-1",
      title: "Task A",
    });

    // Unmaterialized tasks (no task_id) still get the plan button —
    // the plan file can be authored before the first run materializes.
    await user.click(bBtn);
    expect(planEditorOpenMock).toHaveBeenCalledTimes(2);
    expect(planEditorOpenMock).toHaveBeenLastCalledWith({
      entity_type: "task",
      entity_id: "b",
      milestone_id: "ms-42",
      slice_id: "slice-1",
      title: "Task B",
    });
  });

  it("scrolls the tasks list internally when a slice has 20+ tasks", () => {
    // 20-task scroll corner case: the list must cap its height with
    // `max-h-[60vh]` and `overflow-y-auto` so the rail never grows taller
    // than the right slot.
    const tasks = Array.from({ length: 20 }, (_, i) =>
      makeTask(`t-${i}`, { order_index: i }),
    );
    mockTree({
      milestones: [
        makeMilestone({
          slices: [makeSlice({ id: "slice-1", tasks })],
        }),
      ],
    });
    render(wrap(<SliceDetailPanel projectId="proj-1" sliceId="slice-1" />));

    const list = screen.getByTestId("slice-detail-panel-task-list");
    expect(list.children).toHaveLength(20);
    // Class contract — if a future refactor drops either utility, this
    // test fails loud instead of silently breaking the scroll geometry.
    expect(list.className).toMatch(/overflow-y-auto/);
    expect(list.className).toMatch(/max-h-\[60vh\]/);
  });
});
