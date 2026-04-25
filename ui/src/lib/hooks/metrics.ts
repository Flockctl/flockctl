import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { fetchMetricsOverview } from "../api";
import type { MetricsOverview } from "../types";
import { queryKeys } from "./core";

// --- Metrics hooks ---

export function useMetricsOverview(
  params: {
    period?: string;
    date_from?: string;
    date_to?: string;
    ai_provider_key_id?: string;
  },
  options?: Partial<UseQueryOptions<MetricsOverview>>,
) {
  return useQuery({
    queryKey: queryKeys.metricsOverview(params),
    queryFn: () => fetchMetricsOverview(params),
    refetchInterval: 60_000,
    ...options,
  });
}
