import { useProjectStats } from "./hooks/stats";
import { useAttention } from "./hooks/attention";
import { useUsageSummary } from "./hooks/usage";

/**
 * Aggregator hook for the project-detail KPI bar (milestone 09, slice 04).
 *
 * This hook does NOT open a new network round-trip. It stitches three
 * already-existing data hooks into one typed view object:
 *
 *   - `useProjectStats(projectId)` — slice totals + active/failed task counts
 *   - `useAttention()`             — the global approval inbox; filtered
 *                                     down to rows that belong to this
 *                                     project
 *   - `useUsageSummary({...})`     — token + cost totals for the last 24h
 *                                     (period is forwarded as the hook's
 *                                     only knob — callers may override it
 *                                     to e.g. "7d" without touching this
 *                                     module)
 *
 * Invariant (from parent slice.md 04-kpi-bar): a grep for `new fetch` or
 * `new useQuery` in the diff that adds this file must return zero hits.
 * Keep it that way — every new network call goes through one of the three
 * existing hooks.
 *
 * Corner cases:
 *   - Empty project (no slices / tasks / usage) → every numeric field is
 *     `0`; the KPI bar should render flat zeros, not "—" placeholders.
 *   - A single underlying hook failing is surfaced through the per-field
 *     `error` map so the KPI bar can render a skeleton only on the
 *     affected tile instead of collapsing the whole row.
 *   - `useProjectStats` reports `isLoading` even while it's just stale-
 *     refetching; we intentionally pass that through so downstream
 *     components can debounce their skeletons themselves.
 */

export interface KpiData {
  slicesDone: number;
  slicesTotal: number;
  activeTasks: number;
  pendingApproval: number;
  failed24h: number;
  tokens24h: number;
  costCents24h: number;
  isLoading: {
    slicesDone: boolean;
    slicesTotal: boolean;
    activeTasks: boolean;
    pendingApproval: boolean;
    failed24h: boolean;
    tokens24h: boolean;
    costCents24h: boolean;
  };
  error: {
    slicesDone: unknown;
    slicesTotal: unknown;
    activeTasks: unknown;
    pendingApproval: unknown;
    failed24h: unknown;
    tokens24h: unknown;
    costCents24h: unknown;
  };
}

/**
 * @param projectId - the project whose KPI tiles we're rendering. Passed
 *   through to `useProjectStats` and `useUsageSummary`; empty string is
 *   accepted but will short-circuit both upstream hooks (via their own
 *   `enabled: !!projectId` guards).
 * @param period - the usage-summary window. Defaults to `"24h"` to match
 *   the field names `tokens24h` / `costCents24h`; callers that want a
 *   different window are expected to also rename their consuming fields.
 */
export function useKpiData(
  projectId: string,
  period: string = "24h",
): KpiData {
  const projectStats = useProjectStats(projectId);
  const attention = useAttention();
  const usage = useUsageSummary({ project_id: projectId, period });

  // `useAttention` is a global inbox — filter it down to this project's
  // rows. `chat_*` items can have `project_id === null` (workspace-level
  // chats); those never match a concrete projectId and are dropped.
  const pendingApproval = (attention.items ?? []).reduce(
    (n, item) => (item.project_id === projectId ? n + 1 : n),
    0,
  );

  const slices = projectStats.data?.slices;
  const tasks = projectStats.data?.tasks;

  const slicesTotal = slices?.total ?? 0;
  const slicesDone = slices?.completed ?? 0;
  // "Active" = the daemon is going to / already has work outstanding on
  // this task. `queued` is excluded on purpose — that's backlog, not
  // in-flight work.
  const activeTasks = (tasks?.running ?? 0) + (tasks?.assigned ?? 0);
  // ProjectStats counts are all-time; the KPI bar labels it `failed24h`
  // as a forward-looking name. When the backend grows a period filter
  // for /projects/:id/stats this mapping can tighten without the KPI
  // bar needing to change.
  const failed24h = tasks?.failed ?? 0;

  const tokens24h =
    (usage.data?.total_input_tokens ?? 0) +
    (usage.data?.total_output_tokens ?? 0);
  // Cost is stored as USD decimal on the wire; the KPI bar wants
  // integer cents so formatters can stay allocation-free.
  const costCents24h = Math.round((usage.data?.total_cost_usd ?? 0) * 100);

  return {
    slicesDone,
    slicesTotal,
    activeTasks,
    pendingApproval,
    failed24h,
    tokens24h,
    costCents24h,
    isLoading: {
      slicesDone: projectStats.isLoading,
      slicesTotal: projectStats.isLoading,
      activeTasks: projectStats.isLoading,
      pendingApproval: attention.isLoading,
      failed24h: projectStats.isLoading,
      tokens24h: usage.isLoading,
      costCents24h: usage.isLoading,
    },
    error: {
      slicesDone: projectStats.error,
      slicesTotal: projectStats.error,
      activeTasks: projectStats.error,
      pendingApproval: attention.error,
      failed24h: projectStats.error,
      tokens24h: usage.error,
      costCents24h: usage.error,
    },
  };
}
