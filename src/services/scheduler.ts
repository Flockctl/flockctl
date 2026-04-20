import cron, { type ScheduledTask } from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { getDb } from "../db/index.js";
import { schedules, taskTemplates, tasks } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { taskExecutor } from "./task-executor.js";

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
    for (const [id, job] of this.jobs) {
      job.task.stop();
    }
    this.jobs.clear();
  }

  /** Execute a schedule: read template from DB and create a task */
  private executeSchedule(scheduleId: number): void {
    const db = getDb();
    const schedule = db.select().from(schedules).where(eq(schedules.id, scheduleId)).get();
    if (!schedule || schedule.status !== "active") return;

    // Read current template parameters (not cached at schedule creation)
    const template = schedule.templateId
      ? db.select().from(taskTemplates).where(eq(taskTemplates.id, schedule.templateId)).get()
      : null;

    if (!template) return;

    // Create task from template
    try {
      const newTask = db.insert(tasks).values({
        projectId: template.projectId,
        prompt: template.prompt,
        agent: template.agent ?? "claude-code",
        model: template.model,
        taskType: "execution",
        label: `scheduled-${template.name}-${Date.now()}`,
        workingDir: template.workingDir,
        envVars: template.envVars,
        timeoutSeconds: template.timeoutSeconds,
      }).returning().get();

      // Queue for execution
      if (newTask) {
        taskExecutor.execute(newTask.id);
      }
    } catch (err) {
      console.error("Failed to create scheduled task:", err);
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
