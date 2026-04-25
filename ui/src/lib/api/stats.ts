import type { TaskStats, ProjectStats } from "../types";
import { apiFetch } from "./core";

// --- Task Stats ---

export function fetchTaskStats(projectId?: string): Promise<TaskStats> {
  const qs = new URLSearchParams();
  if (projectId) qs.set("project_id", projectId);
  const query = qs.toString();
  return apiFetch(`/tasks/stats${query ? `?${query}` : ""}`);
}

// --- Project Stats ---

export function fetchProjectStats(projectId: string): Promise<ProjectStats> {
  return apiFetch(`/projects/${projectId}/stats`);
}
