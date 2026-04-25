import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchProjectTodo,
  updateProjectTodo,
  fetchWorkspaceTodo,
  updateWorkspaceTodo,
} from "../api";
import { queryKeys } from "./core";

// --- TODO.md hooks ---
// Single file per project/workspace. No cache cascade — edits to a workspace
// TODO.md don't affect child projects (unlike AGENTS.md).

export function useProjectTodo(projectId: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.projectTodo(projectId),
    queryFn: () => fetchProjectTodo(projectId),
    enabled: !!projectId && (opts?.enabled ?? true),
  });
}

export function useUpdateProjectTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, content }: { projectId: string; content: string }) =>
      updateProjectTodo(projectId, content),
    onSuccess: (_result, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projectTodo(projectId) });
    },
  });
}

export function useWorkspaceTodo(workspaceId: string, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.workspaceTodo(workspaceId),
    queryFn: () => fetchWorkspaceTodo(workspaceId),
    enabled: !!workspaceId && (opts?.enabled ?? true),
  });
}

export function useUpdateWorkspaceTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, content }: { workspaceId: string; content: string }) =>
      updateWorkspaceTodo(workspaceId, content),
    onSuccess: (_result, { workspaceId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaceTodo(workspaceId) });
    },
  });
}
