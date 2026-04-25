import { apiFetch } from "./core";

// --- Project Config ---
// Yaml config keys are camelCase on disk; bypass snake_case conversion.

export function fetchProjectConfig(projectId: string): Promise<Record<string, any>> {
  return apiFetch(`/projects/${projectId}/config`, { rawKeys: true });
}

export function updateProjectConfig(projectId: string, config: Record<string, any>): Promise<Record<string, any>> {
  return apiFetch(`/projects/${projectId}/config`, {
    method: "PUT",
    body: JSON.stringify(config),
    rawKeys: true,
  });
}

// --- Workspace Config ---

export function fetchWorkspaceConfig(workspaceId: string): Promise<Record<string, any>> {
  return apiFetch(`/workspaces/${workspaceId}/config`, { rawKeys: true });
}

export function updateWorkspaceConfig(workspaceId: string, config: Record<string, any>): Promise<Record<string, any>> {
  return apiFetch(`/workspaces/${workspaceId}/config`, {
    method: "PUT",
    body: JSON.stringify(config),
    rawKeys: true,
  });
}
