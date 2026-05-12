import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  fetchTasks,
  fetchTask,
  fetchTaskLogs,
  createTask,
  updateTask,
  cancelTask,
  removeTaskWorktree,
  type TaskWorktreeRemoveResponse,
  rerunTask,
  approveTask,
  rejectTask,
} from "../api";
import type {
  PaginatedResponse,
  Task,
  TaskLog,
  TaskCreate,
  TaskUpdate,
  TaskFilters,
} from "../types";
// Const enum lookup for status patches in `useCancelTask`. Imported
// at the value site only — keep the type-only block above unchanged.
import { TaskStatus as TaskStatusValue } from "../types";
import { queryKeys } from "./core";

// Re-export the shared permission request shape under its public alias.
export type { PermissionRequestUI as PermissionRequest } from "./core";

// --- Task hooks ---

export function useTasks(
  offset = 0,
  limit = 50,
  filters?: TaskFilters,
  options?: Partial<UseQueryOptions<PaginatedResponse<Task>>>,
) {
  return useQuery({
    queryKey: [...queryKeys.tasks, { offset, limit, ...filters }],
    queryFn: () => fetchTasks(offset, limit, filters),
    ...options,
  });
}

export function useTask(
  taskId: string,
  options?: Partial<UseQueryOptions<Task>>,
) {
  return useQuery({
    queryKey: queryKeys.task(taskId),
    queryFn: () => fetchTask(taskId),
    enabled: !!taskId,
    ...options,
  });
}

export function useTaskLogs(
  taskId: string,
  options?: Partial<UseQueryOptions<TaskLog[]>>,
) {
  return useQuery({
    queryKey: queryKeys.taskLogs(taskId),
    queryFn: () => fetchTaskLogs(taskId),
    enabled: !!taskId,
    ...options,
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: TaskCreate) => createTask(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

/**
 * Patch a single task row across every cached page of `useTasks(...)`.
 * Used by status-changing mutations (cancel / approve / reject) to
 * avoid the broad-list refetch that the previous `invalidateQueries`
 * call triggered. Returns silently when the row isn't in any cached
 * page — those pages will refresh on their next normal refetch.
 */
function patchTaskInLists(
  queryClient: ReturnType<typeof useQueryClient>,
  taskId: string,
  patch: Partial<Task>,
): void {
  queryClient.setQueriesData<PaginatedResponse<Task>>(
    { queryKey: queryKeys.tasks },
    (old) => {
      if (!old) return old;
      let found = false;
      const items = old.items.map((t) => {
        if (String(t.id) !== String(taskId)) return t;
        found = true;
        return { ...t, ...patch };
      });
      return found ? { ...old, items } : old;
    },
  );
  // Patch the detail query too so the open task page reflects the
  // change without a refetch.
  queryClient.setQueryData<Task>(queryKeys.task(taskId), (prev) =>
    prev ? { ...prev, ...patch } : prev,
  );
}

export function useCancelTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => cancelTask(taskId),
    onSuccess: (result, taskId) => {
      // Use the server's response shape when possible; fall back to
      // a minimal patch so the UI shows the cancelled state instantly.
      const patch: Partial<Task> = (result && typeof result === "object"
        ? (result as Partial<Task>)
        : { status: TaskStatusValue.cancelled });
      patchTaskInLists(queryClient, taskId, patch);
    },
  });
}

export function useRerunTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => rerunTask(taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

/**
 * Mutation wrapping `DELETE /tasks/:id/worktree`. Used by the task
 * detail page's "Remove worktree" button. Returns the structured
 * `{ removed, reason }` body so the caller can decide whether to
 * surface a "kept dirty" outcome differently from a clean nuke.
 *
 * 409 dirty handshake — when called without `force` and the worktree
 * has uncommitted changes, the server throws with `status: 409` and
 * `details.reason === "dirty"`. The component-side handler in
 * task-detail.tsx catches that, prompts the user, and re-issues with
 * `force: true`.
 */
export function useRemoveTaskWorktree() {
  const queryClient = useQueryClient();
  return useMutation<
    TaskWorktreeRemoveResponse,
    Error,
    { taskId: string; force?: boolean }
  >({
    mutationFn: ({ taskId, force }) => removeTaskWorktree(taskId, { force }),
    onSuccess: (_, { taskId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

export function useApproveTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, note }: { taskId: string; note?: string }) => approveTask(taskId, note),
    onSuccess: (result, { taskId }) => {
      // Single-row patch (same rationale as useCancelTask).
      const patch: Partial<Task> = (result && typeof result === "object"
        ? (result as Partial<Task>)
        : {});
      patchTaskInLists(queryClient, taskId, patch);
    },
  });
}

export function useRejectTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, note }: { taskId: string; note?: string }) => rejectTask(taskId, note),
    onSuccess: (result, { taskId }) => {
      const patch: Partial<Task> = (result && typeof result === "object"
        ? (result as Partial<Task>)
        : {});
      patchTaskInLists(queryClient, taskId, patch);
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, data }: { taskId: string; data: TaskUpdate }) =>
      updateTask(taskId, data),
    onSuccess: (updatedTask, { taskId }) => {
      // Patch the single-row cache directly instead of nuking the
      // entire `queryKeys.tasks` tree. Saves one refetch per update
      // (the list view structurally-shares the row reference, so the
      // table renders the change without a network round-trip).
      queryClient.setQueryData<Task>(queryKeys.task(taskId), updatedTask);
      // Patch every list-shaped query that has this row in its items.
      // Avoids the full-list refetch under the previous `invalidate`
      // call (audit-round-1 finding: every task mutation forced a
      // refetch of every `useTasks` instance + the kanban + the table).
      queryClient.setQueriesData<PaginatedResponse<Task>>(
        { queryKey: queryKeys.tasks },
        (old) => {
          if (!old) return old;
          let found = false;
          const items = old.items.map((t) => {
            if (String(t.id) !== String(taskId)) return t;
            found = true;
            return updatedTask;
          });
          // Row wasn't in this cached page — leave untouched so other
          // pages don't pick up an unrelated insert.
          return found ? { ...old, items } : old;
        },
      );
    },
  });
}
