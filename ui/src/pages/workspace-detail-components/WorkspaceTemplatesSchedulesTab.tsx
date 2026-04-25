import { WorkspaceTemplatesSection } from "./WorkspaceTemplatesSection";
import { Separator } from "@/components/ui/separator";

/**
 * Stub for the workspace-level schedules surface.
 *
 * Workspace-level schedules are a deliberate future-milestone item: project
 * schedules remain fully functional under each project's Templates &
 * Schedules tab and are not duplicated here. This component exists purely so
 * the workspace tab mirrors the structural shape of the project-side
 * {@link import("@/pages/project-detail-components/TemplatesSchedulesTab").TemplatesSchedulesTab}
 * (`<Templates/>` → `<Separator/>` → `<Schedules/>`), which avoids a UI layout
 * jump when the real schedules section lands.
 */
function SchedulesStub() {
  return (
    <section
      data-testid="workspace-schedules-stub"
      className="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
    >
      <h3 className="mb-1 text-sm font-medium text-foreground">Schedules</h3>
      <p>
        Workspace-level schedules are planned in a future milestone.
        Project-level schedules remain available under each project&apos;s
        Templates &amp; Schedules tab.
      </p>
    </section>
  );
}

/**
 * "Templates &amp; Schedules" tab on the workspace-detail page.
 *
 * Pure composition wrapper: renders the existing
 * {@link WorkspaceTemplatesSection} unchanged, followed by a placeholder
 * {@link SchedulesStub} that explains where to find project-level schedules.
 * The shape (`<Templates/>` → `<Separator/>` → `<Schedules/>`) deliberately
 * parallels the project-side `TemplatesSchedulesTab` so the two tabs look
 * structurally identical.
 */
export function WorkspaceTemplatesSchedulesTab({
  workspaceId,
}: {
  workspaceId: string;
}) {
  return (
    <div className="space-y-6" data-testid="workspace-templates-schedules-tab">
      <WorkspaceTemplatesSection workspaceId={workspaceId} />
      <Separator />
      <SchedulesStub />
    </div>
  );
}

export default WorkspaceTemplatesSchedulesTab;
