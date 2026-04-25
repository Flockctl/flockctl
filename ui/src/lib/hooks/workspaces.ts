import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  fetchWorkspaces,
  fetchWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  addProjectToWorkspace,
  removeProjectFromWorkspace,
  fetchWorkspaceDashboard,
  fetchWorkspaceDependencyGraph,
} from "../api";
import type {
  Workspace,
  WorkspaceCreate,
  WorkspaceUpdate,
  WorkspaceWithProjects,
  WorkspaceDashboard,
  WorkspaceDependencyGraph,
} from "../types";
import { queryKeys } from "./core";

// --- Workspace hooks ---

export function useWorkspaces(
  options?: Partial<UseQueryOptions<Workspace[]>>,
) {
  return useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: () => fetchWorkspaces(),
    ...options,
  });
}

export function useWorkspace(
  id: string,
  options?: Partial<UseQueryOptions<WorkspaceWithProjects>>,
) {
  return useQuery({
    queryKey: queryKeys.workspace(id),
    queryFn: () => fetchWorkspace(id),
    enabled: !!id,
    ...options,
  });
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: WorkspaceCreate) => createWorkspace(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
  });
}

export function useUpdateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: WorkspaceUpdate }) =>
      updateWorkspace(id, data),
    onSuccess: (_result, { id }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspace(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
  });
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWorkspace(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
  });
}

export function useAddProjectToWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      workspaceId,
      projectId,
    }: {
      workspaceId: string;
      projectId: string;
    }) => addProjectToWorkspace(workspaceId, projectId),
    onSuccess: (_result, { workspaceId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspace(workspaceId),
      });
    },
  });
}

export function useRemoveProjectFromWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      workspaceId,
      projectId,
    }: {
      workspaceId: string;
      projectId: string;
    }) => removeProjectFromWorkspace(workspaceId, projectId),
    onSuccess: (_result, { workspaceId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspace(workspaceId),
      });
    },
  });
}

export function useWorkspaceDashboard(
  workspaceId: string,
  options?: Partial<UseQueryOptions<WorkspaceDashboard>>,
) {
  return useQuery({
    queryKey: queryKeys.workspaceDashboard(workspaceId),
    queryFn: () => fetchWorkspaceDashboard(workspaceId),
    enabled: !!workspaceId,
    refetchInterval: 30_000,
    ...options,
  });
}

export function useWorkspaceDependencyGraph(
  workspaceId: string,
  options?: Partial<UseQueryOptions<WorkspaceDependencyGraph>>,
) {
  return useQuery({
    queryKey: queryKeys.workspaceDependencyGraph(workspaceId),
    queryFn: () => fetchWorkspaceDependencyGraph(workspaceId),
    enabled: !!workspaceId,
    refetchInterval: 30_000,
    ...options,
  });
}
