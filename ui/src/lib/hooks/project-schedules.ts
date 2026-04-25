import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { fetchProjectSchedules } from "../api";
import type { PaginatedResponse, Schedule } from "../types";
import { queryKeys } from "./core";

// --- Project Schedule hooks ---

export function useProjectSchedules(
  projectId: string,
  offset = 0,
  limit = 50,
  options?: Partial<UseQueryOptions<PaginatedResponse<Schedule>>>,
) {
  return useQuery({
    queryKey: [...queryKeys.projectSchedules(projectId), { offset, limit }],
    queryFn: () => fetchProjectSchedules(projectId, offset, limit),
    enabled: !!projectId,
    ...options,
  });
}
