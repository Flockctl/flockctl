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
  gitCommitProject,
  gitPushProject,
  gitStatusProject,
} from "../api";
import type {
  GitCommitBody,
  GitCommitResult,
  GitPullResult,
  GitPushBody,
  GitPushResult,
  GitStatusResult,
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

/**
 * Stage and commit on the project's branch. The mutation always resolves
 * (HTTP 200) — caller inspects the returned `GitCommitResult.ok` to
 * distinguish success from a structured failure (`empty_message`,
 * `empty_index`, `unknown_path`, `detached_head`, …).
 *
 * On settle (success or failure) we invalidate the project query and
 * project tree — both drive the dropdown's enable/disable plus any
 * derived UI that reads HEAD or the working-tree state. We invalidate
 * on both branches because:
 *   - A committed change moves HEAD even on `ok:true` → tree is stale.
 *   - A failure may have partially staged files (the service stages
 *     before re-reading status to detect `empty_index`), so the
 *     working-tree status surfaced elsewhere is also stale.
 */
/**
 * Fetch `git status --porcelain` for a project's local clone. Always
 * resolves with HTTP 200; the structured failure shape (`ok: false,
 * reason: ...`) flows through verbatim. The dialog passes
 * `enabled` / `staleTime: 0` per-open so each open gets a fresh peek
 * — the working tree is by definition mutable between opens.
 */
export function useGitStatusProject(
  projectId: string,
  options?: Partial<UseQueryOptions<GitStatusResult>>,
) {
  return useQuery({
    queryKey: queryKeys.projectGitStatus(projectId),
    queryFn: () => gitStatusProject(projectId),
    enabled: !!projectId,
    ...options,
  });
}

export function useGitCommitProject() {
  const queryClient = useQueryClient();
  return useMutation<
    GitCommitResult,
    Error,
    { projectId: string; body: GitCommitBody }
  >({
    mutationFn: ({ projectId, body }) => gitCommitProject(projectId, body),
    onSettled: (_result, _err, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projectTree(projectId) });
      // The porcelain checklist seen by the Commit dialog is now stale —
      // commit either consumed entries (success) or partially staged them
      // (failure path inside `runGitCommit` stages before re-reading
      // status to detect `empty_index`). Either way, a fresh peek is the
      // correct next read.
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectGitStatus(projectId),
      });
    },
  });
}

/**
 * Push the project's current branch. The mutation always resolves
 * (HTTP 200) — caller inspects the returned `GitPushResult.ok` to
 * distinguish success from a structured failure (`auth_failed`,
 * `rejected_non_fast_forward`, `protected_branch`, `no_upstream`, …).
 *
 * On settle (success or failure) we invalidate the project query and
 * project tree — same rationale as commit: the dropdown's
 * enable/disable plus any derived UI may read upstream tracking state
 * that a push (or a refused push) just changed.
 */
export function useGitPushProject() {
  const queryClient = useQueryClient();
  return useMutation<
    GitPushResult,
    Error,
    { projectId: string; body?: GitPushBody }
  >({
    mutationFn: ({ projectId, body }) => gitPushProject(projectId, body),
    onSettled: (_result, _err, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projectTree(projectId) });
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
