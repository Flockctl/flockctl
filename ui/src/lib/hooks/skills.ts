import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchGlobalSkills,
  fetchWorkspaceSkills,
  fetchProjectSkills,
  createGlobalSkill,
  createWorkspaceSkill,
  createProjectSkill,
  deleteWorkspaceSkill,
  deleteProjectSkill,
} from "../api";
import { queryKeys } from "./core";

// --- Skills hooks ---

export function useGlobalSkills() {
  return useQuery({
    queryKey: queryKeys.globalSkills,
    queryFn: fetchGlobalSkills,
  });
}

export function useWorkspaceSkills(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.workspaceSkills(workspaceId),
    queryFn: () => fetchWorkspaceSkills(workspaceId),
    enabled: !!workspaceId,
  });
}

export function useProjectSkills(workspaceId: string, projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectSkills(workspaceId, projectId),
    queryFn: () => fetchProjectSkills(workspaceId, projectId),
    enabled: !!workspaceId && !!projectId,
  });
}

export function useCreateGlobalSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; content: string }) => createGlobalSkill(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.globalSkills }); },
  });
}

export function useCreateWorkspaceSkill(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; content: string }) => createWorkspaceSkill(workspaceId, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSkills(workspaceId) }); },
  });
}

export function useCreateProjectSkill(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; content: string }) => createProjectSkill(workspaceId, projectId, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.projectSkills(workspaceId, projectId) }); },
  });
}

export function useDeleteWorkspaceSkill(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteWorkspaceSkill(workspaceId, name),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSkills(workspaceId) }); },
  });
}

export function useDeleteProjectSkill(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteProjectSkill(workspaceId, projectId, name),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.projectSkills(workspaceId, projectId) }); },
  });
}
