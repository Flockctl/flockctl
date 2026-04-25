import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  fetchSchedules,
  fetchSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  pauseSchedule,
  resumeSchedule,
  triggerSchedule,
  fetchScheduleTasks,
} from "../api";
import type {
  PaginatedResponse,
  Schedule,
  ScheduleCreate,
  ScheduleFilters,
  Task,
} from "../types";
import { queryKeys } from "./core";

// --- Schedule hooks ---

export function useSchedules(
  offset = 0,
  limit = 50,
  filters?: ScheduleFilters,
  options?: Partial<UseQueryOptions<PaginatedResponse<Schedule>>>,
) {
  return useQuery({
    queryKey: [...queryKeys.schedules, { offset, limit, ...filters }],
    queryFn: () => fetchSchedules(offset, limit, filters),
    ...options,
  });
}

export function useSchedule(
  scheduleId: string,
  options?: Partial<UseQueryOptions<Schedule>>,
) {
  return useQuery({
    queryKey: queryKeys.schedule(scheduleId),
    queryFn: () => fetchSchedule(scheduleId),
    enabled: !!scheduleId,
    ...options,
  });
}

export function useCreateSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ScheduleCreate) => createSchedule(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
    },
  });
}

export function useUpdateSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Partial<ScheduleCreate>;
    }) => updateSchedule(id, data),
    onSuccess: (_result, { id }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedule(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
    },
  });
}

export function useDeleteSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteSchedule(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
    },
  });
}

export function usePauseSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => pauseSchedule(id),
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedule(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
    },
  });
}

export function useResumeSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => resumeSchedule(id),
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedule(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
    },
  });
}

export function useScheduleTasks(
  scheduleId: string,
  offset = 0,
  limit = 20,
  options?: Partial<UseQueryOptions<PaginatedResponse<Task>>>,
) {
  return useQuery({
    queryKey: [...queryKeys.scheduleTasks(scheduleId), { offset, limit }],
    queryFn: () => fetchScheduleTasks(scheduleId, offset, limit),
    enabled: !!scheduleId,
    ...options,
  });
}

export function useTriggerSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => triggerSchedule(id),
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.schedule(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduleTasks(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}
