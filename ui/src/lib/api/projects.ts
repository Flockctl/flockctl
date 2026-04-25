import type {
  PaginatedResponse,
  Project,
  ProjectAllowedKeys,
  ProjectCreate,
  ProjectScan,
  ProjectUpdate,
} from "../types";
import { apiFetch } from "./core";

export function fetchProjects(): Promise<Project[]> {
  return apiFetch<PaginatedResponse<Project>>("/projects").then((r) => r.items);
}

export function fetchProject(id: string): Promise<Project> {
  return apiFetch<Project>(`/projects/${id}`);
}

export function createProject(data: ProjectCreate): Promise<Project> {
  return apiFetch<Project>("/projects", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function scanProjectPath(path: string): Promise<ProjectScan> {
  return apiFetch<ProjectScan>("/projects/scan", {
    method: "POST",
    body: JSON.stringify({ path }),
    rawKeys: true,
  });
}

export function updateProject(
  id: string,
  data: ProjectUpdate,
): Promise<Project> {
  return apiFetch<Project>(`/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteProject(id: string): Promise<void> {
  return apiFetch<void>(`/projects/${id}`, { method: "DELETE" });
}

/**
 * Fetch the effective AI-key allow-list for a project, with workspace → project
 * inheritance resolved server-side. Returns `allowedKeyIds: null` when no
 * restriction is configured (all active keys are permitted).
 */
export function fetchProjectAllowedKeys(
  projectId: string,
): Promise<ProjectAllowedKeys> {
  return apiFetch<ProjectAllowedKeys>(`/projects/${projectId}/allowed-keys`);
}
