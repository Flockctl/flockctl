import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchProjectAgentsMd,
  fetchProjectEffective,
  fetchWorkspaceAgentsMd,
  fetchWorkspaceEffective,
  putProjectAgentsMd,
  putWorkspaceAgentsMd,
} from "../api/agents-md";
import { queryKeys } from "./core";

// --- AGENTS.md hooks (single public layer) ---
//
// Pattern mirrors `project-config.ts`: a read query + a write mutation, with
// the mutation invalidating the read query on success so the editor refetches
// the just-saved layer. The `/agents-md/effective` preview has its own cache
// key and also gets invalidated on save — it's the merged view of all three
// resolved layers and changes whenever the scope-owned layer changes.

// --- Query keys for the `/effective` endpoint ---

const projectEffectiveKey = (projectId: string) =>
  ["projects", projectId, "agents-md", "effective"] as const;

const workspaceEffectiveKey = (workspaceId: string) =>
  ["workspaces", workspaceId, "agents-md", "effective"] as const;

// --- Project scope ---

export function useProjectAgentsMd(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectAgentsMd(projectId),
    queryFn: () => fetchProjectAgentsMd(projectId),
    enabled: !!projectId,
  });
}

export function usePutProjectAgentsMd() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      content,
    }: {
      projectId: string;
      content: string;
    }) => putProjectAgentsMd(projectId, content),
    onSuccess: (_result, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projectAgentsMd(projectId) });
      queryClient.invalidateQueries({ queryKey: projectEffectiveKey(projectId) });
    },
  });
}

export function useProjectEffective(projectId: string) {
  return useQuery({
    queryKey: projectEffectiveKey(projectId),
    queryFn: () => fetchProjectEffective(projectId),
    enabled: !!projectId,
  });
}

// --- Workspace scope ---

export function useWorkspaceAgentsMd(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.workspaceAgentsMd(workspaceId),
    queryFn: () => fetchWorkspaceAgentsMd(workspaceId),
    enabled: !!workspaceId,
  });
}

export function usePutWorkspaceAgentsMd() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      workspaceId,
      content,
    }: {
      workspaceId: string;
      content: string;
    }) => putWorkspaceAgentsMd(workspaceId, content),
    onSuccess: (_result, { workspaceId }) => {
      // Workspace AGENTS.md feeds into every child project's effective view,
      // so invalidate the workspace's own caches and any project-scoped
      // agents-md caches that might be open.
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaceAgentsMd(workspaceId) });
      queryClient.invalidateQueries({ queryKey: workspaceEffectiveKey(workspaceId) });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useWorkspaceEffective(workspaceId: string) {
  return useQuery({
    queryKey: workspaceEffectiveKey(workspaceId),
    queryFn: () => fetchWorkspaceEffective(workspaceId),
    enabled: !!workspaceId,
  });
}
