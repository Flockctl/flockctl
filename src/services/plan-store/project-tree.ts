import { listMilestones, milestoneToApi } from "./milestones.js";
import { listSlices, sliceToApi } from "./slices.js";
import { listPlanTasks, taskToApi } from "./tasks.js";

// ─── Tree ───

export function getProjectTree(projectPath: string): {
  milestones: Array<Record<string, any>>;
} {
  const ms = listMilestones(projectPath);
  return {
    milestones: ms.map(m => {
      const slices = listSlices(projectPath, m.slug);
      return {
        ...milestoneToApi(m),
        slices: slices.map(s => {
          const tasks = listPlanTasks(projectPath, m.slug, s.slug);
          return {
            ...sliceToApi(s),
            tasks: tasks.map(taskToApi),
          };
        }),
      };
    }),
  };
}
