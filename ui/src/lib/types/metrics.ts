// --- Analytics Metrics ---

export interface MetricsOverview {
  time: {
    total_work_seconds: number;
    avg_duration_seconds: number | null;
    median_duration_seconds: number | null;
    avg_queue_wait_seconds: number | null;
    peak_hours: Array<{ hour: number; count: number }>;
  };
  productivity: {
    tasks_by_status: Record<string, number>;
    success_rate: number | null;
    retry_rate: number | null;
    tasks_with_code_changes: number;
    code_change_rate: number | null;
    avg_tasks_per_day: number | null;
    tasks_per_day: Array<{ day: string; count: number }>;
  };
  cost: {
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cache_creation: number;
    total_cache_read: number;
    cache_hit_rate: number | null;
    avg_cost_per_task: number | null;
    cost_by_outcome: Array<{
      outcome: string;
      avg_cost: number;
      total_cost: number;
      task_count: number;
    }>;
    burn_rate_per_day: number | null;
    daily_costs: Array<{ day: string; cost: number }>;
  };
  chats: {
    total_chats: number;
    avg_messages_per_chat: number | null;
    avg_chat_duration_seconds: number | null;
    total_chat_time_seconds: number;
  };
  schedules: {
    total: number;
    active: number;
    paused: number;
  };
}
