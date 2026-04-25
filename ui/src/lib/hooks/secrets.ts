import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchGlobalSecrets,
  upsertGlobalSecret,
  deleteGlobalSecret,
  fetchWorkspaceSecrets,
  upsertWorkspaceSecret,
  deleteWorkspaceSecret,
  fetchProjectSecrets,
  upsertProjectSecret,
  deleteProjectSecret,
} from "../api";
import { queryKeys } from "./core";

// --- Secrets hooks ---

export function useGlobalSecrets() {
  return useQuery({
    queryKey: queryKeys.globalSecrets,
    queryFn: fetchGlobalSecrets,
  });
}

export function useWorkspaceSecrets(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.workspaceSecrets(workspaceId),
    queryFn: () => fetchWorkspaceSecrets(workspaceId),
    enabled: !!workspaceId,
  });
}

export function useProjectSecrets(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectSecrets(projectId),
    queryFn: () => fetchProjectSecrets(projectId),
    enabled: !!projectId,
  });
}

export function useUpsertGlobalSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; value: string; description?: string | null }) =>
      upsertGlobalSecret(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.globalSecrets });
    },
  });
}

export function useUpsertWorkspaceSecret(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; value: string; description?: string | null }) =>
      upsertWorkspaceSecret(workspaceId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSecrets(workspaceId) });
    },
  });
}

export function useUpsertProjectSecret(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; value: string; description?: string | null }) =>
      upsertProjectSecret(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projectSecrets(projectId) });
    },
  });
}

export function useDeleteGlobalSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteGlobalSecret(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.globalSecrets });
    },
  });
}

export function useDeleteWorkspaceSecret(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteWorkspaceSecret(workspaceId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSecrets(workspaceId) });
    },
  });
}

export function useDeleteProjectSecret(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteProjectSecret(projectId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projectSecrets(projectId) });
    },
  });
}
