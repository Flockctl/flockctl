import { Link } from "react-router-dom";
import { FolderGit2, Layers } from "lucide-react";
import type { Project } from "@/lib/types/project";
import { EmptyState } from "@/components/EmptyState";
import { timeAgo, parseServerTimestamp } from "@/lib/utils";

/**
 * OverviewTab — landing surface for `/workspaces/:id` (M20/00).
 *
 * Renders three blocks: at-a-glance KPI tiles (projects total, last
 * activity), a projects list, and a hint pointing at the other tabs
 * for deeper actions. The data is read from the parent's
 * `useWorkspace()` query — this component is purely presentational,
 * no fetching of its own, so it stays cheap and avoids fanning out
 * a second request for the same workspace.
 *
 * Empty state uses `<EmptyState />` so a freshly-created workspace
 * with zero projects gets a useful prompt instead of a bare list.
 */

export interface OverviewTabProps {
  workspaceId?: string;
  workspaceName?: string;
  projects: Project[];
  /** Wall-clock created_at of the workspace — formatted as "X ago". */
  createdAt: string | undefined;
  /** Optional total task count for KPI tile. */
  tasksTotal?: number | null;
}

function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-[18px] font-semibold tabular-nums leading-tight text-foreground">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function OverviewTab({
  workspaceId,
  workspaceName,
  projects,
  createdAt,
  tasksTotal,
}: OverviewTabProps) {
  const projectCount = projects.length;

  return (
    <div data-testid="workspace-overview-tab" className="flex flex-col gap-4">
      <section
        aria-label="Workspace summary"
        className="grid gap-3 sm:grid-cols-2 md:grid-cols-3"
      >
        <StatTile label="Projects" value={projectCount} hint={projectCount === 1 ? "1 project linked" : undefined} />
        {tasksTotal != null && <StatTile label="Tasks" value={tasksTotal} />}
        {createdAt && <StatTile label="Created" value={timeAgo(createdAt)} hint={parseServerTimestamp(createdAt).toLocaleDateString()} />}
      </section>

      <section aria-labelledby="workspace-projects-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="workspace-projects-heading" className="text-sm font-semibold">
            Projects
          </h2>
          {workspaceName && (
            <span className="text-xs text-muted-foreground">in {workspaceName}</span>
          )}
        </div>
        {projects.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="No projects in this workspace yet"
            description={
              <>
                Add a project from the{" "}
                <Link to="/projects" className="underline">
                  Projects page
                </Link>{" "}
                and assign it to this workspace, or create a new one.
              </>
            }
            data-testid="workspace-overview-empty"
          />
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  to={`/projects/${p.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/40"
                  data-testid="workspace-overview-project-row"
                >
                  <FolderGit2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    {p.path && (
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {p.path}
                      </div>
                    )}
                  </div>
                  <div className="hidden text-xs text-muted-foreground sm:block">
                    {p.created_at ? timeAgo(p.created_at) : ""}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {workspaceId && (
        <p className="text-xs text-muted-foreground">
          Looking for milestones, runs, or settings? Switch to the{" "}
          <strong>Plan</strong>, <strong>Runs</strong>, or <strong>Config</strong>{" "}
          tab above.
        </p>
      )}
    </div>
  );
}

export default OverviewTab;
