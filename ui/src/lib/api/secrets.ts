import type { SecretRecord } from "../types";
import { apiFetch } from "./core";

// --- Secrets ---

export type SecretListResponse = { secrets: SecretRecord[] };
export type SecretUpsertInput = { name: string; value: string; description?: string | null };

export function fetchGlobalSecrets(): Promise<SecretListResponse> {
  return apiFetch("/secrets/global");
}

export function upsertGlobalSecret(data: SecretUpsertInput): Promise<SecretRecord> {
  return apiFetch("/secrets/global", { method: "POST", body: JSON.stringify(data) });
}

export function deleteGlobalSecret(name: string): Promise<{ deleted: true }> {
  return apiFetch(`/secrets/global/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export function fetchWorkspaceSecrets(workspaceId: string): Promise<SecretListResponse> {
  return apiFetch(`/secrets/workspaces/${workspaceId}`);
}

export function upsertWorkspaceSecret(workspaceId: string, data: SecretUpsertInput): Promise<SecretRecord> {
  return apiFetch(`/secrets/workspaces/${workspaceId}`, { method: "POST", body: JSON.stringify(data) });
}

export function deleteWorkspaceSecret(workspaceId: string, name: string): Promise<{ deleted: true }> {
  return apiFetch(`/secrets/workspaces/${workspaceId}/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export function fetchProjectSecrets(projectId: string): Promise<SecretListResponse> {
  return apiFetch(`/secrets/projects/${projectId}`);
}

export function upsertProjectSecret(projectId: string, data: SecretUpsertInput): Promise<SecretRecord> {
  return apiFetch(`/secrets/projects/${projectId}`, { method: "POST", body: JSON.stringify(data) });
}

export function deleteProjectSecret(projectId: string, name: string): Promise<{ deleted: true }> {
  return apiFetch(`/secrets/projects/${projectId}/${encodeURIComponent(name)}`, { method: "DELETE" });
}
