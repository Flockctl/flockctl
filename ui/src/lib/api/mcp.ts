import type { McpServer, McpServerConfig, DisableEntry } from "../types";
import { apiFetch } from "./core";

// --- MCP Servers ---

/** Shape returned by POST /mcp/{global|workspace|project} on success. */
export type McpServerSaveResponse = {
  name: string;
  level: "global" | "workspace" | "project";
  saved: true;
};

/** Shape returned by DELETE /mcp/* on success. */
export type McpServerDeleteResponse = { deleted: true };

export function fetchGlobalMcpServers(): Promise<McpServer[]> {
  return apiFetch("/mcp/global");
}

export function fetchWorkspaceMcpServers(workspaceId: string): Promise<McpServer[]> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/servers`);
}

export function fetchProjectMcpServers(workspaceId: string, projectId: string): Promise<McpServer[]> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/projects/${projectId}/servers`);
}

export function createGlobalMcpServer(
  data: { name: string; config: McpServerConfig },
): Promise<McpServerSaveResponse> {
  return apiFetch("/mcp/global", { method: "POST", body: JSON.stringify(data) });
}

export function createWorkspaceMcpServer(
  workspaceId: string,
  data: { name: string; config: McpServerConfig },
): Promise<McpServerSaveResponse> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/servers`, { method: "POST", body: JSON.stringify(data) });
}

export function createProjectMcpServer(
  workspaceId: string,
  projectId: string,
  data: { name: string; config: McpServerConfig },
): Promise<McpServerSaveResponse> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/projects/${projectId}/servers`, { method: "POST", body: JSON.stringify(data) });
}

export function deleteGlobalMcpServer(name: string): Promise<McpServerDeleteResponse> {
  return apiFetch(`/mcp/global/${name}`, { method: "DELETE" });
}

export function deleteWorkspaceMcpServer(
  workspaceId: string,
  name: string,
): Promise<McpServerDeleteResponse> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/servers/${name}`, { method: "DELETE" });
}

export function deleteProjectMcpServer(
  workspaceId: string,
  projectId: string,
  name: string,
): Promise<McpServerDeleteResponse> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/projects/${projectId}/servers/${name}`, { method: "DELETE" });
}

// --- MCP disable lists ---

export function fetchWorkspaceDisabledMcpServers(workspaceId: string): Promise<{ disabled_mcp_servers: DisableEntry[] }> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/disabled-mcp`);
}

export function disableWorkspaceMcpServer(workspaceId: string, entry: DisableEntry): Promise<{ disabled_mcp_servers: DisableEntry[] }> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/disabled-mcp`, { method: "POST", body: JSON.stringify(entry) });
}

export function enableWorkspaceMcpServer(workspaceId: string, entry: DisableEntry): Promise<{ disabled_mcp_servers: DisableEntry[] }> {
  return apiFetch(`/mcp/workspaces/${workspaceId}/disabled-mcp`, { method: "DELETE", body: JSON.stringify(entry) });
}

export function fetchProjectDisabledMcpServers(projectId: string): Promise<{ disabled_mcp_servers: DisableEntry[] }> {
  return apiFetch(`/mcp/projects/${projectId}/disabled-mcp`);
}

export function disableProjectMcpServer(projectId: string, entry: DisableEntry): Promise<{ disabled_mcp_servers: DisableEntry[] }> {
  return apiFetch(`/mcp/projects/${projectId}/disabled-mcp`, { method: "POST", body: JSON.stringify(entry) });
}

export function enableProjectMcpServer(projectId: string, entry: DisableEntry): Promise<{ disabled_mcp_servers: DisableEntry[] }> {
  return apiFetch(`/mcp/projects/${projectId}/disabled-mcp`, { method: "DELETE", body: JSON.stringify(entry) });
}
