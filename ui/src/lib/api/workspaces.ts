import type {
  PaginatedResponse,
  Workspace,
  WorkspaceCreate,
  WorkspaceUpdate,
  WorkspaceWithProjects,
  WorkspaceProject,
  WorkspaceDashboard,
  WorkspaceDependencyGraph,
} from "../types";
import { apiFetch } from "./core";

export function fetchWorkspaces(): Promise<Workspace[]> {
  return apiFetch<PaginatedResponse<Workspace>>("/workspaces").then((r) => r.items);
}

export function fetchWorkspace(id: string): Promise<WorkspaceWithProjects> {
  return apiFetch<WorkspaceWithProjects>(`/workspaces/${id}`);
}

export function createWorkspace(data: WorkspaceCreate): Promise<Workspace> {
  return apiFetch<Workspace>("/workspaces", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateWorkspace(
  id: string,
  data: WorkspaceUpdate,
): Promise<Workspace> {
  return apiFetch<Workspace>(`/workspaces/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteWorkspace(id: string): Promise<void> {
  return apiFetch<void>(`/workspaces/${id}`, { method: "DELETE" });
}

export function addProjectToWorkspace(
  workspaceId: string,
  projectId: string,
): Promise<WorkspaceProject> {
  return apiFetch<WorkspaceProject>(
    `/workspaces/${workspaceId}/projects?project_id=${encodeURIComponent(projectId)}`,
    { method: "POST" },
  );
}

export function removeProjectFromWorkspace(
  workspaceId: string,
  projectId: string,
): Promise<void> {
  return apiFetch<void>(`/workspaces/${workspaceId}/projects/${projectId}`, {
    method: "DELETE",
  });
}

export function fetchWorkspaceDashboard(workspaceId: string): Promise<WorkspaceDashboard> {
  return apiFetch<WorkspaceDashboard>(`/workspaces/${workspaceId}/dashboard`);
}

export function fetchWorkspaceDependencyGraph(workspaceId: string): Promise<WorkspaceDependencyGraph> {
  return apiFetch<WorkspaceDependencyGraph>(`/workspaces/${workspaceId}/dependency-graph`);
}
