import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// The real WorkspaceTemplatesSection hits react-query hooks that fan out to
// `/templates`, `/ai-keys`, etc. The tab is a pure composition shell, so we
// stub the heavy child with a marker div and assert on ordering + the
// Schedules stub copy instead.
vi.mock(
  "@/pages/workspace-detail-components/WorkspaceTemplatesSection",
  () => ({
    WorkspaceTemplatesSection: ({ workspaceId }: { workspaceId: string }) => (
      <div data-testid="workspace-templates-section">
        templates:{workspaceId}
      </div>
    ),
  }),
);

import { WorkspaceTemplatesSchedulesTab } from "../WorkspaceTemplatesSchedulesTab";

describe("WorkspaceTemplatesSchedulesTab", () => {
  it("renders WorkspaceTemplatesSection with the forwarded workspaceId", () => {
    render(<WorkspaceTemplatesSchedulesTab workspaceId="ws-abc" />);

    const section = screen.getByTestId("workspace-templates-section");
    expect(section).toHaveTextContent("templates:ws-abc");
  });

  it("renders a schedules stub describing the future-milestone plan", () => {
    render(<WorkspaceTemplatesSchedulesTab workspaceId="ws-abc" />);

    const stub = screen.getByTestId("workspace-schedules-stub");
    // Single source of truth for the copy — any wording change that drops
    // either half of the message (the future-milestone notice or the
    // project-level escape hatch) should fail this test.
    expect(stub).toHaveTextContent(
      /Workspace-level schedules are planned in a future milestone\./,
    );
    expect(stub).toHaveTextContent(
      /Project-level schedules remain available under each project's Templates & Schedules tab\./,
    );
  });

  it("orders the templates section above the schedules stub", () => {
    const { container } = render(
      <WorkspaceTemplatesSchedulesTab workspaceId="ws-abc" />,
    );

    const tab = container.querySelector(
      '[data-testid="workspace-templates-schedules-tab"]',
    );
    expect(tab).not.toBeNull();

    const testIds = Array.from(
      tab!.querySelectorAll<HTMLElement>("[data-testid]"),
    ).map((el) => el.getAttribute("data-testid"));

    const templatesIdx = testIds.indexOf("workspace-templates-section");
    const scheduleIdx = testIds.indexOf("workspace-schedules-stub");

    expect(templatesIdx).toBeGreaterThanOrEqual(0);
    expect(scheduleIdx).toBeGreaterThan(templatesIdx);
  });
});
