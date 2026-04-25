import type {
  PaginatedResponse,
  Task,
  Schedule,
  ScheduleCreate,
  ScheduleFilters,
} from "../types";
import { apiFetch } from "./core";

export function fetchSchedules(
  offset = 0,
  limit = 50,
  filters?: ScheduleFilters,
): Promise<PaginatedResponse<Schedule>> {
  const params = new URLSearchParams();
  params.set("offset", String(offset));
  params.set("limit", String(limit));
  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, String(value));
      }
    }
  }
  return apiFetch(`/schedules?${params.toString()}`);
}

export function fetchSchedule(scheduleId: string): Promise<Schedule> {
  return apiFetch(`/schedules/${scheduleId}`);
}

export function createSchedule(data: ScheduleCreate): Promise<Schedule> {
  return apiFetch("/schedules", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateSchedule(
  scheduleId: string,
  data: Partial<ScheduleCreate>,
): Promise<Schedule> {
  return apiFetch(`/schedules/${scheduleId}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteSchedule(scheduleId: string): Promise<void> {
  return apiFetch(`/schedules/${scheduleId}`, { method: "DELETE" });
}

export function pauseSchedule(scheduleId: string): Promise<Schedule> {
  return apiFetch(`/schedules/${scheduleId}/pause`, { method: "POST" });
}

export function resumeSchedule(scheduleId: string): Promise<Schedule> {
  return apiFetch(`/schedules/${scheduleId}/resume`, { method: "POST" });
}

export function triggerSchedule(scheduleId: string): Promise<Schedule> {
  return apiFetch(`/schedules/${scheduleId}/trigger`, { method: "POST" });
}

export function fetchScheduleTasks(
  scheduleId: string,
  offset = 0,
  limit = 20,
): Promise<PaginatedResponse<Task>> {
  const params = new URLSearchParams();
  params.set("offset", String(offset));
  params.set("limit", String(limit));
  return apiFetch(`/schedules/${scheduleId}/tasks?${params.toString()}`);
}

export function fetchProjectSchedules(
  projectId: string,
  offset = 0,
  limit = 50,
): Promise<PaginatedResponse<Schedule>> {
  return apiFetch(
    `/projects/${projectId}/schedules?offset=${offset}&limit=${limit}`,
  );
}
