/**
 * Pure helper that splits a flat list of projects into workspace-grouped
 * buckets plus a "standalone" bucket for projects with no workspace.
 *
 * Intentionally framework-free — no React, no async, no fetching. Lives
 * here (next to projects.tsx) so the projects page can render the
 * grouped layout without inlining the bookkeeping. Tested in isolation
 * under src/__tests__/pages/projects-group.test.ts.
 *
 * Sort contract:
 *   - workspaces: by ws.name ascending (locale-aware).
 *   - projects within each workspace: by last_activity_at descending
 *     (most recently active first).
 *   - standalone projects: by last_activity_at descending.
 */

export interface GroupableProject {
  id: string;
  workspace_id: string | number | null | undefined;
  last_activity_at: string | number | Date;
}

export interface GroupableWorkspace {
  id: string | number;
  name: string;
}

export interface GroupedProjects<
  P extends GroupableProject = GroupableProject,
  W extends GroupableWorkspace = GroupableWorkspace,
> {
  workspaces: { ws: W; projects: P[] }[];
  standalone: P[];
}

function activityMs(value: GroupableProject["last_activity_at"]): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function groupByWorkspace<
  P extends GroupableProject,
  W extends GroupableWorkspace,
>(projects: P[], workspaces: W[]): GroupedProjects<P, W> {
  const wsById = new Map<string | number, W>(
    workspaces.map((w) => [w.id, w]),
  );
  const grouped = new Map<string | number, P[]>();
  const standalone: P[] = [];

  for (const p of projects) {
    if (
      p.workspace_id !== null &&
      p.workspace_id !== undefined &&
      wsById.has(p.workspace_id)
    ) {
      const arr = grouped.get(p.workspace_id) ?? [];
      arr.push(p);
      grouped.set(p.workspace_id, arr);
    } else {
      standalone.push(p);
    }
  }

  const byActivityDesc = (a: P, b: P) =>
    activityMs(b.last_activity_at) - activityMs(a.last_activity_at);

  return {
    workspaces: [...grouped.entries()]
      .map(([id, ps]) => ({
        ws: wsById.get(id)!,
        projects: ps.slice().sort(byActivityDesc),
      }))
      .sort((a, b) => a.ws.name.localeCompare(b.ws.name)),
    standalone: standalone.slice().sort(byActivityDesc),
  };
}
