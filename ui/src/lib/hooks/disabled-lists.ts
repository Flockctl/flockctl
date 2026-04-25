import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchWorkspaceDisabledSkills,
  disableWorkspaceSkill,
  enableWorkspaceSkill,
  fetchProjectDisabledSkills,
  disableProjectSkill,
  enableProjectSkill,
  fetchWorkspaceDisabledMcpServers,
  disableWorkspaceMcpServer,
  enableWorkspaceMcpServer,
  fetchProjectDisabledMcpServers,
  disableProjectMcpServer,
  enableProjectMcpServer,
} from "../api";
import { queryKeys } from "./core";

// --- Disabled skill/mcp list hooks ---

export function useWorkspaceDisabledSkills(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.workspaceDisabledSkills(workspaceId),
    queryFn: () => fetchWorkspaceDisabledSkills(workspaceId),
    enabled: !!workspaceId,
  });
}

export function useToggleWorkspaceDisabledSkill(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, level, disable }: { name: string; level: import("../types").DisableLevel; disable: boolean }) =>
      disable
        ? disableWorkspaceSkill(workspaceId, { name, level })
        : enableWorkspaceSkill(workspaceId, { name, level }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDisabledSkills(workspaceId) }); },
  });
}

export function useProjectDisabledSkills(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectDisabledSkills(projectId),
    queryFn: () => fetchProjectDisabledSkills(projectId),
    enabled: !!projectId,
  });
}

export function useToggleProjectDisabledSkill(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, level, disable }: { name: string; level: import("../types").DisableLevel; disable: boolean }) =>
      disable
        ? disableProjectSkill(projectId, { name, level })
        : enableProjectSkill(projectId, { name, level }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.projectDisabledSkills(projectId) }); },
  });
}

export function useWorkspaceDisabledMcpServers(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.workspaceDisabledMcpServers(workspaceId),
    queryFn: () => fetchWorkspaceDisabledMcpServers(workspaceId),
    enabled: !!workspaceId,
  });
}

export function useToggleWorkspaceDisabledMcpServer(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, level, disable }: { name: string; level: import("../types").DisableLevel; disable: boolean }) =>
      disable
        ? disableWorkspaceMcpServer(workspaceId, { name, level })
        : enableWorkspaceMcpServer(workspaceId, { name, level }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDisabledMcpServers(workspaceId) }); },
  });
}

export function useProjectDisabledMcpServers(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectDisabledMcpServers(projectId),
    queryFn: () => fetchProjectDisabledMcpServers(projectId),
    enabled: !!projectId,
  });
}

export function useToggleProjectDisabledMcpServer(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, level, disable }: { name: string; level: import("../types").DisableLevel; disable: boolean }) =>
      disable
        ? disableProjectMcpServer(projectId, { name, level })
        : enableProjectMcpServer(projectId, { name, level }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: queryKeys.projectDisabledMcpServers(projectId) }); },
  });
}
