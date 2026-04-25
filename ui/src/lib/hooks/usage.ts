import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { fetchUsageSummary, fetchUsageBreakdown } from "../api";
import type { UsageSummary, UsageBreakdownResponse } from "../types";
import { queryKeys } from "./core";

// --- Usage hooks ---

export function useUsageSummary(
  params: {
    project_id?: string;
    user_id?: string;
    task_id?: string;
    chat_id?: string;
    period?: string;
    ai_provider_key_id?: string;
  },
  options?: Partial<UseQueryOptions<UsageSummary>>,
) {
  return useQuery({
    queryKey: queryKeys.usageSummary(params),
    queryFn: () => fetchUsageSummary(params),
    ...options,
  });
}

export function useUsageBreakdown(
  params: {
    group_by: string;
    project_id?: string;
    user_id?: string;
    task_id?: string;
    chat_id?: string;
    period?: string;
    ai_provider_key_id?: string;
  },
  options?: Partial<UseQueryOptions<UsageBreakdownResponse>>,
) {
  return useQuery({
    queryKey: queryKeys.usageBreakdown(params),
    queryFn: () => fetchUsageBreakdown(params),
    ...options,
  });
}
