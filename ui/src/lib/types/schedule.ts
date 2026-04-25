import type { TaskTemplate, TemplateScope } from "./task";

export const ScheduleType = {
  cron: "cron",
  one_shot: "one_shot",
} as const;
export type ScheduleType = (typeof ScheduleType)[keyof typeof ScheduleType];

export const ScheduleStatus = {
  active: "active",
  paused: "paused",
  expired: "expired",
} as const;
export type ScheduleStatus =
  (typeof ScheduleStatus)[keyof typeof ScheduleStatus];

// --- Schedule ---
// Schedules reference templates by (scope, name) plus an optional
// workspace/project id. `assigned_key_id` lives on the schedule so the same
// template can run under different AI keys.

export interface Schedule {
  id: string;
  template_scope: TemplateScope;
  template_name: string;
  template_workspace_id: string | null;
  template_project_id: string | null;
  assigned_key_id: string | null;
  schedule_type: ScheduleType;
  cron_expression: string | null;
  run_at: string | null;
  timezone: string;
  status: ScheduleStatus;
  last_fire_time: string | null;
  next_fire_time: string | null;
  misfire_grace_seconds: number;
  created_at: string;
  updated_at: string;
  /** Populated by `GET /schedules/:id` — resolved template snapshot or null. */
  template?: TaskTemplate | null;
}

export interface ScheduleCreate {
  template_scope: TemplateScope;
  template_name: string;
  template_workspace_id?: string | null;
  template_project_id?: string | null;
  assigned_key_id?: string | null;
  schedule_type: ScheduleType;
  cron_expression?: string | null;
  run_at?: string | null;
  timezone?: string;
  misfire_grace_seconds?: number;
}

export interface ScheduleFilters {
  status?: ScheduleStatus;
  schedule_type?: ScheduleType;
}
