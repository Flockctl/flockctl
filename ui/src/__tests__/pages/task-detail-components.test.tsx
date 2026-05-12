import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Task } from "@/lib/types/task";
import { TaskDetailHeader } from "@/pages/task-detail-components/TaskDetailHeader";
import { LogLine } from "@/pages/task-detail-components/LogLine";
import { LogScroller } from "@/pages/task-detail-components/LogScroller";
import { InlinePermissionPrompt } from "@/pages/task-detail-components/InlinePermissionPrompt";
import { StatusPanel } from "@/pages/task-detail-components/StatusPanel";
import { CostPanel } from "@/pages/task-detail-components/CostPanel";
import { FilesTouchedPanel } from "@/pages/task-detail-components/FilesTouchedPanel";
import { TaskDetailRightRail } from "@/pages/task-detail-components/TaskDetailRightRail";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t-1234567",
    status: "running",
    prompt: "do thing\n  detail",
    prompt_file: null,
    agent: "claude-code",
    model: "claude-opus-4",
    actual_model_used: "claude-opus-4-2026",
    timeout_seconds: 600,
    project_id: "p-1",
    assigned_key_id: 1,
    assigned_key_label: "default",
    exit_code: null,
    started_at: "2026-05-07T08:00:00Z",
    completed_at: null,
    working_dir: "/tmp",
    created_at: "2026-05-07T07:59:30Z",
    updated_at: "2026-05-07T08:00:00Z",
    git_commit_before: null,
    git_commit_after: null,
    git_diff_summary: null,
    requires_approval: false,
    approval_status: null,
    approved_at: null,
    approval_note: null,
    permission_mode: "default",
    parent_task_id: null,
    ...overrides,
  };
}

describe("TaskDetailHeader", () => {
  it("renders task id, status badge, and short prompt preview", () => {
    render(
      <MemoryRouter>
        <TaskDetailHeader task={makeTask()} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("task-detail-id").textContent).toContain("T#t-12345");
    expect(screen.getByTestId("task-detail-status").textContent).toBe("running");
    // First prompt line surfaces in header preview
    expect(screen.getByText(/do thing/)).toBeTruthy();
  });

  it("shows Cancel for running tasks and calls onCancel", () => {
    const onCancel = vi.fn();
    render(
      <MemoryRouter>
        <TaskDetailHeader task={makeTask()} onCancel={onCancel} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("task-detail-action-cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows Re-run for failed tasks and Approve for pending_approval", () => {
    const onRerun = vi.fn();
    const onApprove = vi.fn();
    const { rerender } = render(
      <MemoryRouter>
        <TaskDetailHeader task={makeTask({ status: "failed" })} onRerun={onRerun} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("task-detail-action-rerun"));
    expect(onRerun).toHaveBeenCalledOnce();
    rerender(
      <MemoryRouter>
        <TaskDetailHeader
          task={makeTask({ status: "pending_approval" })}
          onApprove={onApprove}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("task-detail-action-approve"));
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("renders the overflow menu only when at least one secondary action is wired", () => {
    const { container, rerender } = render(
      <MemoryRouter>
        <TaskDetailHeader task={makeTask({ status: "done" })} />
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-testid="task-detail-action-overflow"]')).toBeNull();
    rerender(
      <MemoryRouter>
        <TaskDetailHeader task={makeTask({ status: "done" })} onCopyTaskId={() => {}} />
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-testid="task-detail-action-overflow"]')).not.toBeNull();
  });
});

describe("LogLine", () => {
  it("renders timestamp + stream-type badge + content", () => {
    render(<LogLine ts={1714968000000} streamType="stdout" content="hello world" />);
    const row = screen.getByTestId("log-line");
    expect(row.dataset.streamType).toBe("stdout");
    expect(row.textContent).toContain("hello world");
    expect(row.textContent).toContain("stdout");
  });

  it("renders as a button when onClick is supplied", () => {
    const onClick = vi.fn();
    render(<LogLine ts={null} streamType="agent" content="x" onClick={onClick} />);
    const row = screen.getByTestId("log-line");
    expect(row.tagName).toBe("BUTTON");
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("LogScroller", () => {
  it("renders an empty-state message when there are no lines", () => {
    render(<LogScroller lines={[]} />);
    expect(screen.getByText(/Waiting for output/)).toBeTruthy();
  });

  it("renders all lines and respects interleave at boundaries", () => {
    const lines = [
      { ts: null, streamType: "stdout", content: "a" },
      { ts: null, streamType: "stdout", content: "b" },
    ];
    const interleave = new Map<number, React.ReactNode>([
      [0, <span key="i0">prefix</span>],
      [2, <span key="i2">suffix</span>],
    ]);
    render(<LogScroller lines={lines} interleave={interleave} />);
    expect(screen.getByTestId("log-interleave-0").textContent).toBe("prefix");
    expect(screen.getByTestId("log-interleave-2").textContent).toBe("suffix");
  });
});

describe("InlinePermissionPrompt", () => {
  it("calls onAllow with the chosen scope", () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();
    render(
      <InlinePermissionPrompt
        tool="shell.exec"
        scopes={["once", "task"]}
        onAllow={onAllow}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByTestId("inline-permission-allow-task"));
    expect(onAllow).toHaveBeenCalledWith("task");
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("calls onDeny when the deny button is clicked", () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();
    render(<InlinePermissionPrompt tool="x" onAllow={onAllow} onDeny={onDeny} />);
    fireEvent.click(screen.getByTestId("inline-permission-deny"));
    expect(onDeny).toHaveBeenCalledOnce();
  });
});

describe("Right-rail panels", () => {
  it("StatusPanel renders project link when project_id is present", () => {
    render(
      <MemoryRouter>
        <StatusPanel task={makeTask({ project_id: "p-9" })} projectName="alpha" />
      </MemoryRouter>,
    );
    const link = screen.getByText("alpha");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/projects/p-9");
  });

  it("CostPanel formats tokens (K/M) and cents", () => {
    render(<CostPanel promptTokens={1500} totalTokens={1500} costUsdCents={42} />);
    // 1500 → "1.5K"
    expect(screen.getAllByText(/1\.5K/).length).toBeGreaterThan(0);
    expect(screen.getByText(/\$0\.4200/)).toBeTruthy();
  });

  it("FilesTouchedPanel renders empty-state when no files", () => {
    render(<FilesTouchedPanel files={[]} />);
    expect(screen.getByText(/No file changes/)).toBeTruthy();
  });

  it("FilesTouchedPanel calls onSelectFile when a row is clicked", () => {
    const onSelect = vi.fn();
    const file = { path: "src/foo.ts", status: "M" as const };
    render(<FilesTouchedPanel files={[file]} onSelectFile={onSelect} />);
    fireEvent.click(screen.getByTestId("task-detail-file-row"));
    expect(onSelect).toHaveBeenCalledWith(file);
  });

  it("TaskDetailRightRail composes Status + Cost + Files", () => {
    const { container } = render(
      <MemoryRouter>
        <TaskDetailRightRail
          task={makeTask()}
          cost={{ totalTokens: 100, costUsdCents: 5 }}
          files={[{ path: "a.ts", status: "M" }]}
        />
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-testid="task-detail-status-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-detail-cost-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-detail-files-panel"]')).not.toBeNull();
  });
});
