import { FlatCard } from "@/components/design";

import { ProjectTemplatesSection } from "./ProjectTemplatesSection";
import { ProjectSchedulesSection } from "./ProjectSchedulesSection";

/**
 * "Templates & Schedules" tab on the redesigned project-detail page (M23 /
 * project-detail / T07).
 *
 * Pure layout: lifts the two existing project-scoped sections — the
 * project-only templates list and the project-only schedules list — into a
 * side-by-side two-column flat layout.
 *
 *   ┌──────────────────────────────┐  ┌──────────────────────────────┐
 *   │ Templates (project)          │  │ Scheduled tasks (project)    │
 *   │   header  + "Create" button  │  │   header  + "Create" button  │
 *   │   ─────────────────────────  │  │   ─────────────────────────  │
 *   │   table / empty state        │  │   table / empty state        │
 *   └──────────────────────────────┘  └──────────────────────────────┘
 *
 * The two sub-sections own their own data fetching, mutation calls, and
 * dialog wiring — this wrapper does not duplicate that. Add-affordances
 * (Create Template, Create Schedule) continue to open the existing M25
 * template dialog and M21 schedule dialog with the project scope
 * pre-selected and locked, so the behaviour contract is unchanged.
 *
 * Layout note: the columns stack on small viewports (`grid-cols-1`) and
 * split 1fr/1fr on `lg` and up. The prototype uses `gap-4`.
 */
export function TemplatesAndSchedulesTab({
  projectId,
}: {
  projectId: string;
}) {
  return (
    <div
      className="grid grid-cols-1 gap-4 lg:grid-cols-2"
      data-testid="project-templates-and-schedules-tab"
    >
      <div data-testid="project-templates-card">
        <FlatCard className="p-4">
          <ProjectTemplatesSection projectId={projectId} />
        </FlatCard>
      </div>
      <div data-testid="project-schedules-card">
        <FlatCard className="p-4">
          <ProjectSchedulesSection projectId={projectId} />
        </FlatCard>
      </div>
    </div>
  );
}

export default TemplatesAndSchedulesTab;
