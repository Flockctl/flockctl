import { ProjectTemplatesSection } from "./ProjectTemplatesSection";
import { ProjectSchedulesSection } from "./ProjectSchedulesSection";
import { Separator } from "@/components/ui/separator";

/**
 * "Templates & Schedules" tab on the redesigned project-detail page.
 *
 * Pure composition: the existing {@link ProjectTemplatesSection} and
 * {@link ProjectSchedulesSection} are lifted out of the old tree-view header
 * and stacked under a single tab so they stop competing with stats/planning
 * for screen real estate. Neither sub-component has been modified — both
 * continue to own their own CRUD flows and cache invalidation.
 *
 * The separator is visual only; it matches the `<Separator />` pattern used
 * elsewhere in the project-detail surface.
 */
export function TemplatesSchedulesTab({ projectId }: { projectId: string }) {
  return (
    <div className="space-y-6" data-testid="project-templates-schedules-tab">
      <ProjectTemplatesSection projectId={projectId} />
      <Separator />
      <ProjectSchedulesSection projectId={projectId} />
    </div>
  );
}

export default TemplatesSchedulesTab;
