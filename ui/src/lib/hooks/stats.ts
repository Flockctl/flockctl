import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { fetchTaskStats, fetchProjectStats } from "../api";
import type { TaskStats, ProjectStats } from "../types";
import { queryKeys } from "./core";
import { useWsAwarePolling } from "../global-ws";

// --- Task Stats hook ---
//
// Polling cadence routed through `useWsAwarePolling` (audit-round-5):
// silenced when the global WS is connected (task_* events already
// invalidate the matching queryKey) and paused on hidden tabs.

export function useTaskStats(
  projectId?: string,
  options?: Partial<UseQueryOptions<TaskStats>>,
) {
  const refetchInterval = useWsAwarePolling(30_000);
  return useQuery({
    queryKey: queryKeys.taskStats(projectId),
    queryFn: () => fetchTaskStats(projectId),
    refetchInterval,
    ...options,
  });
}

// --- Project Stats hook ---

export function useProjectStats(
  projectId: string,
  options?: Partial<UseQueryOptions<ProjectStats>>,
) {
  const refetchInterval = useWsAwarePolling(30_000);
  return useQuery({
    queryKey: queryKeys.projectStats(projectId),
    queryFn: () => fetchProjectStats(projectId),
    enabled: !!projectId,
    refetchInterval,
    ...options,
  });
}
