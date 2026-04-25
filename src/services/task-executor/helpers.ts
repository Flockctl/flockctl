export function syncPlan(taskId: number): void {
  import("../auto-executor.js").then(m => m.syncPlanFromExecutionTask(taskId)).catch(() => {});
}

export function repointPlan(previousTaskId: number, newTaskId: number): void {
  import("../auto-executor.js").then(m => m.repointPlanTask(previousTaskId, newTaskId)).catch(() => {});
}
