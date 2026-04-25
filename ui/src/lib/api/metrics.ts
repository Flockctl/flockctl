import type { MetricsOverview } from "../types";
import { apiFetch } from "./core";

// --- Metrics ---

export function fetchMetricsOverview(params: {
  period?: string;
  date_from?: string;
  date_to?: string;
  ai_provider_key_id?: string;
}): Promise<MetricsOverview> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      qs.set(key, value);
    }
  }
  return apiFetch(`/metrics/overview?${qs.toString()}`);
}
