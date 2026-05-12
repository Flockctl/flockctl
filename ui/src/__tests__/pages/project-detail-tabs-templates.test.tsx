/**
 * Unit tests for {@link TemplatesAndSchedulesTab} (M23 / project-detail / T07).
 *
 * The tab is a pure layout shim:
 *   - Two FlatCard columns side by side (`grid-cols-1 lg:grid-cols-2`,
 *     `gap-4`) — left = templates scoped to this project, right = schedules
 *     scoped to this project.
 *   - Each card mounts the existing M25 `ProjectTemplatesSection` and M21
 *     `ProjectSchedulesSection` unchanged, which means the add-affordances
 *     keep opening the existing dialogs.
 *
 * Because the wrapper is presentational, the tests pin:
 *   1. exactly two FlatCard columns render, in the documented left/right
 *      order, inside a `grid-cols-1 lg:grid-cols-2 gap-4` container;
 *   2. when the project has 0 templates, the templates column renders the
 *      empty-state copy (no project-scoped templates yet);
 *   3. when the project has 0 schedules, the schedules column renders the
 *      empty-state copy (no scheduled tasks for this project);
 *   4. when both lists have rows, the templates land in the LEFT card and
 *      the schedules land in the RIGHT card (pre-empts a future swap-by-
 *      mistake regression);
 *   5. the templates-side hook is called with `{ scope: "project", projectId }`
 *      and the schedules-side hook is called with the project id, so
 *      "scoped to this project" is invariant-tested, not just trusted.
 *
 * Hook strategy: we mock `@/lib/hooks` so the test drives the listing data
 * deterministically without touching apiFetch / network. Heavy dialog and
 * confirm-dialog modules are stubbed to lightweight markers — we only need
 * to assert that the create-affordance is wired and that the project scope
 * is locked through to the existing dialog (the dialog's own behaviour is
 * tested elsewhere and explicitly reused unchanged here).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { Schedule, TaskTemplate } from "@/lib/types";
import { ScheduleStatus, ScheduleType } from "@/lib/types";

// jsdom is missing the bits Radix Dialog reaches for if the create-dialog
// stubs ever pierce a real Radix portal in a future change. Cheap insurance.
if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// --- Hook spies. ----------------------------------------------------------

const useTemplatesSpy = vi.fn();
const useProjectSchedulesSpy = vi.fn();

vi.mock("@/lib/hooks", () => ({
  useTemplates: (
    offset: number,
    limit: number,
    filter: { scope?: string; projectId?: string },
  ) => useTemplatesSpy(offset, limit, filter),
  useUpdateTemplate: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteTemplate: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useProjectSchedules: (
    projectId: string,
    offset: number,
    limit: number,
    opts?: unknown,
  ) => useProjectSchedulesSpy(projectId, offset, limit, opts),
  usePauseSchedule: () => ({ mutate: vi.fn(), isPending: false }),
  useResumeSchedule: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSchedule: () => ({ mutate: vi.fn(), isPending: false }),
}));

// --- Dialog stubs.  -------------------------------------------------------

vi.mock("@/pages/templates", () => ({
  CreateTemplateDialog: ({
    defaultScope,
    defaultProjectId,
    lockScope,
    triggerLabel,
  }: {
    defaultScope?: string;
    defaultProjectId?: string;
    lockScope?: boolean;
    triggerLabel?: string;
  }) => (
    <button
      type="button"
      data-testid="stub-create-template-dialog"
      data-default-scope={defaultScope}
      data-default-project-id={defaultProjectId}
      data-lock-scope={String(lockScope)}
    >
      {triggerLabel ?? "Create Template"}
    </button>
  ),
}));

vi.mock("@/pages/schedules", () => ({
  CreateScheduleDialog: ({
    projectId,
    buttonSize,
  }: {
    projectId?: string;
    buttonSize?: string;
  }) => (
    <button
      type="button"
      data-testid="stub-create-schedule-dialog"
      data-project-id={projectId ?? ""}
      data-button-size={buttonSize ?? ""}
    >
      Create Schedule
    </button>
  ),
}));

// --- Other helper stubs.  -------------------------------------------------

// The form-fields module pulls in heavy primitive trees we don't need
// here — the templates list never renders the edit dialog in these tests.
vi.mock("@/components/task-form-fields", () => ({
  TaskFormFields: () => null,
  defaultTaskFormValues: {},
}));

vi.mock("@/components/confirm-dialog", () => ({
  ConfirmDialog: () => null,
  useConfirmDialog: () => ({
    open: false,
    onOpenChange: () => {},
    requestConfirm: () => {},
    reset: () => {},
    targetId: null,
  }),
}));

// Import AFTER the mocks so the component picks them up.
import { TemplatesAndSchedulesTab } from "@/pages/project-detail-components/TemplatesAndSchedulesTab";

const PROJECT_ID = "proj-flockctl";

function makeTemplate(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    name: "publish-blog",
    scope: "project",
    workspace_id: null,
    project_id: PROJECT_ID,
    description: "Publish a blog post",
    agent: null,
    model: "sonnet-4.6",
    prompt: "Write the post",
    working_dir: null,
    env_vars: null,
    timeout_seconds: 300,
    label_selector: null,
    image: null,
    source_path: "templates/publish-blog.md",
    created_at: "2026-05-07T00:00:00Z",
    updated_at: "2026-05-07T00:00:00Z",
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "sched-1",
    template_scope: "project",
    template_name: "publish-blog",
    template_workspace_id: null,
    template_project_id: PROJECT_ID,
    assigned_key_id: null,
    schedule_type: ScheduleType.cron,
    cron_expression: "0 9 * * 1",
    run_at: null,
    timezone: "UTC",
    status: ScheduleStatus.active,
    last_fire_time: null,
    next_fire_time: "2026-05-11T09:00:00Z",
    misfire_grace_seconds: 60,
    created_at: "2026-05-07T00:00:00Z",
    updated_at: "2026-05-07T00:00:00Z",
    ...overrides,
  };
}

function setHooksData({
  templates,
  schedules,
}: {
  templates: TaskTemplate[];
  schedules: Schedule[];
}) {
  useTemplatesSpy.mockReturnValue({
    data: { items: templates, total: templates.length, limit: 100, offset: 0 },
    isLoading: false,
  });
  useProjectSchedulesSpy.mockReturnValue({
    data: { items: schedules, total: schedules.length, limit: 50, offset: 0 },
    isLoading: false,
  });
}

beforeEach(() => {
  useTemplatesSpy.mockReset();
  useProjectSchedulesSpy.mockReset();
});

describe("TemplatesAndSchedulesTab / layout", () => {
  it("renders exactly two FlatCard columns inside a 2-col grid container", () => {
    setHooksData({ templates: [], schedules: [] });
    render(<TemplatesAndSchedulesTab projectId={PROJECT_ID} />);

    const root = screen.getByTestId("project-templates-and-schedules-tab");
    // Layout invariants — the prototype's exact column / spacing tokens.
    expect(root.className).toContain("grid");
    expect(root.className).toContain("grid-cols-1");
    expect(root.className).toContain("lg:grid-cols-2");
    expect(root.className).toContain("gap-4");

    // Two FlatCard columns, in the documented left/right order.
    const left = screen.getByTestId("project-templates-card");
    const right = screen.getByTestId("project-schedules-card");
    expect(left).toBeTruthy();
    expect(right).toBeTruthy();
    // Source-of-truth ordering: templates card precedes schedules card in
    // the DOM so it lands on the left under flex / grid auto-flow.
    expect(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("TemplatesAndSchedulesTab / data scoping", () => {
  it("scopes the templates fetch to { scope: 'project', projectId } via useTemplates", () => {
    setHooksData({ templates: [], schedules: [] });
    render(<TemplatesAndSchedulesTab projectId={PROJECT_ID} />);
    expect(useTemplatesSpy).toHaveBeenCalledWith(0, 100, {
      scope: "project",
      projectId: PROJECT_ID,
    });
  });

  it("scopes the schedules fetch to this project via useProjectSchedules", () => {
    setHooksData({ templates: [], schedules: [] });
    render(<TemplatesAndSchedulesTab projectId={PROJECT_ID} />);
    expect(useProjectSchedulesSpy).toHaveBeenCalled();
    const firstCall = useProjectSchedulesSpy.mock.calls[0]!;
    expect(firstCall[0]).toBe(PROJECT_ID);
  });
});

describe("TemplatesAndSchedulesTab / empty states", () => {
  it("project with 0 templates shows the project-scoped empty state in the left card", () => {
    setHooksData({ templates: [], schedules: [] });
    render(<TemplatesAndSchedulesTab projectId={PROJECT_ID} />);

    const left = screen.getByTestId("project-templates-card");
    expect(within(left).getByText(/no project-scoped templates yet/i)).toBeTruthy();
  });

  it("project with 0 schedules shows the project-scoped empty state in the right card", () => {
    setHooksData({ templates: [], schedules: [] });
    render(<TemplatesAndSchedulesTab projectId={PROJECT_ID} />);

    const right = screen.getByTestId("project-schedules-card");
    expect(within(right).getByText(/no scheduled tasks for this project/i)).toBeTruthy();
  });
});

describe("TemplatesAndSchedulesTab / add-affordances open existing dialogs unchanged", () => {
  it("mounts the existing CreateTemplateDialog with project scope locked in the LEFT card", () => {
    setHooksData({ templates: [], schedules: [] });
    render(<TemplatesAndSchedulesTab projectId={PROJECT_ID} />);

    const left = screen.getByTestId("project-templates-card");
    const stub = within(left).getByTestId("stub-create-template-dialog");
    expect(stub.getAttribute("data-default-scope")).toBe("project");
    expect(stub.getAttribute("data-default-project-id")).toBe(PROJECT_ID);
    expect(stub.getAttribute("data-lock-scope")).toBe("true");
  });

  it("mounts the existing CreateScheduleDialog with this projectId in the RIGHT card", () => {
    setHooksData({ templates: [], schedules: [] });
    render(<TemplatesAndSchedulesTab projectId={PROJECT_ID} />);

    const right = screen.getByTestId("project-schedules-card");
    const stub = within(right).getByTestId("stub-create-schedule-dialog");
    expect(stub.getAttribute("data-project-id")).toBe(PROJECT_ID);
  });
});

describe("TemplatesAndSchedulesTab / populated lists land in the right columns", () => {
  it("templates render in the LEFT card and schedules in the RIGHT card", () => {
    setHooksData({
      templates: [makeTemplate({ name: "publish-blog" })],
      schedules: [makeSchedule({ id: "sched-1", template_name: "publish-blog" })],
    });
    render(<TemplatesAndSchedulesTab projectId={PROJECT_ID} />);

    const left = screen.getByTestId("project-templates-card");
    const right = screen.getByTestId("project-schedules-card");

    // Template name appears in the templates card body.
    expect(within(left).getByText("publish-blog")).toBeTruthy();

    // Schedule cron expression renders in the schedules card body.
    expect(within(right).getByText("0 9 * * 1")).toBeTruthy();

    // Cross-check: cron expression should NOT appear in the templates card.
    expect(within(left).queryByText("0 9 * * 1")).toBeNull();
  });
});
