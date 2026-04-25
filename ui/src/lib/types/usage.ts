// --- Usage ---

export interface UsageSummary {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  total_cost_usd: number;
  record_count: number;
  by_provider: Record<string, { tokens: number; cost_usd: number }>;
  by_model: Record<string, { tokens: number; cost_usd: number }>;
}

export interface UsageBreakdownItem {
  scope_id: string | null;
  scope_label: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  record_count: number;
}

export interface UsageBreakdownResponse {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  total_record_count: number;
  items: UsageBreakdownItem[];
}
