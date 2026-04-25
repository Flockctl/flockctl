import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchProjectConfig,
  updateProjectConfig,
  fetchWorkspaceConfig,
  updateWorkspaceConfig,
} from "../api";
import { queryKeys } from "./core";

// --- Project Config hooks ---

export function useProjectConfig(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectConfig(projectId),
    queryFn: () => fetchProjectConfig(projectId),
    enabled: !!projectId,
  });
}

export function useUpdateProjectConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, config }: { projectId: string; config: Record<string, any> }) =>
      updateProjectConfig(projectId, config),
    onSuccess: (_result, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projectConfig(projectId) });
    },
  });
}

// --- Workspace Config hooks ---

export function useWorkspaceConfig(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.workspaceConfig(workspaceId),
    queryFn: () => fetchWorkspaceConfig(workspaceId),
    enabled: !!workspaceId,
  });
}

export function useUpdateWorkspaceConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, config }: { workspaceId: string; config: Record<string, any> }) =>
      updateWorkspaceConfig(workspaceId, config),
    onSuccess: (_result, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaceConfig(workspaceId) });
    },
  });
}
