import { useMutation, useQueryClient } from "@tanstack/react-query";
import { startAutoExecuteAll } from "../api";
import { queryKeys } from "./core";

// --- Auto-Execute All hook ---

export function useStartAutoExecuteAll(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => startAutoExecuteAll(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectTree(projectId),
      });
    },
  });
}
