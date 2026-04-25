import cron, { type ScheduledTask } from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { getDb } from "../db/index.js";
import { schedules, tasks } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { taskExecutor } from "./task-executor/index.js";
import { getTemplate, type TemplateScope } from "./templates.js";

interface ScheduledJob {
  task: ScheduledTask;
  scheduleId: number;
}

export class SchedulerService {
  private jobs = new Map<number, ScheduledJob>();

  /** Compute next fire time for a cron expression */
  computeNextFireTime(expression: string, tz?: string): string | null {
    try {
      const expr = CronExpressionParser.parse(expression, { tz });
      return expr.next().toISOString();
    } catch {
      return null;
    }
  }

  /** Load all active schedules from DB and start cron jobs */
  loadExistingSchedules(): void {
    const db = getDb();
    const active = db.select().from(schedules).where(eq(schedules.status, "active")).all();
    for (const s of active) {
      if (s.cronExpression) {
        this.schedule(s.id, s.cronExpression, s.timezone ?? undefined);
      }
    }
  }

  /** Schedule a new cron job */
  schedule(scheduleId: number, expression: string, tz?: string): void {
    if (!cron.validate(expression)) {
      throw new Error(`Invalid cron expression: ${expression}`);
    }

    // Remove existing job if any
    this.remove(scheduleId);

    const task = cron.schedule(expression, () => {
      this.executeSchedule(scheduleId);
    });

    this.jobs.set(scheduleId, { task, scheduleId });

    // Compute and persist next fire time
    const nextFire = this.computeNextFireTime(expression, tz);
    /* v8 ignore next — defensive: cron.validate accepted expression above, so
     * computeNextFireTime's catch path is unreachable here. */
    if (nextFire) {
      const db = getDb();
      db.update(schedules)
        .set({ nextFireTime: nextFire, updatedAt: new Date().toISOString() })
        .where(eq(schedules.id, scheduleId))
        .run();
    }
  }

  /** Pause a scheduled job */
  pause(scheduleId: number): void {
    const job = this.jobs.get(scheduleId);
    if (job) {
      job.task.stop();
    }
    const db = getDb();
    db.update(schedules)
      .set({ status: "paused", updatedAt: new Date().toISOString() })
      .where(eq(schedules.id, scheduleId))
      .run();
  }

  /** Resume a paused job */
  resume(scheduleId: number): void {
    const db = getDb();
    const schedule = db.select().from(schedules).where(eq(schedules.id, scheduleId)).get();
    if (!schedule?.cronExpression) return;

    const job = this.jobs.get(scheduleId);
    if (job) {
      job.task.start();
    } else {
      this.schedule(scheduleId, schedule.cronExpression, schedule.timezone ?? undefined);
    }

    db.update(schedules)
      .set({ status: "active", updatedAt: new Date().toISOString() })
      .where(eq(schedules.id, scheduleId))
      .run();
  }

  /** Remove a scheduled job */
  remove(scheduleId: number): void {
    const job = this.jobs.get(scheduleId);
    if (job) {
      job.task.stop();
      this.jobs.delete(scheduleId);
    }
  }

  /** Stop all cron jobs */
  stopAll(): void {
    for (const [, job] of this.jobs) {
      job.task.stop();
    }
    this.jobs.clear();
  }

  /**
   * Execute a schedule: resolve its template on disk and spawn a task. If the
   * referenced template file is missing (deleted, renamed, or the scope's
   * project/workspace path no longer exists) we skip the run — schedules
   * survive template churn and the next fire will re-check.
   */
  private executeSchedule(scheduleId: number): void {
    const db = getDb();
    const schedule = db.select().from(schedules).where(eq(schedules.id, scheduleId)).get();
    if (!schedule || schedule.status !== "active") return;

    let template = null;
    try {
      template = getTemplate(
        schedule.templateScope as TemplateScope,
        schedule.templateName,
        {
          workspaceId: schedule.templateWorkspaceId ?? undefined,
          projectId: schedule.templateProjectId ?? undefined,
        },
      );
    } catch (err) {
      console.error(`[scheduler] failed to load template for schedule ${scheduleId}:`, err);
    }

    if (!template) {
      console.warn(
        `[scheduler] schedule ${scheduleId} points to missing template ` +
        `${schedule.templateScope}:${schedule.templateName} — skipping this fire`,
      );
    } else {
      try {
        const newTask = db.insert(tasks).values({
          // For project-scoped templates we carry the project id onto the task
          // so executor/permissions work the same as manually created tasks.
          // Workspace and global templates produce tasks with no projectId —
          // the executor falls back to the template's workingDir (if any).
          projectId: schedule.templateProjectId ?? null,
          prompt: template.prompt,
          agent: template.agent ?? "claude-code",
          model: template.model,
          taskType: "execution",
          label: `scheduled-${template.name}-${Date.now()}`,
          workingDir: template.workingDir,
          envVars: template.envVars ? JSON.stringify(template.envVars) : null,
          timeoutSeconds: template.timeoutSeconds,
          // assignedKeyId moved off the template onto the schedule — one
          // template can now be reused with different keys per schedule.
          assignedKeyId: schedule.assignedKeyId ?? null,
        }).returning().get();

        /* v8 ignore next — defensive: Drizzle's .returning().get() after a
         * successful INSERT always yields the row; the catch block covers
         * the failure path. */
        if (newTask) {
          taskExecutor.execute(newTask.id);
        }
      } catch (err) {
        console.error("Failed to create scheduled task:", err);
      }
    }

    // Update last fire time and compute next fire time
    const nextFire = schedule.cronExpression
      ? this.computeNextFireTime(schedule.cronExpression, schedule.timezone ?? undefined)
      : null;

    db.update(schedules)
      .set({
        lastFireTime: new Date().toISOString(),
        nextFireTime: nextFire,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schedules.id, scheduleId))
      .run();
  }

  /** Trigger a schedule immediately (run now) */
  triggerNow(scheduleId: number): void {
    this.executeSchedule(scheduleId);
  }
}

// Singleton
export const schedulerService = new SchedulerService();
