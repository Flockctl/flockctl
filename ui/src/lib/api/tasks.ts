import type {
  PaginatedResponse,
  Task,
  TaskLog,
  TaskCreate,
  TaskUpdate,
  TaskFilters,
} from "../types";
import { apiFetch } from "./core";

export function fetchTasks(
  offset = 0,
  limit = 50,
  filters?: TaskFilters,
): Promise<PaginatedResponse<Task>> {
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
  return apiFetch(`/tasks?${params.toString()}`);
}

export function fetchTask(taskId: string): Promise<Task> {
  return apiFetch(`/tasks/${taskId}`);
}

export function fetchTaskLogs(taskId: string): Promise<TaskLog[]> {
  return apiFetch(`/tasks/${taskId}/logs`);
}

export function fetchTaskDiff(taskId: string): Promise<{
  summary: string | null;
  diff: string;
  truncated: boolean;
  total_lines: number;
  total_files: number;
  total_entries: number;
}> {
  return apiFetch(`/tasks/${taskId}/diff`);
}

export function approveTask(taskId: string, note?: string): Promise<{ ok: boolean }> {
  return apiFetch(`/tasks/${taskId}/approve`, {
    method: "POST",
    body: JSON.stringify({ note: note ?? null }),
  });
}

export function rejectTask(taskId: string, note?: string): Promise<{ ok: boolean }> {
  return apiFetch(`/tasks/${taskId}/reject`, {
    method: "POST",
    body: JSON.stringify({ note: note ?? null }),
  });
}

export function respondToPermission(
  taskId: string,
  requestId: string,
  behavior: "allow" | "deny",
  message?: string,
): Promise<{ ok: boolean }> {
  return apiFetch(`/tasks/${taskId}/permission/${requestId}`, {
    method: "POST",
    body: JSON.stringify({ behavior, message }),
  });
}

export interface PendingPermissionItem {
  request_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  title: string | null;
  display_name: string | null;
  description: string | null;
  decision_reason: string | null;
  tool_use_id: string;
}

export function fetchTaskPendingPermissions(
  taskId: string,
): Promise<{ items: PendingPermissionItem[] }> {
  return apiFetch(`/tasks/${taskId}/pending-permissions`);
}

export function createTask(data: TaskCreate): Promise<Task> {
  return apiFetch("/tasks", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateTask(taskId: string, data: TaskUpdate): Promise<Task> {
  return apiFetch(`/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function cancelTask(taskId: string): Promise<Task> {
  return apiFetch(`/tasks/${taskId}/cancel`, { method: "POST" });
}

export function rerunTask(taskId: string): Promise<Task> {
  return apiFetch(`/tasks/${taskId}/rerun`, { method: "POST" });
}
