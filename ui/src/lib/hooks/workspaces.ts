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
  fetchWorkspaceAllowedKeys,
  gitPullWorkspace,
  gitCommitWorkspace,
  gitPushWorkspace,
  gitStatusWorkspace,
} from "../api";
import type {
  GitCommitBody,
  GitCommitResult,
  GitPullResult,
  GitPushBody,
  GitPushResult,
  GitStatusResult,
  Workspace,
  WorkspaceAllowedKeys,
  WorkspaceCreate,
  WorkspaceUpdate,
  WorkspaceWithProjects,
  WorkspaceDashboard,
  WorkspaceDependencyGraph,
} from "../types";
import { queryKeys } from "./core";
import { useWsAwarePolling } from "../global-ws";

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
  const refetchInterval = useWsAwarePolling(30_000);
  return useQuery({
    queryKey: queryKeys.workspaceDashboard(workspaceId),
    queryFn: () => fetchWorkspaceDashboard(workspaceId),
    enabled: !!workspaceId,
    refetchInterval,
    ...options,
  });
}

export function useWorkspaceDependencyGraph(
  workspaceId: string,
  options?: Partial<UseQueryOptions<WorkspaceDependencyGraph>>,
) {
  const refetchInterval = useWsAwarePolling(30_000);
  return useQuery({
    queryKey: queryKeys.workspaceDependencyGraph(workspaceId),
    queryFn: () => fetchWorkspaceDependencyGraph(workspaceId),
    enabled: !!workspaceId,
    refetchInterval,
    ...options,
  });
}

/**
 * Fetch the resolved AI-key allow-list for a workspace. Use this to filter
 * the AI-key picker on workspace-only chats (started from the workspace
 * page) so only permitted keys show up — same UX the project chats already
 * get via {@link useProjectAllowedKeys}.
 *
 * `allowedKeyIds === null` → no restriction, all active keys are allowed.
 */
export function useWorkspaceAllowedKeys(
  workspaceId: string,
  options?: Partial<UseQueryOptions<WorkspaceAllowedKeys>>,
) {
  return useQuery({
    queryKey: queryKeys.workspaceAllowedKeys(workspaceId),
    queryFn: () => fetchWorkspaceAllowedKeys(workspaceId),
    enabled: !!workspaceId,
    ...options,
  });
}

/**
 * Run `git pull --ff-only` against the workspace's local clone. Direct
 * mirror of {@link useGitPullProject} — the mutation always resolves
 * (HTTP 200) and the caller inspects `GitPullResult.ok` to distinguish
 * success from a structured failure.
 *
 * On success (and only when the pull actually moved HEAD) we invalidate
 * the workspace query so any derived UI reflects the new state. On
 * `already_up_to_date` we deliberately do nothing — nothing changed on
 * disk, a refetch would just thrash. On `ok:false` we also skip the
 * invalidate for the same reason: surface the error modal cleanly.
 */
export function useGitPullWorkspace() {
  const queryClient = useQueryClient();
  return useMutation<GitPullResult, Error, string>({
    mutationFn: (workspaceId) => gitPullWorkspace(workspaceId),
    onSuccess: (result, workspaceId) => {
      if (result.ok && !result.already_up_to_date) {
        queryClient.invalidateQueries({ queryKey: queryKeys.workspace(workspaceId) });
      }
    },
  });
}

/**
 * Fetch `git status --porcelain` for a workspace's local clone. Direct
 * mirror of {@link useGitStatusProject} — always resolves with HTTP 200
 * and the caller inspects `GitStatusResult.ok`. The Commit dialog wires
 * `enabled` / `staleTime: 0` per-open so each open gets a fresh peek
 * (the working tree is by definition mutable between opens).
 */
export function useGitStatusWorkspace(
  workspaceId: string,
  options?: Partial<UseQueryOptions<GitStatusResult>>,
) {
  return useQuery({
    queryKey: queryKeys.workspaceGitStatus(workspaceId),
    queryFn: () => gitStatusWorkspace(workspaceId),
    enabled: !!workspaceId,
    ...options,
  });
}

/**
 * Stage and commit on the workspace's branch. Direct mirror of
 * {@link useGitCommitProject} — the mutation always resolves (HTTP 200)
 * and the caller inspects `GitCommitResult.ok`.
 *
 * On settle (success OR structured failure) we invalidate the workspace
 * query, because a failure may still have partially staged files (the
 * service stages before re-reading status to detect `empty_index`), so
 * any working-tree-dependent UI is stale either way.
 */
export function useGitCommitWorkspace() {
  const queryClient = useQueryClient();
  return useMutation<
    GitCommitResult,
    Error,
    { workspaceId: string; body: GitCommitBody }
  >({
    mutationFn: ({ workspaceId, body }) => gitCommitWorkspace(workspaceId, body),
    onSettled: (_result, _err, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspace(workspaceId) });
      // Same rationale as the project mirror — commit either consumed
      // entries (success) or partially staged them before failure, so
      // any cached porcelain peek is now stale and a fresh next read is
      // the right behaviour.
      queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceGitStatus(workspaceId),
      });
    },
  });
}

/**
 * Push the workspace's current branch. Direct mirror of
 * {@link useGitPushProject} — the mutation always resolves (HTTP 200)
 * and the caller inspects `GitPushResult.ok`.
 *
 * On settle (success OR structured failure OR network error) we
 * invalidate the workspace query. A push (or refused push) can change
 * upstream-tracking state read by other UI; settling on either path
 * keeps that surface in sync.
 */
export function useGitPushWorkspace() {
  const queryClient = useQueryClient();
  return useMutation<
    GitPushResult,
    Error,
    { workspaceId: string; body?: GitPushBody }
  >({
    mutationFn: ({ workspaceId, body }) => gitPushWorkspace(workspaceId, body),
    onSettled: (_result, _err, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspace(workspaceId) });
    },
  });
}
