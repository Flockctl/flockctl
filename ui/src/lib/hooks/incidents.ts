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
      qc.setQueryData(queryKeys.incident(incident.id), incident);
      qc.invalidateQueries({ queryKey: queryKeys.incidents });
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
