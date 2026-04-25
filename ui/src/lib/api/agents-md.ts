import { apiFetch } from "./core";
import type {
  Effective,
  ProjectAgentsMd,
  PutLayerResult,
  WorkspaceAgentsMd,
} from "../types/agents-md";

// --- AGENTS.md (single public layer per scope) ---
//
// The server exposes the public AGENTS.md for the editable scopes. Keys still
// carry hyphens ("project-public", "workspace-public") so every request uses
// `rawKeys: true` to bypass camelCase/snake_case conversion — we want the
// layer keys preserved exactly as the server sends and expects them.

// --- Project scope ---

export function fetchProjectAgentsMd(projectId: string): Promise<ProjectAgentsMd> {
  return apiFetch(`/projects/${projectId}/agents-md`, { rawKeys: true });
}

export function putProjectAgentsMd(
  projectId: string,
  content: string,
): Promise<PutLayerResult> {
  return apiFetch(`/projects/${projectId}/agents-md`, {
    method: "PUT",
    body: JSON.stringify({ content }),
    rawKeys: true,
  });
}

export function fetchProjectEffective(projectId: string): Promise<Effective> {
  return apiFetch(`/projects/${projectId}/agents-md/effective`, { rawKeys: true });
}

// --- Workspace scope ---

export function fetchWorkspaceAgentsMd(workspaceId: string): Promise<WorkspaceAgentsMd> {
  return apiFetch(`/workspaces/${workspaceId}/agents-md`, { rawKeys: true });
}

export function putWorkspaceAgentsMd(
  workspaceId: string,
  content: string,
): Promise<PutLayerResult> {
  return apiFetch(`/workspaces/${workspaceId}/agents-md`, {
    method: "PUT",
    body: JSON.stringify({ content }),
    rawKeys: true,
  });
}

export function fetchWorkspaceEffective(workspaceId: string): Promise<Effective> {
  return apiFetch(`/workspaces/${workspaceId}/agents-md/effective`, { rawKeys: true });
}
