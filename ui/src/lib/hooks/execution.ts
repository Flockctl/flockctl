import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import {
  fetchExecutionGraph,
  fetchProjectExecutionOverview,
} from "../api";
import type {
  ExecutionGraphResponse,
  ProjectExecutionOverviewResponse,
} from "../types";
import { queryKeys } from "./core";

// --- Execution Graph hook ---

export function useExecutionGraph(
  projectId: string,
  milestoneId: string,
  options?: Partial<UseQueryOptions<ExecutionGraphResponse>> & {
    refetchInterval?: number | false;
  },
) {
  return useQuery({
    queryKey: queryKeys.executionGraph(projectId, milestoneId),
    queryFn: () => fetchExecutionGraph(projectId, milestoneId),
    enabled: !!projectId && !!milestoneId,
    ...options,
  });
}

export function useProjectExecutionOverview(
  projectId: string,
  options?: Partial<UseQueryOptions<ProjectExecutionOverviewResponse>> & {
    refetchInterval?: number | false;
  },
) {
  return useQuery({
    queryKey: queryKeys.executionOverview(projectId),
    queryFn: () => fetchProjectExecutionOverview(projectId),
    enabled: !!projectId,
    ...options,
  });
}
