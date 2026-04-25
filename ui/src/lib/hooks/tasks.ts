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

export function useCancelTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => cancelTask(taskId),
    onSuccess: (_result, taskId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
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

export function useApproveTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, note }: { taskId: string; note?: string }) => approveTask(taskId, note),
    onSuccess: (_result, { taskId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

export function useRejectTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, note }: { taskId: string; note?: string }) => rejectTask(taskId, note),
    onSuccess: (_result, { taskId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, data }: { taskId: string; data: TaskUpdate }) =>
      updateTask(taskId, data),
    onSuccess: (_, { taskId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}
