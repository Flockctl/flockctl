// `waiting_for_input` is a *suspend* state: the task has emitted a question
// (via AskUserQuestion) and is blocked awaiting a human answer. It is the
// only non-terminal state besides `running` and must round-trip cleanly:
//  - running → waiting_for_input   (on question emit)
//  - waiting_for_input → running   (on answer / resume)
//  - waiting_for_input → cancelled (user-initiated abort)
//  - waiting_for_input → timed_out (watchdog timeout applied to the wait)
// It intentionally does NOT transition directly to done/failed — the task
// must first return to `running` so the normal completion path owns cleanup
// (usage persistence, git diff snapshot, retry accounting).
export const TASK_STATUS_TRANSITIONS: Record<string, string[]> = {
  queued: ["running", "cancelled"],
  // `rate_limited` is reachable from `running` when the AI provider returns a
  // rate-limit / usage-limit error mid-turn (see
  // `services/agents/rate-limit-classifier.ts`). The task is parked, NOT
  // failed — its `claude_session_id` lets `rate-limit-scheduler.ts` resume the
  // SDK session at `resume_at` without losing context.
  running: ["done", "failed", "cancelled", "timed_out", "pending_approval", "waiting_for_input", "rate_limited"],
  // `queued` is allowed so a waiting task can be resumed after a daemon
  // restart: the in-memory session is gone, so the answer handler flips
  // the task back to queued and lets execute() spin up a fresh session
  // via the persisted claudeSessionId.
  waiting_for_input: ["running", "queued", "cancelled", "timed_out"],
  pending_approval: ["done", "cancelled"],
  // From rate_limited: scheduler wakes the task → `queued` (executor will
  // pick it up and resume); user cancels via DELETE → `cancelled`; if the
  // resumed run hits the limit AGAIN, it transitions running→rate_limited
  // again, so we don't need a self-loop here.
  rate_limited: ["queued", "cancelled"],
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
  WAITING_FOR_INPUT: "waiting_for_input",
  PENDING_APPROVAL: "pending_approval",
  /** Parked due to provider rate-limit / usage-limit. Will auto-resume at
   *  `tasks.resume_at` via the rate-limit scheduler. */
  RATE_LIMITED: "rate_limited",
  DONE: "done",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed_out",
} as const;

/**
 * Terminal statuses reachable from an error path in AgentSession.run().
 * Used by task-executor's finalize helpers so the error-classification
 * code has a single, narrow type instead of repeating the union inline.
 */
export type TerminalErrorTaskStatus =
  | typeof TaskStatus.TIMED_OUT
  | typeof TaskStatus.CANCELLED
  | typeof TaskStatus.FAILED;

/**
 * Statuses that keep a task "live" — it has started but has not yet reached
 * a terminal state. `waiting_for_input` is considered live because the agent
 * session is still in memory awaiting the answer; it just doesn't accrue
 * cost or count against the concurrency budget.
 */
export const LIVE_TASK_STATUSES: readonly string[] = [
  TaskStatus.RUNNING,
  TaskStatus.WAITING_FOR_INPUT,
  // Rate-limited tasks are still "live" — they own a session_id and will
  // resume on schedule. Treated like `waiting_for_input` for accounting:
  // the task hasn't finished, but it isn't actively burning a slot either.
  TaskStatus.RATE_LIMITED,
] as const;

/**
 * Statuses that actively consume concurrency + cost budget. Distinct from
 * LIVE — a task parked in `waiting_for_input` is live but NOT consuming.
 * This is the single source of truth for "does this task count against
 * maxConcurrent / wall-time billing" checks across the codebase.
 */
export const CONSUMING_TASK_STATUSES: readonly string[] = [
  TaskStatus.RUNNING,
] as const;

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

// ─── Attention aggregation ───
// Items surfaced in the "blocked on me" list. Defined in src/services/attention.ts
// and re-exported here so route/UI layers can import from a stable location
// without reaching into the service module.
export type { AttentionItem } from "../services/attention.js";
