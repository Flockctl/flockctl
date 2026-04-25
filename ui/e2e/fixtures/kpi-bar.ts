import type { APIRequestContext } from "@playwright/test";
import { createProject, uniq } from "../_helpers";

/**
 * Fixtures for the mission-control KPI bar e2e spec
 * (milestone 09 / slice 04).
 *
 * The KPI bar reads from three server hooks:
 *
 *   - `useProjectStats(projectId)` → GET /projects/:id/stats
 *   - `useAttention()`             → GET /attention
 *   - `useUsageSummary(...)`       → GET /usage/summary
 *
 * All three are deterministic about zero-state: a freshly-created
 * project has no slices, no tasks, and no usage records, so the KPI
 * bar renders `0 / 0`, `0`, `0`, `0`, and `0` respectively. That
 * zero-state is the baseline we snapshot; the number-match test then
 * asserts the rendered values line up with the raw stats payload, so
 * a future divergence between `useKpiData` and `/projects/:id/stats`
 * will fail loudly even without having to seed non-zero data.
 *
 * The spec also seeds a queued task via `POST /tasks` to exercise the
 * ~2s react-query invalidation contract — a brand-new task flips
 * `tasks.total` but not `tasks.running` / `tasks.assigned`, so the
 * value we re-fetch in the test is what actually shows up in the
 * `Active tasks` tile after the invalidation round-trip.
 */

export interface KpiBarProject {
  projectId: number;
  projectName: string;
  projectPath: string;
}

/**
 * Seed a minimal project for the KPI bar tests. We deliberately do
 * NOT seed slices/tasks/usage here — the zero-state is the stable
 * baseline. Tests that need non-zero data seed it inline.
 */
export async function seedKpiBarProject(
  request: APIRequestContext,
): Promise<KpiBarProject> {
  const name = uniq("kpi-bar");
  const project = await createProject(request, name);
  return {
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
  };
}

/**
 * Shape of the `/projects/:id/stats` payload we care about for the
 * number-match assertion. The server returns many more fields; we
 * narrow here so a type-safe `pickStats()` helper can be written
 * without the whole route schema leaking into the test.
 */
export interface ProjectStatsSnapshot {
  slices: { total: number; completed: number };
  tasks: {
    total: number;
    queued: number;
    assigned: number;
    running: number;
    completed: number;
    failed: number;
  };
  usage: {
    total_cost_usd?: number;
    totalCostUsd?: number;
    total_input_tokens?: number;
    totalInputTokens?: number;
    total_output_tokens?: number;
    totalOutputTokens?: number;
  };
}

/** Fetch the raw stats the KPI bar is supposed to mirror. */
export async function fetchProjectStats(
  request: APIRequestContext,
  projectId: number,
): Promise<ProjectStatsSnapshot> {
  const res = await request.get(`/projects/${projectId}/stats`);
  if (res.status() !== 200) {
    throw new Error(
      `GET /projects/${projectId}/stats failed: ${res.status()} ${await res.text()}`,
    );
  }
  return (await res.json()) as ProjectStatsSnapshot;
}
