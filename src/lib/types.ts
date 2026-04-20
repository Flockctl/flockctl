export const TASK_STATUS_TRANSITIONS: Record<string, string[]> = {
  queued: ["running", "cancelled"],
  running: ["done", "failed", "cancelled", "timed_out", "pending_approval"],
  pending_approval: ["done", "cancelled"],
  done: [],
  failed: ["queued"],
  cancelled: ["queued"],
  timed_out: ["queued"],
};

export function validateTaskTransition(current: string, next: string): boolean {
  return (TASK_STATUS_TRANSITIONS[current] ?? []).includes(next);
}

export const TaskStatus = {
  QUEUED: "queued",
  RUNNING: "running",
  PENDING_APPROVAL: "pending_approval",
  DONE: "done",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed_out",
} as const;

export const TaskType = {
  EXECUTION: "execution",
  PLANNING: "planning",
  VERIFICATION: "verification",
  MERGE: "merge",
} as const;

export const MilestoneStatus = {
  PENDING: "pending",
  PLANNING: "planning",
  ACTIVE: "active",
  COMPLETED: "completed",
} as const;

export const SliceStatus = {
  PENDING: "pending",
  PLANNING: "planning",
  ACTIVE: "active",
  VERIFYING: "verifying",
  MERGING: "merging",
  COMPLETED: "completed",
  SKIPPED: "skipped",
  FAILED: "failed",
} as const;

export const PlanTaskStatus = {
  PENDING: "pending",
  ACTIVE: "active",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export const MergeStatus = {
  QUEUED: "queued",
  IN_PROGRESS: "in_progress",
  MERGED: "merged",
  CONFLICT: "conflict",
  RESOLVING: "resolving",
  VERIFYING: "verifying",
  FAILED: "failed",
} as const;

export const ChatMessageRole = {
  USER: "user",
  ASSISTANT: "assistant",
  SYSTEM: "system",
} as const;

export const ScheduleType = {
  CRON: "cron",
  ONE_SHOT: "one_shot",
} as const;

export const ScheduleStatus = {
  ACTIVE: "active",
  PAUSED: "paused",
  EXPIRED: "expired",
} as const;

export const BudgetScope = {
  GLOBAL: "global",
  PROJECT: "project",
  WORKSPACE: "workspace",
} as const;

export const BudgetPeriod = {
  DAILY: "daily",
  MONTHLY: "monthly",
  TOTAL: "total",
} as const;

export const BudgetAction = {
  PAUSE: "pause",
  WARN: "warn",
} as const;
