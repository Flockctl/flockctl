import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import {
  fetchIncident,
  fetchIncidents,
  updateIncident,
  deleteIncident,
  type IncidentResponse,
} from "../api";
import type { PaginatedResponse } from "../types";
import { queryKeys } from "./core";

// --- Incidents ---

export function useIncidents(
  page = 1,
  perPage = 50,
  options?: Partial<UseQueryOptions<PaginatedResponse<IncidentResponse>>>,
) {
  return useQuery<PaginatedResponse<IncidentResponse>>({
    queryKey: [...queryKeys.incidents, { page, perPage }],
    queryFn: () => fetchIncidents(page, perPage),
    ...options,
  });
}

export function useIncident(
  id: string,
  options?: Partial<UseQueryOptions<IncidentResponse>>,
) {
  return useQuery<IncidentResponse>({
    queryKey: queryKeys.incident(id),
    queryFn: () => fetchIncident(id),
    enabled: !!id,
    ...options,
  });
}

export function useUpdateIncident() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Parameters<typeof updateIncident>[1];
    }) => updateIncident(id, data),
    onSuccess: (incident) => {
      // Single-row patch (audit-round-5). Previously the success path
      // invalidated the whole list, forcing a refetch on every open
      // incidents page. Now we patch the detail cache AND every cached
      // list page that contains the row — same pattern as
      // `patchTaskInLists` in tasks.ts.
      qc.setQueryData(queryKeys.incident(incident.id), incident);
      qc.setQueriesData<PaginatedResponse<IncidentResponse>>(
        { queryKey: queryKeys.incidents },
        (old) => {
          if (!old) return old;
          let touched = false;
          const items = old.items.map((row) => {
            if (String(row.id) !== String(incident.id)) return row;
            touched = true;
            return incident;
          });
          return touched ? { ...old, items } : old;
        },
      );
    },
  });
}

export function useDeleteIncident() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteIncident(id),
    onSuccess: (_res, id) => {
      qc.removeQueries({ queryKey: queryKeys.incident(id) });
      qc.invalidateQueries({ queryKey: queryKeys.incidents });
    },
  });
}
