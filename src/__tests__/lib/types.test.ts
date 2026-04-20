import { describe, it, expect } from "vitest";
import {
  TASK_STATUS_TRANSITIONS,
  validateTaskTransition,
  TaskStatus,
  TaskType,
  MilestoneStatus,
  SliceStatus,
  PlanTaskStatus,
  MergeStatus,
  ChatMessageRole,
  ScheduleType,
  ScheduleStatus,
} from "../../lib/types.js";

describe("validateTaskTransition", () => {
  it("allows queued → running", () => {
    expect(validateTaskTransition("queued", "running")).toBe(true);
  });

  it("allows queued → cancelled", () => {
    expect(validateTaskTransition("queued", "cancelled")).toBe(true);
  });

  it("allows running → done", () => {
    expect(validateTaskTransition("running", "done")).toBe(true);
  });

  it("allows running → failed", () => {
    expect(validateTaskTransition("running", "failed")).toBe(true);
  });

  it("allows running → cancelled", () => {
    expect(validateTaskTransition("running", "cancelled")).toBe(true);
  });

  it("allows running → timed_out", () => {
    expect(validateTaskTransition("running", "timed_out")).toBe(true);
  });

  it("allows failed → queued (requeue)", () => {
    expect(validateTaskTransition("failed", "queued")).toBe(true);
  });

  it("allows cancelled → queued (requeue)", () => {
    expect(validateTaskTransition("cancelled", "queued")).toBe(true);
  });

  it("allows timed_out → queued (requeue)", () => {
    expect(validateTaskTransition("timed_out", "queued")).toBe(true);
  });

  it("rejects done → running (invalid)", () => {
    expect(validateTaskTransition("done", "running")).toBe(false);
  });

  it("rejects done → queued (invalid)", () => {
    expect(validateTaskTransition("done", "queued")).toBe(false);
  });

  it("rejects done → anything", () => {
    expect(validateTaskTransition("done", "failed")).toBe(false);
    expect(validateTaskTransition("done", "cancelled")).toBe(false);
  });

  it("rejects queued → done (must go through running)", () => {
    expect(validateTaskTransition("queued", "done")).toBe(false);
  });

  it("rejects queued → failed", () => {
    expect(validateTaskTransition("queued", "failed")).toBe(false);
  });

  it("handles unknown source status", () => {
    expect(validateTaskTransition("nonexistent", "running")).toBe(false);
  });

  it("handles unknown target status", () => {
    expect(validateTaskTransition("queued", "nonexistent")).toBe(false);
  });
});

describe("TASK_STATUS_TRANSITIONS map", () => {
  it("has entries for all TaskStatus values", () => {
    for (const status of Object.values(TaskStatus)) {
      expect(TASK_STATUS_TRANSITIONS).toHaveProperty(status);
    }
  });

  it("done has no outgoing transitions", () => {
    expect(TASK_STATUS_TRANSITIONS.done).toEqual([]);
  });
});

describe("Enum constants", () => {
  it("TaskStatus has expected values", () => {
    expect(TaskStatus.QUEUED).toBe("queued");
    expect(TaskStatus.RUNNING).toBe("running");
    expect(TaskStatus.DONE).toBe("done");
    expect(TaskStatus.FAILED).toBe("failed");
    expect(TaskStatus.CANCELLED).toBe("cancelled");
    expect(TaskStatus.TIMED_OUT).toBe("timed_out");
  });

  it("TaskType has expected values", () => {
    expect(TaskType.EXECUTION).toBe("execution");
    expect(TaskType.PLANNING).toBe("planning");
    expect(TaskType.VERIFICATION).toBe("verification");
    expect(TaskType.MERGE).toBe("merge");
  });

  it("MilestoneStatus has expected values", () => {
    expect(MilestoneStatus.PENDING).toBe("pending");
    expect(MilestoneStatus.PLANNING).toBe("planning");
    expect(MilestoneStatus.ACTIVE).toBe("active");
    expect(MilestoneStatus.COMPLETED).toBe("completed");
  });

  it("SliceStatus has expected values", () => {
    expect(SliceStatus.PENDING).toBe("pending");
    expect(SliceStatus.ACTIVE).toBe("active");
    expect(SliceStatus.COMPLETED).toBe("completed");
    expect(SliceStatus.FAILED).toBe("failed");
    expect(SliceStatus.SKIPPED).toBe("skipped");
    expect(SliceStatus.VERIFYING).toBe("verifying");
    expect(SliceStatus.MERGING).toBe("merging");
  });

  it("PlanTaskStatus has expected values", () => {
    expect(PlanTaskStatus.PENDING).toBe("pending");
    expect(PlanTaskStatus.ACTIVE).toBe("active");
    expect(PlanTaskStatus.COMPLETED).toBe("completed");
    expect(PlanTaskStatus.FAILED).toBe("failed");
  });

  it("MergeStatus has expected values", () => {
    expect(MergeStatus.QUEUED).toBe("queued");
    expect(MergeStatus.IN_PROGRESS).toBe("in_progress");
    expect(MergeStatus.MERGED).toBe("merged");
    expect(MergeStatus.CONFLICT).toBe("conflict");
    expect(MergeStatus.FAILED).toBe("failed");
  });

  it("ChatMessageRole has user/assistant/system", () => {
    expect(ChatMessageRole.USER).toBe("user");
    expect(ChatMessageRole.ASSISTANT).toBe("assistant");
    expect(ChatMessageRole.SYSTEM).toBe("system");
  });

  it("ScheduleType has cron/one_shot", () => {
    expect(ScheduleType.CRON).toBe("cron");
    expect(ScheduleType.ONE_SHOT).toBe("one_shot");
  });

  it("ScheduleStatus has active/paused/expired", () => {
    expect(ScheduleStatus.ACTIVE).toBe("active");
    expect(ScheduleStatus.PAUSED).toBe("paused");
    expect(ScheduleStatus.EXPIRED).toBe("expired");
  });
});
