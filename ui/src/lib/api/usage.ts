import type {
  UsageSummary,
  UsageBreakdownResponse,
} from "../types";
import { apiFetch } from "./core";

export function fetchUsageSummary(params: {
  project_id?: string;
  user_id?: string;
  task_id?: string;
  chat_id?: string;
  period?: string;
  ai_provider_key_id?: string;
}): Promise<UsageSummary> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      qs.set(key, value);
    }
  }
  return apiFetch<UsageSummary>(`/usage/summary?${qs.toString()}`);
}

export function fetchUsageBreakdown(params: {
  group_by: string;
  project_id?: string;
  user_id?: string;
  task_id?: string;
  chat_id?: string;
  period?: string;
  ai_provider_key_id?: string;
}): Promise<UsageBreakdownResponse> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      qs.set(key, value);
    }
  }
  return apiFetch<UsageBreakdownResponse>(`/usage/breakdown?${qs.toString()}`);
}
