import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  fetchProjects,
  fetchProject,
  createProject,
  updateProject,
  deleteProject,
  fetchProjectTree,
  fetchProjectAllowedKeys,
  fetchAutoExecStatus,
} from "../api";
import type {
  Project,
  ProjectAllowedKeys,
  ProjectCreate,
  ProjectUpdate,
  ProjectTree,
  AutoExecuteStatusResponse,
} from "../types";
import { queryKeys } from "./core";

// --- Project hooks ---

export function useProjects(
  options?: Partial<UseQueryOptions<Project[]>>,
) {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => fetchProjects(),
    ...options,
  });
}

export function useProject(
  id: string,
  options?: Partial<UseQueryOptions<Project>>,
) {
  return useQuery({
    queryKey: queryKeys.project(id),
    queryFn: () => fetchProject(id),
    enabled: !!id,
    ...options,
  });
}

export function useProjectTree(
  id: string,
  options?: Partial<UseQueryOptions<ProjectTree>>,
) {
  return useQuery({
    queryKey: queryKeys.projectTree(id),
    queryFn: () => fetchProjectTree(id),
    enabled: !!id,
    ...options,
  });
}

/**
 * Fetch the resolved AI-key allow-list for a project (workspace → project
 * inheritance applied server-side). Use this to filter the AI-key picker in
 * chats, tasks, and the Generate Plan dialog so only permitted keys show up.
 *
 * `allowedKeyIds === null` → no restriction, all active keys are allowed.
 */
export function useProjectAllowedKeys(
  projectId: string,
  options?: Partial<UseQueryOptions<ProjectAllowedKeys>>,
) {
  return useQuery({
    queryKey: queryKeys.projectAllowedKeys(projectId),
    queryFn: () => fetchProjectAllowedKeys(projectId),
    enabled: !!projectId,
    ...options,
  });
}

export function useAutoExecStatus(
  projectId: string,
  milestoneId: string,
  options?: Partial<UseQueryOptions<AutoExecuteStatusResponse>>,
) {
  return useQuery({
    queryKey: queryKeys.autoExecStatus(projectId, milestoneId),
    queryFn: () => fetchAutoExecStatus(projectId, milestoneId),
    enabled: !!projectId && !!milestoneId,
    ...options,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ProjectCreate) => createProject(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ProjectUpdate }) =>
      updateProject(id, data),
    onSuccess: (_result, { id }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.project(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      // Allow-list may have just been changed via this PATCH — force UI
      // pickers to re-resolve against the updated inheritance chain.
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectAllowedKeys(id),
      });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}
