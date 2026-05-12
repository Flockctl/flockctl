import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { fetchMetricsOverview } from "../api";
import type { MetricsOverview } from "../types";
import { queryKeys } from "./core";
import { useWsAwarePolling } from "../global-ws";

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
  // Audit-round-5: WS-aware fallback. Metrics derive from usage_records
  // which is append-only — the global WS broadcasts task_done events
  // that already invalidate the cache, so polling at 60s is redundant
  // when the socket is up. Pauses on hidden tabs too.
  const refetchInterval = useWsAwarePolling(60_000);
  return useQuery({
    queryKey: queryKeys.metricsOverview(params),
    queryFn: () => fetchMetricsOverview(params),
    refetchInterval,
    ...options,
  });
}
