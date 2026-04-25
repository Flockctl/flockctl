import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { fetchTaskStats, fetchProjectStats } from "../api";
import type { TaskStats, ProjectStats } from "../types";
import { queryKeys } from "./core";

// --- Task Stats hook ---

export function useTaskStats(
  projectId?: string,
  options?: Partial<UseQueryOptions<TaskStats>>,
) {
  return useQuery({
    queryKey: queryKeys.taskStats(projectId),
    queryFn: () => fetchTaskStats(projectId),
    refetchInterval: 30_000,
    ...options,
  });
}

// --- Project Stats hook ---

export function useProjectStats(
  projectId: string,
  options?: Partial<UseQueryOptions<ProjectStats>>,
) {
  return useQuery({
    queryKey: queryKeys.projectStats(projectId),
    queryFn: () => fetchProjectStats(projectId),
    enabled: !!projectId,
    refetchInterval: 30_000,
    ...options,
  });
}
