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
  gitPullProject,
} from "../api";
import type {
  GitPullResult,
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

/**
 * Run `git pull --ff-only` against the project's local clone. The
 * mutation always resolves (HTTP 200) — caller inspects the returned
 * `GitPullResult.ok` to distinguish success from a structured failure.
 *
 * On success we invalidate the project query and the project tree so any
 * derived UI (file lists, plan-store summaries) reflects the new HEAD.
 * On structured failure (`ok: false`) we deliberately do *not* invalidate
 * — nothing changed on disk, and a needless refetch would just thrash
 * the UI right when we want to show the error modal cleanly.
 */
export function useGitPullProject() {
  const queryClient = useQueryClient();
  return useMutation<GitPullResult, Error, string>({
    mutationFn: (projectId) => gitPullProject(projectId),
    onSuccess: (result, projectId) => {
      if (result.ok && !result.already_up_to_date) {
        queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.projectTree(projectId) });
      }
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
