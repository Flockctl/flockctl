import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  fetchPlanFile,
  updatePlanFile,
  fetchMilestoneReadme,
} from "../api";
import { queryKeys } from "./core";

// --- Plan File hooks ---

export function usePlanFile(
  projectId: string,
  params: { type: string; milestone?: string; slice?: string; task?: string },
  options?: Partial<UseQueryOptions<{ content: string; path: string }>>,
) {
  return useQuery({
    queryKey: queryKeys.planFile(projectId, params.type, params.milestone ?? params.slice ?? params.task ?? ""),
    queryFn: () => fetchPlanFile(projectId, params),
    enabled: !!projectId && !!params.type,
    ...options,
  });
}

export function useMilestoneReadme(
  projectId: string,
  milestoneSlug: string,
  options?: Partial<UseQueryOptions<{ content: string; path: string }>>,
) {
  return useQuery({
    queryKey: ["projects", projectId, "milestones", milestoneSlug, "readme"] as const,
    queryFn: () => fetchMilestoneReadme(projectId, milestoneSlug),
    enabled: !!projectId && !!milestoneSlug,
    retry: false,
    ...options,
  });
}

export function useUpdatePlanFile(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { type: string; milestone?: string; slice?: string; task?: string; content: string }) =>
      updatePlanFile(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}
