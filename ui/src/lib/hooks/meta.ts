import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchMeta, updateMetaDefaults } from "../api";
import { queryKeys } from "./core";

// --- Meta hooks ---

export function useMeta() {
  return useQuery({
    queryKey: queryKeys.meta,
    queryFn: fetchMeta,
    staleTime: 60_000, // re-check every 60s
  });
}

export function useUpdateMetaDefaults() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { default_model?: string | null; default_key_id?: number | null }) =>
      updateMetaDefaults(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.meta });
    },
  });
}
