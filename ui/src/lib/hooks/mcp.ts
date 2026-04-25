import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchGlobalMcpServers,
  fetchWorkspaceMcpServers,
  fetchProjectMcpServers,
  createGlobalMcpServer,
  createWorkspaceMcpServer,
  createProjectMcpServer,
  deleteGlobalMcpServer,
  deleteWorkspaceMcpServer,
  deleteProjectMcpServer,
} from "../api";
import { queryKeys } from "./core";

// --- MCP Server hooks ---

export function useGlobalMcpServers() {
  return useQuery({
    queryKey: queryKeys.globalMcpServers,
    queryFn: fetchGlobalMcpServers,
  });
}

export function useWorkspaceMcpServers(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.workspaceMcpServers(workspaceId),
    queryFn: () => fetchWorkspaceMcpServers(workspaceId),
    enabled: !!workspaceId,
  });
}

export function useProjectMcpServers(workspaceId: string, projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectMcpServers(workspaceId, projectId),
    queryFn: () => fetchProjectMcpServers(workspaceId, projectId),
    enabled: !!workspaceId && !!projectId,
  });
}

export function useCreateGlobalMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; config: import("../types").McpServerConfig }) => createGlobalMcpServer(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.globalMcpServers }); },
  });
}

export function useCreateWorkspaceMcpServer(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; config: import("../types").McpServerConfig }) => createWorkspaceMcpServer(workspaceId, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.workspaceMcpServers(workspaceId) }); },
  });
}

export function useCreateProjectMcpServer(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; config: import("../types").McpServerConfig }) => createProjectMcpServer(workspaceId, projectId, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.projectMcpServers(workspaceId, projectId) }); },
  });
}

export function useDeleteGlobalMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteGlobalMcpServer(name),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.globalMcpServers }); },
  });
}

export function useDeleteWorkspaceMcpServer(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteWorkspaceMcpServer(workspaceId, name),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.workspaceMcpServers(workspaceId) }); },
  });
}

export function useDeleteProjectMcpServer(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteProjectMcpServer(workspaceId, projectId, name),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.projectMcpServers(workspaceId, projectId) }); },
  });
}
